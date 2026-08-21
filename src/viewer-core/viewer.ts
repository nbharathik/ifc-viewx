// Public viewer entry point: wires the async IFC engine (worker-backed,
// inline fallback) to the scene. Loads are progressive; mesh batches render
// as they arrive. The webview and the browser harness share this surface.
import { WorkerEngine } from './engine/workerEngine.js';
import { CachedEngine } from './engine/cache.js';
import { SceneController } from './scene/scene.js';
import { ViewerControls } from './scene/controls.js';
import { PropertiesPanel } from './panels/properties.js';
import { TreePanel } from './panels/tree.js';
import { PerfHud } from './panels/perfHud.js';
import { AxisGizmo } from './panels/axisGizmo.js';
import { LoadingOverlay, ErrorCard } from './panels/overlays.js';
import { CancelledError } from './engine/types.js';
import { TriangleStore } from './scene/triangleStore.js';
import { XrController, type XrMode } from './scene/xr.js';
import { expressOf, modelOf, packId } from './ids.js';
import { explodeOffsets, storeyElementSets, storeySlideOffsets } from './arrange.js';
import { compassPoint, heading, metres, speedLabel, storeyAt, type StoreyBand } from './flyStats.js';
import {
  canTransform,
  compatibleCrs,
  IDENTITY_MODEL_TRANSFORM,
  localToProjected,
  projectedToLocal,
  relativeModelTransform,
  safeModelTransform,
} from '../geo/coordinates.js';
import {
  DEFAULT_MEASUREMENT_FORMAT,
  constrainMeasurementPoint,
  formatArea,
  formatCoordinate,
  formatLength,
  measurementSemantic,
} from './measurements.js';
import type {
  MeasureConstraint,
  MeasurementFormat,
  MeasurementSemantic,
} from './measurements.js';
import type { CameraPose, ClipPlaneSpec, ProjectionMode, SceneInfo, SnapHit, SnapKind } from './scene/scene.js';
import type { PickResult, ViewPreset } from './scene/controls.js';
import type {
  AsyncIfcEngine,
  GeoreferencedPoint,
  IfcGeoReference,
  IfcGridInfo,
  IfcTaskGraph,
  ItemProperties,
  LazyCategory,
  LoadProgress,
  LoadSource,
  LoadedModel,
  ModelBounds,
  ModelStats,
  ModelTransform,
  OrganizeIndex,
  SpatialNode,
} from './engine/types.js';

export * from './engine/types.js';
export type { CameraPose, ProjectionMode, SceneInfo, SnapHit, SnapKind } from './scene/scene.js';
export type { PickResult, ViewPreset } from './scene/controls.js';
export {
  DEFAULT_MEASUREMENT_FORMAT,
  constrainMeasurementPoint,
  formatArea,
  formatCoordinate,
  formatLength,
  formatVolume,
  formatWeight,
  measurementSemantic,
} from './measurements.js';
export type {
  MeasureConstraint,
  MeasurementFormat,
  MeasurementPrecision,
  MeasurementSemantic,
  MeasurementUnit,
} from './measurements.js';

export type SectionAxisName = 'x' | 'y' | 'z';

export interface AxisSectionState {
  axis: SectionAxisName;
  offset: number;
  flip: boolean;
}

/**
 * Arbitrary plane: unit normal in scene space, n . p = offset on the plane.
 * flip false discards the n . p > offset half, matching the axis convention.
 */
export interface PlaneSectionState {
  axis?: undefined;
  id: string;
  name: string;
  normal: [number, number, number];
  offset: number;
  flip: boolean;
}

export type SectionState = AxisSectionState | PlaneSectionState;

export const isAxisSection = (s: SectionState): s is AxisSectionState =>
  typeof (s as AxisSectionState).axis === 'string';

const AXIS_NORMAL: Record<SectionAxisName, [number, number, number]> = {
  x: [1, 0, 0],
  y: [0, 1, 0],
  z: [0, 0, 1],
};

const sectionKey = (s: SectionState): string => (isAxisSection(s) ? s.axis : s.id);

const normalize3 = (v: [number, number, number]): [number, number, number] | null => {
  const len = Math.hypot(v[0], v[1], v[2]);
  if (!Number.isFinite(len) || len < 1e-9) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
};

/**
 * One model in a federated set. `index` is the slot packed into every id the
 * model owns, so `modelOf(someElementId)` names the model it came from.
 */
export interface FederatedModel {
  index: number;
  name: string;
  visible: boolean;
  /** Nudge applied to the whole model, for files that disagree on placement. */
  offset: [number, number, number];
  transform: ModelTransform;
  geo: IfcGeoReference;
  geoStatus: 'ready' | 'aligned' | 'manual' | 'missing' | 'conflict';
  diagnostics: string[];
  elements: number;
  triangles: number;
}

/** What the viewer keeps per open model. */
interface ModelEntry {
  index: number;
  /** The engine's handle, which is a CachedEngine slot. */
  modelID: number;
  name: string;
  tree: SpatialNode | null;
  stats: ModelStats | null;
  categories: Set<LazyCategory>;
  geo: IfcGeoReference;
}

/** A clipping volume, in scene coordinates. Corners, not centre and size. */
export interface SectionBox {
  min: [number, number, number];
  max: [number, number, number];
}

const AXIS_ORDER: SectionAxisName[] = ['x', 'y', 'z'];

/**
 * A box as six half-spaces. Materials keep three's default clipIntersection,
 * so a fragment outside any one of them is dropped, which is the box.
 */
/**
 * Rewrite a spatial tree's ids into one model's namespace. Model 0 packs to
 * itself, so a single model skips the walk entirely and keeps the exact tree
 * the engine handed over, node identity included.
 */
export function packTree(node: SpatialNode, modelIndex: number): SpatialNode {
  if (modelIndex === 0) return node;
  return {
    ...node,
    expressID: packId(modelIndex, node.expressID),
    children: node.children.map((child) => packTree(child, modelIndex)),
  };
}

export function boxPlanes(box: SectionBox): AxisSectionState[] {
  const planes: AxisSectionState[] = [];
  AXIS_ORDER.forEach((axis, i) => {
    planes.push({ axis, offset: box.max[i], flip: false });
    planes.push({ axis, offset: box.min[i], flip: true });
  });
  return planes;
}

/**
 * Grow a box by a share of its longest side, so the elements it was fitted to
 * do not sit exactly on a clipping plane and lose their own faces.
 */
export function padBox(box: SectionBox, pad: number): SectionBox {
  const span = Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]);
  const grow = Math.max(span * pad, 0.01);
  return {
    min: [box.min[0] - grow, box.min[1] - grow, box.min[2] - grow],
    max: [box.max[0] + grow, box.max[1] + grow, box.max[2] + grow],
  };
}

/** Keep every axis open by at least a sliver; a collapsed one clips it all. */
export function sanitizeBox(box: SectionBox): SectionBox {
  const min = box.min.map((value, i) => Math.min(value, box.max[i] - 1e-3)) as [number, number, number];
  return { min, max: [...box.max] as [number, number, number] };
}

/** How a new selection combines with the current one. */
export type SelectMode = 'replace' | 'add' | 'remove' | 'toggle';

/**
 * What the measure tool pulls a placed point onto. Auto takes a corner first,
 * then an edge midpoint, then the point along the edge; vertex takes corners
 * only, for measuring a grid of them; off measures the raw surface.
 */
export type SnapMode = 'auto' | 'vertex' | 'off';

/** One first-class distance measurement. Arithmetic stays in metres. */
export interface Measurement {
  kind: 'distance';
  /** Handle for removeMeasurement; 0 while the span still follows the cursor. */
  id: number;
  label: string;
  visible: boolean;
  semantic: MeasurementSemantic;
  a: [number, number, number];
  b: [number, number, number] | null;
  distance: number;
  /** Split into the ground plane and the height, the way a builder reads it. */
  horizontal: number;
  vertical: number;
  /** Rise over horizontal run. Null represents a vertical span. */
  slopePercent: number | null;
  /** Unsigned angle above the horizontal plane, in degrees. */
  slopeAngle: number;
  /** False while the far end is still following the cursor. */
  complete: boolean;
  /** What each end caught; the far end is null until it is placed. */
  ends: [SnapKind, SnapKind | null];
}

export interface DistanceMeasurementState {
  /** Absent in viewpoints written before measurements became first-class objects. */
  kind?: 'distance';
  id?: number;
  label?: string;
  visible?: boolean;
  a: [number, number, number];
  b: [number, number, number];
  ends: [SnapKind, SnapKind];
}

/** What the measure tool is collecting: two points, three, or a ring of them. */
export type MeasureMode = 'distance' | 'path' | 'angle' | 'area' | 'coordinate' | 'count';

/** A finished shape or coordinate. Distances are metres, angles degrees. */
export interface ShapeMeasure {
  id: number;
  kind: 'path' | 'angle' | 'area' | 'coordinate' | 'count';
  label: string;
  visible: boolean;
  points: Array<[number, number, number]>;
  /** Angle at the middle point, degrees. Only for `angle`. */
  angle?: number;
  /** Newell area of the ring, m2. Only for `area`. */
  area?: number;
  /** Total edge length, closing edge included for an area. */
  perimeter: number;
}

export interface ShapeMeasurementState {
  kind: ShapeMeasure['kind'];
  id?: number;
  label?: string;
  visible?: boolean;
  points: Array<[number, number, number]>;
}

export type MeasurementState = DistanceMeasurementState | ShapeMeasurementState;

/** A text note anchored to a scene-space point, optionally about an element. */
export interface AnnotationState {
  kind?: 'note';
  id?: number;
  text: string;
  at: [number, number, number];
  elementId?: number;
  visible?: boolean;
  createdAt?: string;
}
export type MeasurementObject = Measurement | ShapeMeasure;
export interface MeasurementUpdate {
  label?: string;
  visible?: boolean;
}

const sub = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
  a[0] - b[0],
  a[1] - b[1],
  a[2] - b[2],
];

const length3 = (v: [number, number, number]): number => Math.hypot(v[0], v[1], v[2]);

/**
 * Newell's method: the area of the best-fit plane the ring sits in. Exact for a
 * planar ring, and the sensible answer for one that is slightly out of plane,
 * which is what picking points off a real model always gives you.
 */
export function ringArea(points: Array<[number, number, number]>): number {
  if (points.length < 3) return 0;
  let x = 0;
  let y = 0;
  let z = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    const b = points[(i + 1) % points.length];
    x += a[1] * b[2] - a[2] * b[1];
    y += a[2] * b[0] - a[0] * b[2];
    z += a[0] * b[1] - a[1] * b[0];
  }
  return Math.hypot(x, y, z) / 2;
}

/** Angle at `b`, in degrees. Zero-length arms have no angle to report. */
export function angleAt(
  a: [number, number, number],
  b: [number, number, number],
  c: [number, number, number],
): number {
  const u = sub(a, b);
  const v = sub(c, b);
  const lu = length3(u);
  const lv = length3(v);
  if (lu === 0 || lv === 0) return 0;
  const cos = (u[0] * v[0] + u[1] * v[1] + u[2] * v[2]) / (lu * lv);
  return (Math.acos(Math.min(1, Math.max(-1, cos))) * 180) / Math.PI;
}

export function ringPerimeter(points: Array<[number, number, number]>, closed: boolean): number {
  let total = 0;
  const last = closed ? points.length : points.length - 1;
  for (let i = 0; i < last; i++) total += length3(sub(points[(i + 1) % points.length], points[i]));
  return total;
}

/** Degrees, to a tenth: finer than that is noise on a picked point. */
export function formatAngle(degrees: number): string {
  return `${degrees.toFixed(1)} deg`;
}

/**
 * One named visibility rule. Keep rules union with each other, hide rules
 * subtract; both are removable, so a view can be built up and taken apart.
 */
export interface VisibilityRule {
  id: string;
  label: string;
  mode: 'keep' | 'hide';
  ids: number[];
  /** How the rule was built, when the caller could say. Saved views read it. */
  selector?: unknown;
}

/** One point in the visibility history: everything `applyVisibility` reads. */
interface VisibilityStep {
  rules: VisibilityRule[];
  hidden: number[];
}

const VISIBILITY_HISTORY_LIMIT = 50;

/** Shape id carried by the legs of the angle or ring still being placed. */
const PENDING_SHAPE = -1;

interface MeasureSpanRecord {
  id: number;
  a: [number, number, number];
  b: [number, number, number];
  ends: [SnapKind, SnapKind];
  label?: string;
  visible?: boolean;
  shape?: number;
}

export interface MeasureLabelBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function selectMeasureLabels<T extends MeasureLabelBox>(items: T[], limit = 80, gap = 5): T[] {
  const kept: T[] = [];
  for (const item of items) {
    if (kept.length >= limit) break;
    if (!Number.isFinite(item.x) || !Number.isFinite(item.y)) continue;
    const overlaps = kept.some((other) =>
      Math.abs(item.x - other.x) < (item.width + other.width) / 2 + gap
      && Math.abs(item.y - other.y) < (item.height + other.height) / 2 + gap,
    );
    if (!overlaps) kept.push(item);
  }
  return kept;
}

const sameIds = (a: number[], b: number[]): boolean =>
  a.length === b.length && a.every((id, i) => id === b[i]);

function sameStep(a: VisibilityStep, b: VisibilityStep): boolean {
  if (a.rules.length !== b.rules.length || !sameIds(a.hidden, b.hidden)) return false;
  return a.rules.every((rule, i) => rule.mode === b.rules[i].mode && sameIds(rule.ids, b.rules[i].ids));
}

export interface ViewerWorkerOptions {
  /** Bundled worker script URL (used with a blob fallback when cross-origin). */
  url?: string;
  /** Factory the host controls (Vite worker import). Preferred when set. */
  factory?: () => Worker;
}

export interface ViewerOptions {
  /** Directory/URL serving web-ifc.wasm (required in the browser). */
  wasmPath?: string;
  wasmAbsolute?: boolean;
  /** Initial viewport background color (overridden by theme later). */
  background?: number;
  /** MSAA; read once at renderer creation. Default true. */
  antialias?: boolean;
  /** Host containers for the tree and properties panels; omit to mount none. */
  panels?: { tree?: HTMLElement; properties?: HTMLElement };
  /** Built-in load progress card. Turn it off when the host draws its own. */
  progressCard?: boolean;
  /** Parser worker source; false forces the inline (main thread) engine. */
  worker?: ViewerWorkerOptions | false;
}

export interface ViewerLoadOptions {
  onProgress?: (progress: LoadProgress) => void;
  /** Shown in the model list; the file name, normally. */
  name?: string;
}

export interface LoadTimeline {
  downloadMs?: number;
  parseMs?: number;
  geometryMs?: number;
  uploadMs?: number;
  fileBytes?: number;
  /** Wall time from load start to the first visible geometry. */
  firstGeometryMs?: number;
  /** Wall time for the whole load. */
  totalMs?: number;
}

export interface Viewer {
  /** Load a model from bytes or a URL. URL loads stream through the worker. */
  load(source: Uint8Array | LoadSource, options?: ViewerLoadOptions): Promise<LoadedModel>;
  /** Start booting the parser engine early so the first load skips the wait. */
  warmup(): void;
  /** Cancel the in-flight load, if any. */
  cancelLoad(): void;
  /** Drop the model on screen and every state derived from it. */
  unload(options?: { keepError?: boolean }): void;
  getStats(): ModelStats | null;
  /** Entity counts per IFC class, computed on first call and then cached. */
  getCountsByType(): Promise<Record<string, number>>;
  /** Native work schedules, task times, dependencies and product links. */
  getTaskGraph(): Promise<IfcTaskGraph>;
  /** Groups, layers, classifications and materials, merged across models. */
  getOrganizeIndex(): Promise<OrganizeIndex>;
  /** Grid axes as scene-space polylines with their bubble labels. */
  getGridAxes(): Promise<IfcGridInfo[]>;
  /** Show or hide the grid axes overlay; fetches the axes on first show. */
  setGridsVisible(on: boolean): Promise<void>;
  areGridsVisible(): boolean;
  /** Feature-edge line layer over the shading. */
  setEdgesVisible(on: boolean): void;
  areEdgesVisible(): boolean;
  // -- annotations: text notes anchored to the model ------------------------
  addAnnotation(state: Omit<AnnotationState, 'id'>): AnnotationState;
  updateAnnotation(id: number, patch: { text?: string; visible?: boolean }): boolean;
  removeAnnotation(id: number): void;
  getAnnotationStates(): AnnotationState[];
  setAnnotationStates(states: AnnotationState[]): void;
  /** Increments when notes are added, edited or removed. */
  getAnnotationRevision(): number;
  onAnnotationChange(listener: () => void): () => void;
  getLoadTimeline(): LoadTimeline | null;
  getSceneInfo(): SceneInfo;
  getSpatialTree(): SpatialNode | null;
  getProperties(expressID: number): Promise<ItemProperties | null>;
  /** Select an element: highlight + notify subscribers. null clears. */
  select(expressID: number | null): void;
  /** Multi-selection: a click replaces, Ctrl-click toggles, panels can add. */
  selectMany(expressIDs: Iterable<number>, mode?: SelectMode): void;
  toggleSelect(expressID: number): void;
  clearSelection(): void;
  /** The element panels show; the last one touched. */
  getSelection(): number | null;
  getSelectedIds(): number[];
  /** Subscribe to selection changes; returns an unsubscribe function. */
  onSelectionChange(listener: (expressID: number | null) => void): () => void;
  /** Subscribe to model-loaded events; returns an unsubscribe function. */
  onModelLoaded(listener: () => void): () => void;
  /** Subscribe to visibility changes (hide/isolate/show all/categories). */
  onVisibilityChange(listener: () => void): () => void;
  /** Visibility. */
  hideSelected(): void;
  isolateSelected(): void;
  /** Show only these; replaces what was kept. `label` names it in the UI. */
  isolate(expressIDs: number[], label?: string): void;
  setHidden(expressIDs: number[], hidden: boolean): void;
  showAll(): void;
  /** Named, removable visibility rules. Keeps union, hides subtract. */
  addRule(rule: Omit<VisibilityRule, "id">): VisibilityRule;
  removeRule(id: string): void;
  getRules(): VisibilityRule[];
  clearRules(): void;
  /** Elements hidden one at a time, rather than by a rule. */
  getHiddenCount(): number;
  getHiddenIds(): number[];

  /** Hidden elements stay on screen as a faint hatch instead of vanishing. */
  setGhostHidden(on: boolean): void;
  isGhostHidden(): boolean;

