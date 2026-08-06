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
import type { CameraPose, SceneInfo, SnapHit, SnapKind } from './scene/scene.js';
import type { PickResult, ViewPreset } from './scene/controls.js';
import type {
  AsyncIfcEngine,
  ItemProperties,
  LazyCategory,
  LoadProgress,
  LoadSource,
  LoadedModel,
  ModelBounds,
  ModelStats,
  SpatialNode,
} from './engine/types.js';

export * from './engine/types.js';
export type { CameraPose, SceneInfo, SnapHit, SnapKind } from './scene/scene.js';
export type { ViewPreset } from './scene/controls.js';

export interface SectionState {
  axis: 'x' | 'y' | 'z';
  offset: number;
  flip: boolean;
}

/** How a new selection combines with the current one. */
export type SelectMode = 'replace' | 'add' | 'remove' | 'toggle';

/**
 * What the measure tool pulls a placed point onto. Auto takes a corner first,
 * then an edge midpoint, then the point along the edge; vertex takes corners
 * only, for measuring a grid of them; off measures the raw surface.
 */
export type SnapMode = 'auto' | 'vertex' | 'off';

/** One measurement. Distances are in the viewer's units, i.e. metres. */
export interface Measurement {
  /** Handle for removeMeasurement; 0 while the span still follows the cursor. */
  id: number;
  distance: number;
  /** Split into the ground plane and the height, the way a builder reads it. */
  horizontal: number;
  vertical: number;
  /** False while the far end is still following the cursor. */
  complete: boolean;
  /** What each end caught; the far end is null until it is placed. */
  ends: [SnapKind, SnapKind | null];
}

/** What the measure tool is collecting: two points, three, or a ring of them. */
export type MeasureMode = 'distance' | 'angle' | 'area';

/** A finished angle or area. Distances are metres, angles degrees. */
export interface ShapeMeasure {
  id: number;
  kind: 'angle' | 'area';
  points: Array<[number, number, number]>;
  /** Angle at the middle point, degrees. Only for `angle`. */
  angle?: number;
  /** Newell area of the ring, m2. Only for `area`. */
  area?: number;
  /** Total edge length, closing edge included for an area. */
  perimeter: number;
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

export function formatArea(squareMetres: number): string {
  if (!Number.isFinite(squareMetres)) return '-';
  if (squareMetres >= 1) return `${squareMetres.toFixed(squareMetres >= 100 ? 1 : 2)} m2`;
  return `${Math.round(squareMetres * 10000)} cm2`;
}

/** Metres, dropping to millimetres below one, so short spans stay readable. */
export function formatLength(metres: number): string {
  if (!Number.isFinite(metres)) return '-';
  if (metres >= 1) return `${metres.toFixed(metres >= 100 ? 1 : 2)} m`;
  return `${Math.round(metres * 1000)} mm`;
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
}

/** One point in the visibility history: everything `applyVisibility` reads. */
interface VisibilityStep {
  rules: VisibilityRule[];
  hidden: number[];
}

const VISIBILITY_HISTORY_LIMIT = 50;

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
  /** Offset subtracted from IFC coordinates to keep large models precise. */
  getModelOrigin(): [number, number, number];
  isElementVisible(expressID: number): boolean;
  /** Lazy categories (spaces/openings), hidden by default. Resolves when loaded. */
  setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void>;
  isCategoryVisible(category: LazyCategory): boolean;
  /** Performance HUD visibility. */
  setPerfHud(visible: boolean): void;
  /** Re-read the host's theme variables and recolor the viewport. */
  updateTheme(): void;
  fitToModel(): CameraPose;
  fitToElement(expressID: number): CameraPose | null;
  /** Frame the model from a preset direction. */
  viewFrom(view: ViewPreset): void;
  /** Axis-aligned section plane; replaces whatever is active. */
  setSection(state: SectionState): void;
  /** Any combination of the three axes at once (empty clears). */
  setSections(states: SectionState[]): void;
  getSections(): SectionState[];
  /** Fires when a viewport handle drag moved a plane. */
  onSectionChange(listener: () => void): () => void;
  clearSection(): void;
  getSection(): SectionState | null;
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
  removeShapeMeasure(id: number): void;

