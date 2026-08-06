// Scene controller: renderer, camera, lights, and the ModelBatcher. Picking
// is a GPU ID pass. No web-ifc here; it consumes framework-agnostic IfcMesh.
import * as THREE from 'three';

import { ModelBatcher } from './batcher.js';
import type { IfcMesh, ModelBounds } from '../engine/types.js';

/**
 * What a measured point landed on, in the order the tool prefers to catch
 * them. `surface` is the exact point under the cursor, i.e. nothing snapped.
 */
export type SnapKind = 'vertex' | 'midpoint' | 'edge' | 'surface';

export interface SnapHit {
  point: [number, number, number];
  kind: SnapKind;
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

export class SceneController {
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
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
  /** Drawing-buffer size last handed to the renderer; -1 forces the first set. */
  private sizedWidth = -1;
  private sizedHeight = -1;
  /** Kept because clearModel builds a fresh batcher, which defaults to on. */
  private doubleSided = true;
  /** Same reason: a fresh batcher would forget the ghost preference. */
  private ghostHidden = false;
  private readonly planCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 1000);
  /** Section handles live in their own scene so clipping can be turned off. */
  private readonly gizmoScene = new THREE.Scene();
  private readonly gizmos = new THREE.Group();
  private readonly handleAxes = new Map<THREE.Object3D, 'x' | 'y' | 'z'>();
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
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: colors.antialias ?? true,
      preserveDrawingBuffer: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(1); // pinned; user scale handled in applySize

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(colors.background);

    this.camera = new THREE.PerspectiveCamera(50, 1, 0.01, 1000);
    this.camera.position.set(10, 10, 10);
    this.camera.lookAt(0, 0, 0);

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