  /**
   * Colour elements by rule. `assignment` maps an expressID to a 1-based index
   * into `colors` (0-255 RGB triples); anything absent keeps its own colour.
   */
  setColorOverride(assignment: Map<number, number>, colors: Array<[number, number, number]>): void;
  clearColorOverride(): void;
  hasColorOverride(): boolean;

  /** Step back and forward through hide, isolate and show-all. */
  undoVisibility(): boolean;
  redoVisibility(): boolean;
  canUndoVisibility(): boolean;
  canRedoVisibility(): boolean;
  setSubtreeVisible(expressID: number, visible: boolean): void;
  isSubtreeVisible(expressID: number): boolean;
  toggleSubtreeVisible(expressID: number): void;
  /** Elements with geometry under a spatial node; the unit filters work on. */
  getSubtreeElementIds(expressID: number): number[];
  /** expressID to IFC class for everything with geometry. */
  getElementTypes(): Map<number, string>;
  /** How much of the model hide/isolate is currently keeping off screen. */
  getVisibilityCounts(): { total: number; hidden: number };
  /** Whether this element has geometry in the scene, and whether it is drawn. */
  hasGeometry(expressID: number): boolean;
  /** World AABB of one element, in viewport coordinates. Null without geometry. */
  getElementBounds(expressID: number): ModelBounds | null;
  /**
   * The CPU-side triangles kept as the model streamed in, for analysis that
   * needs real surfaces rather than boxes. The clash engine reads it.
   */
  getTriangles(): TriangleStore;
  /** Offset subtracted from IFC coordinates to keep large models precise. */
  getModelOrigin(): [number, number, number];
  isElementVisible(expressID: number): boolean;
  /** Lazy categories (spaces/openings), hidden by default. Resolves when loaded. */
  setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void>;
  isCategoryVisible(category: LazyCategory): boolean;
  /** Performance HUD visibility. */
  setPerfHud(visible: boolean): void;
  /** Skip instanced entries smaller than this on screen; 0 draws everything. */
  setLodThreshold(pixels: number): void;
  getLodThreshold(): number;
  /** Instanced entries the last frame skipped as too small to see. */
  getLodCulled(): number;
  /** Re-read the host's theme variables and recolor the viewport. */
  updateTheme(): void;
  /** Light the model from a real sun direction; null restores the neutral rig. */
  setSun(direction: [number, number, number] | null): void;
  getSun(): [number, number, number] | null;
  /** Draw a scan as points, in scene coordinates. Null clears it. */
  setPointCloud(positions: Float32Array | null, colors?: Float32Array | null, size?: number): void;
  setPointCloudSize(size: number): void;
  setPointCloudVisible(visible: boolean): void;
  hasPointCloud(): boolean;
  fitToModel(): CameraPose;
  fitToElement(expressID: number): CameraPose | null;
  /** Frame an arbitrary point, such as where two elements collide. */
  fitToPoint(point: [number, number, number], radius?: number): CameraPose;
  /** Frame the model from a preset direction. */
  viewFrom(view: ViewPreset): void;
  /** Camera projection; toggling keeps the current framing. */
  setProjection(mode: ProjectionMode): void;
  getProjection(): ProjectionMode;
  /** Orbit the view about the world up axis by this many degrees. */
  rotateView(degrees: number): void;
  /** First-person flight: WASD moves, Q/E is down and up, wheel sets speed. */
  setFlyMode(on: boolean): void;
  isFlyMode(): boolean;
  /** Fires when flight starts or stops, whatever caused it. */
  onFlyChange(listener: (on: boolean) => void): () => void;
  /** Draw these elements see-through (screen-door), keeping them pickable. */
  setXray(expressIDs: Iterable<number>, on: boolean): void;
  /** Everything visible except these ids becomes see-through. */
  xrayAllExcept(expressIDs: Iterable<number>): void;
  clearXray(): void;
  getXrayCount(): number;
  isElementXray(expressID: number): boolean;
  /** When on, clicks and snaps skip see-through elements. */
  setPickIgnoreXray(on: boolean): void;
  getPickIgnoreXray(): boolean;
  /** Draw the selection through occluders in a faint overlay pass. */
  setShowThroughSelection(on: boolean): void;
  getShowThroughSelection(): boolean;
  // -- display offsets: storey slide, explode, move selection ---------------
  /** Add a delta to the display offset of these elements. */
  offsetElements(expressIDs: Iterable<number>, delta: [number, number, number]): void;
  /** Absolute per-element offsets, as viewpoints and the slide tools write. */
  setElementOffsetEntries(entries: Array<[number, [number, number, number]]>): void;
  /** Clear all offsets, or only the given elements' offsets. */
  clearElementOffsets(expressIDs?: Iterable<number>): void;
  hasElementOffsets(): boolean;
  getElementOffsets(): Array<[number, [number, number, number]]>;
  /** Pull storeys apart along an axis; spacing 0 puts them back. */
  setStoreySlide(axis: 'x' | 'y' | 'z', spacing: number): void;
  /** Radial explode by factor; 0 puts everything back. */
  setExplode(factor: number): void;
  /**
   * Face the last-picked surface head on, keeping the orbit distance. True
   * when a face normal was used; false means it fell back to the nearest axis.
   */
  viewPerpendicular(): boolean;
  /** Axis-aligned section plane; replaces whatever is active. */
  setSection(state: SectionState): void;
  /** Any combination of the three axes at once (empty clears). */
  setSections(states: SectionState[]): void;
  getSections(): SectionState[];
  /** Fires when a viewport handle drag moved a plane. */
  onSectionChange(listener: () => void): () => void;
  clearSection(): void;
  getSection(): SectionState | null;
  /** Cut on the last-picked face; null when nothing was picked or no normal. */
  addSectionFromPick(name?: string): PlaneSectionState | null;
  /** Look at a section plane head on from its kept side. */
  viewAlongSection(key: string): boolean;
  removeSection(key: string): void;
  renameSection(key: string, name: string): void;
  // -- federation ------------------------------------------------------------
  /** Open a model beside the ones already loaded, rather than replacing them. */
  addModel(source: Uint8Array | LoadSource, options?: ViewerLoadOptions): Promise<FederatedModel>;
  /** Drop one model and everything pointing at its elements. */
  unloadModel(index: number): void;
  getModels(): FederatedModel[];
  setModelVisible(index: number, visible: boolean): void;
  isModelVisible(index: number): boolean;
  /** Nudge one model, for files that disagree about the shared origin. */
  setModelTransform(index: number, offset: [number, number, number]): void;
  getModelTransform(index: number): [number, number, number];
  /** Full affine placement recorded for automatic or manual federation. */
  setModelPlacement(index: number, transform: ModelTransform): void;
  getModelPlacement(index: number): ModelTransform;
  /** Re-run compatibility checks and align every model with a shared CRS. */
  alignGeospatialModels(): number;
  getGeoAnchor(): number | null;
  sceneToGeoreferenced(point: [number, number, number]): GeoreferencedPoint | null;
  georeferencedToScene(point: [number, number, number]): [number, number, number] | null;

  /** Six planes at once. Replaces any per-axis section, and vice versa. */
  setSectionBox(box: SectionBox | null): void;
  getSectionBox(): SectionBox | null;
  /** The model's full extent, i.e. the box before the user narrows it. */
  getModelBox(): SectionBox;
  /** A padded box around these elements, or null when none has geometry. */
  boxAround(expressIDs: number[], pad?: number): SectionBox | null;
  /** Floorplan inset in the corner of the viewport; follows the section. */
  setPlanView(on: boolean): void;
  isPlanView(): boolean;
  /** What the tool collects: a span, an angle, or a closed ring. */
  setMeasureMode(mode: MeasureMode): void;
  getMeasureMode(): MeasureMode;
  /** Finished angles and areas, oldest first. */
  getShapeMeasures(): ShapeMeasure[];
  /** Points placed toward the shape in hand. */
  getPendingPoints(): Array<[number, number, number]>;
  /** Close the ring being drawn. False when there are not yet three points. */
  closeArea(): boolean;
  /** Finish the open path being drawn. False before two points exist. */
  finishPath(): boolean;
  removeShapeMeasure(id: number): void;
  /** Every placed distance, path, angle, area and coordinate, oldest first. */
  getMeasurementObjects(): MeasurementObject[];
  /** Change first-class metadata without recreating witness geometry. */
  updateMeasurement(id: number, patch: MeasurementUpdate): boolean;
  /** One render for a bulk visibility change. */
  setMeasurementsVisible(ids: Iterable<number>, visible: boolean): number;
  /** Remove an object regardless of its geometry kind. */
  removeMeasurementObject(id: number): void;
  /** Frame an object's witness geometry while retaining the current view direction. */
  focusMeasurement(id: number): boolean;
  /** Spans plus finished shapes, for anything that reports what is placed. */
  getMeasureCount(): number;

  /** Two-click distance measurement; returns the new mode state. */
  toggleMeasure(): boolean;
  setMeasuring(on: boolean): void;
  isMeasuring(): boolean;
  /** Which geometry features a measured point is pulled onto. */
  setSnapMode(mode: SnapMode): void;
  getSnapMode(): SnapMode;
  /** Axis or picked-surface constraint applied after snapping and switchable mid-measure. */
  setMeasureConstraint(constraint: MeasureConstraint): void;
  getMeasureConstraint(): MeasureConstraint;
  /** Display-only units and precision; geometry always remains metres. */
  setMeasurementFormat(format: MeasurementFormat): void;
  getMeasurementFormat(): MeasurementFormat;
  /** The span in hand, or the last placed one; null before the first point. */
  getMeasurement(): Measurement | null;
  /** Every placed span, oldest first. Spans stack until reset or removed. */
  getMeasurements(): Measurement[];
  /** Serializable span geometry for viewpoints and extension-owned workflows. */
  getMeasurementStates(): MeasurementState[];
  /** Replace placed distance spans from a saved view. */
  setMeasurementStates(states: MeasurementState[]): void;
  /** Increments only when placed objects or their metadata change, not on hover. */
  getMeasurementRevision(): number;
  /** Add a host-generated span, such as a geometry-query witness line. */
  addMeasurement(
    a: [number, number, number],
    b: [number, number, number],
    ends?: [SnapKind, SnapKind],
  ): Measurement;
  /** Remove one placed span by its id. */
  removeMeasurement(id: number): void;
  /** Drop every span and the point in hand without leaving measure mode. */
  resetMeasure(): void;
  /**
   * Take back the last measure step: the point in hand first, then the most
   * recently placed object. Backspace calls this while the tool is active.
   */
  undoLastMeasurement(): boolean;
  /** Fires when the measurement, the snap mode or the tool state changed. */
  onMeasureChange(listener: () => void): () => void;
  /** Render and download the viewport as a PNG. */
  screenshot(): void;
  /** Render the viewport to an image, optionally downscaled. */
  captureImage(maxWidth?: number, type?: string, quality?: number): Promise<Blob | null>;
  /** The 2D plan alone, square, at its own resolution. Null when it is off. */
  capturePlanImage(size?: number, type?: string, quality?: number): Promise<Blob | null>;
  /**
   * A live video stream of the viewport, for recording a walkthrough. Null in
   * a browser without captureStream. The caller owns stopping it.
   */
  captureStream(fps?: number): MediaStream | null;
  // -- immersive review ------------------------------------------------------
  /** Whether this browser and headset can run the mode at all. */
  xrSupported(mode: XrMode): Promise<boolean>;
  /** Enter VR or AR. Must be called from a user gesture. */
  startXr(mode: XrMode): Promise<void>;
  exitXr(): Promise<void>;
  xrMode(): XrMode | null;
  onXrChange(listener: (mode: XrMode | null) => void): () => void;
  /** Save the plan as a PNG; false when there is no plan to save. */
  downloadPlan(name?: string): Promise<boolean>;
  /** Performance settings. */
  setRenderScale(scale: number): void;
  setAdaptiveResolution(on: boolean): void;
  setDoubleSided(on: boolean): void;
  getRenderTiming(): { lastMs: number; rendersLastSecond: number };
  /** Fires after every render pass; for status readouts. */
  onRenderTick(listener: () => void): () => void;
  pickAt(clientX: number, clientY: number): PickResult | null;
  /** Last surface selected by a real viewport click, not a scripted selection. */
  getLastPick(): PickResult | null;
  /** Precision hover feedback for extension-owned face, edge and vertex picks. */
  setPickGuide(on: boolean): void;
  getCamera(): CameraPose;
  getViewport(): { width: number; height: number; aspect: number };
  /** Drawing-buffer scale; below 1 only transiently during slow interaction. */
  getResolutionScale(): number;
  /** Live GPU resource counts (for leak detection). */
  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number };
  setCamera(pose: CameraPose): void;
  resize(width: number, height: number): void;
  render(): void;
  isReady(): boolean;
  /** True while a load or an add is still streaming. */
  isLoading(): boolean;
  dispose(): void;
}

/** Minimum ms between renders while mesh batches stream in. */
const PROGRESSIVE_RENDER_INTERVAL = 150;
/** Elements whose properties stay resident; selection revisits are common. */
const PROPS_CACHE_SIZE = 200;
/** What the cursor tag calls each snap result. */
const SNAP_LABEL: Record<SnapKind, string> = {
  vertex: 'Vertex',
  midpoint: 'Edge midpoint',
  edge: 'Edge',
  surface: 'Face',
};

/** Update the small flight table without parsing model-owned text as markup. */
export function updateFlyReadout(
  readout: HTMLElement,
  rows: readonly (readonly [label: string, value: string])[],
): void {
  const current = [...readout.children];
  const reusable =
    current.length === rows.length &&
    current.every((row, index) =>
      row.children.length === 2 &&
      row.firstElementChild?.tagName === 'SPAN' &&
      row.firstElementChild.textContent === rows[index][0] &&
      row.lastElementChild?.tagName === 'B',
    );
  if (!reusable) {
    const doc = readout.ownerDocument;
    readout.replaceChildren(
      ...rows.map(([label, value]) => {
        const row = doc.createElement('div');
        const name = doc.createElement('span');
        const output = doc.createElement('b');
        name.textContent = label;
        output.textContent = value;
        row.append(name, output);
        return row;
      }),
    );
    return;
  }
  rows.forEach(([, value], index) => {
    const output = current[index].lastElementChild!;
    if (output.textContent !== value) output.textContent = value;
  });
}

class ViewerImpl implements Viewer {
  private engine: AsyncIfcEngine | null = null;
  private readonly scene: SceneController;
  private readonly controls: ViewerControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly propertiesPanel: PropertiesPanel | null;
  private readonly treePanel: TreePanel | null;
  private readonly perfHud: PerfHud;
  private readonly axisGizmo: AxisGizmo;
  private readonly xr: XrController;
  private readonly loadingOverlay: LoadingOverlay | null;
  private readonly errorCard: ErrorCard;
  private initialized: Promise<AsyncIfcEngine> | null = null;
  /** Open models by slot index. Slot 0 is the one `load()` replaces. */
  private readonly models = new Map<number, ModelEntry>();
  private geoAnchor: number | null = null;
  /** Triangles kept for analysis; fed by every ingest, read by the clash engine. */
  private readonly triangles = new TriangleStore();
  private nextModelIndex = 0;
  private stats: ModelStats | null = null;
  private timeline: LoadTimeline | null = null;
  private ready = false;
  private loading = false;
  private loadToken = 0;
  private readonly selection = new Set<number>();
  private primary: number | null = null;
  private lastPick: PickResult | null = null;
  private pickGuide = false;
  /** Visibility layers: named rules plus elements hidden one at a time. */
  private rules: VisibilityRule[] = [];
  private readonly hiddenIds = new Set<number>();
  private ruleSeq = 0;
  private visPast: VisibilityStep[] = [];
  private visFuture: VisibilityStep[] = [];
  private cachedTree: SpatialNode | null = null;
  private measuring = false;
  /** Last hover answer, so the cursor class is written only when it changes. */
  private overHandle = false;
  /**
   * Placed spans, oldest first; they stack until removed or reset. A span with
   * a `shape` belongs to an angle or a ring and is drawn, not listed: it is the
   * shape's leg, so it is removed with the shape rather than on its own.
   * PENDING_SHAPE marks the legs of the shape still being placed.
   */
  private spans: MeasureSpanRecord[] = [];
  private visibleSpans: MeasureSpanRecord[] = [];
  private spanVersion = 0;
  private visibleSpanVersion = -1;
  private spanSeq = 0;
  /** Public ids are shared by every measurement kind, so ledger actions are unambiguous. */
  private measurementSeq = 0;
  private measurementRevision = 0;
  /** First point of the span in hand, if one is being placed. */
  private measureA: [number, number, number] | null = null;
  private measureAKind: SnapKind | null = null;
  private measureNormal: [number, number, number] | null = null;
  private measureMode: MeasureMode = 'distance';
  /** Points placed toward the angle or ring in hand. */
  private chain: Array<[number, number, number]> = [];
  private shapes: ShapeMeasure[] = [];
  private measureHover: SnapHit | null = null;
  /** True while the gesture that placed the first point is still running. */
  private measureOpening = false;
  private snapMode: SnapMode = 'auto';
  private measureConstraint: MeasureConstraint = 'free';
  private measurementFormat: MeasurementFormat = {
    ...DEFAULT_MEASUREMENT_FORMAT,
    precision: { ...DEFAULT_MEASUREMENT_FORMAT.precision },
  };
  private hoverPending: [number, number] | null = null;
  private hoverAt: [number, number] | null = null;
  private hoverFrame = 0;
  /** One distance label per drawn span, pooled like the scene's markers. */
  private readonly spanLabels: HTMLElement[] = [];
  private snapTag: HTMLElement | null = null;
  private readonly measureListeners = new Set<() => void>();
  private planFrame: HTMLElement | null = null;
  private planSize = 0;
  private sections: SectionState[] = [];
  private box: SectionBox | null = null;
  private drag: { key: string; grabbed: number; base: number } | null = null;
  private planeSeq = 0;
  private gridsOn = false;
  private readonly gridLabels: HTMLElement[] = [];
  private flyPanel: HTMLElement | null = null;
  private flyReadout: HTMLElement | null = null;
  private storeyBands: StoreyBand[] = [];
  private slideEntries: Array<[number, [number, number, number]]> = [];
  private explodeEntries: Array<[number, [number, number, number]]> = [];
  private readonly manualOffsets = new Map<number, [number, number, number]>();
  private annotations: Array<Required<Pick<AnnotationState, 'id' | 'text' | 'at' | 'visible'>> & Pick<AnnotationState, 'elementId' | 'createdAt'>> = [];
  private annotationSeq = 0;
  private annotationRevision = 0;
  private readonly noteLabels: HTMLElement[] = [];
  private readonly annotationListeners = new Set<() => void>();
  private readonly sectionListeners = new Set<() => void>();
  private readonly loadedCategories = new Set<LazyCategory>();
  private readonly selectionListeners = new Set<(expressID: number | null) => void>();
  private readonly modelLoadedListeners = new Set<() => void>();
  private readonly renderTickListeners = new Set<() => void>();
  private readonly visibilityListeners = new Set<() => void>();
  /** Per-model lookups: both are O(n) to build and hot in the tree panel. */
  private nodeIndex: Map<number, SpatialNode> | null = null;
  private readonly subtreeCache = new Map<number, number[]>();
  /** Per-branch visibility, dropped whenever visibility moves. */
  private readonly subtreeVisible = new Map<number, boolean>();
  private readonly propsCache = new Map<number, ItemProperties | null>();

