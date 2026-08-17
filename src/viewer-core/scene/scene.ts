// Scene controller: renderer, camera, lights, and the ModelBatcher. Picking
// is a GPU ID pass. No web-ifc here; it consumes framework-agnostic IfcMesh.
import * as THREE from 'three';

import { ModelBatcher } from './batcher.js';
import { createWebGlRenderer } from './webgl.js';
import type { IfcMesh, ModelBounds, ModelTransform } from '../engine/types.js';

/**
 * What a measured point landed on, in the order the tool prefers to catch
 * them. `surface` is the exact point under the cursor, i.e. nothing snapped.
 */
export type SnapKind = 'vertex' | 'midpoint' | 'edge' | 'surface';

export interface SnapHit {
  point: [number, number, number];
  kind: SnapKind;
  /** Element that owns a snapped feature. Raw face picks use the center-pixel pick id. */
  expressID?: number;
}

/** One placed measurement span, ready to draw. */
export interface MeasureSpan {
  a: [number, number, number];
  b: [number, number, number];
}

export interface CameraPose {
  position: [number, number, number];
  target: [number, number, number];
}

export interface SceneInfo {
  meshCount: number;
  triangleCount: number;
  visibleTriangleCount: number;
  bounds: { min: [number, number, number]; max: [number, number, number] };
}

export interface SceneColors {
  background: number;
  /** MSAA; only read at renderer creation. */
  antialias?: boolean;
}

export interface ScenePick {
  expressID: number;
  point: [number, number, number];
}

/** One clip plane, already resolved to a unit normal in scene space. */
export interface ClipPlaneSpec {
  key: string;
  normal: [number, number, number];
  offset: number;
  flip: boolean;
}

/** One grid axis polyline in scene space, with its bubble label. */
export interface GridOverlayLine {
  label: string | null;
  /** Flat xyz triples. */
  points: number[];
}

const DEFAULT_COLORS: SceneColors = { background: 0x1e1e1e };
/** Scratch objects: picking and the measure overlay run on every mouse move. */
const _size = new THREE.Vector2();
const _ndc = new THREE.Vector2();
const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _up = new THREE.Vector3();
const _scale = new THREE.Vector3();
const _forward = new THREE.Vector3();
const _raycaster = new THREE.Raycaster();
const _pixel = new Uint8Array(4);
const _viewProjection = new THREE.Matrix4();
const remember = (state: Float64Array, index: number, value: number): boolean => {
  if (state[index] === value) return false;
  state[index] = value;
  return true;
};
/** Measure markers keep this radius on screen whatever the zoom. */
const MEASURE_MARKER_PX = 4;
/** Half-thickness of the measure bar, in screen pixels. */
const MEASURE_LINE_PX = 1.4;
/** Resolution of the pick patch that collects snap candidates. */
const SNAP_PATCH = 33;
/** Elements scanned per snap query, nearest the cursor first. */
const SNAP_CANDIDATE_LIMIT = 64;
/**
 * Snap kinds in priority order with how close, in pixels, the cursor has to
 * be to catch each. Priority is strict: any corner in reach beats a midpoint,
 * and any midpoint beats a point somewhere along an edge. Ranking them all by
 * distance instead would hand almost every click to an edge, since there is
 * one under the cursor nearly everywhere, and the number would then drift
 * with the mouse rather than settling on the corner the user aimed at.
 */
const SNAP_KINDS = ['vertex', 'midpoint', 'edge'] as const;
const SNAP_RADIUS = [14, 11, 9];
/** Compared against squared screen distances, so the scan skips the sqrt. */
const SNAP_RADIUS_SQ = SNAP_RADIUS.map((r) => r * r);

/**
 * GL reads a render target bottom-up; an image is top-down. Copy row by row
 * into the reversed position, which a square plan makes easy to get wrong
 * because most of them look plausible either way up.
 */
export function flipRows(source: Uint8Array, side: number, out: Uint8ClampedArray): void {
  const stride = side * 4;
  for (let row = 0; row < side; row++) {
    out.set(source.subarray(row * stride, row * stride + stride), (side - 1 - row) * stride);
  }
}

/**
 * Keep the locator on the map. Inside the framed area it is the true
 * position; beyond it the marker rides the border on the side the camera
 * actually is, the way a map pins an off-screen target, so flying away never
 * makes it vanish. Returns the clamped x and z plus whether it was pinned.
 */
export function clampToPlan(
  x: number,
  z: number,
  centreX: number,
  centreZ: number,
  half: number,
): { x: number; z: number; pinned: boolean } {
  const edge = half * 0.94;
  const dx = Math.min(edge, Math.max(-edge, x - centreX));
  const dz = Math.min(edge, Math.max(-edge, z - centreZ));
  return { x: centreX + dx, z: centreZ + dz, pinned: dx !== x - centreX || dz !== z - centreZ };
}

export function needsMeasureLayout(
  spans: readonly MeasureSpan[],
  live: { a: [number, number, number]; end: [number, number, number] | null } | null,
  hover: [number, number, number] | null,
  visible: boolean,
): boolean {
  return spans.length > 0 || live !== null || hover !== null || visible;
}

export type ProjectionMode = 'perspective' | 'orthographic';