    this.pickTarget = new THREE.WebGLRenderTarget(1, 1);
  }

  /** Feed a batch of engine meshes into the GPU batcher. */
  addMeshes(meshes: IfcMesh[]): void {
    this.batcher.ingest(meshes);
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

  /** Origin subtracted from IFC coordinates when the model sits far out. */
  getModelOrigin(): [number, number, number] {
    const origin = this.batcher.getOrigin();
    return [origin.x, origin.y, origin.z];
  }

  getViewport(): { width: number; height: number; aspect: number } {
    const size = this.renderer.getSize(new THREE.Vector2());
    return { width: size.x, height: size.y, aspect: this.camera.aspect };
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
    if (size.x < 1 || size.y < 1) return false;
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

    this.camera.setViewOffset(
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
    this.renderer.render(this.scene, this.camera);
    this.renderer.readRenderTargetPixels(target, 0, 0, target.width, target.height, out);

    this.camera.clearViewOffset();
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
    const along = depth / Math.max(ray.direction.dot(forward), 1e-6);
    const point = _v.copy(ray.origin).addScaledVector(ray.direction, along);
    return [point.x, point.y, point.z];
  }

  /** Clip on any combination of the three axis-aligned planes. */
  setClipPlanes(planes: Array<{ axis: 'x' | 'y' | 'z'; offset: number; flip: boolean }>): void {
    this.renderer.clippingPlanes = planes.map(({ axis, offset, flip }) => {
      const normal = new THREE.Vector3(
        axis === 'x' ? -1 : 0,
        axis === 'y' ? -1 : 0,
        axis === 'z' ? -1 : 0,
      );
      if (flip) normal.negate();
      return new THREE.Plane(normal, flip ? -offset : offset);
    });
  }

  clearClipPlane(): void {
    this.renderer.clippingPlanes = [];
  }

  // -- section handles ------------------------------------------------------
  /**
   * A draggable arrow per active plane, drawn in a second pass with clipping
   * off (a global clipping plane would otherwise cut the handle sitting on
   * it) and without depth test, so a control is never buried in geometry.
   */
  setSectionHandles(planes: Array<{ axis: 'x' | 'y' | 'z'; offset: number; flip: boolean }>): void {
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
    const b = this.batcher.getBounds();
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
      const dir = plane.axis === 'x' ? 0 : plane.axis === 'y' ? 1 : 2;
      const center = [
        (b.min.x + b.max.x) / 2,
        (b.min.y + b.max.y) / 2,
        (b.min.z + b.max.z) / 2,
      ];
      center[dir] = plane.offset;

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
      // The stem is built along Y; rotate it onto the plane normal.
      if (plane.axis === 'x') group.rotation.z = -Math.PI / 2;
      else if (plane.axis === 'z') group.rotation.x = Math.PI / 2;
      group.position.set(center[0], center[1], center[2]);
      group.renderOrder = 1001;
      this.gizmos.add(group);
      this.handleAxes.set(group, plane.axis);
    }
  }

  /** Axis of the handle under these normalized device coords, if any. */
  pickSectionHandle(ndcX: number, ndcY: number): 'x' | 'y' | 'z' | null {
    if (this.gizmos.children.length === 0) return null;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.intersectObjects(this.gizmos.children, true)[0];
    if (!hit) return null;
    let node: THREE.Object3D | null = hit.object;
    while (node && !this.handleAxes.has(node)) node = node.parent;
    return node ? (this.handleAxes.get(node) ?? null) : null;
  }

  /**
   * Where the pointer lands on the axis, measured on the plane that contains
   * the axis and faces the camera most directly.
   */
  dragSectionOffset(axis: 'x' | 'y' | 'z', ndcX: number, ndcY: number): number | null {
    const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const b = this.batcher.getBounds();
    const axisVec = new THREE.Vector3(index === 0 ? 1 : 0, index === 1 ? 1 : 0, index === 2 ? 1 : 0);
    const view = this.camera.getWorldDirection(new THREE.Vector3());
    const normal = axisVec.clone().cross(view);
    if (normal.lengthSq() < 1e-8) return null; // looking straight down the axis
    normal.cross(axisVec).normalize();
    const center = new THREE.Vector3(
      (b.min.x + b.max.x) / 2,
      (b.min.y + b.max.y) / 2,
      (b.min.z + b.max.z) / 2,
    );
    const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(normal, center);
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(plane, new THREE.Vector3());
    return hit ? hit.getComponent(index) : null;
  }

  /** Keep a section offset inside the model. */
  clampSectionOffset(axis: 'x' | 'y' | 'z', offset: number): number {
    const b = this.batcher.getBounds();
    const index = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
    const low = [b.min.x, b.min.y, b.min.z][index];
    const high = [b.max.x, b.max.y, b.max.z][index];
    return Math.min(high, Math.max(low, offset));
  }

  private renderGizmos(): void {
    if (this.gizmos.children.length === 0) return;
    const saved = this.renderer.clippingPlanes;
    this.renderer.clippingPlanes = [];
    this.renderer.autoClear = false;
    this.renderer.render(this.gizmoScene, this.camera);
    this.renderer.autoClear = true;
    this.renderer.clippingPlanes = saved;
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

  private renderPlan(): void {
    const rect = this.getPlanRect();
    const b = this.batcher.getBounds();
    if (!rect || !Number.isFinite(b.min.x) || b.max.x < b.min.x) return;

    const cx = (b.min.x + b.max.x) / 2;
    const cz = (b.min.z + b.max.z) / 2;
    const half = (Math.max(b.max.x - b.min.x, b.max.z - b.min.z) * 0.54) || 1;
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

    const scale = this.resolutionScale * this.userScale;
    const px = Math.round(rect.x * scale);
    const py = Math.round(rect.y * scale);
    const size = Math.round(rect.size * scale);
    const r = this.renderer;
    r.setScissorTest(true);
    r.setViewport(px, py, size, size);
    r.setScissor(px, py, size, size);
    r.render(this.scene, cam);
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
    const consider = (x: number, y: number, z: number, kind: number): void => {
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
        consider(ax, ay, az, 0);
        const bw = project(bx, by, bz);
        if (bw === 0) continue;
        const bpx = sx;
        const bpy = sy;
        consider(bx, by, bz, 0);
        if (vertexOnly) continue;

        if (project((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2) !== 0) {
          consider((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2, 1);
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
        consider(ax + (bx - ax) * s, ay + (by - ay) * s, az + (bz - az) * s, 2);
      }
    }

    for (let kind = 0; kind < SNAP_KINDS.length; kind++) {
      if (nearest[kind] === Infinity) continue;
      return {
        point: [found[kind * 3], found[kind * 3 + 1], found[kind * 3 + 2]],
        kind: SNAP_KINDS[kind],
      };
    }
    return null;
  }

  /** World units covered by one CSS pixel at this depth; sizes snap radii. */
  worldPerPixel(point: [number, number, number]): number {
    return this.pixelScale(point[0], point[1], point[2]);
  }

  private pixelScale(x: number, y: number, z: number): number {
    const distance = this.camera.position.distanceTo(_scale.set(x, y, z));
    const vFov = (this.camera.fov * Math.PI) / 180;
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
    this.layoutMeasure();
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
    this.camera.aspect = this.baseWidth / this.baseHeight;
    this.camera.updateProjectionMatrix();
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
    if (this.measure?.visible) this.layoutMeasure();
    this.renderer.render(this.scene, this.camera);
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
    this.scene.remove(this.batcher.group);
    this.batcher.dispose();
    this.pickTarget.dispose();
    this.snapTarget?.dispose();
    this.renderer.dispose();
  }
}