  constructor(
    private readonly container: HTMLElement,
    private readonly options: ViewerOptions,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.style.display = 'block';
    this.canvas.style.width = '100%';
    this.canvas.style.height = '100%';
    this.canvas.tabIndex = 0;
    this.container.appendChild(this.canvas);

    this.scene = new SceneController(this.canvas, {
      background: options.background ?? 0x1e1e1e,
      antialias: options.antialias,
    });
    this.xr = new XrController({
      renderer: this.scene.renderer,
      draw: () => this.scene.render(),
      // Standing on the floor of the model, under the point the camera was
      // looking at, rather than at a scene origin that may be far outside it.
      standAt: () => {
        const pose = this.controls.getPose();
        const bounds = this.scene.getBounds();
        return [pose.target[0], bounds.min.y, pose.target[2]];
      },
      setPresenting: (on) => this.scene.setPresenting(on),
    });
    this.controls = new ViewerControls(this.scene, this.container, () => this.scene.render(), {
      // Ctrl/Cmd/Shift-click adds to or removes from the selection; a plain
      // click replaces it, and clicking nothing clears it.
      // Measuring owns the left button: it needs the exact point, not the
      // element, so the id pass never runs. Two clicks and one press-drag
      // place the same span, whichever way the user reaches for it.
      onToolDown: (clientX, clientY) => {
        if (!this.measuring) return false;
        this.measureDown(clientX, clientY);
        return true;
      },
      onToolMove: (clientX, clientY) => this.queueMeasureHover(clientX, clientY),
      onToolUp: (clientX, clientY, moved) => this.measureUp(clientX, clientY, moved),
      onToolKey: (key) => {
        if (!this.measuring) return false;
        if (key === 'x' || key === 'y' || key === 'z') {
          this.setMeasureConstraint(this.measureConstraint === key ? 'free' : key);
          return true;
        }
        if (key === 'p' || key === 'l') {
          const constraint: MeasureConstraint = key === 'p' ? 'perpendicular' : 'parallel';
          this.setMeasureConstraint(this.measureConstraint === constraint ? 'free' : constraint);
          return true;
        }
        if (key === '0') {
          this.setMeasureConstraint('free');
          return true;
        }
        if (key === 'enter' && this.measureMode === 'path') return this.finishPath();
        if (key === 'backspace') return this.undoLastMeasurement();
        return false;
      },
      onPick: (pick, additive, clientX, clientY) => {
        const close = this.hoverAt
          && Math.hypot(this.hoverAt[0] - clientX, this.hoverAt[1] - clientY) <= 3;
        const guided = this.pickGuide ? (close ? this.measureHover : this.probe(clientX, clientY)) : null;
        const selectedId = guided?.expressID ?? pick?.expressID;
        this.lastPick = selectedId && (guided || pick) ? {
          expressID: selectedId,
          point: [...(guided?.point ?? pick?.point ?? [0, 0, 0])],
          ...(guided ? { kind: guided.kind } : {}),
        } : null;
        if (!selectedId) return additive ? undefined : this.clearSelection();
        this.selectMany([selectedId], additive ? 'toggle' : 'replace');
      },
      // Escape drops the span in hand first, and only then the tool itself.
      onEscape: () => {
        if (!this.measuring) return this.clearSelection();
        // Escape drops the shape in hand first, then leaves the tool, so a
        // misplaced point never costs the whole session.
        if (this.chain.length) {
          this.dropPending();
          return this.pushMeasure();
        }
        if (this.measureA) return this.cancelPending();
        this.setMeasuring(false);
      },
      onHide: () => this.hideSelected(),
      onIsolate: () => this.isolateSelected(),
      onShowAll: () => this.showAll(),
      // Grabbing anywhere on the arrow drags from that point, so the plane
      // never jumps to the cursor on mouse-down.
      onHandleDown: (x, y) => {
        const key = this.scene.pickSectionHandle(x, y);
        const section = key === null ? undefined : this.sections.find((s) => sectionKey(s) === key);
        if (key === null || !section) return false;
        const normal = isAxisSection(section) ? AXIS_NORMAL[section.axis] : section.normal;
        const grabbed = this.scene.dragSectionOffset(normal, x, y);
        if (grabbed === null) return false;
        this.drag = { key, grabbed, base: section.offset };
        this.container.classList.add('ifc-dragging-section');
        return true;
      },
      onHandleDrag: (x, y) => {
        if (!this.drag) return;
        const section = this.sections.find((s) => sectionKey(s) === this.drag?.key);
        if (!section) return;
        const normal = isAxisSection(section) ? AXIS_NORMAL[section.axis] : section.normal;
        const now = this.scene.dragSectionOffset(normal, x, y);
        if (now === null) return;
        const offset = this.scene.clampSectionOffset(normal, this.drag.base + (now - this.drag.grabbed));
        this.setSections(
          this.sections.map((s) => (sectionKey(s) === this.drag?.key ? { ...s, offset } : s)),
        );
      },
      onHandleUp: () => {
        this.drag = null;
        this.container.classList.remove('ifc-dragging-section');
      },
      onHover: (x, y, clientX, clientY) => {
        const over = this.scene.pickSectionHandle(x, y) !== null;
        // Only touch the DOM when the answer changed. Writing the same class
        // on every move invalidates style, and the next move's rect read then
        // forces a full layout: one recalc per mouse move for nothing.
        if (over !== this.overHandle) {
          this.overHandle = over;
          this.container.classList.toggle('ifc-over-handle', over);
        }
        if (this.measuring || this.pickGuide) this.queueMeasureHover(clientX, clientY);
      },
      onCameraChange: () => {
        const at = this.hoverAt;
        this.hoverAt = null;
        if (at && (this.measuring || this.pickGuide)) this.queueMeasureHover(at[0], at[1]);
      },
    });
    // A live accessor rather than the camera itself: the projection toggle
    // swaps the active camera, and the gizmo must follow the one on screen.
    const sceneRef = this.scene;
    this.axisGizmo = new AxisGizmo(
      this.container,
      { get matrixWorld() { return sceneRef.camera.matrixWorld; } },
      {
        getPose: () => this.controls.getPose(),
        setPose: (pose) => this.controls.setPose(pose),
      },
    );
    this.scene.onAfterRender = () => {
      this.axisGizmo.sync();
      this.syncMeasureOverlay();
      this.syncGridOverlay();
      this.syncAnnotationOverlay();
      this.syncPlanFrame();
      this.syncFlyPanel();
      for (const listener of this.renderTickListeners) listener();
    };

    const panels = options.panels ?? {};
    this.propertiesPanel = panels.properties ? new PropertiesPanel(panels.properties, this) : null;
    this.treePanel = panels.tree ? new TreePanel(panels.tree, this) : null;
    this.perfHud = new PerfHud(this.container, {
      getRendererInfo: () => this.scene.getRendererInfo(),
      getRenderTiming: () => this.scene.getRenderTiming(),
      getResolutionScale: () => this.scene.getResolutionScale(),
      getLoadTimeline: () => this.timeline,
    });
    // Overlays mount independently of the side panels. The progress card is
    // the one piece a host may already draw itself, and two cards reporting
    // one load is worse than either alone.
    this.loadingOverlay =
      options.progressCard === false ? null : new LoadingOverlay(this.container, () => this.cancelLoad());
    this.errorCard = new ErrorCard(this.container);

    this.updateTheme();
    this.resizeToContainer();
  }

  /**
   * Engine strategy: worker when a source is configured and Workers exist,
   * inline otherwise. A worker that fails to boot degrades to inline so the
   * viewer always works. The inline engine is a dynamic import: it pulls
   * web-ifc onto the main thread, which must stay out of the startup chunk.
   * Both variants are wrapped in the OPFS format cache.
   */
  private ensureInit(): Promise<AsyncIfcEngine> {
    if (!this.initialized) {
      // A rejected promise left in this slot would brick every later load with
      // the same stale error, so a failed boot is forgotten and can be retried.
      this.initialized = (async () => {
        let engine: AsyncIfcEngine | null = null;
        const workerOpts = this.options.worker;
        if (workerOpts !== false && workerOpts && typeof Worker !== 'undefined') {
          const workerEngine = new WorkerEngine({
            wasmPath: this.options.wasmPath,
            wasmAbsolute: this.options.wasmAbsolute ?? false,
            spawn: { url: workerOpts.url, factory: workerOpts.factory },
          });
          try {
            await workerEngine.init();
            engine = workerEngine;
          } catch (err) {
            console.warn('ifc-viewer: worker engine unavailable, using inline engine', err);
            workerEngine.terminate();
          }
        }
        if (!engine) {
          const { InlineEngine } = await import('./engine/inlineEngine.js');
          const inline = new InlineEngine({
            wasmPath: this.options.wasmPath,
            wasmAbsolute: this.options.wasmAbsolute ?? false,
          });
          await inline.init();
          engine = inline;
        }
        this.engine = new CachedEngine(engine);
        return this.engine;
      })().catch((err: unknown) => {
        this.initialized = null;
        throw err;
      });
    }
    return this.initialized;
  }

  warmup(): void {
    void this.ensureInit().catch(() => undefined);
  }

  private resizeToContainer(): void {
    const rect = this.container.getBoundingClientRect();
    this.scene.resize(rect.width || this.container.clientWidth, rect.height || this.container.clientHeight);
  }