  /** Two-click distance measurement; returns the new mode state. */
  toggleMeasure(): boolean;
  setMeasuring(on: boolean): void;
  isMeasuring(): boolean;
  /** Which geometry features a measured point is pulled onto. */
  setSnapMode(mode: SnapMode): void;
  getSnapMode(): SnapMode;
  /** The span in hand, or the last placed one; null before the first point. */
  getMeasurement(): Measurement | null;
  /** Every placed span, oldest first. Spans stack until reset or removed. */
  getMeasurements(): Measurement[];
  /** Remove one placed span by its id. */
  removeMeasurement(id: number): void;
  /** Drop every span and the point in hand without leaving measure mode. */
  resetMeasure(): void;
  /** Fires when the measurement, the snap mode or the tool state changed. */
  onMeasureChange(listener: () => void): () => void;
  /** Render and download the viewport as a PNG. */
  screenshot(): void;
  /** Render the viewport to an image, optionally downscaled. */
  captureImage(maxWidth?: number, type?: string, quality?: number): Promise<Blob | null>;
  /** Performance settings. */
  setRenderScale(scale: number): void;
  setAdaptiveResolution(on: boolean): void;
  setDoubleSided(on: boolean): void;
  getRenderTiming(): { lastMs: number; rendersLastSecond: number };
  /** Fires after every render pass; for status readouts. */
  onRenderTick(listener: () => void): () => void;
  pickAt(clientX: number, clientY: number): PickResult | null;
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
  dispose(): void;
}

/** Minimum ms between renders while mesh batches stream in. */
const PROGRESSIVE_RENDER_INTERVAL = 150;
/** Elements whose properties stay resident; selection revisits are common. */
const PROPS_CACHE_SIZE = 200;
/** What the cursor tag calls each snap result. */
const SNAP_LABEL: Record<SnapKind, string> = {
  vertex: 'Corner',
  midpoint: 'Midpoint',
  edge: 'Edge',
  surface: 'Surface',
};