export class SceneController {
  readonly scene: THREE.Scene;
  private readonly perspCamera: THREE.PerspectiveCamera;
  private readonly orthoCamera: THREE.OrthographicCamera;
  private activeCamera: THREE.PerspectiveCamera | THREE.OrthographicCamera;
  /** Half the world height the ortho frustum covers at zoom 1. */
  private orthoHalfHeight = 10;
  readonly renderer: THREE.WebGLRenderer;
  private batcher: ModelBatcher;
  private colors: SceneColors;
  private readonly pickTarget: THREE.WebGLRenderTarget;
  /** Square of element ids around the cursor; only built if measuring starts. */
  private snapTarget: THREE.WebGLRenderTarget | null = null;
  private readonly snapPixels = new Uint8Array(SNAP_PATCH * SNAP_PATCH * 4);
  private lastRenderMs = 0;
  private renderTimestamps: number[] = [];
  /** CSS-pixel viewport size; the drawing buffer is this times the scale. */
  private baseWidth = 1;
  private baseHeight = 1;
  /** Drawing-buffer scale in (0, 1]; lowered during interaction on slow scenes. */
  private resolutionScale = 1;
  /** User-chosen render scale (settings); multiplies the adaptive scale. */
  private userScale = 1;
  private measure: THREE.Group | null = null;
  private measureSpans: MeasureSpan[] = [];
  private laidOutMeasureSpans: MeasureSpan[] | null = null;
  /** Camera/viewport values that affect the constant-pixel measure geometry. */
  private readonly measureView = new Float64Array(11).fill(Number.NaN);
  private measureLive: { a: [number, number, number]; end: [number, number, number] | null } | null =
    null;
  private measureHover: [number, number, number] | null = null;
  /** One set of nodes per drawn span, grown on demand and hidden when spare. */
  private readonly measurePool: Array<{ a: THREE.Mesh; b: THREE.Mesh; line: THREE.Mesh }> = [];
  private hoverMarker: THREE.Mesh | null = null;
  private measureParts: {
    sphere: THREE.SphereGeometry;
    bar: THREE.CylinderGeometry;
    placed: THREE.MeshBasicMaterial;
    live: THREE.MeshBasicMaterial;
  } | null = null;
  private plan = false;
  /** Draw the highlighted selection through occluders in a second pass. */
  private showThrough = false;
  /** Drawing-buffer size last handed to the renderer; -1 forces the first set. */
  private sizedWidth = -1;
  private sizedHeight = -1;
  /** Kept because clearModel builds a fresh batcher, which defaults to on. */
  private doubleSided = true;
  /**
   * Instanced entries smaller than this on screen are skipped. Measured across
   * the corpus, 2 px removes up to 40 percent of draw calls on instancing-heavy
   * models and none of the triangles anyone can see. Zero turns it off.
   */
  private lodThreshold = 2;
  private lodCulled = 0;
  /** Same reason: a fresh batcher would forget the ghost preference. */
  private ghostHidden = false;
  private readonly planCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  /** Section handles live in their own scene so clipping can be turned off. */
  private readonly gizmoScene = new THREE.Scene();
  private readonly gizmos = new THREE.Group();
  /** Grid axes render unclipped beside the gizmos; sections never cut them. */
  private readonly gridGroup = new THREE.Group();
  /** Annotation anchor dots; a sibling of gizmos so handle rebuilds spare it. */
  private readonly annotationGroup = new THREE.Group();
  private readonly annotationPool: THREE.Mesh[] = [];
  private annotationParts: { sphere: THREE.SphereGeometry; material: THREE.MeshBasicMaterial } | null = null;
  private gridAxes: GridOverlayLine[] = [];
  private gridMaterial: THREE.LineDashedMaterial | null = null;
  private planMarkerScene: THREE.Scene | null = null;
  private planMarker: THREE.Group | null = null;
  private planCone: THREE.Mesh | null = null;
  /** Marker materials with the opacity they were built at, for dimming. */
  private readonly planMarkerParts: Array<{ material: THREE.MeshBasicMaterial; opacity: number }> = [];
  private readonly handleAxes = new Map<THREE.Object3D, { key: string; normal: THREE.Vector3 }>();
  /** Built once and then only moved; a slider drag must not allocate. */
  private boxOutline: THREE.LineSegments | null = null;
  /** Axes the current handle set was built for, so a drag only repositions. */
  private handleKey = '';
  private readonly gizmoMaterial = new THREE.MeshBasicMaterial({
    color: 0x3b82f6,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });
  private readonly raycaster = new THREE.Raycaster();
  /** Invoked after every render pass; used to keep DOM overlays in sync. */
  onAfterRender: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, colors: SceneColors = DEFAULT_COLORS) {
    this.colors = colors;
    this.renderer = createWebGlRenderer(canvas, colors.antialias ?? true).renderer;
    this.renderer.setPixelRatio(1); // pinned; user scale handled in applySize
    // render() reads the counters after every pass, so it owns the reset.
    this.renderer.info.autoReset = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(colors.background);

    this.perspCamera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.perspCamera.position.set(10, 10, 10);
    this.perspCamera.lookAt(0, 0, 0);
    this.orthoCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
    this.activeCamera = this.perspCamera;

    const hemi = new THREE.HemisphereLight(0xffffff, 0x444444, 1.1);
    hemi.position.set(0, 1, 0);
    this.scene.add(hemi);
    const dir = new THREE.DirectionalLight(0xffffff, 1.6);
    dir.position.set(5, 10, 7.5);
    this.scene.add(dir);
    const dir2 = new THREE.DirectionalLight(0xffffff, 0.5);
    dir2.position.set(-6, 4, -5);
    this.scene.add(dir2);

    this.batcher = new ModelBatcher();
    this.scene.add(this.batcher.group);
    this.gizmoScene.add(this.gizmos);
    this.gizmoScene.add(this.gridGroup);
    this.gridGroup.visible = false;
    this.gizmoScene.add(this.annotationGroup);

    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);
  }

  /** The active camera: perspective by default, orthographic after a toggle. */
  get camera(): THREE.PerspectiveCamera | THREE.OrthographicCamera {
    return this.activeCamera;
  }

  /** Perspective-equivalent framing parameters, valid in either projection. */
  getFrameParams(): { fov: number; aspect: number } {
    return { fov: this.perspCamera.fov, aspect: this.baseWidth / this.baseHeight };
  }

  getProjectionMode(): ProjectionMode {
    return this.activeCamera === this.orthoCamera ? 'orthographic' : 'perspective';
  }

  /**
   * Switch projection without a visual jump: the orthographic frustum height
   * is matched to what the perspective camera sees at the orbit target, and
   * the way back turns the accumulated ortho zoom into an equivalent dolly.
   */
  setProjectionMode(mode: ProjectionMode, target: [number, number, number]): void {
    if (mode === this.getProjectionMode()) return;
    const t = new THREE.Vector3(...target);
    const p = this.perspCamera;
    const o = this.orthoCamera;
    if (mode === 'orthographic') {
      const distance = Math.max(p.position.distanceTo(t), 1e-3);
      this.orthoHalfHeight = Math.tan((p.fov * Math.PI) / 360) * distance;
      o.zoom = 1;
      o.position.copy(p.position);
      o.quaternion.copy(p.quaternion);
      o.up.copy(p.up);
      o.near = p.near;
      o.far = p.far;
      this.syncOrthoFrustum();
      this.activeCamera = o;
    } else {
      const halfH = this.orthoHalfHeight / Math.max(o.zoom, 1e-6);
      const distance = Math.max(halfH / Math.tan((p.fov * Math.PI) / 360), 1e-3);
      const dir = t.clone().sub(o.position);
      if (dir.lengthSq() > 1e-12) dir.normalize();
      else o.getWorldDirection(dir);
      p.position.copy(t).addScaledVector(dir, -distance);
      p.quaternion.copy(o.quaternion);
      p.up.copy(o.up);
      p.near = o.near;
      p.far = o.far;
      p.updateProjectionMatrix();
      this.activeCamera = p;
    }
  }

  /** Fit the ortho frustum to a pose set by perspective framing math. */
  matchOrthoToDistance(distance: number): void {
    if (this.getProjectionMode() !== 'orthographic') return;
    this.orthoHalfHeight = Math.tan((this.perspCamera.fov * Math.PI) / 360) * Math.max(distance, 1e-3);
    this.orthoCamera.zoom = 1;
    this.syncOrthoFrustum();
  }

  private syncOrthoFrustum(): void {
    const aspect = this.baseWidth / Math.max(1, this.baseHeight);
    const o = this.orthoCamera;
    o.top = this.orthoHalfHeight;
    o.bottom = -this.orthoHalfHeight;
    o.left = -this.orthoHalfHeight * aspect;
    o.right = this.orthoHalfHeight * aspect;
    o.updateProjectionMatrix();
  }

  /** Feed a batch of engine meshes into the GPU batcher. */
  addMeshes(meshes: IfcMesh[], modelIndex = 0): void {
    this.batcher.ingest(meshes, modelIndex);
  }

  // -- visibility ---------------------------------------------------------
  setHidden(expressIDs: Iterable<number>, hidden: boolean): void {
    this.batcher.setHidden(expressIDs, hidden);
  }

  /** Hide everything except the given expressIDs. */
  isolate(expressIDs: Iterable<number>): void {
    this.batcher.isolate(expressIDs);
  }

  showAll(): void {
    this.batcher.showAll();
  }

  setCategoryVisible(type: string, visible: boolean): void {
    this.batcher.setCategoryVisible(type, visible);
  }

  setGhostHidden(on: boolean): void {
    this.ghostHidden = on;
    this.batcher.setGhostHidden(on);
  }

  isGhostHidden(): boolean {
    return this.ghostHidden;
  }

  setXray(expressIDs: Iterable<number>, on: boolean): void {
    this.batcher.setXray(expressIDs, on);
  }

  clearXray(): void {
    this.batcher.clearXray();
  }

  isElementXray(expressID: number): boolean {
    return this.batcher.isElementXray(expressID);
  }

  getXrayCount(): number {
    return this.batcher.getXrayCount();
  }

  setPickSolidOnly(on: boolean): void {
    this.batcher.setPickSolidOnly(on);
  }

  isPickSolidOnly(): boolean {
    return this.batcher.isPickSolidOnly();
  }

  /**
   * Perspective zoom. Only the perspective camera has a lens, so this is a
   * no-op reader/writer while the parallel one is active.
   */
  setFieldOfView(deg: number): void {
    if (this.perspCamera.fov === deg) return;
    this.perspCamera.fov = deg;
    this.perspCamera.updateProjectionMatrix();
  }

  getFieldOfView(): number {
    return this.perspCamera.fov;
  }

  /** Unit view direction, so hosts can read it without importing three. */
  getViewDirection(): [number, number, number] {
    const d = this.camera.getWorldDirection(_forward);
    return [d.x, d.y, d.z];
  }

  /** Camera position in scene space, same reason. */
  getCameraPosition(): [number, number, number] {
    const p = this.camera.position;
    return [p.x, p.y, p.z];
  }

  /** The world direction the top of the screen points at. */
  getViewUp(): [number, number, number] {
    const up = _up.set(0, 1, 0).applyQuaternion(this.camera.quaternion);
    return [up.x, up.y, up.z];
  }

  setElementOffsets(entries: Iterable<[number, [number, number, number]]>): void {
    this.batcher.setElementOffsets(entries);
  }

  clearElementOffsets(): void {
    this.batcher.clearElementOffsets();
  }

  hasElementOffsets(): boolean {
    return this.batcher.hasElementOffsets();
  }

  getElementOffset(expressID: number): [number, number, number] | null {
    return this.batcher.getElementOffset(expressID);
  }

  getElementOffsets(): Array<[number, [number, number, number]]> {
    return this.batcher.getElementOffsets();
  }

  setEdges(on: boolean): void {
    this.batcher.setEdges(on);
  }

  isEdges(): boolean {
    return this.batcher.isEdges();
  }

  setColorOverride(assignment: Map<number, number>, colors: Array<[number, number, number]>): void {
    this.batcher.setColorOverride(assignment, colors);
  }

  clearColorOverride(): void {
    this.batcher.clearColorOverride();
  }

  hasColorOverride(): boolean {
    return this.batcher.hasColorOverride();
  }

  getCategoryVisible(type: string): boolean {
    return this.batcher.getCategoryVisible(type);
  }

  isElementVisible(expressID: number): boolean {
    return this.batcher.isElementVisible(expressID);
  }

  getElementTypes(): Map<number, string> {
    return this.batcher.getElementTypes();
  }

  getVisibilityCounts(): { total: number; hidden: number } {
    return this.batcher.getVisibilityCounts();
  }


  /** True when the element contributed geometry to the scene. */
  hasElement(expressID: number): boolean {
    return this.batcher.hasElement(expressID);
  }

  /** World-space (origin-shifted) AABB of one element. */
  getElementBounds(expressID: number): ModelBounds | null {
    return this.batcher.elementBounds(expressID);
  }

  /** Highlight exactly these elements; anything else drops back to normal. */
  setHighlighted(expressIDs: Iterable<number>): void {
    this.batcher.setHighlighted(expressIDs);
  }


  getBounds(): ModelBounds {
    return this.batcher.getBounds();
  }

  setModelVisible(modelIndex: number, visible: boolean): void {
    this.batcher.setModelVisible(modelIndex, visible);
  }

  isModelVisible(modelIndex: number): boolean {
    return this.batcher.isModelVisible(modelIndex);
  }

  setModelTransform(modelIndex: number, offset: [number, number, number]): void {
    const current = this.batcher.getModelPlacement(modelIndex);
    this.batcher.setModelPlacement(modelIndex, { ...current, translation: offset });
  }

  getModelTransform(modelIndex: number): [number, number, number] {
    return this.batcher.getModelPlacement(modelIndex).translation;
  }

  setModelPlacement(modelIndex: number, transform: ModelTransform): void {
    this.batcher.setModelPlacement(modelIndex, transform);
  }

  getModelPlacement(modelIndex: number): ModelTransform {
    return this.batcher.getModelPlacement(modelIndex);
  }

  removeModel(modelIndex: number): void {
    this.batcher.removeModel(modelIndex);
  }

  /** Origin subtracted from IFC coordinates when the model sits far out. */
  getModelOrigin(): [number, number, number] {
    const origin = this.batcher.getOrigin();
    return [origin.x, origin.y, origin.z];
  }

  getViewport(): { width: number; height: number; aspect: number } {
    const size = this.renderer.getSize(new THREE.Vector2());
    return { width: size.x, height: size.y, aspect: this.baseWidth / Math.max(1, this.baseHeight) };
  }

  /** Live GPU resource counts (for leak detection and the perf HUD). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number } {
    const info = this.renderer.info;
    return {
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      calls: info.render.calls,
      triangles: info.render.triangles,
    };
  }

  /** Timing of the most recent render pass and renders in the last second. */
  /** Instanced entries the last frame skipped as too small to see. */
  getLodCulled(): number {
    return this.lodCulled;
  }

  /** Pixel threshold for instance culling; 0 draws everything. */
  setLodThreshold(pixels: number): void {
    this.lodThreshold = Math.max(0, pixels);
    if (this.lodThreshold === 0) this.batcher.clearLod();
  }

  getLodThreshold(): number {
    return this.lodThreshold;
  }

  getRenderTiming(): { lastMs: number; rendersLastSecond: number } {
    const cutoff = performance.now() - 1000;
    this.renderTimestamps = this.renderTimestamps.filter((t) => t > cutoff);
    return { lastMs: this.lastRenderMs, rendersLastSecond: this.renderTimestamps.length };
  }

  /**
   * Render a square of the pick pass centred on the cursor and read it back.
   * `spread` is the half-width in CSS pixels: 0 reads the single pixel a click
   * needs, more collects the neighbourhood the measure tool snaps within. The
   * result always lands in the full `target`, so a wide region is sampled at
   * the target's resolution rather than the screen's.
   * The measurement overlay is taken out of the pass first: it sits on the
   * surface it marks, so leaving it in would let the cursor snap to its own
   * marker and creep towards the camera a little every frame.
   */
  private renderPick(
    canvasX: number,
    canvasY: number,
    spread: number,
    target: THREE.WebGLRenderTarget,
    out: Uint8Array,
  ): boolean {
    const size = this.renderer.getSize(_size);
    return this.renderPickWith(this.camera, size.x, size.y, canvasX, canvasY, spread, target, out);
  }

  /**
   * The id pass, against any camera and any view size. The plan inset picks
   * with the same code as the viewport rather than a second implementation:
   * an inset that disagreed with the 3D view about what is under the cursor
   * would be worse than one that cannot be clicked at all.
   *
   * `viewWidth`/`viewHeight` are the drawing-buffer pixels the given camera
   * fills, which is the whole canvas for the main camera and the inset square
   * for the plan one.
   */
  private renderPickWith(
    camera: THREE.PerspectiveCamera | THREE.OrthographicCamera,
    viewWidth: number,
    viewHeight: number,
    canvasX: number,
    canvasY: number,
    spread: number,
    target: THREE.WebGLRenderTarget,
    out: Uint8Array,
  ): boolean {
    const size = { x: viewWidth, y: viewHeight };
    if (size.x < 1 || size.y < 1) return false;
    // Screen-size culling is a decision about the last drawn frame from the
    // main camera. The pick pass answers "what is under this pixel" and must
    // see everything, or a small element becomes unclickable and unsnappable.
    this.batcher.clearLod();
    // CSS px -> drawing-buffer px (differs while the resolution is scaled).
    // Capped at the target size: a span wider than the patch would downsample
    // and thin silhouettes would vanish from the candidate read.
    const scale = this.resolutionScale * this.userScale;
    const half = Math.min(Math.max(Math.round(spread * scale), 0), Math.floor((target.width - 1) / 2));
    const span = half * 2 + 1;

    const prevBackground = this.scene.background;
    const prevOverride = this.scene.overrideMaterial;
    const prevTarget = this.renderer.getRenderTarget();
    const prevClearColor = new THREE.Color();
    this.renderer.getClearColor(prevClearColor);
    const prevClearAlpha = this.renderer.getClearAlpha();
    const overlayShown = this.measure?.visible ?? false;
    if (this.measure) this.measure.visible = false;

    camera.setViewOffset(
      size.x,
      size.y,
      Math.floor(canvasX * scale) - half,
      Math.floor(canvasY * scale) - half,
      span,
      span,
    );
    this.scene.background = null;
    this.scene.overrideMaterial = this.batcher.pickMaterial;
    this.renderer.setRenderTarget(target);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.render(this.scene, camera);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, out);

    camera.clearViewOffset();
    this.scene.background = prevBackground;
    this.scene.overrideMaterial = prevOverride;
    this.renderer.setRenderTarget(prevTarget);
    this.renderer.setClearColor(prevClearColor, prevClearAlpha);
    if (this.measure) this.measure.visible = overlayShown;
    return true;
  }

  /** Pick ray through canvas CSS coordinates. */
  private rayThrough(canvasX: number, canvasY: number): THREE.Ray {
    const size = this.renderer.getSize(_size);
    const scale = this.resolutionScale * this.userScale;
    _raycaster.setFromCamera(
      _ndc.set(
        ((canvasX * scale) / size.x) * 2 - 1,
        -((canvasY * scale) / size.y) * 2 + 1,
      ),
      this.camera,
    );
    return _raycaster.ray;
  }

  /**
   * GPU ID pick at canvas CSS coordinates. Hidden elements are not pickable.
   * The point is the ray hit on the element's AABB, which is close enough to
   * select by; anything that has to land on the surface uses pickPoint.
   */
  pick(canvasX: number, canvasY: number): ScenePick | null {
    if (!this.renderPick(canvasX, canvasY, 0, this.pickTarget, _pixel)) return null;
    const id = _pixel[0] * 65536 + _pixel[1] * 256 + _pixel[2];
    if (id === 0) return null;
    const expressID = this.batcher.expressIDForIndex(id - 1);
    if (expressID === null) return null;
    const ray = this.rayThrough(canvasX, canvasY);
    const point =
      this.batcher.rayElementPoint(ray.origin, ray.direction, expressID) ??
      ([0, 0, 0] as [number, number, number]);
    return { expressID, point };
  }

  /**
   * Exact surface point under the cursor, for measuring. Same one-pixel pass
   * as pick(), reading packed view depth instead of the element index, so the
   * point is where the geometry actually is rather than where its bounding box
   * happens to start. Depth is packed over the span the model occupies along
   * the view axis: 24 bits over that is well under a millimetre, where 24 bits
   * over near..far would be centimetres.
   */
  pickPoint(canvasX: number, canvasY: number): [number, number, number] | null {
    const forward = this.camera.getWorldDirection(_forward);
    const b = this.batcher.getBounds();
    let near = Infinity;
    let far = -Infinity;
    for (let c = 0; c < 8; c++) {
      const depth = _v
        .set(c & 1 ? b.max.x : b.min.x, c & 2 ? b.max.y : b.min.y, c & 4 ? b.max.z : b.min.z)
        .sub(this.camera.position)
        .dot(forward);
      near = Math.min(near, depth);
      far = Math.max(far, depth);
    }
    near = Math.max(near, this.camera.near);
    far = Math.max(far, near + 1e-3);

    this.batcher.setDepthPick(true, near, far - near);
    const ok = this.renderPick(canvasX, canvasY, 0, this.pickTarget, _pixel);
    this.batcher.setDepthPick(false);
    if (!ok || _pixel[3] < 128) return null;

    const t = _pixel[0] / 255 + _pixel[1] / 65025 + _pixel[2] / 16581375;
    const depth = near + t * (far - near);
    const ray = this.rayThrough(canvasX, canvasY);
    // Depth is measured along the view axis, the ray is not; project it back.
    // Under an orthographic camera the ray starts on the near plane rather
    // than at the camera position, so that head start comes off the depth.
    const originDepth = _v2.copy(ray.origin).sub(this.camera.position).dot(forward);
    const along = (depth - originDepth) / Math.max(ray.direction.dot(forward), 1e-6);
    const point = _v.copy(ray.origin).addScaledVector(ray.direction, along);
    return [point.x, point.y, point.z];
  }

  /** Estimate the picked face normal from neighbouring packed-depth samples. */
  surfaceNormalAt(
    canvasX: number,
    canvasY: number,
    point: [number, number, number],
  ): [number, number, number] | null {
    const xPoint = this.pickPoint(canvasX + 3, canvasY) ?? this.pickPoint(canvasX - 3, canvasY);
    const yPoint = this.pickPoint(canvasX, canvasY + 3) ?? this.pickPoint(canvasX, canvasY - 3);
    if (!xPoint || !yPoint) return null;
    const center = new THREE.Vector3(...point);
    const across = new THREE.Vector3(...xPoint).sub(center);
    const down = new THREE.Vector3(...yPoint).sub(center);
    const limit = this.worldPerPixel(point) * 50;
    if (across.length() > limit || down.length() > limit) return null;
    const normal = across.cross(down).normalize();
    return normal.lengthSq() > 1e-12 ? [normal.x, normal.y, normal.z] : null;
  }

  /**
   * Clip on any combination of planes. Materials keep three's default
   * `clipIntersection = false`, so a fragment outside any one plane is
   * dropped: six axis planes are therefore a box, with no extra clipping code.
   * The normal points at the discarded side when flip is false.
   */
  setClipPlanes(planes: ClipPlaneSpec[]): void {
    this.renderer.clippingPlanes = planes.map(({ normal, offset, flip }) => {
      const n = new THREE.Vector3(...normal);
      if (!flip) n.negate();
      return new THREE.Plane(n, flip ? -offset : offset);
    });
    this.batcher.setCapMode(planes.length > 0);
  }

  clearClipPlane(): void {
    this.renderer.clippingPlanes = [];
    this.batcher.setCapMode(false);
  }

  /**
   * Wireframe around the section box. One unit-cube geometry, moved and scaled
   * rather than rebuilt, because this is driven from a slider drag.
   */
  setSectionBoxOutline(box: { min: [number, number, number]; max: [number, number, number] } | null): void {
    if (!box) {
      if (this.boxOutline) this.boxOutline.visible = false;
      return;
    }
    if (!this.boxOutline) {
      const edges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
      this.boxOutline = new THREE.LineSegments(
        edges,
        new THREE.LineBasicMaterial({ color: 0x3b82f6, transparent: true, opacity: 0.85 }),
      );
      this.boxOutline.renderOrder = 1000;
      this.gizmoScene.add(this.boxOutline);
    }
    // Both the box and the batch bounds are in scene space, which is already
    // origin-subtracted, so nothing is rebased here.
    this.boxOutline.visible = true;
    this.boxOutline.scale.set(
      Math.max(1e-4, box.max[0] - box.min[0]),
      Math.max(1e-4, box.max[1] - box.min[1]),
      Math.max(1e-4, box.max[2] - box.min[2]),
    );
    this.boxOutline.position.set(
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    );
  }

  // -- section handles ------------------------------------------------------
  /**
   * A draggable arrow per active plane, drawn in a second pass with clipping
   * off (a global clipping plane would otherwise cut the handle sitting on
   * it) and without depth test, so a control is never buried in geometry.
   */
  setSectionHandles(planes: ClipPlaneSpec[]): void {
    // Dragging a handle calls this on every pointermove. The arrows depend on
    // which planes exist and where they point, so an unchanged set is
    // repositioned rather than torn down and rebuilt, which is four GPU
    // geometries per plane per mouse move.
    const key = planes
      .map((plane) => `${plane.key}@${plane.normal.map((v) => v.toFixed(3)).join(',')}`)
      .sort()
      .join('|');
    const b = this.batcher.getBounds();
    const center = new THREE.Vector3(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
    );
    const place = (group: THREE.Object3D, spec: ClipPlaneSpec): void => {
      const n = _v.set(spec.normal[0], spec.normal[1], spec.normal[2]);
      const slide = spec.offset - n.dot(center);
      group.position.copy(center).addScaledVector(n, slide);
    };
    if (key && key === this.handleKey) {
      for (const [group, entry] of this.handleAxes) {
        const plane = planes.find((spec) => spec.key === entry.key);
        if (plane) place(group, plane);
      }
      return;
    }
    this.handleKey = key;
    for (const child of [...this.gizmos.children]) {
      this.gizmos.remove(child);
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        mesh.geometry?.dispose();
        // The grab sphere owns its material; the arrows share gizmoMaterial.
        if (mesh.material && mesh.material !== this.gizmoMaterial) {
          (mesh.material as THREE.Material).dispose();
        }
      });
    }
    this.handleAxes.clear();
    if (planes.length === 0 || !Number.isFinite(b.min.x) || b.max.x < b.min.x) return;

    const span = new THREE.Vector3(
      b.max.x - b.min.x,
      b.max.y - b.min.y,
      b.max.z - b.min.z,
    ).length();
    const shaft = Math.max(span * 0.05, 0.2);
    const head = shaft * 0.45;
    for (const plane of planes) {
      const group = new THREE.Group();
      // Grab volume: invisible and generous, so the arrow is easy to hit.
      const grab = new THREE.Mesh(
        new THREE.SphereGeometry(head * 1.6, 10, 8),
        new THREE.MeshBasicMaterial({ visible: false }),
      );
      group.add(grab);
      const stem = new THREE.Mesh(new THREE.CylinderGeometry(head * 0.14, head * 0.14, shaft * 2, 8), this.gizmoMaterial);
      group.add(stem);
      for (const sign of [1, -1]) {
        const cone = new THREE.Mesh(new THREE.ConeGeometry(head * 0.42, head, 12), this.gizmoMaterial);
        cone.position.y = sign * shaft;
        cone.rotateZ(sign > 0 ? 0 : Math.PI);
        group.add(cone);
      }
      // The stem is built along Y; swing it onto the plane normal.
      const normal = new THREE.Vector3(...plane.normal).normalize();
      group.quaternion.setFromUnitVectors(_up.set(0, 1, 0), normal);
      place(group, plane);
      group.renderOrder = 1001;
      this.gizmos.add(group);
      this.handleAxes.set(group, { key: plane.key, normal });
    }
  }

  /** Key of the handle under these normalized device coords, if any. */
  pickSectionHandle(ndcX: number, ndcY: number): string | null {
    if (this.gizmos.children.length === 0) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.intersectObjects(this.gizmos.children, true)[0];
    if (!hit) return null;
    let node: THREE.Object3D | null = hit.object;
    while (node && !this.handleAxes.has(node)) node = node.parent;
    return node ? (this.handleAxes.get(node)?.key ?? null) : null;
  }

  /**
   * Where the pointer lands along the plane normal, measured on the plane
   * that contains the normal and faces the camera most directly.
   */
  dragSectionOffset(normal: [number, number, number], ndcX: number, ndcY: number): number | null {
    const n = new THREE.Vector3(...normal).normalize();
    const view = this.camera.getWorldDirection(new THREE.Vector3());
    const planeN = n.clone().cross(view);
    if (planeN.lengthSq() < 1e-8) return null; // looking straight down the normal
    planeN.cross(n).normalize();
    const b = this.batcher.getBounds();
    const center = new THREE.Vector3(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
    );
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(planeN, center);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? hit.dot(n) : null;
  }

  /** Keep a section offset inside the model along its own normal. */
  clampSectionOffset(normal: [number, number, number], offset: number): number {
    const b = this.batcher.getBounds();
    let low = Infinity;
    let high = -Infinity;
    for (let c = 0; c < 8; c++) {
      const d =
        normal[0] * (c & 1 ? b.max.x : b.min.x) +
        normal[1] * (c & 2 ? b.max.y : b.min.y) +
        normal[2] * (c & 4 ? b.max.z : b.min.z);
      if (d < low) low = d;
      if (d > high) high = d;
    }
    return Math.min(high, Math.max(low, offset));
  }

  /** Selection silhouette through cover: one extra pass, only when on. */
  private renderShowThrough(): void {
    const prevOverride = this.scene.overrideMaterial;
    const prevBackground = this.scene.background;
    // Overlay meshes have no aElementIndex, so the override shader would read
    // element 0's state for them; keep them out of the pass, as the pick does.
    const overlayShown = this.measure?.visible ?? false;
    if (this.measure) this.measure.visible = false;
    const annotationsShown = this.annotationGroup.visible;
    this.annotationGroup.visible = false;
    this.scene.overrideMaterial = this.batcher.showThroughMaterial;
    this.scene.background = null;
    this.renderer.autoClear = false;
    this.renderer.render(this.scene, this.camera);
    this.renderer.autoClear = true;
    this.scene.overrideMaterial = prevOverride;
    this.scene.background = prevBackground;
    if (this.measure) this.measure.visible = overlayShown;
    this.annotationGroup.visible = annotationsShown;
  }

  setShowThrough(on: boolean): void {
    this.showThrough = on;
  }

  isShowThrough(): boolean {
    return this.showThrough;
  }

  /** Anchor dots for the annotation notes, sized from the model span. */
  setAnnotations(points: Array<[number, number, number]>): void {
    if (!this.annotationParts) {
      this.annotationParts = {
        sphere: new THREE.SphereGeometry(1, 10, 8),
        material: new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false, transparent: true, opacity: 0.95 }),
      };
    }
    const b = this.batcher.getBounds();
    const span = Number.isFinite(b.min.x)
      ? new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z).length()
      : 40;
    const radius = Math.max(span * 0.0035, 0.03);
    while (this.annotationPool.length < points.length) {
      const dot = new THREE.Mesh(this.annotationParts.sphere, this.annotationParts.material);
      dot.renderOrder = 999;
      this.annotationGroup.add(dot);
      this.annotationPool.push(dot);
    }
    this.annotationPool.forEach((dot, index) => {
      const point = points[index];
      dot.visible = Boolean(point);
      if (point) {
        dot.position.set(point[0], point[1], point[2]);
        dot.scale.setScalar(radius);
      }
    });
  }

  private renderGizmos(): void {
    if (
      this.gizmos.children.length === 0 &&
      !this.boxOutline?.visible &&
      !this.gridGroup.visible &&
      !this.annotationPool.some((dot) => dot.visible)
    ) return;
    const saved = this.renderer.clippingPlanes;
    this.renderer.clippingPlanes = [];
    this.renderer.autoClear = false;
    this.renderer.render(this.gizmoScene, this.camera);
    this.renderer.autoClear = true;
    this.renderer.clippingPlanes = saved;
  }

  // -- grid axes overlay ----------------------------------------------------
  setGridAxes(axes: GridOverlayLine[]): void {
    for (const child of [...this.gridGroup.children]) {
      this.gridGroup.remove(child);
      (child as THREE.Line).geometry?.dispose();
    }
    this.gridAxes = axes;
    this.gridGroup.visible = axes.length > 0;
    if (!axes.length) return;
    const b = this.batcher.getBounds();
    const span = Number.isFinite(b.min.x)
      ? new THREE.Vector3(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z).length()
      : 40;
    if (!this.gridMaterial) {
      this.gridMaterial = new THREE.LineDashedMaterial({
        color: 0x8899aa,
        transparent: true,
        opacity: 0.6,
        depthTest: false,
      });
    }
    this.gridMaterial.dashSize = span * 0.012;
    this.gridMaterial.gapSize = span * 0.008;
    for (const axis of axes) {
      const points: THREE.Vector3[] = [];
      for (let i = 0; i + 2 < axis.points.length; i += 3) {
        points.push(new THREE.Vector3(axis.points[i], axis.points[i + 1], axis.points[i + 2]));
      }
      if (points.length < 2) continue;
      const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(points), this.gridMaterial);
      line.computeLineDistances();
      line.renderOrder = 998;
      this.gridGroup.add(line);
    }
  }

  getGridOverlay(): GridOverlayLine[] {
    return this.gridAxes;
  }

  // -- plan inset -----------------------------------------------------------
  /**
   * A floorplan in the corner of the same canvas: one extra scissored pass
   * with an orthographic camera looking straight down. It shares the scene's
   * clipping planes, so a horizontal section turns it into a real plan cut.
   * A second canvas would mean a second GL context for the same geometry.
   */
  setPlanView(on: boolean): void {
    this.plan = on;
  }

  isPlanView(): boolean {
    return this.plan;
  }

  /** Inset rect in CSS pixels from the bottom-left, or null when it is off. */
  getPlanRect(): { x: number; y: number; size: number } | null {
    if (!this.plan) return null;
    const size = Math.round(Math.min(230, this.baseWidth * 0.3, this.baseHeight * 0.42));
    return size < 90 ? null : { x: 14, y: 14, size };
  }

  /**
   * Aim the plan camera at the model from directly above. Shared by the inset
   * render and the inset pick, so a click can never resolve against a
   * different framing than the one on screen.
   *
   * `locator` gives the inset a little more margin than the exported sheet,
   * so the position marker has somewhere to sit when the camera is just
   * outside the walls. The frame stays fixed to the model either way: sizing
   * it to the camera instead would keep the marker at the same spot on the
   * inset however far you flew, which reads as though nothing moved.
   */
  private configurePlanCamera(locator = false): boolean {
    const b = this.batcher.getBounds();
    if (!Number.isFinite(b.min.x) || b.max.x < b.min.x) return false;
    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const half = (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * (locator ? 0.68 : 0.54)) || 1;
    const height = Math.max(b.max.y - b.min.y, 1);
    const cam = this.planCamera;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 0.01;
    cam.far = height * 6 + 20;
    cam.position.set(cx, b.max.y + height, cz);
    cam.up.set(0, 0, -1);
    cam.lookAt(cx, b.min.y, cz);
    cam.updateProjectionMatrix();
    return true;
  }

  /**
   * What is under a point in the plan inset, in inset CSS pixels from its
   * top-left. The id pass runs against the plan camera over the inset square,
   * which is why the drawing-buffer scale is applied to the inset size rather
   * than to the canvas.
   */
  pickInPlan(insetX: number, insetY: number): ScenePick | null {
    const rect = this.getPlanRect();
    // Same framing the inset drew with, or a click lands somewhere else.
    if (!rect || !this.configurePlanCamera(true)) return null;
    if (insetX < 0 || insetY < 0 || insetX > rect.size || insetY > rect.size) return null;
    const scale = this.resolutionScale * this.userScale;
    const side = Math.max(1, Math.round(rect.size * scale));
    if (!this.renderPickWith(this.planCamera, side, side, insetX, insetY, 0, this.pickTarget, _pixel)) {
      return null;
    }
    const id = _pixel[0] * 65536 + _pixel[1] * 256 + _pixel[2];
    if (id === 0) return null;
    const expressID = this.batcher.expressIDForIndex(id - 1);
    if (expressID === null) return null;
    // Straight down, so the world point is the element's own extent under the
    // click rather than a ray through a perspective frustum.
    const bounds = this.batcher.elementBounds(expressID);
    const point: [number, number, number] = bounds
      ? [
          (bounds.min.x + bounds.max.x) / 2,
          (bounds.min.y + bounds.max.y) / 2,
          (bounds.min.z + bounds.max.z) / 2,
        ]
      : [0, 0, 0];
    return { expressID, point };
  }

  /**
   * The locator: a dot for where the camera stands and a wedge for what it
   * can see, the way a map shows heading. Both are built in the XZ plane
   * facing -Z, which is plan screen-up, and rotated about Y to the heading.
   */
  private ensurePlanMarker(): THREE.Group {
    if (this.planMarker) return this.planMarker;
    this.planMarkerScene = new THREE.Scene();
    const group = new THREE.Group();

    const cone = new THREE.BufferGeometry();
    const half = Math.PI / 5;
    const segments = 12;
    const wedge: number[] = [];
    for (let i = 0; i < segments; i++) {
      const a = -half + (i / segments) * half * 2;
      const b = -half + ((i + 1) / segments) * half * 2;
      wedge.push(0, 0, 0, Math.sin(a) * 5.5, 0, -Math.cos(a) * 5.5, Math.sin(b) * 5.5, 0, -Math.cos(b) * 5.5);
    }
    cone.setAttribute('position', new THREE.Float32BufferAttribute(wedge, 3));
    this.planCone = new THREE.Mesh(
      cone,
      new THREE.MeshBasicMaterial({
        color: 0xff8c1a, depthTest: false, transparent: true, opacity: 0.32, side: THREE.DoubleSide,
      }),
    );
    group.add(this.planCone);

    // A dark halo under the dot, so the locator reads on a pale floor as well
    // as a dark one.
    const halo = new THREE.CircleGeometry(1.75, 20).rotateX(-Math.PI / 2);
    group.add(new THREE.Mesh(halo, new THREE.MeshBasicMaterial({
      color: 0x11151c, depthTest: false, transparent: true, opacity: 0.55, side: THREE.DoubleSide,
    })));
    const dot = new THREE.CircleGeometry(1.15, 20).rotateX(-Math.PI / 2);
    group.add(new THREE.Mesh(dot, new THREE.MeshBasicMaterial({
      color: 0xff8c1a, depthTest: false, transparent: true, opacity: 1, side: THREE.DoubleSide,
    })));
    const tip = new THREE.BufferGeometry();
    tip.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, -2.6, -1.1, 0, -0.2, 1.1, 0, -0.2], 3));
    group.add(new THREE.Mesh(tip, new THREE.MeshBasicMaterial({
      color: 0xff8c1a, depthTest: false, transparent: true, opacity: 0.95, side: THREE.DoubleSide,
    })));

    group.traverse((node) => {
      const material = (node as THREE.Mesh).material as THREE.MeshBasicMaterial | undefined;
      if (material) this.planMarkerParts.push({ material, opacity: material.opacity });
    });
    this.planMarker = group;
    this.planMarkerScene.add(group);
    return group;
  }

  /** Ground position under an inset point; null when the inset is off. */
  planPointAt(insetX: number, insetY: number): [number, number] | null {
    const rect = this.getPlanRect();
    if (!rect || !this.configurePlanCamera(true)) return null;
    if (insetX < 0 || insetY < 0 || insetX > rect.size || insetY > rect.size) return null;
    const cam = this.planCamera;
    const half = cam.right;
    // Screen-right is +X; screen-up is -Z (cam.up is 0,0,-1); insetY grows down.
    return [
      cam.position.x + ((insetX / rect.size) * 2 - 1) * half,
      cam.position.z + ((insetY / rect.size) * 2 - 1) * half,
    ];
  }

  /**
   * The plan on its own, rendered square at `size` px into an offscreen
   * target. It is a separate pass rather than a crop of the canvas so the
   * sheet is not limited to the inset's 230 px, and it inherits the clipping
   * planes, which is what makes it a cut rather than a roof.
   */
  capturePlan(size = 1600): HTMLCanvasElement | null {
    const doc = this.renderer.domElement.ownerDocument;
    if (!this.configurePlanCamera()) return null;
    const side = Math.max(64, Math.min(4096, Math.floor(size)));
    const target = new THREE.WebGLRenderTarget(side, side);
    const previousTarget = this.renderer.getRenderTarget();
    const pixels = new Uint8Array(side * side * 4);
    try {
      this.batcher.clearLod();
      this.renderer.setRenderTarget(target);
      this.renderer.render(this.scene, this.planCamera);
      this.renderer.readRenderTargetPixels(target, 0, 0, side, side, pixels);
    } finally {
      this.renderer.setRenderTarget(previousTarget);
      target.dispose();
    }
    const canvas = doc.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const image = ctx.createImageData(side, side);
    flipRows(pixels, side, image.data);
    ctx.putImageData(image, 0, 0);
    return canvas;
  }

  private renderPlan(): void {
    // The inset looks down its own orthographic camera, so the main camera's
    // size decisions do not apply to it.
    this.batcher.clearLod();
    const rect = this.getPlanRect();
    if (!rect || !this.configurePlanCamera(true)) return;

    const scale = this.resolutionScale * this.userScale;
    const px = Math.round(rect.x * scale);
    const py = Math.round(rect.y * scale);
    const size = Math.round(rect.size * scale);
    const r = this.renderer;
    r.setScissorTest(true);
    r.setViewport(px, py, size, size);
    r.setScissor(px, py, size, size);
    r.render(this.scene, this.planCamera);
    // Camera marker: where the main camera stands and which way it looks.
    const marker = this.ensurePlanMarker();
    const d = this.camera.getWorldDirection(_forward);
    const b = this.batcher.getBounds();
    const height = Number.isFinite(b.min.y) ? Math.max(b.max.y - b.min.y, 1) : 1;
    const at = clampToPlan(
      this.camera.position.x,
      this.camera.position.z,
      this.planCamera.position.x,
      this.planCamera.position.z,
      this.planCamera.right,
    );
    marker.position.set(at.x, (Number.isFinite(b.max.y) ? b.max.y : 0) + height * 0.5, at.z);
    marker.rotation.y = Math.atan2(-d.x, -d.z);
    // Pinned at the border it is a "you are over there" hint, so it dims.
    for (const part of this.planMarkerParts) {
      part.material.opacity = at.pinned ? part.opacity * 0.55 : part.opacity;
    }
    marker.scale.setScalar(this.planCamera.right * 0.07);
    // The wedge stretches with the lens, so a zoomed view reads as a narrower
    // cone, matching what the main view can actually see.
    if (this.planCone) {
      this.planCone.scale.setScalar(Math.tan((this.getFieldOfView() * Math.PI) / 360) / Math.tan(Math.PI / 7.2));
    }
    const savedClip = r.clippingPlanes;
    r.clippingPlanes = [];
    r.autoClear = false;
    r.render(this.planMarkerScene!, this.planCamera);
    r.autoClear = true;
    r.clippingPlanes = savedClip;
    r.setScissorTest(false);
    const buffer = r.getDrawingBufferSize(new THREE.Vector2());
    r.setViewport(0, 0, buffer.x, buffer.y);
  }

  // -- snapping -------------------------------------------------------------
  /**
   * The elements drawn within `spread` pixels of the cursor, closest ring
   * first. Taking candidates from the pick pass rather than a world-space
   * index means the tool only ever catches geometry that is actually on
   * screen at that spot: nothing behind a wall, nothing cut off by a section.
   */
  private candidatesAt(canvasX: number, canvasY: number, spread: number): number[] {
    if (!this.snapTarget) this.snapTarget = new THREE.WebGLRenderTarget(SNAP_PATCH, SNAP_PATCH);
    if (!this.renderPick(canvasX, canvasY, spread, this.snapTarget, this.snapPixels)) return [];
    const ids: number[] = [];
    const seen = new Set<number>();
    const centre = (SNAP_PATCH - 1) / 2;
    const at = (x: number, y: number): void => {
      if (x < 0 || y < 0 || x >= SNAP_PATCH || y >= SNAP_PATCH) return;
      const p = (y * SNAP_PATCH + x) * 4;
      const index =
        this.snapPixels[p] * 65536 + this.snapPixels[p + 1] * 256 + this.snapPixels[p + 2];
      if (index === 0 || seen.has(index)) return;
      seen.add(index);
      const expressID = this.batcher.expressIDForIndex(index - 1);
      if (expressID !== null) ids.push(expressID);
    };
    for (let r = 0; r <= centre && ids.length < SNAP_CANDIDATE_LIMIT; r++) {
      for (let d = -r; d <= r; d++) {
        at(centre + d, centre - r);
        at(centre + d, centre + r);
        at(centre - r, centre + d);
        at(centre + r, centre + d);
      }
    }
    return ids;
  }

  /**
   * Where a measured point goes: the geometry feature the cursor is asking
   * for, the exact surface point when none is in reach, and null when there
   * is nothing under the cursor at all. `snap` off measures the raw surface.
   */
  probeAt(canvasX: number, canvasY: number, snap: boolean, vertexOnly: boolean): SnapHit | null {
    const surface = (): SnapHit | null => {
      const point = this.pickPoint(canvasX, canvasY);
      return point ? { point, kind: 'surface' } : null;
    };
    if (!snap) return surface();
    const ids = this.candidatesAt(canvasX, canvasY, SNAP_RADIUS[0]);
    // Nothing was drawn within reach of the cursor, so the surface point
    // cannot be there either: that pass would only cost a render to say so.
    if (ids.length === 0) return null;
    return this.snapTo(ids, canvasX, canvasY, vertexOnly) ?? surface();
  }

  /**
   * The feature point the cursor is asking for, judged on screen because that
   * is how the user judges it: a corner 6 px away is the one they mean, not
   * one 3 cm away in a direction the screen cannot show.
   */
  private snapTo(
    ids: number[],
    canvasX: number,
    canvasY: number,
    vertexOnly: boolean,
  ): SnapHit | null {
    this.camera.updateMatrixWorld();
    this.camera.matrixWorldInverse.copy(this.camera.matrixWorld).invert();
    const e = _viewProjection
      .multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse)
      .elements;
    const width = this.baseWidth;
    const height = this.baseHeight;
    // Screen position and clip w of a world point; w <= 0 means behind us.
    let sx = 0;
    let sy = 0;
    const project = (x: number, y: number, z: number): number => {
      const w = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (w <= 1e-6) return 0;
      sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / w * 0.5 + 0.5) * width;
      sy = (0.5 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / w * 0.5) * height;
      return w;
    };

    // One running best per kind, so priority can be applied after the scan.
    const nearest = [Infinity, Infinity, Infinity];
    const found = new Float64Array(9);
    const foundIds = new Float64Array(3);
    const consider = (x: number, y: number, z: number, kind: number, id: number): void => {
      // Squared: tens of thousands of these run per hover frame and only the
      // ordering matters, so the square root is pure cost. `nearest` holds
      // squared distances to match, which the Infinity test below is fine with.
      const ex = sx - canvasX;
      const ey = sy - canvasY;
      const distance = ex * ex + ey * ey;
      // Stated the positive way on purpose: a candidate has to prove it is in
      // reach, so geometry that came in degenerate is dropped rather than
      // winning every comparison it takes part in.
      if (!(distance < SNAP_RADIUS_SQ[kind]) || !(distance < nearest[kind])) return;
      nearest[kind] = distance;
      found[kind * 3] = x;
      found[kind * 3 + 1] = y;
      found[kind * 3 + 2] = z;
      foundIds[kind] = id;
    };

    for (const id of ids) {
      const segments = this.batcher.segmentsOf(id);
      if (!segments) continue;
      for (let i = 0; i + 6 <= segments.length; i += 6) {
        const ax = segments[i];
        const ay = segments[i + 1];
        const az = segments[i + 2];
        const bx = segments[i + 3];
        const by = segments[i + 4];
        const bz = segments[i + 5];
        const aw = project(ax, ay, az);
        if (aw === 0) continue;
        const apx = sx;
        const apy = sy;
        consider(ax, ay, az, 0, id);
        const bw = project(bx, by, bz);
        if (bw === 0) continue;
        const bpx = sx;
        const bpy = sy;
        consider(bx, by, bz, 0, id);
        if (vertexOnly) continue;

        if (project((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2) !== 0) {
          consider((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, 1, id);
        }
        // Closest point along the drawn edge, then back to 3D. The screen
        // parameter is not the world one under perspective, hence the w mix.
        const dx = bpx - apx;
        const dy = bpy - apy;
        const lengthSq = dx * dx + dy * dy;
        if (lengthSq < 1e-9) continue;
        const t = Math.min(1, Math.max(0, ((canvasX - apx) * dx + (canvasY - apy) * dy) / lengthSq));
        const s = (t * aw) / (bw + t * (aw - bw));
        sx = apx + dx * t;
        sy = apy + dy * t;
        consider(ax + (bx - ax) * s, ay + (by - ay) * s, az + (bz - az) * s, 2, id);
      }
    }

    for (let kind = 0; kind < SNAP_KINDS.length; kind++) {
      if (nearest[kind] === Infinity) continue;
      return {
        point: [found[kind * 3], found[kind * 3 + 1], found[kind * 3 + 2]],
        kind: SNAP_KINDS[kind],
        expressID: foundIds[kind],
      };
    }
    return null;
  }

  /** World units covered by one CSS pixel at this depth; sizes snap radii. */
  worldPerPixel(point: [number, number, number]): number {
    return this.pixelScale(point[0], point[1], point[2]);
  }

  private pixelScale(x: number, y: number, z: number): number {
    const cam = this.activeCamera;
    if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
      const o = cam as THREE.OrthographicCamera;
      return (o.top - o.bottom) / o.zoom / Math.max(1, this.baseHeight);
    }
    const p = cam as THREE.PerspectiveCamera;
    const distance = p.position.distanceTo(_scale.set(x, y, z));
    const vFov = (p.fov * Math.PI) / 180;
    return (2 * Math.tan(vFov / 2) * distance) / Math.max(1, this.baseHeight);
  }

  /**
   * Measurement overlay: every placed span, the span in hand, and the point
   * the cursor would take next. Nodes are pooled and only repositioned; this
   * runs on every mouse move while measuring, so it must not allocate per
   * call. Everything is re-laid out on every render to a constant pixel size,
   * so markers and bars stay readable through any zoom or orbit.
   */
  setMeasure(
    spans: MeasureSpan[],
    live: { a: [number, number, number]; end: [number, number, number] | null } | null,
    hover: [number, number, number] | null,
  ): void {
    this.measureSpans = spans;
    this.measureLive = live;
    this.measureHover = hover;
  }

  private layoutMeasure(): void {
    const spans = this.measureSpans;
    const live = this.measureLive;
    if (spans.length === 0 && !live && !this.measureHover) {
      if (this.measure) this.measure.visible = false;
      return;
    }
    const parts = this.measureParts ?? this.buildMeasure();
    this.measure!.visible = true;
    const camera = this.camera;
    let viewChanged = false;
    viewChanged = remember(this.measureView, 0, camera.position.x) || viewChanged;
    viewChanged = remember(this.measureView, 1, camera.position.y) || viewChanged;
    viewChanged = remember(this.measureView, 2, camera.position.z) || viewChanged;
    viewChanged = remember(this.measureView, 3, camera.quaternion.x) || viewChanged;
    viewChanged = remember(this.measureView, 4, camera.quaternion.y) || viewChanged;
    viewChanged = remember(this.measureView, 5, camera.quaternion.z) || viewChanged;
    viewChanged = remember(this.measureView, 6, camera.quaternion.w) || viewChanged;
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? (camera as THREE.OrthographicCamera)
      : null;
    // Slot 7 tracks whatever controls the world-per-pixel scale in the active
    // projection; slot 8 flips when the projection itself changes.
    viewChanged =
      remember(
        this.measureView,
        7,
        ortho ? (ortho.top - ortho.bottom) / ortho.zoom : (camera as THREE.PerspectiveCamera).fov,
      ) || viewChanged;
    viewChanged = remember(this.measureView, 8, ortho ? 1 : 0) || viewChanged;
    viewChanged = remember(this.measureView, 9, this.baseWidth) || viewChanged;
    viewChanged = remember(this.measureView, 10, this.baseHeight) || viewChanged;
    const placedChanged = viewChanged || spans !== this.laidOutMeasureSpans;
    this.laidOutMeasureSpans = spans;

    const count = spans.length + (live ? 1 : 0);
    while (this.measurePool.length < count) {
      const marker = (): THREE.Mesh => {
        const mesh = new THREE.Mesh(parts.sphere, parts.placed);
        mesh.renderOrder = 1000;
        this.measure!.add(mesh);
        return mesh;
      };
      const line = new THREE.Mesh(parts.bar, parts.placed);
      line.renderOrder = 1000;
      line.frustumCulled = false;
      this.measure!.add(line);
      this.measurePool.push({ a: marker(), b: marker(), line });
    }

    const place = (marker: THREE.Mesh, point: [number, number, number] | null): void => {
      marker.visible = point !== null;
      if (!point) return;
      marker.position.set(point[0], point[1], point[2]);
      marker.scale.setScalar(Math.max(this.worldPerPixel(point) * MEASURE_MARKER_PX, 1e-4));
    };
    const bar = (line: THREE.Mesh, a: [number, number, number], end: [number, number, number]): void => {
      const from = _v.set(a[0], a[1], a[2]);
      const to = _v2.set(end[0], end[1], end[2]);
      const length = from.distanceTo(to);
      const mid = line.position.copy(from).lerp(to, 0.5);
      // The bar is modelled along Y, so aim that axis down the measured span.
      if (length > 1e-9) {
        line.quaternion.setFromUnitVectors(_up.set(0, 1, 0), to.sub(from).divideScalar(length));
      }
      const thickness = Math.max(this.pixelScale(mid.x, mid.y, mid.z) * MEASURE_LINE_PX, 1e-5);
      line.scale.set(thickness, Math.max(length, 1e-5), thickness);
    };

    this.measurePool.forEach((nodes, index) => {
      // Cursor hover changes at frame rate. Placed nodes keep their transforms
      // until either their stable array reference or the camera changes.
      if (index < spans.length && !placedChanged) return;
      const span =
        index < spans.length
          ? spans[index]
          : live && index === spans.length
            ? { a: live.a, b: live.end }
            : null;
      // The moving end of the live span is marked by the hover dot instead.
      place(nodes.a, span?.a ?? null);
      place(nodes.b, index < spans.length ? span?.b ?? null : null);
      nodes.line.visible = Boolean(span?.a && span.b);
      if (span?.a && span.b) bar(nodes.line, span.a, span.b);
    });
    place(this.hoverMarker!, this.measureHover);
  }

  private buildMeasure(): NonNullable<SceneController['measureParts']> {
    const parts = {
      sphere: new THREE.SphereGeometry(1, 12, 8),
      bar: new THREE.CylinderGeometry(1, 1, 1, 6),
      placed: new THREE.MeshBasicMaterial({ color: 0xff8c1a, depthTest: false }),
      live: new THREE.MeshBasicMaterial({ color: 0x3b82f6, depthTest: false }),
    };
    const group = new THREE.Group();
    this.scene.add(group);
    this.measure = group;
    this.hoverMarker = new THREE.Mesh(parts.sphere, parts.live);
    this.hoverMarker.renderOrder = 1001;
    this.hoverMarker.visible = false;
    group.add(this.hoverMarker);
    this.measureParts = parts;
    return parts;
  }

  /** World point to CSS pixel coordinates in the canvas. */
  projectPoint(p: [number, number, number]): { x: number; y: number; behind: boolean } {
    const v = new THREE.Vector3(...p).project(this.camera);
    return {
      x: (v.x * 0.5 + 0.5) * this.baseWidth,
      y: (-v.y * 0.5 + 0.5) * this.baseHeight,
      behind: v.z > 1 || v.z < -1,
    };
  }

  resize(width: number, height: number): void {
    this.baseWidth = Math.max(1, Math.floor(width));
    this.baseHeight = Math.max(1, Math.floor(height));
    this.applySize();
  }

  private applySize(): void {
    const scale = this.resolutionScale * this.userScale;
    const w = Math.max(1, Math.floor(this.baseWidth * scale));
    const h = Math.max(1, Math.floor(this.baseHeight * scale));
    // setSize reassigns canvas.width/height, which reallocates the drawing
    // buffer. Flooring means a resize can land on the same pixel count, and
    // three does not check, so the guard is here.
    if (w !== this.sizedWidth || h !== this.sizedHeight) {
      this.sizedWidth = w;
      this.sizedHeight = h;
      this.renderer.setSize(w, h, false);
    }
    // Outside the guard: the aspect follows the CSS size, which can change
    // without the floored buffer size changing.
    this.perspCamera.aspect = this.baseWidth / this.baseHeight;
    this.perspCamera.updateProjectionMatrix();
    this.syncOrthoFrustum();
  }

  /** Persistent render scale from settings (0.5 to 2 of CSS pixels). */
  setUserScale(scale: number): void {
    const clamped = Math.min(2, Math.max(0.5, scale));
    if (clamped === this.userScale) return;
    this.userScale = clamped;
    this.applySize();
  }

  /**
   * Scale the drawing buffer without changing the CSS size: fewer pixels to
   * shade while the canvas stretches to fill the viewport. Used to keep
   * orbiting fluid on heavy scenes; 1 restores full resolution.
   */
  setResolutionScale(scale: number): void {
    const clamped = Math.min(1, Math.max(0.25, scale));
    if (clamped === this.resolutionScale) return;
    this.resolutionScale = clamped;
    this.applySize();
  }

  getResolutionScale(): number {
    return this.resolutionScale;
  }

  /** Streaming mode skips transparent sorting while mesh batches pour in. */
  setStreamingMode(on: boolean): void {
    this.renderer.sortObjects = !on;
  }

  setDoubleSided(double: boolean): void {
    this.doubleSided = double;
    this.batcher.setDoubleSided(double);
  }

  render(): void {
    const t0 = performance.now();
    if (needsMeasureLayout(this.measureSpans, this.measureLive, this.measureHover, this.measure?.visible ?? false)) {
      this.layoutMeasure();
    }
    // Counters are read after the whole frame, so three must not reset them at
    // the start of each pass: without this the gizmo pass is what the perf HUD
    // reports, which is a handful of arrows rather than the model.
    this.renderer.info.reset();
    this.lodCulled = this.lodThreshold > 0
      ? this.batcher.applyLod(this.camera, this.renderer.domElement.height, this.lodThreshold)
      : 0;
    this.renderer.render(this.scene, this.camera);
    if (this.showThrough && this.batcher.hasHighlight()) this.renderShowThrough();
    this.renderGizmos();
    if (this.plan) this.renderPlan();
    this.lastRenderMs = performance.now() - t0;
    this.renderTimestamps.push(t0);
    if (this.renderTimestamps.length > 240) this.renderTimestamps.shift();
    this.onAfterRender?.();
  }

  getSceneInfo(): SceneInfo {
    const b = this.batcher.getBounds();
    return {
      meshCount: this.batcher.meshCount,
      triangleCount: this.batcher.triangleCount,
      visibleTriangleCount: this.batcher.visibleTriangleCount(),
      bounds: {
        min: [b.min.x, b.min.y, b.min.z],
        max: [b.max.x, b.max.y, b.max.z],
      },
    };
  }

  setBackground(color: number): void {
    this.colors = { ...this.colors, background: color };
    (this.scene.background as THREE.Color).set(color);
  }

  /** Set the viewport background from any CSS color string (theme-driven). */
  setBackgroundCss(css: string): boolean {
    const trimmed = css.trim();
    if (!trimmed) return false;
    try {
      const color = new THREE.Color(trimmed);
      (this.scene.background as THREE.Color).copy(color);
      this.colors = { ...this.colors, background: color.getHex() };
      return true;
    } catch {
      return false;
    }
  }

  clearModel(): void {
    this.setMeasure([], null, null);
    this.setSectionHandles([]);
    this.setSectionBoxOutline(null);
    this.clearClipPlane();
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.batcher = new ModelBatcher();
    this.batcher.setDoubleSided(this.doubleSided);
    this.batcher.setGhostHidden(this.ghostHidden);
    this.scene.add(this.batcher.group);
  }

  dispose(): void {
    this.setSectionHandles([]);
    if (this.measureParts) {
      this.measureParts.sphere.dispose();
      this.measureParts.bar.dispose();
      this.measureParts.placed.dispose();
      this.measureParts.live.dispose();
    }
    this.gizmoMaterial.dispose();
    if (this.boxOutline) {
      this.boxOutline.geometry.dispose();
      (this.boxOutline.material as THREE.Material).dispose();
    }
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.pickTarget.dispose();
    this.snapTarget?.dispose();
    this.renderer.dispose();
    // renderer.dispose() frees objects but deliberately retains the context.
    // Release it too so remounting the SDK cannot exhaust the browser's small
    // per-process WebGL context allowance.
    this.renderer.forceContextLoss();
  }
}