  async load(source: Uint8Array | LoadSource, options: ViewerLoadOptions = {}): Promise<LoadedModel> {
    // Overlay first: the initial load pays the worker spawn and wasm compile,
    // which is otherwise dead time with no feedback.
    this.errorCard.hide();
    this.loadingOverlay?.show();
    let engine: AsyncIfcEngine;
    try {
      engine = await this.ensureInit();
    } catch (err) {
      this.loadingOverlay?.hide();
      this.errorCard.show(err instanceof Error ? err.message : String(err));
      throw err;
    }
    if (this.loading) {
      // A newer load supersedes the in-flight one.
      engine.cancel();
    }
    const token = ++this.loadToken;
    this.loading = true;
    this.ready = false;

    this.scene.setHighlighted([]);
    this.scene.clearModel();
    this.triangles.clear();
    // load() replaces: every federated model goes, and the next one starts
    // again at slot 0, where packed ids are the raw expressIDs.
    for (const entry of this.models.values()) engine.dispose(entry.modelID);
    this.models.clear();
    this.nextModelIndex = 0;
    this.geoAnchor = null;
    this.lastPick = null;
    if (this.selection.size) {
      this.selection.clear();
      this.primary = null;
      this.emitSelection();
    }
    // A new model starts unfiltered; rules point at ids that no longer exist.
    this.rules = [];
    this.hiddenIds.clear();
    this.visPast = [];
    this.visFuture = [];
    this.scene.clearColorOverride();

    this.loadedCategories.clear();
    this.cachedTree = null;
    this.nodeIndex = null;
    this.subtreeCache.clear();
    this.subtreeVisible.clear();
    this.propsCache.clear();
    this.stats = null;
    // The scene already dropped the clip planes; tell subscribers the section
    // is gone so anything following it (plan inset, chips) resets too.
    if (this.sections.length || this.box) {
      this.sections = [];
      this.box = null;
      this.emitSection();
    }
    this.setMeasuring(false);
    this.resetMeasure();
    this.resetAnnotations();
    this.resetGrids();
    this.resetArrange();
    this.syncMeasureOverlay();

    const normalized: LoadSource =
      source instanceof Uint8Array ? { kind: 'bytes', bytes: source } : source;

    const t0 = performance.now();
    const timeline: LoadTimeline = {};
    this.timeline = timeline;
    let uploadMs = 0;
    let firstBatch = true;
    let lastRender = 0;
    // Progressive renders skip transparent sorting; restored before the
    // final render below (and on error/cancel).
    this.scene.setStreamingMode(true);

    try {
      const meta = await engine.loadModel(normalized, {
        onProgress: (p) => {
          if (token !== this.loadToken) return;
          this.loadingOverlay?.update(p);
          options.onProgress?.(p);
        },
        onMeshBatch: (meshes) => {
          if (token !== this.loadToken) return;
          const u0 = performance.now();
          this.scene.addMeshes(meshes);
          this.triangles.add(meshes, 0);
          uploadMs += performance.now() - u0;
          if (firstBatch) {
            firstBatch = false;
            timeline.firstGeometryMs = performance.now() - t0;
            this.resizeToContainer();
            this.controls.fitToModel();
          }
          const t = performance.now();
          if (t - lastRender > PROGRESSIVE_RENDER_INTERVAL) {
            lastRender = t;
            this.scene.render();
          }
        },
      });
      if (token !== this.loadToken) throw new CancelledError();

      this.stats = { ...meta.stats, uploadMs };
      this.models.set(0, {
        index: 0,
        modelID: meta.modelID,
        name: options.name ?? 'Model',
        tree: meta.tree,
        stats: this.stats,
        categories: this.loadedCategories,
        geo: meta.geo,
      });
      this.alignGeospatialModels();
      this.nextModelIndex = 1;
      this.cachedTree = meta.tree;
      timeline.downloadMs = meta.stats.downloadMs;
      timeline.parseMs = meta.stats.parseMs;
      timeline.geometryMs = meta.stats.geometryMs;
      timeline.uploadMs = uploadMs;
      timeline.fileBytes = meta.stats.fileBytes;
      timeline.totalMs = performance.now() - t0;

      this.scene.setStreamingMode(false);
      this.resizeToContainer();
      this.controls.fitToModel();
      this.scene.render();
      this.loadingOverlay?.hide();
      this.ready = true;
      this.loading = false;
      for (const listener of this.modelLoadedListeners) listener();
      return {
        modelID: meta.modelID,
        meshes: [],
        bounds: meta.bounds,
        stats: this.stats,
        geo: meta.geo,
      };
    } catch (err) {
      if (token !== this.loadToken) throw err; // superseded; the newer load owns the UI
      this.scene.setStreamingMode(false);
      this.loading = false;
      this.loadingOverlay?.hide();
      if (err instanceof CancelledError) {
        // User cancel: clear the partial model, no error card.
        this.scene.clearModel();
        this.scene.render();
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      this.errorCard.show(message);
      throw err;
    }
  }

  cancelLoad(): void {
    if (this.loading) this.engine?.cancel();
  }

  // -- federation ------------------------------------------------------------
  /**
   * Add a model beside the ones already open, rather than replacing them.
   *
   * The new model takes the next slot, and every id it mints is packed with
   * that slot, so an expressID that exists in two files no longer collides.
   * Slot 0 packs to itself, which is why one open model is byte for byte what
   * it was before federation existed.
   *
   * Loads are serialised: the batcher shares one origin across models, and two
   * concurrent ingests would race to set it.
   */
  async addModel(source: Uint8Array | LoadSource, options: ViewerLoadOptions = {}): Promise<FederatedModel> {
    if (this.models.size === 0) {
      await this.load(source, options);
      return this.getModels()[0];
    }
    if (this.loading) throw new Error('another model is still loading');
    const engine = await this.ensureInit();
    const index = this.nextModelIndex++;
    const token = ++this.loadToken;
    this.loading = true;
    this.loadingOverlay?.show();
    this.scene.setStreamingMode(true);

    const normalized: LoadSource =
      source instanceof Uint8Array ? { kind: 'bytes', bytes: source } : source;
    let uploadMs = 0;
    try {
      const meta = await engine.loadModel(normalized, {
        onProgress: (p) => {
          if (token !== this.loadToken) return;
          this.loadingOverlay?.update(p);
          options.onProgress?.(p);
        },
        onMeshBatch: (meshes) => {
          if (token !== this.loadToken) return;
          const u0 = performance.now();
          this.scene.addMeshes(meshes, index);
          this.triangles.add(meshes, index);
          uploadMs += performance.now() - u0;
        },
      });
      if (token !== this.loadToken) throw new CancelledError();
      this.models.set(index, {
        index,
        modelID: meta.modelID,
        name: options.name ?? `Model ${index + 1}`,
        tree: meta.tree ? packTree(meta.tree, index) : null,
        stats: { ...meta.stats, uploadMs },
        categories: new Set(),
        geo: meta.geo,
      });
      this.alignGeospatialModels();
      this.afterModelSetChanged();
      this.scene.setStreamingMode(false);
      this.scene.render();
      this.loadingOverlay?.hide();
      this.loading = false;
      for (const listener of this.modelLoadedListeners) listener();
      return this.getModels().find((model) => model.index === index)!;
    } catch (err) {
      this.nextModelIndex = Math.max(this.nextModelIndex, index + 1);
      this.scene.removeModel(index);
      this.models.delete(index);
      this.scene.setStreamingMode(false);
      this.loading = false;
      this.loadingOverlay?.hide();
      if (token === this.loadToken && !(err instanceof CancelledError)) {
        this.errorCard.show(err instanceof Error ? err.message : String(err));
      }
      throw err;
    }
  }

  /** Drop one model. Unloading the last one leaves an empty viewer. */
  unloadModel(index: number): void {
    const entry = this.models.get(index);
    if (!entry) return;
    this.engine?.dispose(entry.modelID);
    this.scene.removeModel(index);
    this.triangles.dropModel(index);
    this.models.delete(index);
    if (this.geoAnchor === index) this.geoAnchor = null;
    // Anything pointing at its elements is stale the moment they are gone.
    for (const id of [...this.selection]) {
      if (modelOf(id) === index) this.selection.delete(id);
    }
    if (this.primary !== null && modelOf(this.primary) === index) this.primary = null;
    for (const id of [...this.hiddenIds]) {
      if (modelOf(id) === index) this.hiddenIds.delete(id);
    }
    this.rules = this.rules
      .map((rule) => ({ ...rule, ids: rule.ids.filter((id) => modelOf(id) !== index) }))
      .filter((rule) => rule.ids.length > 0);
    for (const id of [...this.propsCache.keys()]) {
      if (modelOf(id) === index) this.propsCache.delete(id);
    }
    this.slideEntries = this.slideEntries.filter(([id]) => modelOf(id) !== index);
    this.explodeEntries = this.explodeEntries.filter(([id]) => modelOf(id) !== index);
    for (const id of [...this.manualOffsets.keys()]) {
      if (modelOf(id) === index) this.manualOffsets.delete(id);
    }
    this.afterModelSetChanged();
    this.alignGeospatialModels();
    this.emitSelection();
    this.commitVisibility();
    for (const listener of this.modelLoadedListeners) listener();
  }

  getModels(): FederatedModel[] {
    const anchor = this.geoAnchor === null ? null : this.models.get(this.geoAnchor) ?? null;
    return [...this.models.values()]
      .sort((a, b) => a.index - b.index)
      .map((entry) => {
        const transform = this.scene.getModelPlacement(entry.index);
        const diagnostics = [...entry.geo.warnings];
        let geoStatus: FederatedModel['geoStatus'];
        if (transform.source === 'manual') geoStatus = 'manual';
        else if (!canTransform(entry.geo)) geoStatus = 'missing';
        else if (entry.index === this.geoAnchor) geoStatus = 'ready';
        else if (anchor && compatibleCrs(anchor.geo.projectedCrs, entry.geo.projectedCrs)) geoStatus = 'aligned';
        else {
          geoStatus = 'conflict';
          diagnostics.push('The projected CRS conflicts with the federation anchor.');
        }
        return {
          index: entry.index,
          name: entry.name,
          visible: this.scene.isModelVisible(entry.index),
          offset: [...transform.translation],
          transform,
          geo: entry.geo,
          geoStatus,
          diagnostics,
          elements: entry.stats?.meshCount ?? 0,
          triangles: entry.stats?.triangleCount ?? 0,
        };
      });
  }

  setModelVisible(index: number, visible: boolean): void {
    if (!this.models.has(index)) return;
    this.scene.setModelVisible(index, visible);
    this.commitVisibility();
  }

  isModelVisible(index: number): boolean {
    return this.scene.isModelVisible(index);
  }

  /** Nudge one model, for files that disagree about the shared origin. */
  setModelTransform(index: number, offset: [number, number, number]): void {
    if (!this.models.has(index)) return;
    const current = this.scene.getModelPlacement(index);
    this.scene.setModelPlacement(index, safeModelTransform({
      ...current,
      translation: offset,
      source: 'manual',
      recordedAt: new Date().toISOString(),
    }));
    this.commitVisibility();
  }

  getModelTransform(index: number): [number, number, number] {
    return this.scene.getModelPlacement(index).translation;
  }

  setModelPlacement(index: number, transform: ModelTransform): void {
    if (!this.models.has(index) || index === this.geoAnchor) return;
    this.scene.setModelPlacement(index, safeModelTransform(transform));
    this.commitVisibility();
  }

  getModelPlacement(index: number): ModelTransform {
    return this.scene.getModelPlacement(index);
  }

  alignGeospatialModels(): number {
    const entries = [...this.models.values()].sort((a, b) => a.index - b.index);
    const current = this.geoAnchor === null ? null : this.models.get(this.geoAnchor);
    const anchor = current && canTransform(current.geo)
      ? current
      : entries.find((entry) => canTransform(entry.geo)) ?? null;
    this.geoAnchor = anchor?.index ?? null;
    if (!anchor) return 0;
    let aligned = 0;
    for (const entry of entries) {
      const existing = this.scene.getModelPlacement(entry.index);
      if (entry.index === anchor.index) {
        this.scene.setModelPlacement(entry.index, { ...IDENTITY_MODEL_TRANSFORM, source: 'automatic' });
        continue;
      }
      if (existing.source === 'manual') continue;
      const engineering = relativeModelTransform(anchor.geo, entry.geo);
      // relativeModelTransform speaks the engineering frame (east, north,
      // height); the Y-up scene wants (east, height, -north). The rotation
      // is about the vertical in both frames and passes through unchanged.
      const transform = engineering
        ? {
            ...engineering,
            translation: [
              engineering.translation[0],
              engineering.translation[2],
              -engineering.translation[1],
            ] as [number, number, number],
          }
        : null;
      this.scene.setModelPlacement(entry.index, transform ?? IDENTITY_MODEL_TRANSFORM);
      if (transform) aligned += 1;
    }
    return aligned;
  }

  getGeoAnchor(): number | null {
    return this.geoAnchor;
  }

  sceneToGeoreferenced(point: [number, number, number]): GeoreferencedPoint | null {
    const anchor = this.geoAnchor === null ? null : this.models.get(this.geoAnchor);
    if (!anchor || !anchor.geo.projectedCrs) return null;
    const origin = this.getModelOrigin();
    // The map math works in the IFC Z-up frame; the Y-up scene point must
    // swizzle at this seam: local = (x, -z, y).
    const x = point[0] + origin[0];
    const y = point[1] + origin[1];
    const z = point[2] + origin[2];
    const coordinates = localToProjected([x, -z, y], anchor.geo);
    if (!coordinates) return null;
    return { crs: anchor.geo.projectedCrs.name ?? 'Unnamed projected CRS', coordinates };
  }

  georeferencedToScene(point: [number, number, number]): [number, number, number] | null {
    const anchor = this.geoAnchor === null ? null : this.models.get(this.geoAnchor);
    if (!anchor) return null;
    const local = projectedToLocal(point, anchor.geo);
    if (!local) return null;
    const origin = this.getModelOrigin();
    // Inverse of the seam above: Z-up local (e, n, h) lands at scene
    // (e, h, -n) before the origin shift comes off.
    return [local[0] - origin[0], local[2] - origin[1], -local[1] - origin[2]];
  }

  /**
   * Recompose everything derived from the set of open models: the tree the
   * panels walk, and every cache keyed on it.
   */
  private afterModelSetChanged(): void {
    const entries = [...this.models.values()].sort((a, b) => a.index - b.index);
    const trees = entries.filter((entry) => entry.tree).map((entry) => entry);
    if (trees.length === 0) this.cachedTree = null;
    else if (trees.length === 1) this.cachedTree = trees[0].tree;
    else {
      // A synthetic root over the per-model projects, so the tree panel walks
      // one structure and every node id still names its own model.
      this.cachedTree = {
        expressID: 0,
        type: 'IfcProjectLibrary',
        name: 'Federated models',
        children: trees.map((entry) => ({
          ...(entry.tree as SpatialNode),
          name: entry.name,
        })),
      };
    }
    this.nodeIndex = null;
    this.subtreeCache.clear();
    this.subtreeVisible.clear();
    this.stats = entries.reduce<ModelStats | null>((sum, entry) => {
      if (!entry.stats) return sum;
      if (!sum) return { ...entry.stats };
      return {
        ...sum,
        totalEntities: sum.totalEntities + entry.stats.totalEntities,
        meshCount: sum.meshCount + entry.stats.meshCount,
        triangleCount: sum.triangleCount + entry.stats.triangleCount,
      };
    }, null);
  }

  /**
   * Everything the load prologue resets, without a model to put back. The
   * parser engine stays warm, so the next open is still a fast one, and the
   * model-loaded listeners fire so panels rebuild from an empty viewer.
   */
  unload(options: { keepError?: boolean } = {}): void {
    this.loadToken += 1;
    if (this.loading) this.engine?.cancel();
    this.loading = false;
    this.ready = false;
    // A failed load unloads too, and its own card is the only explanation.
    if (!options.keepError) this.errorCard.hide();
    this.loadingOverlay?.hide();
    this.scene.setHighlighted([]);
    this.scene.clearModel();
    this.triangles.clear();
    for (const entry of this.models.values()) this.engine?.dispose(entry.modelID);
    this.models.clear();
    this.geoAnchor = null;
    this.nextModelIndex = 0;
    this.lastPick = null;
    if (this.selection.size) {
      this.selection.clear();
      this.primary = null;
      this.emitSelection();
    }
    this.rules = [];
    this.hiddenIds.clear();
    this.visPast = [];
    this.visFuture = [];
    this.loadedCategories.clear();
    this.cachedTree = null;
    this.nodeIndex = null;
    this.subtreeCache.clear();
    this.subtreeVisible.clear();
    this.propsCache.clear();
    this.stats = null;
    this.timeline = null;
    if (this.sections.length || this.box) {
      this.sections = [];
      this.box = null;
      this.emitSection();
    }
    this.setPlanView(false);
    this.setMeasuring(false);
    this.resetMeasure();
    this.resetAnnotations();
    this.resetGrids();
    this.syncMeasureOverlay();
    for (const listener of this.modelLoadedListeners) listener();
    this.commitVisibility();
  }

  getStats(): ModelStats | null {
    return this.stats;
  }

  async getCountsByType(): Promise<Record<string, number>> {
    if (this.stats?.countsByType) return this.stats.countsByType;
    const engine = this.engine;
    if (!engine || this.models.size === 0) return {};
    const token = this.loadToken;
    const each = await Promise.all(
      [...this.models.values()].map((entry) => engine.getCountsByType(entry.modelID)),
    );
    // Counts for the model that was open when this started say nothing about
    // the one that replaced it while it ran.
    if (token !== this.loadToken) return {};
    const counts: Record<string, number> = {};
    for (const one of each) {
      for (const [type, n] of Object.entries(one)) counts[type] = (counts[type] ?? 0) + n;
    }
    if (this.stats) this.stats.countsByType = counts;
    return counts;
  }

  async getTaskGraph(): Promise<IfcTaskGraph> {
    const engine = this.engine;
    if (!engine || this.models.size === 0) return { schedules: [], tasks: [], sequences: [] };
    const token = this.loadToken;
    const entries = [...this.models.values()];
    const each = await Promise.all(entries.map((entry) => engine.getTaskGraph(entry.modelID)));
    if (token !== this.loadToken) return { schedules: [], tasks: [], sequences: [] };
    const graph: IfcTaskGraph = { schedules: [], tasks: [], sequences: [] };
    entries.forEach((entry, index) => {
      const source = each[index];
      const pack = (id: number): number => packId(entry.index, id);
      graph.schedules.push(...source.schedules.map((schedule) => ({
        ...schedule,
        expressID: pack(schedule.expressID),
        taskIds: schedule.taskIds.map(pack),
        modelIndex: entry.index,
        modelName: entry.name,
      })));
      graph.tasks.push(...source.tasks.map((task) => ({
        ...task,
        expressID: pack(task.expressID),
        scheduleIds: task.scheduleIds.map(pack),
        parentTaskId: task.parentTaskId === null ? null : pack(task.parentTaskId),
        childTaskIds: task.childTaskIds.map(pack),
        productIds: task.productIds.map(pack),
        predecessorIds: task.predecessorIds.map(pack),
        successorIds: task.successorIds.map(pack),
        modelIndex: entry.index,
        modelName: entry.name,
      })));
      graph.sequences.push(...source.sequences.map((sequence) => ({
        ...sequence,
        expressID: pack(sequence.expressID),
        predecessorId: pack(sequence.predecessorId),
        successorId: pack(sequence.successorId),
        modelIndex: entry.index,
        modelName: entry.name,
      })));
    });
    return graph;
  }

  async getOrganizeIndex(): Promise<OrganizeIndex> {
    const empty: OrganizeIndex = { groups: [], layers: [], classifications: [], materials: [] };
    const engine = this.engine;
    if (!engine || this.models.size === 0) return empty;
    const token = this.loadToken;
    const entries = [...this.models.values()];
    const each = await Promise.all(entries.map((entry) => engine.getOrganizeIndex(entry.modelID)));
    if (token !== this.loadToken) return empty;
    const merged: OrganizeIndex = { groups: [], layers: [], classifications: [], materials: [] };
    const layerByName = new Map<string, number[]>();
    const classByKey = new Map<string, { system: string; code: string | null; ids: number[] }>();
    const materialByName = new Map<string, number[]>();
    entries.forEach((entry, index) => {
      const source = each[index];
      const pack = (id: number): number => packId(entry.index, id);
      // Groups stay distinct per entity; names collide legitimately.
      merged.groups.push(...source.groups.map((group) => ({
        ...group,
        expressID: pack(group.expressID),
        ids: group.ids.map(pack),
      })));
      // Layers, classifications and materials merge by name across models,
      // which is what an organize panel wants from a federation.
      for (const layer of source.layers) {
        const bucket = layerByName.get(layer.name) ?? [];
        bucket.push(...layer.ids.map(pack));
        layerByName.set(layer.name, bucket);
      }
      for (const item of source.classifications) {
        const key = `${item.system}|${item.code ?? ''}`;
        const bucket = classByKey.get(key) ?? { system: item.system, code: item.code, ids: [] };
        bucket.ids.push(...item.ids.map(pack));
        classByKey.set(key, bucket);
      }
      for (const material of source.materials) {
        const bucket = materialByName.get(material.name) ?? [];
        bucket.push(...material.ids.map(pack));
        materialByName.set(material.name, bucket);
      }
    });
    merged.layers = [...layerByName.entries()].map(([name, ids]) => ({ name, ids }));
    merged.classifications = [...classByKey.values()];
    merged.materials = [...materialByName.entries()].map(([name, ids]) => ({ name, ids }));
    return merged;
  }

  /**
   * Grid axes in scene space: model coordinates run through each model's
   * placement and the shared origin shift, the same map the meshes took.
   */
  async getGridAxes(): Promise<IfcGridInfo[]> {
    const engine = this.engine;
    if (!engine || this.models.size === 0) return [];
    const token = this.loadToken;
    const entries = [...this.models.values()];
    const each = await Promise.all(entries.map((entry) => engine.getGridAxes(entry.modelID)));
    if (token !== this.loadToken) return [];
    const origin = this.scene.getModelOrigin();
    const out: IfcGridInfo[] = [];
    entries.forEach((entry, index) => {
      const transform = this.scene.getModelPlacement(entry.index);
      // Same Y-up plan rotation the batcher applies to the model group.
      const cos = Math.cos(transform.rotationZ);
      const sin = Math.sin(transform.rotationZ);
      const s = transform.scale;
      const toScene = (x: number, y: number, z: number): [number, number, number] => [
        s * (cos * x + sin * z) + transform.translation[0] - origin[0],
        s * y + transform.translation[1] - origin[1],
        s * (-sin * x + cos * z) + transform.translation[2] - origin[2],
      ];
      for (const grid of each[index]) {
        out.push({
          expressID: packId(entry.index, grid.expressID),
          name: grid.name,
          axes: grid.axes.map((axis) => {
            const points: number[] = [];
            for (let i = 0; i + 2 < axis.points.length; i += 3) {
              points.push(...toScene(axis.points[i], axis.points[i + 1], axis.points[i + 2]));
            }
            return { ...axis, points };
          }),
        });
      }
    });
    return out;
  }

  async setGridsVisible(on: boolean): Promise<void> {
    this.gridsOn = on;
    if (!on) {
      this.scene.setGridAxes([]);
      this.syncGridOverlay();
      this.scene.render();
      return;
    }
    const grids = await this.getGridAxes();
    if (!this.gridsOn) return;
    const lines = grids.flatMap((grid) =>
      grid.axes.map((axis) => ({ label: axis.label, points: axis.points })),
    );
    this.scene.setGridAxes(lines);
    this.scene.render();
  }

  areGridsVisible(): boolean {
    return this.gridsOn;
  }

  private syncGridOverlay(): void {
    const axes = this.scene.getGridOverlay();
    const wanted: Array<{ text: string; at: [number, number, number] }> = [];
    for (const axis of axes) {
      if (!axis.label || axis.points.length < 6) continue;
      const last = axis.points.length - 3;
      wanted.push(
        { text: axis.label, at: [axis.points[0], axis.points[1], axis.points[2]] },
        { text: axis.label, at: [axis.points[last], axis.points[last + 1], axis.points[last + 2]] },
      );
    }
    while (this.gridLabels.length < wanted.length) {
      const node = this.container.ownerDocument.createElement('div');
      node.className = 'ifc-grid-bubble';
      this.container.appendChild(node);
      this.gridLabels.push(node);
    }
    this.gridLabels.forEach((node, index) => this.placeLabel(node, wanted[index] ?? null));
  }

  setEdgesVisible(on: boolean): void {
    this.scene.setEdges(on);
    this.scene.render();
  }

  areEdgesVisible(): boolean {
    return this.scene.isEdges();
  }

  // -- annotations ----------------------------------------------------------

  /**
   * Model-swap reset: clears state and scene dots WITHOUT notifying
   * listeners, or the dock would persist an empty list into the outgoing
   * model's storage key mid-load.
   */
  private resetAnnotations(): void {
    if (this.annotations.length === 0) return;
    this.annotations = [];
    this.annotationRevision += 1;
    this.scene.setAnnotations([]);
  }

  /** Grid axes belong to the model that authored them; a swap drops them. */
  private resetGrids(): void {
    if (!this.gridsOn) return;
    this.gridsOn = false;
    this.scene.setGridAxes([]);
  }

  private pushAnnotations(): void {
    this.scene.setAnnotations(
      this.annotations.filter((note) => note.visible).map((note) => note.at),
    );
    this.scene.render();
    for (const listener of this.annotationListeners) listener();
  }

  addAnnotation(state: Omit<AnnotationState, 'id'>): AnnotationState {
    const id = ++this.annotationSeq;
    const note = {
      id,
      text: (state.text ?? '').trim().replace(/\s+/g, ' ').slice(0, 200) || `Note ${id}`,
      at: [...state.at] as [number, number, number],
      visible: state.visible !== false,
      ...(typeof state.elementId === 'number' ? { elementId: state.elementId } : {}),
      createdAt: state.createdAt ?? new Date().toISOString(),
    };
    this.annotations.push(note);
    this.annotationRevision += 1;
    this.pushAnnotations();
    return { kind: 'note', ...note };
  }

  updateAnnotation(id: number, patch: { text?: string; visible?: boolean }): boolean {
    const note = this.annotations.find((entry) => entry.id === id);
    if (!note) return false;
    if (typeof patch.text === 'string') {
      const clean = patch.text.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (clean) note.text = clean;
    }
    if (typeof patch.visible === 'boolean') note.visible = patch.visible;
    this.annotationRevision += 1;
    this.pushAnnotations();
    return true;
  }

  removeAnnotation(id: number): void {
    const before = this.annotations.length;
    this.annotations = this.annotations.filter((entry) => entry.id !== id);
    if (this.annotations.length === before) return;
    this.annotationRevision += 1;
    this.pushAnnotations();
  }

  getAnnotationStates(): AnnotationState[] {
    return this.annotations.map((note) => ({ kind: 'note', ...note, at: [...note.at] as [number, number, number] }));
  }

  setAnnotationStates(states: AnnotationState[]): void {
    const point = (value: unknown): value is [number, number, number] =>
      Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    const used = new Set<number>();
    this.annotations = [];
    for (const state of states) {
      if (!state || typeof state !== 'object' || !point(state.at)) continue;
      const text = typeof state.text === 'string' ? state.text.trim().slice(0, 200) : '';
      if (!text) continue;
      let id = Number.isInteger(state.id) && state.id! > 0 && !used.has(state.id!) ? state.id! : 0;
      if (id) this.annotationSeq = Math.max(this.annotationSeq, id);
      else while (used.has(++this.annotationSeq)) { /* claim the next free id */ }
      if (!id) id = this.annotationSeq;
      used.add(id);
      this.annotations.push({
        id,
        text,
        at: [state.at[0], state.at[1], state.at[2]],
        visible: state.visible !== false,
        ...(typeof state.elementId === 'number' ? { elementId: state.elementId } : {}),
        ...(typeof state.createdAt === 'string' ? { createdAt: state.createdAt } : {}),
      });
    }
    this.annotationRevision += 1;
    this.pushAnnotations();
  }

  getAnnotationRevision(): number {
    return this.annotationRevision;
  }

  onAnnotationChange(listener: () => void): () => void {
    this.annotationListeners.add(listener);
    return () => this.annotationListeners.delete(listener);
  }

  private syncAnnotationOverlay(): void {
    const wanted = this.annotations.filter((note) => note.visible);
    while (this.noteLabels.length < wanted.length) {
      const node = this.container.ownerDocument.createElement('div');
      node.className = 'ifc-note-label';
      this.container.appendChild(node);
      this.noteLabels.push(node);
    }
    this.noteLabels.forEach((node, index) => {
      const note = wanted[index];
      this.placeLabel(node, note ? { text: note.text, at: note.at } : null);
    });
  }

  getLoadTimeline(): LoadTimeline | null {
    return this.timeline;
  }

  getSceneInfo(): SceneInfo {
    return this.scene.getSceneInfo();
  }

  getSpatialTree(): SpatialNode | null {
    return this.cachedTree;
  }

  /** Cached: the status bar, the panel and the assistant all ask for the same
   *  element, and every miss is a worker round trip. */
  async getProperties(expressID: number): Promise<ItemProperties | null> {
    if (!this.engine) return null;
    // The id names its own model, so a #1234 in the services file is never
    // answered by the #1234 in the architecture file.
    const entry = this.models.get(modelOf(expressID));
    if (!entry) return null;
    const hit = this.propsCache.get(expressID);
    if (hit !== undefined) return hit;
    const token = this.loadToken;
    let props: ItemProperties | null;
    try {
      props = await this.engine.getItemProperties(entry.modelID, expressOf(expressID));
    } catch {
      props = null;
    }
    // A request issued against the previous model resolves after the switch;
    // caching it would answer for an id that belongs to a different file now.
    if (token !== this.loadToken) return null;
    if (this.propsCache.size >= PROPS_CACHE_SIZE) {
      this.propsCache.delete(this.propsCache.keys().next().value as number);
    }
    this.propsCache.set(expressID, props);
    return props;
  }

  /**
   * Selection is a set, and every entry point says how it combines:
   * 'replace' (a plain click), 'add', 'remove' or 'toggle' (Ctrl-click).
   * The last element touched stays the primary one, which is what the
   * properties panel reads and what the tree scrolls to.
   */
  selectMany(expressIDs: Iterable<number>, mode: SelectMode = 'replace'): void {
    const incoming = [...expressIDs];
    if (mode === 'replace') this.selection.clear();
    let primary = this.primary;
    for (const id of incoming) {
      const inside = this.selection.has(id);
      if (mode === 'remove' || (mode === 'toggle' && inside)) {
        this.selection.delete(id);
        if (primary === id) primary = null;
      } else {
        this.selection.add(id);
        primary = id;
      }
    }
    if (primary === null || !this.selection.has(primary)) {
      // Keep a primary while anything is selected: panels need something to show.
      primary = this.selection.size ? [...this.selection][this.selection.size - 1] : null;
    }
    this.primary = primary;
    this.scene.setHighlighted(this.selection);
    this.scene.render();
    this.emitSelection();
  }

  select(expressID: number | null): void {
    if (expressID === null) return this.clearSelection();
    if (this.selection.size === 1 && this.primary === expressID) return;
    this.selectMany([expressID], 'replace');
  }

  toggleSelect(expressID: number): void {
    this.selectMany([expressID], 'toggle');
  }

  clearSelection(): void {
    if (this.selection.size === 0) return;
    this.selection.clear();
    this.primary = null;
    this.scene.setHighlighted(this.selection);
    this.scene.render();
    this.emitSelection();
  }

  getSelection(): number | null {
    return this.primary;
  }

  getSelectedIds(): number[] {
    return [...this.selection];
  }

  onSelectionChange(listener: (expressID: number | null) => void): () => void {
    this.selectionListeners.add(listener);
    return () => this.selectionListeners.delete(listener);
  }

  onModelLoaded(listener: () => void): () => void {
    this.modelLoadedListeners.add(listener);
    return () => this.modelLoadedListeners.delete(listener);
  }

  onVisibilityChange(listener: () => void): () => void {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  private emitSelection(): void {
    for (const listener of this.selectionListeners) listener(this.primary);
  }

  /** Render and tell subscribers (the tree repaints its eye toggles). */
  private commitVisibility(): void {
    // Cleared before the listeners run, since they immediately re-read it.
    this.subtreeVisible.clear();
    this.scene.render();
    for (const listener of this.visibilityListeners) listener();
  }

  // -- visibility ---------------------------------------------------------
  /** expressIDs in the subtree rooted at `expressID` that have geometry. */
  private subtreeElementIds(expressID: number): number[] {
    const cached = this.subtreeCache.get(expressID);
    if (cached) return cached;
    const node = this.findNode(expressID);
    let ids: number[];
    if (!node) {
      ids = this.scene.hasElement(expressID) ? [expressID] : [];
    } else {
      ids = [];
      const walk = (n: SpatialNode): void => {
        if (this.scene.hasElement(n.expressID)) ids.push(n.expressID);
        n.children.forEach(walk);
      };
      walk(node);
    }
    this.subtreeCache.set(expressID, ids);
    return ids;
  }

  /** One pass over the tree, then constant-time lookups for its lifetime. */
  private findNode(expressID: number): SpatialNode | null {
    if (!this.cachedTree) return null;
    if (!this.nodeIndex) {
      this.nodeIndex = new Map();
      const walk = (n: SpatialNode): void => {
        this.nodeIndex!.set(n.expressID, n);
        n.children.forEach(walk);
      };
      walk(this.cachedTree);
    }
    return this.nodeIndex.get(expressID) ?? null;
  }

  /** Every selected element's subtree, which is what the verbs below act on. */
  private selectedElementIds(): number[] {
    const ids = new Set<number>();
    for (const id of this.selection) for (const child of this.subtreeElementIds(id)) ids.add(child);
    return [...ids];
  }

  /**
   * One place decides what is on screen, from three layers:
   *   keep rules  union together, so a second filter widens the view;
   *   hide rules  subtract from it;
   *   hidden ids  subtract too (the H key, a tree eye, a class eye).
   * Every rule therefore restores exactly what it hid when it is removed.
   */
  private applyVisibility(): void {
    const keeps = this.rules.filter((rule) => rule.mode === 'keep');
    const hides = this.rules.filter((rule) => rule.mode === 'hide');
    if (keeps.length === 0) {
      const off = new Set(this.hiddenIds);
      for (const rule of hides) for (const id of rule.ids) off.add(id);
      this.scene.showAll();
      if (off.size) this.scene.setHidden(off, true);
    } else {
      const visible = new Set<number>();
      for (const rule of keeps) for (const id of rule.ids) visible.add(id);
      for (const rule of hides) for (const id of rule.ids) visible.delete(id);
      for (const id of this.hiddenIds) visible.delete(id);
      this.scene.isolate(visible);
    }
    this.commitVisibility();
  }

  addRule(rule: Omit<VisibilityRule, 'id'>): VisibilityRule {
    this.pushVisibilityHistory();
    const added: VisibilityRule = { ...rule, id: `v${++this.ruleSeq}`, ids: [...rule.ids] };
    this.rules.push(added);
    this.applyVisibility();
    return added;
  }

  removeRule(id: string): void {
    const before = this.rules.length;
    const next = this.rules.filter((rule) => rule.id !== id);
    if (next.length === before) return;
    this.pushVisibilityHistory();
    this.rules = next;
    this.applyVisibility();
  }

  getRules(): VisibilityRule[] {
    return this.rules.map((rule) => ({ ...rule }));
  }

  clearRules(): void {
    if (this.rules.length === 0) return;
    this.pushVisibilityHistory();
    this.rules = [];
    this.applyVisibility();
  }

  hideSelected(): void {
    const ids = this.selectedElementIds();
    if (ids.length) this.setHidden(ids, true);
  }

  isolateSelected(): void {
    const ids = this.selectedElementIds();
    if (ids.length) this.isolate(ids, `Selection (${ids.length})`);
  }

  /**
   * Show only these: replaces whatever was being kept, and starts from a clean
   * slate of manual hides, because "only this" should mean exactly that.
   */
  isolate(expressIDs: number[], label = 'Isolated'): void {
    this.pushVisibilityHistory();
    this.rules = this.rules.filter((rule) => rule.mode === 'hide');
    this.hiddenIds.clear();
    this.rules.push({ id: `v${++this.ruleSeq}`, label, mode: 'keep', ids: [...expressIDs] });
    this.applyVisibility();
  }

  setHidden(expressIDs: number[], hidden: boolean): void {
    if (expressIDs.length === 0) return;
    this.pushVisibilityHistory();
    for (const id of expressIDs) {
      if (hidden) this.hiddenIds.add(id);
      else this.hiddenIds.delete(id);
    }
    this.applyVisibility();
  }

  showAll(): void {
    if (this.rules.length || this.hiddenIds.size) this.pushVisibilityHistory();
    this.rules = [];
    this.hiddenIds.clear();
    this.scene.showAll();
    this.commitVisibility();
  }

  /** Elements hidden one by one rather than by a rule. */
  getHiddenCount(): number {
    return this.hiddenIds.size;
  }

  getHiddenIds(): number[] {
    return [...this.hiddenIds];
  }

  setGhostHidden(on: boolean): void {
    this.scene.setGhostHidden(on);
    this.scene.render();
  }

  setXray(expressIDs: Iterable<number>, on: boolean): void {
    this.scene.setXray(expressIDs, on);
    this.scene.render();
  }

  xrayAllExcept(expressIDs: Iterable<number>): void {
    const keep = new Set(expressIDs);
    const rest: number[] = [];
    for (const id of this.scene.getElementTypes().keys()) {
      if (!keep.has(id) && this.scene.isElementVisible(id)) rest.push(id);
    }
    // One write for the whole flip: previous x-rays that are now kept go off.
    this.scene.setXray(keep, false);
    this.scene.setXray(rest, true);
    this.scene.render();
  }

  clearXray(): void {
    this.scene.clearXray();
    this.scene.render();
  }

  getXrayCount(): number {
    return this.scene.getXrayCount();
  }

  isElementXray(expressID: number): boolean {
    return this.scene.isElementXray(expressID);
  }

  setPickIgnoreXray(on: boolean): void {
    this.scene.setPickSolidOnly(on);
  }

  getPickIgnoreXray(): boolean {
    return this.scene.isPickSolidOnly();
  }

  setShowThroughSelection(on: boolean): void {
    this.scene.setShowThrough(on);
    this.scene.render();
  }

  getShowThroughSelection(): boolean {
    return this.scene.isShowThrough();
  }

  /**
   * Display offsets compose from three parts: storey slide, explode, and
   * manual moves. Each writer replaces only its own part; the batcher gets
   * the per-element sum, so the tools stack instead of clobbering each other.
   */
  private recomposeArrange(): void {
    const sums = new Map<number, [number, number, number]>();
    const add = (id: number, offset: [number, number, number]): void => {
      const current = sums.get(id);
      if (current) {
        current[0] += offset[0];
        current[1] += offset[1];
        current[2] += offset[2];
      } else {
        sums.set(id, [offset[0], offset[1], offset[2]]);
      }
    };
    for (const [id, offset] of this.slideEntries) add(id, offset);
    for (const [id, offset] of this.explodeEntries) add(id, offset);
    for (const [id, offset] of this.manualOffsets) add(id, offset);
    const entries: Array<[number, [number, number, number]]> = [];
    for (const [id] of this.scene.getElementOffsets()) {
      if (!sums.has(id)) entries.push([id, [0, 0, 0]]);
    }
    for (const [id, offset] of sums) entries.push([id, offset]);
    this.scene.setElementOffsets(entries);
    this.scene.render();
  }

  private resetArrange(): void {
    this.slideEntries = [];
    this.explodeEntries = [];
    this.manualOffsets.clear();
  }

  offsetElements(expressIDs: Iterable<number>, delta: [number, number, number]): void {
    for (const id of expressIDs) {
      const current = this.manualOffsets.get(id) ?? [0, 0, 0];
      const next: [number, number, number] = [current[0] + delta[0], current[1] + delta[1], current[2] + delta[2]];
      if (next.every((value) => value === 0)) this.manualOffsets.delete(id);
      else this.manualOffsets.set(id, next);
    }
    this.recomposeArrange();
  }

  setElementOffsetEntries(entries: Array<[number, [number, number, number]]>): void {
    // Viewpoints restore totals; they become the manual baseline.
    this.resetArrange();
    for (const [id, offset] of entries) {
      if (offset.some((value) => value !== 0)) this.manualOffsets.set(id, [offset[0], offset[1], offset[2]]);
    }
    this.recomposeArrange();
  }

  clearElementOffsets(expressIDs?: Iterable<number>): void {
    if (expressIDs) {
      const drop = new Set(expressIDs);
      this.slideEntries = this.slideEntries.filter(([id]) => !drop.has(id));
      this.explodeEntries = this.explodeEntries.filter(([id]) => !drop.has(id));
      for (const id of drop) this.manualOffsets.delete(id);
      this.recomposeArrange();
      return;
    }
    this.resetArrange();
    this.scene.clearElementOffsets();
    this.scene.render();
  }

  hasElementOffsets(): boolean {
    return this.scene.hasElementOffsets();
  }

  getElementOffsets(): Array<[number, [number, number, number]]> {
    return this.scene.getElementOffsets();
  }

  setStoreySlide(axis: 'x' | 'y' | 'z', spacing: number): void {
    this.slideEntries = storeySlideOffsets(this.getSpatialTree(), axis, spacing)
      .filter(([, offset]) => offset.some((value) => value !== 0));
    this.recomposeArrange();
  }

  setExplode(factor: number): void {
    // Everything works from resting positions (bounds minus the current
    // offset), or dragging the slider would compound on its own output.
    const centers = new Map<number, [number, number, number]>();
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (const id of this.scene.getElementTypes().keys()) {
      const b = this.scene.getElementBounds(id);
      if (!b) continue;
      const shift = this.scene.getElementOffset(id) ?? [0, 0, 0];
      const center: [number, number, number] = [
        (b.min.x + b.max.x) / 2 - shift[0],
        (b.min.y + b.max.y) / 2 - shift[1],
        (b.min.z + b.max.z) / 2 - shift[2],
      ];
      centers.set(id, center);
      if (center[0] < minX) minX = center[0];
      if (center[1] < minY) minY = center[1];
      if (center[2] < minZ) minZ = center[2];
      if (center[0] > maxX) maxX = center[0];
      if (center[1] > maxY) maxY = center[1];
      if (center[2] > maxZ) maxZ = center[2];
    }
    if (centers.size === 0) return;
    const origin: [number, number, number] = [(minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2];
    this.explodeEntries = explodeOffsets(centers.keys(), (id) => centers.get(id) ?? null, origin, factor)
      .filter(([, offset]) => offset.some((value) => value !== 0));
    this.recomposeArrange();
  }

  setLodThreshold(pixels: number): void {
    this.scene.setLodThreshold(pixels);
    this.scene.render();
  }

  getLodThreshold(): number {
    return this.scene.getLodThreshold();
  }

  getLodCulled(): number {
    return this.scene.getLodCulled();
  }

  isGhostHidden(): boolean {
    return this.scene.isGhostHidden();
  }

  setColorOverride(assignment: Map<number, number>, colors: Array<[number, number, number]>): void {
    this.scene.setColorOverride(assignment, colors);
    this.scene.render();
  }

  clearColorOverride(): void {
    this.scene.clearColorOverride();
    this.scene.render();
  }

  hasColorOverride(): boolean {
    return this.scene.hasColorOverride();
  }

  // -- visibility history --------------------------------------------------
  /**
   * Visibility is entirely `rules` plus `hiddenIds`, so a step is a snapshot of
   * those two. Snapshots are taken before a change, which is what makes the
   * first undo land on what was on screen rather than one step past it.
   */
  private snapshotVisibility(): VisibilityStep {
    return { rules: this.rules.map((rule) => ({ ...rule, ids: [...rule.ids] })), hidden: [...this.hiddenIds] };
  }

  private pushVisibilityHistory(): void {
    const step = this.snapshotVisibility();
    const top = this.visPast[this.visPast.length - 1];
    if (top && sameStep(top, step)) return;
    this.visPast.push(step);
    if (this.visPast.length > VISIBILITY_HISTORY_LIMIT) this.visPast.shift();
    this.visFuture = [];
  }

  private restoreVisibility(step: VisibilityStep): void {
    this.rules = step.rules.map((rule) => ({ ...rule, ids: [...rule.ids] }));
    this.hiddenIds.clear();
    for (const id of step.hidden) this.hiddenIds.add(id);
    this.applyVisibility();
  }

  undoVisibility(): boolean {
    const step = this.visPast.pop();
    if (!step) return false;
    this.visFuture.push(this.snapshotVisibility());
    this.restoreVisibility(step);
    return true;
  }

  redoVisibility(): boolean {
    const step = this.visFuture.pop();
    if (!step) return false;
    this.visPast.push(this.snapshotVisibility());
    this.restoreVisibility(step);
    return true;
  }

  canUndoVisibility(): boolean {
    return this.visPast.length > 0;
  }

  canRedoVisibility(): boolean {
    return this.visFuture.length > 0;
  }

  setSubtreeVisible(expressID: number, visible: boolean): void {
    this.setHidden(this.subtreeElementIds(expressID), !visible);
  }

  /**
   * The tree asks this once per painted row, and the rows nest, so a storey is
   * walked again for every element under it. The answer only changes when
   * visibility does, so it is memoized per generation; leaves are not stored,
   * which keeps the map at a few hundred interior nodes rather than every id.
   */
  isSubtreeVisible(expressID: number): boolean {
    const hit = this.subtreeVisible.get(expressID);
    if (hit !== undefined) return hit;
    const node = this.findNode(expressID);
    if (!node) {
      const ids = this.subtreeElementIds(expressID);
      return ids.length === 0 || ids.every((id) => this.scene.isElementVisible(id));
    }
    const own = !this.scene.hasElement(expressID) || this.scene.isElementVisible(expressID);
    const visible = own && node.children.every((child) => this.isSubtreeVisible(child.expressID));
    if (node.children.length > 0) this.subtreeVisible.set(expressID, visible);
    return visible;
  }

  toggleSubtreeVisible(expressID: number): void {
    this.setSubtreeVisible(expressID, !this.isSubtreeVisible(expressID));
  }

  getSubtreeElementIds(expressID: number): number[] {
    return this.subtreeElementIds(expressID);
  }

  getElementTypes(): Map<number, string> {
    return this.scene.getElementTypes();
  }

  getVisibilityCounts(): { total: number; hidden: number } {
    return this.scene.getVisibilityCounts();
  }

  hasGeometry(expressID: number): boolean {
    return this.scene.hasElement(expressID);
  }

  getElementBounds(expressID: number): ModelBounds | null {
    return this.scene.getElementBounds(expressID);
  }

  getTriangles(): TriangleStore {
    return this.triangles;
  }

  getModelOrigin(): [number, number, number] {
    return this.scene.getModelOrigin();
  }

  isElementVisible(expressID: number): boolean {
    return this.scene.isElementVisible(expressID);
  }

  async setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void> {
    const engine = this.engine;
    if (!engine || this.models.size === 0) return;
    // Flag first so isCategoryVisible reflects the toggle immediately; meshes
    // stream in behind it.
    this.scene.setCategoryVisible(category, visible);
    if (visible) {
      const token = this.loadToken;
      // Each model streams its own spaces into its own slot, so their ids stay
      // separate and each batch lands in the right group.
      const pending = [...this.models.values()].filter((entry) => !entry.categories.has(category));
      for (const entry of pending) entry.categories.add(category);
      this.loadedCategories.add(category);
      try {
        await Promise.all(
          pending.map((entry) =>
            engine.loadCategory(entry.modelID, category, (meshes) => {
              // A model switch mid-stream would otherwise pour the old model's
              // spaces into the new model's batcher.
              if (token !== this.loadToken) return;
              this.scene.addMeshes(meshes, entry.index);
              this.triangles.add(meshes, entry.index);
            }),
          ),
        );
      } catch (err) {
        for (const entry of pending) entry.categories.delete(category);
        this.loadedCategories.delete(category);
        throw err;
      }
      if (token !== this.loadToken) return;
      // Subtree lists computed before these arrived are short by exactly them.
      this.subtreeCache.clear();
      this.subtreeVisible.clear();
    }
    this.applyVisibility();
  }

  isCategoryVisible(category: LazyCategory): boolean {
    return this.scene.getCategoryVisible(category);
  }

  setPerfHud(visible: boolean): void {
    this.perfHud.setVisible(visible);
  }

  updateTheme(): void {
    const styles = getComputedStyle(this.container);
    const bg =
      styles.getPropertyValue('--ifc-viewport-bg') ||
      styles.getPropertyValue('--vscode-editor-background');
    if (this.scene.setBackgroundCss(bg)) {
      this.scene.render();
    }
  }

  fitToModel(): CameraPose {
    const pose = this.controls.fitToModel();
    this.scene.render();
    return pose;
  }

  fitToElement(expressID: number): CameraPose | null {
    const pose = this.controls.fitToElement(expressID);
    this.scene.render();
    return pose;
  }

  fitToPoint(point: [number, number, number], radius = 1): CameraPose {
    const pose = this.controls.fitToPoint(point, radius);
    this.scene.render();
    return pose;
  }

  viewFrom(view: ViewPreset): void {
    this.controls.viewFrom(view);
    this.scene.render();
  }

  setProjection(mode: ProjectionMode): void {
    this.controls.setProjection(mode);
    this.scene.render();
  }

  getProjection(): ProjectionMode {
    return this.controls.getProjection();
  }

  rotateView(degrees: number): void {
    this.controls.rotateView(degrees);
    this.scene.render();
  }

  setFlyMode(on: boolean): void {
    if (on) {
      this.buildStoreyBands();
      this.controls.startFly();
    } else {
      this.controls.stopFly();
    }
  }

  isFlyMode(): boolean {
    return this.controls.isFlying();
  }

  onFlyChange(listener: (on: boolean) => void): () => void {
    return this.controls.onFlyChange(listener);
  }

  viewPerpendicular(): boolean {
    const pick = this.lastPick;
    if (pick) {
      const projected = this.scene.projectPoint(pick.point);
      if (!projected.behind) {
        const normal = this.scene.surfaceNormalAt(projected.x, projected.y, pick.point);
        if (normal) {
          // Keep the camera on its own side of the face.
          const pose = this.controls.getPose();
          const toCam = [
            pose.position[0] - pick.point[0],
            pose.position[1] - pick.point[1],
            pose.position[2] - pick.point[2],
          ];
          const dot = normal[0] * toCam[0] + normal[1] * toCam[1] + normal[2] * toCam[2];
          const dir: [number, number, number] =
            dot < 0 ? [-normal[0], -normal[1], -normal[2]] : normal;
          this.controls.lookAlong(dir);
          this.scene.render();
          return true;
        }
      }
    }
    const pose = this.controls.getPose();
    const dx = pose.position[0] - pose.target[0];
    const dy = pose.position[1] - pose.target[1];
    const dz = pose.position[2] - pose.target[2];
    const ax = Math.abs(dx);
    const ay = Math.abs(dy);
    const az = Math.abs(dz);
    const dir: [number, number, number] =
      ax >= ay && ax >= az
        ? [Math.sign(dx) || 1, 0, 0]
        : ay >= az
          ? [0, Math.sign(dy) || 1, 0]
          : [0, 0, Math.sign(dz) || 1];
    this.controls.lookAlong(dir);
    this.scene.render();
    return false;
  }

  setSection(state: SectionState): void {
    this.setSections([state]);
  }

  setSections(states: SectionState[]): void {
    // One plane per axis; arbitrary planes dedupe on their own id. External
    // ids bump the counter so a restored plane-3 can never collide with the
    // next minted id, and ids that would land in the axis keyspace regenerate.
    const byKey = new Map<string, SectionState>();
    for (const state of states) {
      if (isAxisSection(state)) {
        byKey.set(state.axis, state);
        continue;
      }
      const normal = normalize3(state.normal);
      if (!normal) continue;
      const numbered = /^plane-(\d+)$/.exec(state.id ?? '');
      if (numbered) this.planeSeq = Math.max(this.planeSeq, Number(numbered[1]));
      let id = state.id === 'x' || state.id === 'y' || state.id === 'z' ? '' : state.id;
      if (!id) do id = `plane-${++this.planeSeq}`; while (byKey.has(id));
      byKey.set(id, { ...state, id, name: state.name || `Plane ${this.planeSeq}`, normal });
    }
    // Eight planes cap: three compiles shaders per clip-plane count and the
    // box path already needs six.
    this.sections = [...byKey.values()].slice(0, 8);
    // A box is six planes on the same three axes, so the two cannot both be
    // on; whichever the user reached for last wins.
    if (this.sections.length) this.box = null;
    this.applyClipping();
  }

  /**
   * Six planes around a volume. Kept separate from the per-axis sections so
   * `getSections()` still answers for those alone: storey cuts, viewpoints and
   * BCF all round-trip section planes and would otherwise pick up half a box.
   */
  setSectionBox(box: SectionBox | null): void {
    this.box = box ? sanitizeBox(box) : null;
    if (this.box) this.sections = [];
    this.applyClipping();
  }

  getSectionBox(): SectionBox | null {
    return this.box ? { min: [...this.box.min], max: [...this.box.max] } : null;
  }

  /** The model's own extent, as the starting box before the user narrows it. */
  getModelBox(): SectionBox {
    const b = this.scene.getBounds();
    return { min: [b.min.x, b.min.y, b.min.z], max: [b.max.x, b.max.y, b.max.z] };
  }

  /** A box around these elements, padded so their own faces are not clipped. */
  boxAround(expressIDs: number[], pad = 0.05): SectionBox | null {
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let found = 0;
    for (const id of expressIDs) {
      const bounds = this.scene.getElementBounds(id);
      if (!bounds) continue;
      found++;
      const lo = [bounds.min.x, bounds.min.y, bounds.min.z];
      const hi = [bounds.max.x, bounds.max.y, bounds.max.z];
      for (let i = 0; i < 3; i++) {
        if (lo[i] < min[i]) min[i] = lo[i];
        if (hi[i] > max[i]) max[i] = hi[i];
      }
    }
    if (!found) return null;
    return padBox({ min, max }, pad);
  }

  private clipSpecs(states: SectionState[]): ClipPlaneSpec[] {
    return states.map((s) =>
      isAxisSection(s)
        ? { key: s.axis, normal: AXIS_NORMAL[s.axis], offset: s.offset, flip: s.flip }
        : { key: s.id, normal: s.normal, offset: s.offset, flip: s.flip },
    );
  }

  /** The one place clip planes are computed, from whichever state is active. */
  private applyClipping(): void {
    const specs = this.clipSpecs(this.box ? boxPlanes(this.box) : this.sections);
    this.scene.setClipPlanes(specs);
    // Arrows belong to the plane tool; the box shows its own wireframe.
    this.scene.setSectionHandles(this.box ? [] : specs);
    this.scene.setSectionBoxOutline(this.box);
    this.scene.render();
    this.emitSection();
  }

  private emitSection(): void {
    for (const listener of this.sectionListeners) listener();
  }

  /** Fires whenever the section changed, from a drag or from any caller. */
  onSectionChange(listener: () => void): () => void {
    this.sectionListeners.add(listener);
    return () => this.sectionListeners.delete(listener);
  }

  getSections(): SectionState[] {
    return this.sections;
  }

  clearSection(): void {
    this.sections = [];
    this.box = null;
    this.scene.clearClipPlane();
    this.scene.setSectionHandles([]);
    this.scene.setSectionBoxOutline(null);
    this.scene.render();
    this.emitSection();
  }

  getSection(): SectionState | null {
    // Legacy single-plane read: axis entries only, so viewpoints saved before
    // arbitrary planes never resurrect one as a broken axis entry.
    return this.sections.find(isAxisSection) ?? null;
  }

  addSectionFromPick(name?: string): PlaneSectionState | null {
    // Eight planes is the clipping budget; a ninth would be silently sliced.
    if (this.sections.length >= 8) return null;
    const pick = this.lastPick;
    if (!pick) return null;
    const projected = this.scene.projectPoint(pick.point);
    if (projected.behind) return null;
    const raw = this.scene.surfaceNormalAt(projected.x, projected.y, pick.point);
    if (!raw) return null;
    const pose = this.controls.getPose();
    const toCam = [
      pose.position[0] - pick.point[0],
      pose.position[1] - pick.point[1],
      pose.position[2] - pick.point[2],
    ];
    const dot = raw[0] * toCam[0] + raw[1] * toCam[1] + raw[2] * toCam[2];
    // Toward the camera, so flip=false discards the camera side and the cut
    // is visible the moment the plane lands.
    const n: [number, number, number] = dot < 0 ? [-raw[0], -raw[1], -raw[2]] : raw;
    const plane: PlaneSectionState = {
      id: `plane-${++this.planeSeq}`,
      name: name ?? `Plane ${this.planeSeq}`,
      normal: n,
      offset: n[0] * pick.point[0] + n[1] * pick.point[1] + n[2] * pick.point[2],
      flip: false,
    };
    this.setSections([...this.sections, plane]);
    return plane;
  }

  viewAlongSection(key: string): boolean {
    const section = this.sections.find((s) => sectionKey(s) === key);
    if (!section) return false;
    const n = isAxisSection(section) ? AXIS_NORMAL[section.axis] : section.normal;
    // lookAlong's direction points from target toward the camera; the camera
    // belongs on the kept side.
    const dir: [number, number, number] = section.flip ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
    this.controls.lookAlong(dir);
    this.scene.render();
    return true;
  }

  removeSection(key: string): void {
    this.setSections(this.sections.filter((s) => sectionKey(s) !== key));
  }

  renameSection(key: string, name: string): void {
    const clean = name.trim().slice(0, 60);
    if (!clean) return;
    this.sections = this.sections.map((s) =>
      !isAxisSection(s) && s.id === key ? { ...s, name: clean } : s,
    );
    this.emitSection();
  }

  setPlanView(on: boolean): void {
    this.scene.setPlanView(on);
    this.syncPlanFrame();
    this.scene.render();
  }

  isPlanView(): boolean {
    return this.scene.isPlanView();
  }

  /** Keep the framed border over the inset in step with the canvas. */
  /** The first model's name, so a saved plan is traceable to its file. */
  private planName(): string {
    return [...this.models.values()][0]?.name || 'plan';
  }

  /**
   * Storey elevations, taken once when flight starts. Walking the tree and
   * every element bound per frame would be far too much work for a readout.
   */
  private buildStoreyBands(): void {
    this.storeyBands = [];
    for (const storey of storeyElementSets(this.getSpatialTree())) {
      let base = Infinity;
      for (const id of storey.ids) {
        const bounds = this.scene.getElementBounds(id);
        if (bounds && bounds.min.y < base) base = bounds.min.y;
      }
      if (Number.isFinite(base)) this.storeyBands.push({ name: storey.name, elevation: base });
    }
  }

  /**
   * The flight HUD: where you are, which way you face, how fast, and the keys
   * that drive it. It sits beside the plan and only exists while flying.
   */
  private syncFlyPanel(): void {
    const flying = this.controls.isFlying();
    const rect = this.scene.getPlanRect();
    if (!flying) {
      this.flyPanel?.remove();
      this.flyPanel = null;
      this.flyReadout = null;
      return;
    }
    if (!this.flyPanel) {
      const doc = this.container.ownerDocument;
      this.flyPanel = doc.createElement('div');
      this.flyPanel.className = 'ifc-fly-panel';
      const keys = (...items: string[]): string =>
        items.map((item) => `<kbd>${item}</kbd>`).join('');
      this.flyPanel.innerHTML =
        '<div class="ifc-fly-head">Fly</div>' +
        '<div class="ifc-fly-read"></div>' +
        '<div class="ifc-fly-keys">' +
        `<div>${keys('W', 'A', 'S', 'D')}<span>move</span></div>` +
        `<div>${keys('Q', 'E')}<span>down, up</span></div>` +
        `<div>${keys('Shift')}<span>faster</span></div>` +
        `<div>${keys('Wheel')}<span>zoom</span></div>` +
        `<div>${keys('Esc')}<span>exit</span></div>` +
        '</div>';
      this.container.appendChild(this.flyPanel);
      this.flyReadout = this.flyPanel.querySelector('.ifc-fly-read');
    }
    // Beside the plan when it is showing, in its place when it is not.
    const left = rect ? rect.x + rect.size + 10 : 14;
    if (this.flyPanel.style.left !== `${left}px`) this.flyPanel.style.left = `${left}px`;

    const origin = this.scene.getModelOrigin();
    const p = this.scene.getCameraPosition();
    const facing = heading(this.scene.getViewDirection(), this.scene.getViewUp());
    const storey = storeyAt(this.storeyBands, p[1]);
    const speed = this.controls.getFlySpeed() ?? 0;
    const rows: Array<readonly [string, string]> = [
      ['At', `${metres(p[0] + origin[0])}, ${metres(p[2] + origin[2])}`],
      ['Height', `${metres(p[1] + origin[1])} m`],
      ...(storey ? [['Level', storey] as const] : []),
      ['Facing', `${compassPoint(facing)} ${Math.round(facing)}°`],
      ['Speed', speedLabel(speed)],
      ['Zoom', `${Math.round(this.scene.getFieldOfView())}°`],
    ];
    if (this.flyReadout) updateFlyReadout(this.flyReadout, rows);
  }

  private syncPlanFrame(): void {
    const rect = this.scene.getPlanRect();
    if (!rect) {
      this.planFrame?.remove();
      this.planFrame = null;
      this.planSize = 0;
      return;
    }
    if (!this.planFrame) {
      this.planFrame = this.container.ownerDocument.createElement('div');
      this.planFrame.className = 'ifc-plan-frame';
      this.planFrame.innerHTML =
        '<span>Plan</span>' +
        '<button type="button" class="ifc-plan-save" title="Download this plan as a PNG" aria-label="Download this plan as a PNG">' +
        '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.9" ' +
        'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
        '<path d="M12 3v12M7.5 10.5 12 15l4.5-4.5M4.5 20h15"/></svg></button>' +
        '<span class="ifc-plan-north">N</span>';
      this.planFrame.querySelector('.ifc-plan-save')?.addEventListener('click', (event) => {
        event.stopPropagation();
        void this.downloadPlan(this.planName());
      });
      this.container.appendChild(this.planFrame);
      this.planSize = 0;
      // North needle: rotated by true north when the anchor model has one.
      const anchor = this.geoAnchor === null ? null : [...this.models.values()].find((m) => m.index === this.geoAnchor);
      const north = anchor?.geo.trueNorth?.degreesFromGridNorth ?? 0;
      const needle = this.planFrame.querySelector<HTMLElement>('.ifc-plan-north');
      if (needle && north !== 0) needle.style.transform = `rotate(${north}deg)`;
    }
    if (this.planSize === rect.size) return;
    this.planSize = rect.size;
    this.planFrame.style.left = `${rect.x}px`;
    this.planFrame.style.bottom = `${rect.y}px`;
    this.planFrame.style.width = `${rect.size}px`;
    this.planFrame.style.height = `${rect.size}px`;
  }

  toggleMeasure(): boolean {
    this.setMeasuring(!this.measuring);
    return this.measuring;
  }

  setMeasuring(on: boolean): void {
    if (on && this.pickGuide) this.setPickGuide(false);
    if (on === this.measuring) return;
    this.measuring = on;
    this.hoverAt = null;
    this.container.classList.toggle('ifc-measuring', on);
    this.controls.setToolActive(on);
    // Placed measurements outlive the tool: they are part of the view, and the
    // filter chip or the tool's own Clear is what takes them off.
    if (!on) {
      this.dropPending();
      return this.cancelPending();
    }
    this.scene.render();
    this.emitMeasure();
  }

  isMeasuring(): boolean {
    return this.measuring;
  }

  setSnapMode(mode: SnapMode): void {
    if (mode === this.snapMode) return;
    this.snapMode = mode;
    this.measureHover = null;
    this.hoverAt = null;
    // pushMeasure, not emitMeasure: the scene still holds the old hover dot.
    this.pushMeasure();
  }

  getSnapMode(): SnapMode {
    return this.snapMode;
  }

  setMeasureConstraint(constraint: MeasureConstraint): void {
    if (constraint === this.measureConstraint) return;
    this.measureConstraint = constraint;
    // Re-apply the most recent raw cursor location immediately, so changing a
    // lock mid-measure feels like a drafting constraint rather than a setting.
    if (this.hoverAt && (this.measureA || this.chain.length)) {
      const next = this.probe(this.hoverAt[0], this.hoverAt[1]);
      this.measureHover = next ? this.constrainedHit(next) : null;
    }
    this.pushMeasure();
  }

  getMeasureConstraint(): MeasureConstraint {
    return this.measureConstraint;
  }

  setMeasurementFormat(format: MeasurementFormat): void {
    const next: MeasurementFormat = {
      unit: format.unit,
      precision: { ...format.precision },
      zeroSuppression: format.zeroSuppression,
    };
    if (JSON.stringify(next) === JSON.stringify(this.measurementFormat)) return;
    this.measurementFormat = next;
    this.scene.render();
    this.emitMeasure();
  }

  getMeasurementFormat(): MeasurementFormat {
    return { ...this.measurementFormat, precision: { ...this.measurementFormat.precision } };
  }

  private spansChanged(): void {
    this.spanVersion += 1;
  }

  private drawnMeasureSpans(): MeasureSpanRecord[] {
    if (this.visibleSpanVersion !== this.spanVersion) {
      this.visibleSpans = this.spans.filter((span) => span.visible !== false);
      this.visibleSpanVersion = this.spanVersion;
    }
    return this.visibleSpans;
  }

  resetMeasure(): void {
    const changed = this.spans.length > 0 || this.shapes.length > 0;
    this.spans = [];
    this.spansChanged();
    this.shapes = [];
    this.chain = [];
    if (changed) this.measurementRevision += 1;
    this.cancelPending();
  }

  /** Drop the point in hand; placed spans stay. */
  private cancelPending(): void {
    this.measureA = null;
    this.measureAKind = null;
    this.measureNormal = null;
    this.measureHover = null;
    this.measureOpening = false;
    this.pushMeasure();
  }

  private spanMetrics(
    a: [number, number, number],
    end: [number, number, number] | null,
    ends: [SnapKind, SnapKind | null],
    id: number,
    complete: boolean,
    label = 'Length',
    visible = true,
  ): Measurement {
    const resolvedEnds: [SnapKind, SnapKind] = [ends[0], ends[1] ?? ends[0]];
    if (!end) {
      return {
        kind: 'distance', id, label, visible, semantic: measurementSemantic(resolvedEnds),
        a: [...a], b: null, distance: 0, horizontal: 0, vertical: 0,
        slopePercent: 0, slopeAngle: 0, complete, ends,
      };
    }
    const [dx, dy, dz] = [end[0] - a[0], end[1] - a[1], end[2] - a[2]];
    const horizontal = Math.hypot(dx, dz);
    const vertical = Math.abs(dy);
    return {
      kind: 'distance',
      id,
      label,
      visible,
      semantic: measurementSemantic(resolvedEnds),
      a: [...a],
      b: [...end],
      distance: Math.hypot(dx, dy, dz),
      horizontal,
      vertical,
      slopePercent: horizontal > 1e-12 ? (vertical / horizontal) * 100 : null,
      slopeAngle: (Math.atan2(vertical, horizontal) * 180) / Math.PI,
      complete,
      ends,
    };
  }

  getMeasurement(): Measurement | null {
    if (this.measureA) {
      return this.spanMetrics(
        this.measureA,
        this.measureHover?.point ?? null,
        [this.measureAKind ?? 'surface', this.measureHover?.kind ?? null],
        0,
        false,
      );
    }
    for (let index = this.spans.length - 1; index >= 0; index--) {
      const last = this.spans[index];
      if (last.shape === undefined) {
        return this.spanMetrics(last.a, last.b, last.ends, last.id, true, last.label, last.visible);
      }
    }
    return null;
  }

  getMeasurements(): Measurement[] {
    return this.spans
      .filter((span) => span.shape === undefined)
      .map((span) => this.spanMetrics(span.a, span.b, span.ends, span.id, true, span.label, span.visible));
  }

  private measurementKindLabel(kind: MeasurementObject['kind']): string {
    return kind === 'distance' ? 'Length'
      : kind === 'path' ? 'Path'
        : kind === 'angle' ? 'Angle'
          : kind === 'area' ? 'Area'
            : kind === 'count' ? 'Count'
              : 'Coordinate';
  }

  private cleanMeasurementLabel(value: unknown, fallback: string, id: number): string {
    const clean = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, 80) : '';
    return clean || `${fallback} ${id}`;
  }

  private defaultMeasurementLabel(kind: MeasurementObject['kind']): string {
    const base = this.measurementKindLabel(kind);
    const count = this.getMeasurementObjects().filter((entry) => entry.kind === kind).length + 1;
    return `${base} ${count}`;
  }

  getMeasurementObjects(): MeasurementObject[] {
    const distances = this.getMeasurements();
    const shapes = this.getShapeMeasures();
    return [...distances, ...shapes].sort((a, b) => a.id - b.id);
  }

  updateMeasurement(id: number, patch: MeasurementUpdate): boolean {
    const span = this.spans.find((entry) => entry.shape === undefined && entry.id === id);
    const shape = this.shapes.find((entry) => entry.id === id);
    const current = span ?? shape;
    if (!current) return false;
    let changed = false;
    if (patch.label !== undefined) {
      const fallback = this.measurementKindLabel(shape?.kind ?? 'distance');
      const label = this.cleanMeasurementLabel(patch.label, fallback, id);
      if (label !== current.label) {
        current.label = label;
        changed = true;
      }
    }
    if (patch.visible !== undefined && patch.visible !== current.visible) {
      current.visible = patch.visible;
      if (shape) {
        for (const leg of this.spans) if (leg.shape === shape.id) leg.visible = patch.visible;
      }
      this.spansChanged();
      changed = true;
    }
    if (!changed) return false;
    this.measurementRevision += 1;
    this.pushMeasure();
    return true;
  }

  setMeasurementsVisible(ids: Iterable<number>, visible: boolean): number {
    const wanted = new Set(ids);
    let changed = 0;
    for (const span of this.spans) {
      if (span.shape !== undefined || !wanted.has(span.id) || span.visible === visible) continue;
      span.visible = visible;
      changed += 1;
    }
    for (const shape of this.shapes) {
      if (!wanted.has(shape.id) || shape.visible === visible) continue;
      shape.visible = visible;
      for (const leg of this.spans) if (leg.shape === shape.id) leg.visible = visible;
      changed += 1;
    }
    if (changed) {
      this.spansChanged();
      this.measurementRevision += 1;
      this.pushMeasure();
    }
    return changed;
  }

  removeMeasurementObject(id: number): void {
    if (this.spans.some((span) => span.shape === undefined && span.id === id)) this.removeMeasurement(id);
    else this.removeShapeMeasure(id);
  }

  focusMeasurement(id: number): boolean {
    const item = this.getMeasurementObjects().find((entry) => entry.id === id);
    if (!item) return false;
    const points = item.kind === 'distance'
      ? [item.a, ...(item.b ? [item.b] : [])]
      : item.points;
    if (points.length === 0) return false;
    const center: [number, number, number] = [0, 0, 0];
    for (const point of points) {
      center[0] += point[0] / points.length;
      center[1] += point[1] / points.length;
      center[2] += point[2] / points.length;
    }
    let radius = 0;
    for (const point of points) radius = Math.max(radius, length3(sub(point, center)));
    this.fitToPoint(center, Math.max(0.25, radius * 1.15));
    return true;
  }

  private buildShapeSpans(shape: ShapeMeasure): void {
    if (shape.kind === 'coordinate') return;
    const last = shape.kind === 'area' ? shape.points.length : shape.points.length - 1;
    for (let index = 0; index < last; index++) {
      this.spans.push({
        id: ++this.spanSeq,
        a: shape.points[index],
        b: shape.points[(index + 1) % shape.points.length],
        ends: ['surface', 'surface'],
        visible: shape.visible,
        shape: shape.id,
      });
    }
    this.spansChanged();
  }

  setPickGuide(on: boolean): void {
    if (on && this.measuring) this.setMeasuring(false);
    if (on === this.pickGuide) return;
    this.pickGuide = on;
    this.container.classList.toggle('ifc-pick-guided', on);
    if (!on && !this.measuring) {
      this.measureHover = null;
      this.hoverAt = null;
    }
    this.pushMeasure();
  }

  getMeasurementStates(): MeasurementState[] {
    const distances: DistanceMeasurementState[] = this.spans
      .filter((span) => span.shape === undefined)
      .map((span) => ({
        kind: 'distance', id: span.id, label: span.label, visible: span.visible !== false,
        a: [...span.a], b: [...span.b], ends: [...span.ends],
      }));
    const shapes: ShapeMeasurementState[] = this.shapes.map((shape) => ({
      kind: shape.kind,
      id: shape.id,
      label: shape.label,
      visible: shape.visible,
      points: shape.points.map((point) => [...point]),
    }));
    return [...distances, ...shapes].sort((a, b) => (a.id ?? 0) - (b.id ?? 0));
  }

  setMeasurementStates(states: MeasurementState[]): void {
    this.spans = [];
    this.spansChanged();
    this.shapes = [];
    this.chain = [];
    const used = new Set<number>();
    const claimId = (preferred: number | undefined): number => {
      if (Number.isInteger(preferred) && preferred! > 0 && !used.has(preferred!)) {
        used.add(preferred!);
        this.measurementSeq = Math.max(this.measurementSeq, preferred!);
        return preferred!;
      }
      while (used.has(++this.measurementSeq));
      used.add(this.measurementSeq);
      return this.measurementSeq;
    };
    const point = (value: unknown): value is [number, number, number] =>
      Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
    for (const state of states) {
      if (!state || typeof state !== 'object') continue;
      if ('a' in state && 'b' in state && point(state.a) && point(state.b)) {
        const ends: [SnapKind, SnapKind] = Array.isArray(state.ends)
          && state.ends.length === 2
          && state.ends.every((kind) => typeof kind === 'string' && kind in SNAP_LABEL)
          ? [...state.ends]
          : ['surface', 'surface'];
        const id = claimId(state.id);
        this.spans.push({
          id,
          a: [...state.a],
          b: [...state.b],
          ends,
          label: this.cleanMeasurementLabel(state.label, 'Length', id),
          visible: state.visible !== false,
        });
        continue;
      }
      if (!('points' in state) || !Array.isArray(state.points) || !state.points.every(point)) continue;
      if (!['path', 'angle', 'area', 'coordinate', 'count'].includes(state.kind)) continue;
      const minimum = state.kind === 'coordinate' || state.kind === 'count' ? 1 : state.kind === 'path' ? 2 : 3;
      if (state.points.length < minimum) continue;
      const id = claimId(state.id);
      const points = state.points.map((entry) => [...entry] as [number, number, number]);
      const shape: ShapeMeasure = {
        id,
        kind: state.kind,
        label: this.cleanMeasurementLabel(state.label, this.measurementKindLabel(state.kind), id),
        visible: state.visible !== false,
        points,
        perimeter: state.kind === 'coordinate' || state.kind === 'count' ? 0 : ringPerimeter(points, state.kind === 'area'),
        ...(state.kind === 'angle' ? { angle: angleAt(points[0], points[1], points[2]) } : {}),
        ...(state.kind === 'area' ? { area: ringArea(points) } : {}),
      };
      this.shapes.push(shape);
      this.buildShapeSpans(shape);
    }
    this.measurementRevision += 1;
    this.cancelPending();
  }

  addMeasurement(
    a: [number, number, number],
    b: [number, number, number],
    ends: [SnapKind, SnapKind] = ['surface', 'surface'],
  ): Measurement {
    const id = ++this.measurementSeq;
    const label = this.defaultMeasurementLabel('distance');
    this.spans.push({ id, a: [...a], b: [...b], ends, label, visible: true });
    this.spansChanged();
    this.measurementRevision += 1;
    this.pushMeasure();
    return this.spanMetrics(a, b, ends, id, true, label, true);
  }

  removeMeasurement(id: number): void {
    const before = this.spans.length;
    this.spans = this.spans.filter((span) => span.shape !== undefined || span.id !== id);
    if (this.spans.length !== before) {
      this.spansChanged();
      this.measurementRevision += 1;
      this.pushMeasure();
    }
  }

  getMeasurementRevision(): number {
    return this.measurementRevision;
  }

  onMeasureChange(listener: () => void): () => void {
    this.measureListeners.add(listener);
    return () => this.measureListeners.delete(listener);
  }

  private emitMeasure(): void {
    for (const listener of this.measureListeners) listener();
  }

  /**
   * Where a press or a hover lands: the geometry feature nearest the cursor
   * on screen, or the exact surface point under it when nothing is close
   * enough. Candidates are the elements actually drawn around the cursor, so
   * measuring across a gap catches the corner on the far side of it and never
   * catches one hidden behind a wall.
   */
  private constrainedHit(hit: SnapHit): SnapHit {
    const origin = this.measureA ?? this.chain[this.chain.length - 1];
    if (!origin || this.measureConstraint === 'free') return hit;
    return { ...hit, point: constrainMeasurementPoint(origin, hit.point, this.measureConstraint, this.measureNormal) };
  }

  private probe(clientX: number, clientY: number): SnapHit | null {
    const [x, y] = this.controls.toCanvas(clientX, clientY);
    return this.scene.probeAt(x, y, this.snapMode !== 'off', this.snapMode === 'vertex');
  }

  /**
   * Press: the first point of a new span, or the start of the gesture that
   * closes the one in hand. A closed span joins the placed list, so the next
   * press starts the next measurement without a trip back to the toolbar.
   */
  private measureDown(clientX: number, clientY: number): void {
    // Angle and area place their point on release, so the press only has to
    // keep the hover honest.
    if (this.measureMode !== 'distance') return this.queueMeasureHover(clientX, clientY);
    if (this.measureA) {
      this.measureOpening = false; // this gesture closes the span
      return this.queueMeasureHover(clientX, clientY);
    }
    const hit = this.probe(clientX, clientY);
    if (!hit) return; // a press on nothing keeps what is already measured
    this.measureA = hit.point;
    this.measureAKind = hit.kind;
    const [canvasX, canvasY] = this.controls.toCanvas(clientX, clientY);
    this.measureNormal = this.scene.surfaceNormalAt(canvasX, canvasY, hit.point);
    if (!this.measureNormal && (this.measureConstraint === 'perpendicular' || this.measureConstraint === 'parallel')) {
      this.measureConstraint = 'free';
    }
    this.measureHover = null;
    this.measureOpening = true;
    this.pushMeasure();
  }

  /**
   * Release: a drag has already shown where the span ends, so it closes
   * there. A press that never moved is the first of two clicks, and waits.
   */
  /**
   * Angle and area collect a chain of points rather than pairs. Each placed
   * point becomes a span so the shape draws itself with the renderer the
   * distance tool already uses, and no new drawing code exists for either.
   */
  private chainUp(clientX: number, clientY: number): void {
    const raw = this.probe(clientX, clientY) ?? this.measureHover;
    if (!raw) return;
    const hit = this.constrainedHit(raw);
    const point = hit.point;
    const last = this.chain[this.chain.length - 1];
    if (last && last[0] === point[0] && last[1] === point[1] && last[2] === point[2]) return;

    // Clicking the first point again closes a ring, which is what every
    // polygon tool does and what a user tries before finding the button.
    if (this.measureMode === 'area' && this.chain.length >= 3) {
      const first = this.chain[0];
      if (length3(sub(point, first)) < this.closeTolerance()) {
        this.closeArea();
        return;
      }
    }

    if (!last) {
      const [canvasX, canvasY] = this.controls.toCanvas(clientX, clientY);
      this.measureNormal = this.scene.surfaceNormalAt(canvasX, canvasY, point);
      if (!this.measureNormal && (this.measureConstraint === 'perpendicular' || this.measureConstraint === 'parallel')) {
        this.measureConstraint = 'free';
      }
    }
    this.chain.push(point);
    if (this.measureMode === 'coordinate' || this.measureMode === 'count') {
      const kind = this.measureMode;
      const id = ++this.measurementSeq;
      this.shapes.push({
        id,
        kind,
        label: this.defaultMeasurementLabel(kind),
        visible: true,
        points: [[...point]],
        perimeter: 0,
      });
      this.chain = [];
      this.measureNormal = null;
      this.measurementRevision += 1;
      this.pushMeasure();
      return;
    }
    if (last) {
      this.spans.push({
        id: ++this.spanSeq,
        a: last,
        b: point,
        ends: ['surface', hit.kind],
        shape: PENDING_SHAPE,
      });
      this.spansChanged();
    }
    this.measureHover = hit;
    if (this.measureMode === 'angle' && this.chain.length === 3) {
      const [a, b, c] = this.chain;
      const id = ++this.measurementSeq;
      this.shapes.push({
        id,
        kind: 'angle',
        label: this.defaultMeasurementLabel('angle'),
        visible: true,
        points: [a, b, c],
        angle: angleAt(a, b, c),
        perimeter: ringPerimeter([a, b, c], false),
      });
      this.adoptPending(id);
      this.chain = [];
      this.measureNormal = null;
      this.measurementRevision += 1;
    }
    this.pushMeasure();
  }

  /** Hand the legs drawn so far to the shape that just closed over them. */
  private adoptPending(shape: number): void {
    for (const span of this.spans) {
      if (span.shape === PENDING_SHAPE) span.shape = shape;
    }
  }

  /** Throw away the half-drawn shape: its points and the legs between them. */
  private dropPending(): void {
    this.chain = [];
    this.measureNormal = null;
    const before = this.spans.length;
    this.spans = this.spans.filter((span) => span.shape !== PENDING_SHAPE);
    if (this.spans.length !== before) this.spansChanged();
  }

  /** A click within this of the first point counts as closing the ring. */
  private closeTolerance(): number {
    const bounds = this.scene.getBounds();
    const size = Math.max(
      bounds.max.x - bounds.min.x,
      bounds.max.y - bounds.min.y,
      bounds.max.z - bounds.min.z,
    );
    return Math.max(0.05, size * 0.005);
  }

  closeArea(): boolean {
    if (this.measureMode !== 'area' || this.chain.length < 3) return false;
    const points = this.chain;
    const id = ++this.measurementSeq;
    this.spans.push({
      id: ++this.spanSeq,
      a: points[points.length - 1],
      b: points[0],
      ends: ['surface', 'surface'],
      shape: PENDING_SHAPE,
    });
    this.spansChanged();
    this.shapes.push({
      id,
      kind: 'area',
      label: this.defaultMeasurementLabel('area'),
      visible: true,
      points: [...points],
      area: ringArea(points),
      perimeter: ringPerimeter(points, true),
    });
    this.adoptPending(id);
    this.chain = [];
    this.measureNormal = null;
    this.measurementRevision += 1;
    this.pushMeasure();
    return true;
  }

  finishPath(): boolean {
    if (this.measureMode !== 'path' || this.chain.length < 2) return false;
    const points = this.chain.map((point) => [...point] as [number, number, number]);
    const id = ++this.measurementSeq;
    this.shapes.push({
      id,
      kind: 'path',
      label: this.defaultMeasurementLabel('path'),
      visible: true,
      points,
      perimeter: ringPerimeter(points, false),
    });
    this.adoptPending(id);
    this.chain = [];
    this.measureNormal = null;
    this.measurementRevision += 1;
    this.pushMeasure();
    return true;
  }

  setMeasureMode(mode: MeasureMode): void {
    if (this.measureMode === mode) return;
    this.measureMode = mode;
    // A half-drawn shape means nothing in the mode that replaces it.
    this.dropPending();
    this.measureA = null;
    this.measureAKind = null;
    this.measureNormal = null;
    this.hoverAt = null;
    this.pushMeasure();
  }

  getMeasureMode(): MeasureMode {
    return this.measureMode;
  }

  getShapeMeasures(): ShapeMeasure[] {
    return this.shapes.map((shape) => ({ ...shape, points: shape.points.map((p) => [...p] as [number, number, number]) }));
  }

  getPendingPoints(): Array<[number, number, number]> {
    return this.chain.map((p) => [...p] as [number, number, number]);
  }

  removeShapeMeasure(id: number): void {
    const before = this.shapes.length;
    this.shapes = this.shapes.filter((shape) => shape.id !== id);
    if (this.shapes.length === before) return;
    // The legs were only ever the shape drawing itself; they go with it.
    this.spans = this.spans.filter((span) => span.shape !== id);
    this.spansChanged();
    this.measurementRevision += 1;
    this.pushMeasure();
  }

  /** Everything placed: spans plus finished shapes. Drives the filter chip. */
  getMeasureCount(): number {
    return this.spans.filter((span) => span.shape === undefined).length + this.shapes.length;
  }

  undoLastMeasurement(): boolean {
    // A chain in progress: take back the last placed point and its leg.
    if (this.chain.length > 0) {
      this.chain.pop();
      for (let i = this.spans.length - 1; i >= 0; i--) {
        if (this.spans[i].shape === PENDING_SHAPE) {
          this.spans.splice(i, 1);
          this.spansChanged();
          break;
        }
      }
      if (this.chain.length === 0) this.measureNormal = null;
      this.pushMeasure();
      return true;
    }
    // The first point of a distance span in hand.
    if (this.measureA) {
      this.measureA = null;
      this.measureAKind = null;
      this.measureNormal = null;
      this.pushMeasure();
      return true;
    }
    // Nothing pending: drop the newest placed object. Spans and shapes number
    // themselves separately, so the active tool decides which list is "last".
    const span = [...this.spans].reverse().find((entry) => entry.shape === undefined);
    const shape = this.shapes[this.shapes.length - 1];
    if (this.measureMode === 'distance' && span) {
      this.removeMeasurement(span.id);
      return true;
    }
    if (shape) {
      this.removeShapeMeasure(shape.id);
      return true;
    }
    if (span) {
      this.removeMeasurement(span.id);
      return true;
    }
    return false;
  }

  private measureUp(clientX: number, clientY: number, moved: boolean): void {
    if (!this.measuring) return;
    // A chain places one point per click, so the two-click guard the distance
    // tool needs would swallow every one of them.
    if (this.measureMode !== 'distance') return this.chainUp(clientX, clientY);
    if (!this.measureA) return;
    if (this.measureOpening && !moved) return;
    const raw = this.probe(clientX, clientY) ?? this.measureHover;
    if (!raw) return;
    const hit = this.constrainedHit(raw);
    const a = this.measureA;
    // A second click on the very same point is not a span; keep waiting.
    if (hit.point[0] === a[0] && hit.point[1] === a[1] && hit.point[2] === a[2]) return;
    const id = ++this.measurementSeq;
    this.spans.push({
      id,
      a,
      b: hit.point,
      ends: [this.measureAKind ?? 'surface', hit.kind],
      label: this.defaultMeasurementLabel('distance'),
      visible: true,
    });
    this.spansChanged();
    this.measurementRevision += 1;
    this.measureA = null;
    this.measureAKind = null;
    this.measureNormal = null;
    // Keep the hover on the placed end: the tool is already armed for the
    // next span, and the dot says so.
    this.measureHover = hit;
    this.measureOpening = false;
    this.pushMeasure();
  }

  /**
   * Cursor feedback, on hover and mid-drag alike: one GPU read per frame at
   * most, and no repaint unless the cursor found a different point.
   */
  private queueMeasureHover(clientX: number, clientY: number): void {
    const previous = this.hoverPending ?? this.hoverAt;
    if (previous && Math.hypot(previous[0] - clientX, previous[1] - clientY) < 0.75) return;
    this.hoverPending = [clientX, clientY];
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const at = this.hoverPending;
      this.hoverPending = null;
      if (!at || (!this.measuring && !this.pickGuide)) return;
      const probed = this.probe(at[0], at[1]);
      const next = probed ? this.constrainedHit(probed) : null;
      this.hoverAt = at;
      const current = this.measureHover;
      if (
        next?.kind === current?.kind &&
        next?.point[0] === current?.point[0] &&
        next?.point[1] === current?.point[1] &&
        next?.point[2] === current?.point[2]
      ) {
        return;
      }
      this.measureHover = next;
      this.pushMeasure();
    });
  }