class ViewerImpl implements Viewer {
  private engine: AsyncIfcEngine | null = null;
  private readonly scene: SceneController;
  private readonly controls: ViewerControls;
  private readonly canvas: HTMLCanvasElement;
  private readonly propertiesPanel: PropertiesPanel | null;
  private readonly treePanel: TreePanel | null;
  private readonly perfHud: PerfHud;
  private readonly axisGizmo: AxisGizmo;
  private readonly loadingOverlay: LoadingOverlay | null;
  private readonly errorCard: ErrorCard;
  private initialized: Promise<AsyncIfcEngine> | null = null;
  private currentModelID: number | null = null;
  private stats: ModelStats | null = null;
  private timeline: LoadTimeline | null = null;
  private ready = false;
  private loading = false;
  private loadToken = 0;
  private readonly selection = new Set<number>();
  private primary: number | null = null;
  /** Visibility layers: named rules plus elements hidden one at a time. */
  private rules: VisibilityRule[] = [];
  private readonly hiddenIds = new Set<number>();
  private ruleSeq = 0;
  private visPast: VisibilityStep[] = [];
  private visFuture: VisibilityStep[] = [];
  private cachedTree: SpatialNode | null = null;
  private measuring = false;
  /** Placed spans, oldest first; they stack until removed or reset. */
  private spans: Array<{
    id: number;
    a: [number, number, number];
    b: [number, number, number];
    ends: [SnapKind, SnapKind];
  }> = [];
  private spanSeq = 0;
  /** First point of the span in hand, if one is being placed. */
  private measureA: [number, number, number] | null = null;
  private measureAKind: SnapKind | null = null;
  private measureMode: MeasureMode = 'distance';
  /** Points placed toward the angle or ring in hand. */
  private chain: Array<[number, number, number]> = [];
  private shapes: ShapeMeasure[] = [];
  private shapeSeq = 0;
  private measureHover: SnapHit | null = null;
  /** True while the gesture that placed the first point is still running. */
  private measureOpening = false;
  private snapMode: SnapMode = 'auto';
  private hoverPending: [number, number] | null = null;
  private hoverFrame = 0;
  /** One distance label per drawn span, pooled like the scene's markers. */
  private readonly spanLabels: HTMLElement[] = [];
  private snapTag: HTMLElement | null = null;
  private readonly measureListeners = new Set<() => void>();
  private planFrame: HTMLElement | null = null;
  private planSize = 0;
  private sections: SectionState[] = [];
  private drag: { axis: SectionState['axis']; grabbed: number; base: number } | null = null;
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
      onPick: (pick, additive) => {
        if (!pick) return additive ? undefined : this.clearSelection();
        this.selectMany([pick.expressID], additive ? 'toggle' : 'replace');
      },
      // Escape drops the span in hand first, and only then the tool itself.
      onEscape: () => {
        if (!this.measuring) return this.clearSelection();
        // Escape drops the shape in hand first, then leaves the tool, so a
        // misplaced point never costs the whole session.
        if (this.chain.length) {
          this.chain = [];
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
        const axis = this.scene.pickSectionHandle(x, y);
        const grabbed = axis === null ? null : this.scene.dragSectionOffset(axis, x, y);
        const base = this.sections.find((s) => s.axis === axis)?.offset;
        if (axis === null || grabbed === null || base === undefined) return false;
        this.drag = { axis, grabbed, base };
        this.container.classList.add('ifc-dragging-section');
        return true;
      },
      onHandleDrag: (x, y) => {
        if (!this.drag) return;
        const now = this.scene.dragSectionOffset(this.drag.axis, x, y);
        if (now === null) return;
        const offset = this.scene.clampSectionOffset(this.drag.axis, this.drag.base + (now - this.drag.grabbed));
        this.setSections(
          this.sections.map((s) => (s.axis === this.drag?.axis ? { ...s, offset } : s)),
        );
      },
      onHandleUp: () => {
        this.drag = null;
        this.container.classList.remove('ifc-dragging-section');
      },
      onHover: (x, y, clientX, clientY) => {
        const over = this.scene.pickSectionHandle(x, y) !== null;
        this.container.classList.toggle('ifc-over-handle', over);
        if (this.measuring) this.queueMeasureHover(clientX, clientY);
      },
    });
    this.axisGizmo = new AxisGizmo(this.container, this.scene.camera, {
      getPose: () => this.controls.getPose(),
      setPose: (pose) => this.controls.setPose(pose),
    });
    this.scene.onAfterRender = () => {
      this.axisGizmo.sync();
      this.syncMeasureOverlay();
      this.syncPlanFrame();
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
    if (this.currentModelID !== null) {
      engine.dispose(this.currentModelID);
      this.currentModelID = null;
    }
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
    if (this.sections.length) {
      this.sections = [];
      this.emitSection();
    }
    this.setMeasuring(false);
    this.resetMeasure();
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

      this.currentModelID = meta.modelID;
      this.stats = { ...meta.stats, uploadMs };
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
    if (this.currentModelID !== null) {
      this.engine?.dispose(this.currentModelID);
      this.currentModelID = null;
    }
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
    if (this.sections.length) {
      this.sections = [];
      this.emitSection();
    }
    this.setPlanView(false);
    this.setMeasuring(false);
    this.resetMeasure();
    this.syncMeasureOverlay();
    for (const listener of this.modelLoadedListeners) listener();
    this.commitVisibility();
  }

  getStats(): ModelStats | null {
    return this.stats;
  }

  async getCountsByType(): Promise<Record<string, number>> {
    if (this.stats?.countsByType) return this.stats.countsByType;
    if (this.currentModelID === null || !this.engine) return {};
    const token = this.loadToken;
    const counts = await this.engine.getCountsByType(this.currentModelID);
    // Counts for the model that was open when this started say nothing about
    // the one that replaced it while it ran.
    if (token !== this.loadToken) return {};
    if (this.stats) this.stats.countsByType = counts;
    return counts;
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
    if (this.currentModelID === null || !this.engine) return null;
    const hit = this.propsCache.get(expressID);
    if (hit !== undefined) return hit;
    const token = this.loadToken;
    let props: ItemProperties | null;
    try {
      props = await this.engine.getItemProperties(this.currentModelID, expressID);
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

  getModelOrigin(): [number, number, number] {
    return this.scene.getModelOrigin();
  }

  isElementVisible(expressID: number): boolean {
    return this.scene.isElementVisible(expressID);
  }

  async setCategoryVisible(category: LazyCategory, visible: boolean): Promise<void> {
    if (this.currentModelID === null || !this.engine) return;
    // Flag first so isCategoryVisible reflects the toggle immediately; meshes
    // stream in behind it.
    this.scene.setCategoryVisible(category, visible);
    if (visible && !this.loadedCategories.has(category)) {
      const token = this.loadToken;
      this.loadedCategories.add(category);
      try {
        await this.engine.loadCategory(this.currentModelID, category, (meshes) => {
          // A model switch mid-stream would otherwise pour the old model's
          // spaces into the new model's batcher.
          if (token === this.loadToken) this.scene.addMeshes(meshes);
        });
      } catch (err) {
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

  viewFrom(view: ViewPreset): void {
    this.controls.viewFrom(view);
    this.scene.render();
  }

  setSection(state: SectionState): void {
    this.setSections([state]);
  }

  setSections(states: SectionState[]): void {
    // One plane per axis: a second X plane would just fight the first.
    const byAxis = new Map(states.map((state) => [state.axis, state]));
    this.sections = [...byAxis.values()];
    this.scene.setClipPlanes(this.sections);
    this.scene.setSectionHandles(this.sections);
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
    this.scene.clearClipPlane();
    this.scene.setSectionHandles([]);
    this.scene.render();
    this.emitSection();
  }

  getSection(): SectionState | null {
    return this.sections[0] ?? null;
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
      this.planFrame.innerHTML = '<span>Plan</span>';
      this.container.appendChild(this.planFrame);
      this.planSize = 0;
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
    if (on === this.measuring) return;
    this.measuring = on;
    this.container.classList.toggle('ifc-measuring', on);
    this.controls.setToolActive(on);
    if (!on) return this.resetMeasure();
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
    // pushMeasure, not emitMeasure: the scene still holds the old hover dot.
    this.pushMeasure();
  }

  getSnapMode(): SnapMode {
    return this.snapMode;
  }

  resetMeasure(): void {
    this.spans = [];
    this.shapes = [];
    this.chain = [];
    this.cancelPending();
  }

  /** Drop the point in hand; placed spans stay. */
  private cancelPending(): void {
    this.measureA = null;
    this.measureAKind = null;
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
  ): Measurement {
    if (!end) return { id, distance: 0, horizontal: 0, vertical: 0, complete, ends };
    const [dx, dy, dz] = [end[0] - a[0], end[1] - a[1], end[2] - a[2]];
    return {
      id,
      distance: Math.hypot(dx, dy, dz),
      horizontal: Math.hypot(dx, dz),
      vertical: Math.abs(dy),
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
    const last = this.spans[this.spans.length - 1];
    return last ? this.spanMetrics(last.a, last.b, last.ends, last.id, true) : null;
  }

  getMeasurements(): Measurement[] {
    return this.spans.map((span) => this.spanMetrics(span.a, span.b, span.ends, span.id, true));
  }

  removeMeasurement(id: number): void {
    const before = this.spans.length;
    this.spans = this.spans.filter((span) => span.id !== id);
    if (this.spans.length !== before) this.pushMeasure();
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
    // arm the gesture and keep the hover honest.
    if (this.measureMode !== 'distance') {
      this.measureOpening = this.chain.length === 0;
      return this.queueMeasureHover(clientX, clientY);
    }
    if (this.measureA) {
      this.measureOpening = false; // this gesture closes the span
      return this.queueMeasureHover(clientX, clientY);
    }
    const hit = this.probe(clientX, clientY);
    if (!hit) return; // a press on nothing keeps what is already measured
    this.measureA = hit.point;
    this.measureAKind = hit.kind;
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
    const hit = this.probe(clientX, clientY) ?? this.measureHover;
    if (!hit) return;
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

    this.chain.push(point);
    if (last) {
      this.spans.push({ id: ++this.spanSeq, a: last, b: point, ends: ['surface', hit.kind] });
    }
    this.measureHover = hit;
    if (this.measureMode === 'angle' && this.chain.length === 3) {
      const [a, b, c] = this.chain;
      this.shapes.push({
        id: ++this.shapeSeq,
        kind: 'angle',
        points: [a, b, c],
        angle: angleAt(a, b, c),
        perimeter: ringPerimeter([a, b, c], false),
      });
      this.chain = [];
    }
    this.pushMeasure();
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
    this.spans.push({
      id: ++this.spanSeq,
      a: points[points.length - 1],
      b: points[0],
      ends: ['surface', 'surface'],
    });
    this.shapes.push({
      id: ++this.shapeSeq,
      kind: 'area',
      points: [...points],
      area: ringArea(points),
      perimeter: ringPerimeter(points, true),
    });
    this.chain = [];
    this.pushMeasure();
    return true;
  }

  setMeasureMode(mode: MeasureMode): void {
    if (this.measureMode === mode) return;
    this.measureMode = mode;
    // A half-drawn shape means nothing in the mode that replaces it.
    this.chain = [];
    this.measureA = null;
    this.measureAKind = null;
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
    if (this.shapes.length !== before) this.pushMeasure();
  }

  private measureUp(clientX: number, clientY: number, moved: boolean): void {
    if (!this.measuring) return;
    if (this.measureMode !== 'distance') {
      if (this.measureOpening && !moved) return;
      return this.chainUp(clientX, clientY);
    }
    if (!this.measureA) return;
    if (this.measureOpening && !moved) return;
    const hit = this.probe(clientX, clientY) ?? this.measureHover;
    if (!hit) return;
    const a = this.measureA;
    // A second click on the very same point is not a span; keep waiting.
    if (hit.point[0] === a[0] && hit.point[1] === a[1] && hit.point[2] === a[2]) return;
    this.spans.push({
      id: ++this.spanSeq,
      a,
      b: hit.point,
      ends: [this.measureAKind ?? 'surface', hit.kind],
    });
    this.measureA = null;
    this.measureAKind = null;
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
    this.hoverPending = [clientX, clientY];
    if (this.hoverFrame) return;
    this.hoverFrame = requestAnimationFrame(() => {
      this.hoverFrame = 0;
      const at = this.hoverPending;
      this.hoverPending = null;
      if (!at || !this.measuring) return;
      const next = this.probe(at[0], at[1]);
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

  /** Hand every span to the overlay and tell the panels about them. */
  private pushMeasure(): void {
    this.scene.setMeasure(
      this.spans,
      this.measureA ? { a: this.measureA, end: this.measureHover?.point ?? null } : null,
      this.measuring ? this.measureHover?.point ?? null : null,
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

    const entries: Array<{ text: string; at: [number, number, number] }> = [];
    for (const span of this.spans) {
      entries.push({ text: formatLength(length(span.a, span.b)), at: mid(span.a, span.b) });
    }
    const end = this.measureHover?.point ?? null;
    if (this.measureA && end && length(this.measureA, end) > 0) {
      entries.push({ text: formatLength(length(this.measureA, end)), at: mid(this.measureA, end) });
    }
    while (this.spanLabels.length < entries.length) {
      const node = this.container.ownerDocument.createElement('div');
      node.className = 'ifc-measure-label';
      this.container.appendChild(node);
      this.spanLabels.push(node);
    }
    this.spanLabels.forEach((node, index) => this.placeLabel(node, entries[index] ?? null));

    // With snapping off every point is a surface point, so naming it is noise.
    const hover = this.measuring && this.snapMode !== 'off' ? this.measureHover : null;
    if (hover && !this.snapTag) {
      this.snapTag = this.container.ownerDocument.createElement('div');
      this.snapTag.className = 'ifc-snap-tag';
      this.container.appendChild(this.snapTag);
    }
    if (this.snapTag) {
      this.placeLabel(this.snapTag, hover ? { text: SNAP_LABEL[hover.kind], at: hover.point } : null);
    }
  }

  /** Park a label over a world point, or hide it when there is nothing to say. */
  private placeLabel(
    node: HTMLElement,
    entry: { text: string; at: [number, number, number] } | null,
  ): void {
    if (!entry) {
      node.style.display = 'none';
      return;
    }
    const screen = this.scene.projectPoint(entry.at);
    node.style.display = screen.behind ? 'none' : 'block';
    node.style.left = `${screen.x}px`;
    node.style.top = `${screen.y}px`;
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

  pickAt(clientX: number, clientY: number): PickResult | null {
    return this.controls.pickAt(clientX, clientY);
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

  isReady(): boolean {
    return this.ready;
  }

  dispose(): void {
    if (this.hoverFrame) cancelAnimationFrame(this.hoverFrame);
    this.hoverFrame = 0;
    this.hoverPending = null;
    this.measuring = false;
    for (const node of this.spanLabels) node.remove();
    this.snapTag?.remove();
    this.planFrame?.remove();
    if (this.currentModelID !== null) {
      this.engine?.dispose(this.currentModelID);
      this.currentModelID = null;
    }
    this.engine?.terminate();
    this.engine = null;
    this.initialized = null;
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