  /**
   * Hand every span to the overlay and tell the panels about them. A chain
   * rubber-bands from its last placed point, the same way a pair does from the
   * first, so both tools show where the next click lands.
   */
  private pushMeasure(): void {
    const from = this.measureA ?? (this.measuring ? this.chain[this.chain.length - 1] ?? null : null);
    this.scene.setMeasure(
      this.drawnMeasureSpans(),
      from ? { a: from, end: this.measureHover?.point ?? null } : null,
      this.measuring || this.pickGuide ? this.measureHover?.point ?? null : null,
    );
    this.scene.render();
    this.emitMeasure();
  }

  /**
   * Floating labels, each kept to one job: a distance over the middle of
   * every span, and the cursor carries what it is about to snap to. Anything
   * longer belongs in the panel, not on top of the model.
   */
  private syncMeasureOverlay(): void {
    const mid = (a: [number, number, number], b: [number, number, number]): [number, number, number] =>
      [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    const length = (a: [number, number, number], b: [number, number, number]): number =>
      Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);

    const entries: Array<{ text: string; at: [number, number, number]; order: number }> = [];
    for (const span of this.spans) {
      if (span.visible === false || span.shape !== undefined) continue;
      entries.push({
        text: formatLength(length(span.a, span.b), this.measurementFormat),
        at: mid(span.a, span.b),
        order: span.id,
      });
    }
    // The answer goes in the middle of the shape it answers for, so an angle
    // and a ring read off the model without a trip to the panel.
    for (const shape of this.shapes) {
      if (!shape.visible) continue;
      const at: [number, number, number] = [0, 0, 0];
      for (const point of shape.points) {
        at[0] += point[0] / shape.points.length;
        at[1] += point[1] / shape.points.length;
        at[2] += point[2] / shape.points.length;
      }
      entries.push({
        text: shape.kind === 'angle' ? formatAngle(shape.angle ?? 0)
          : shape.kind === 'area' ? formatArea(shape.area ?? 0, this.measurementFormat)
            : shape.kind === 'path' ? formatLength(shape.perimeter, this.measurementFormat)
              : formatCoordinate(shape.points[0], this.measurementFormat),
        at: shape.kind === 'angle' ? shape.points[1] : at,
        order: shape.id,
      });
    }
    const end = this.measureHover?.point ?? null;
    const from = this.measureA ?? (this.measuring ? this.chain[this.chain.length - 1] ?? null : null);
    if (from && end && length(from, end) > 0) {
      entries.push({
        text: formatLength(length(from, end), this.measurementFormat),
        at: mid(from, end),
        order: Number.MAX_SAFE_INTEGER,
      });
    }
    entries.sort((a, b) => b.order - a.order);
    const candidates: Array<MeasureLabelBox & {
      text: string;
      at: [number, number, number];
      screen: { x: number; y: number; behind: boolean };
    }> = [];
    const width = this.container.clientWidth;
    const height = this.container.clientHeight;
    for (const entry of entries) {
      const screen = this.scene.projectPoint(entry.at);
      if (screen.behind || screen.x < -12 || screen.y < -12 || screen.x > width + 12 || screen.y > height + 12) continue;
      candidates.push({
        ...entry,
        screen,
        x: screen.x,
        y: screen.y,
        width: Math.max(52, Math.min(220, entry.text.length * 7.2 + 20)),
        height: 24,
      });
    }
    const visibleEntries = selectMeasureLabels(candidates);
    while (this.spanLabels.length < visibleEntries.length) {
      const node = this.container.ownerDocument.createElement('div');
      node.className = 'ifc-measure-label';
      this.container.appendChild(node);
      this.spanLabels.push(node);
    }
    this.spanLabels.forEach((node, index) => this.placeLabel(node, visibleEntries[index] ?? null));

    const hover = this.measuring || this.pickGuide ? this.measureHover : null;
    if (hover && !this.snapTag) {
      this.snapTag = this.container.ownerDocument.createElement('div');
      this.snapTag.className = 'ifc-snap-tag';
      this.container.appendChild(this.snapTag);
    }
    if (this.snapTag) {
      const lockName = this.measureConstraint === 'perpendicular' ? 'PERP'
        : this.measureConstraint === 'parallel' ? 'PAR'
          : this.measureConstraint.toUpperCase();
      const lock = this.measureConstraint === 'free' ? '' : ` · ${lockName} lock`;
      this.snapTag.dataset.constraint = this.measureConstraint;
      this.placeLabel(this.snapTag, hover ? { text: `${SNAP_LABEL[hover.kind]}${lock}`, at: hover.point } : null);
    }
  }

  /** Park a label over a world point, or hide it when there is nothing to say. */
  private placeLabel(
    node: HTMLElement,
    entry: {
      text: string;
      at: [number, number, number];
      screen?: { x: number; y: number; behind: boolean };
    } | null,
  ): void {
    if (!entry) {
      if (node.style.display !== 'none') node.style.display = 'none';
      return;
    }
    const screen = entry.screen ?? this.scene.projectPoint(entry.at);
    const display = screen.behind ? 'none' : 'block';
    if (node.style.display !== display) node.style.display = display;
    if (!screen.behind) {
      const left = `${screen.x}px`;
      const top = `${screen.y}px`;
      if (node.style.left !== left) node.style.left = left;
      if (node.style.top !== top) node.style.top = top;
    }
    if (node.textContent !== entry.text) node.textContent = entry.text;
  }

  setRenderScale(scale: number): void {
    this.scene.setUserScale(scale);
    this.scene.render();
  }

  setAdaptiveResolution(on: boolean): void {
    this.controls.setAdaptiveResolution(on);
  }

  setDoubleSided(on: boolean): void {
    this.scene.setDoubleSided(on);
    this.scene.render();
  }

  getRenderTiming(): { lastMs: number; rendersLastSecond: number } {
    return this.scene.getRenderTiming();
  }

  onRenderTick(listener: () => void): () => void {
    this.renderTickListeners.add(listener);
    return () => this.renderTickListeners.delete(listener);
  }

  screenshot(): void {
    this.scene.render();
    this.canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = this.container.ownerDocument.createElement('a');
      a.href = url;
      a.download = `ifcviewx-${new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-')}.png`;
      a.click();
      // Revoking in the same task cancels the download on some browsers.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  }

  /** Same frame as screenshot(), handed back instead of downloaded. Downscaling
   *  happens in the same task as the render, while the buffer is still valid. */
  captureImage(maxWidth = 0, type = 'image/png', quality = 0.92): Promise<Blob | null> {
    this.scene.render();
    let source: HTMLCanvasElement = this.canvas;
    if (maxWidth > 0 && this.canvas.width > maxWidth) {
      const scaled = this.container.ownerDocument.createElement('canvas');
      scaled.width = maxWidth;
      scaled.height = Math.max(1, Math.round((this.canvas.height / this.canvas.width) * maxWidth));
      scaled.getContext('2d')?.drawImage(this.canvas, 0, 0, scaled.width, scaled.height);
      source = scaled;
    }
    return new Promise((resolve) => source.toBlob((blob) => resolve(blob), type, quality));
  }

  xrSupported(mode: XrMode): Promise<boolean> {
    return this.xr.supported(mode);
  }

  startXr(mode: XrMode): Promise<void> {
    return this.xr.start(mode);
  }

  exitXr(): Promise<void> {
    return this.xr.end();
  }

  xrMode(): XrMode | null {
    return this.xr.current();
  }

  onXrChange(listener: (mode: XrMode | null) => void): () => void {
    return this.xr.onChange(listener);
  }

  setSun(direction: [number, number, number] | null): void {
    this.scene.setSun(direction);
    this.scene.render();
  }

  getSun(): [number, number, number] | null {
    return this.scene.getSun();
  }

  setPointCloud(positions: Float32Array | null, colors: Float32Array | null = null, size = 0.02): void {
    this.scene.setPointCloud(positions, colors, size);
    this.scene.render();
  }

  setPointCloudSize(size: number): void {
    this.scene.setPointCloudSize(size);
    this.scene.render();
  }

  setPointCloudVisible(visible: boolean): void {
    this.scene.setPointCloudVisible(visible);
    this.scene.render();
  }

  hasPointCloud(): boolean {
    return this.scene.hasPointCloud();
  }

  captureStream(fps = 30): MediaStream | null {
    const canvas = this.canvas as HTMLCanvasElement & { captureStream?: (rate: number) => MediaStream };
    if (typeof canvas.captureStream !== 'function') return null;
    // A frame is only produced when the canvas is drawn to, so a still model
    // records as a still frame rather than as a stalled stream.
    return canvas.captureStream(fps);
  }

  capturePlanImage(size = 1600, type = 'image/png', quality = 0.92): Promise<Blob | null> {
    const canvas = this.scene.capturePlan(size);
    if (!canvas) return Promise.resolve(null);
    return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, quality));
  }

  async downloadPlan(name = 'plan'): Promise<boolean> {
    const blob = await this.capturePlanImage();
    if (!blob) return false;
    const url = URL.createObjectURL(blob);
    const a = this.container.ownerDocument.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\.[^.]+$/, '') || 'plan'}-plan.png`;
    a.click();
    // Revoking in the same task cancels the download on some browsers.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  }

  pickAt(clientX: number, clientY: number): PickResult | null {
    return this.controls.pickAt(clientX, clientY);
  }

  getLastPick(): PickResult | null {
    return this.lastPick ? {
      expressID: this.lastPick.expressID,
      point: [...this.lastPick.point],
      ...(this.lastPick.kind ? { kind: this.lastPick.kind } : {}),
    } : null;
  }

  getCamera(): CameraPose {
    return this.controls.getPose();
  }

  getViewport(): { width: number; height: number; aspect: number } {
    return this.scene.getViewport();
  }

  getResolutionScale(): number {
    return this.scene.getResolutionScale();
  }

  getRendererInfo(): { geometries: number; textures: number; calls: number; triangles: number } {
    return this.scene.getRendererInfo();
  }

  setCamera(pose: CameraPose): void {
    this.controls.setPose(pose);
    this.scene.render();
  }

  resize(width: number, height: number): void {
    this.scene.resize(width, height);
    this.scene.render();
  }

  render(): void {
    this.scene.render();
    this.perfHud.onRender();
  }

  isLoading(): boolean {
    return this.loading;
  }

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    // Stop the headset-owned animation loop and initiate session closure while
    // the renderer it is attached to is still alive.
    this.xr.dispose();
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hoverPending = null;
    this.measuring = false;
    for (const node of this.spanLabels) node.remove();
    for (const node of this.gridLabels) node.remove();
    for (const node of this.noteLabels) node.remove();
    this.flyPanel?.remove();
    this.snapTag?.remove();
    this.planFrame?.remove();
    for (const entry of this.models.values()) this.engine?.dispose(entry.modelID);
    this.models.clear();
    this.engine?.terminate();
    this.engine = null;
    this.initialized = null;
    // Takes the geometry worker with it, if one was ever started.
    this.triangles.dispose();
    this.propertiesPanel?.dispose();
    this.treePanel?.dispose();
    this.perfHud.dispose();
    this.axisGizmo.dispose();
    this.loadingOverlay?.dispose();
    this.errorCard.dispose();
    this.controls.dispose();
    this.scene.dispose();
    if (this.canvas.parentElement === this.container) {
      this.container.removeChild(this.canvas);
    }
  }
}

export function createViewer(container: HTMLElement, options: ViewerOptions = {}): Viewer {
  return new ViewerImpl(container, options);
}
