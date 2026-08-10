// What a running plugin is handed.
//
// The helpers are the whole point: a panel that only calls these keeps working
// when core moves, and the subscriptions it makes are released for it when it
// closes, so a plugin cannot leak a listener into the viewer.
import { expressOf, modelOf } from "../../viewer-core/ids.js";
import { toast } from "../../ui/kit.js";
import { publishFindings } from "../../ui/findings.js";
import { classCounts, type PropertyIndex } from "../../sdk/data.js";
import { detectClashes } from "../../ifc/clash.js";
import type { ClashOptions, SweepResult } from "../../ifc/clash.js";
import { measureDistance } from "../../geometry/distance.js";
import type { DistanceOptions, DistanceResult } from "../../geometry/distance.js";
import { measureLaser } from "../../geometry/laser.js";
import type { LaserOptions, LaserResult } from "../../geometry/laser.js";
import { extractSectionContours } from "../../geometry/section.js";
import type { SectionAxis, SectionContourOptions, SectionContourResult } from "../../geometry/section.js";
import { geometrySignatures } from "../../geometry/signatures.js";
import type { GeometrySignatureOptions, GeometrySignatureResult } from "../../geometry/signatures.js";
import { modelElements } from "../../llm/actions.js";
import type {
  ExtensionCapabilities,
  ExtensionEvent,
  ModelElement,
  ModelInfo,
} from "../../sdk/types.js";
import type { ReportFinding } from "../../ui/report.js";
import type {
  CameraPose,
  FederatedModel,
  ItemProperties,
  Measurement,
  ModelBounds,
  PickResult,
  SectionBox,
  SectionState,
  SpatialNode,
  Viewer,
  ViewPreset,
} from "../../viewer-core/viewer.js";
import type { ServiceClient } from "../../bridge/serviceClient.js";

export interface PythonRunner {
  runsNatively(): boolean;
  query(code: string, onStatus?: (text: string) => void): Promise<string>;
  propose(code: string, onStatus?: (text: string) => void): Promise<string>;
}

export interface HostContext {
  readonly viewer: Viewer;
  readonly service: ServiceClient;
  readonly python: PythonRunner;
  readonly capabilities: ExtensionCapabilities;
  model(): ModelInfo;
  elements(): ModelElement[];
  classes(): Array<[string, number]>;
  index(): PropertyIndex;
  properties(id: number): Promise<ItemProperties | null>;
  tree(): SpatialNode | null;
  subtree(id: number): number[];
  bounds(id: number): ModelBounds | null;
  clash(a: number[], b: number[], options?: ClashOptions): Promise<SweepResult>;
  distance(a: number, b: number, options?: DistanceOptions): Promise<DistanceResult>;
  laser(origin: [number, number, number], options?: LaserOptions): Promise<LaserResult>;
  sectionContours(axis: SectionAxis, offset: number, options?: SectionContourOptions): Promise<SectionContourResult>;
  geometrySignatures(ids: number[], options?: GeometrySignatureOptions): Promise<GeometrySignatureResult>;
  select(ids: number | number[] | null): void;
  selection(): number[];
  lastPick(): PickResult | null;
  setPickGuide(on: boolean): void;
  isVisible(id: number): boolean;
  isolate(ids: number[], label?: string): void;
  hide(ids: number[]): void;
  showAll(): void;
  frame(id?: number): void;
  frameAt(point: [number, number, number], radius?: number): void;
  viewFrom(view: ViewPreset): void;
  camera(): CameraPose;
  setCamera(pose: CameraPose): void;
  sections(): SectionState[];
  setSections(states: SectionState[]): void;
  sectionBox(): SectionBox | null;
  setSectionBox(box: SectionBox | null): void;
  boxAround(ids: number[], pad?: number): SectionBox | null;
  models(): FederatedModel[];
  setModelVisible(index: number, visible: boolean): void;
  modelOf(id: number): number;
  expressOf(id: number): number;
  colorBy(assignment: Map<number, number>, colors: Array<[number, number, number]>): void;
  measurements(): Measurement[];
  addMeasurement(a: [number, number, number], b: [number, number, number]): Measurement;
  removeMeasurement(id: number): void;
  on(event: ExtensionEvent, handler: () => void): () => void;
  publishFindings(summary: string, findings: ReportFinding[]): void;
  log(text: string, kind?: "info" | "success" | "error"): void;
  toast(text: string, kind?: "info" | "success" | "error"): void;
  run(commandId: string): void;
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
  close(): void;
}

export interface ContextDeps {
  viewer: Viewer;
  service: ServiceClient;
  python: PythonRunner;
  capabilities: ExtensionCapabilities;
  index(): PropertyIndex;
  modelKey(): string;
  modelName(): string;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  close(id: string): void;
  /** Model and service changes reach the host first; the viewer owns the rest. */
  hostEvent(event: "model" | "service", handler: () => void): () => void;
}

export interface ScopedHostContext {
  ctx: HostContext;
  /** Drops every subscription the plugin made through `on`. */
  release(): void;
}

export function createHostContext(manifest: { id: string; name: string }, deps: ContextDeps): ScopedHostContext {
  const bag: Array<() => void> = [];
  const scope = (key: string): string => `ifcviewx.plug.${manifest.id}.${key}`;
  const { viewer } = deps;

  const subscribe = (event: ExtensionEvent, handler: () => void): (() => void) => {
    switch (event) {
      case "selection":
        return viewer.onSelectionChange(() => handler());
      case "visibility":
        return viewer.onVisibilityChange(handler);
      case "section":
        return viewer.onSectionChange(handler);
      case "measure":
        return viewer.onMeasureChange(handler);
      default:
        return deps.hostEvent(event, handler);
    }
  };

  const ctx: HostContext = {
    viewer,
    service: deps.service,
    python: deps.python,
    capabilities: deps.capabilities,

    model: () => ({ key: deps.modelKey(), name: deps.modelName(), loaded: deps.modelKey() !== "" }),

    elements: () => modelElements(viewer),
    classes: () => classCounts(modelElements(viewer)),
    index: () => deps.index(),
    properties: (expressID) => viewer.getProperties(expressID),
    tree: () => viewer.getSpatialTree(),
    subtree: (expressID) => viewer.getSubtreeElementIds(expressID),
    bounds: (expressID) => viewer.getElementBounds(expressID),
    clash: (a, b, options) => detectClashes(viewer, a, b, options),
    distance: (a, b, options) => measureDistance(viewer, a, b, options),
    laser: (origin, options) => measureLaser(viewer, origin, options),
    sectionContours: (axis, offset, options) => extractSectionContours(viewer, axis, offset, options),
    geometrySignatures: (ids, options) => geometrySignatures(viewer, ids, options),

    select: (ids) => {
      if (ids === null) viewer.clearSelection();
      else if (typeof ids === "number") viewer.select(ids);
      else viewer.selectMany(ids);
    },
    selection: () => viewer.getSelectedIds(),
    lastPick: () => viewer.getLastPick(),
    setPickGuide: (on) => viewer.setPickGuide(on),
    isVisible: (id) => viewer.isElementVisible(id),
    isolate: (ids, label) => viewer.isolate(ids, label),
    hide: (ids) => viewer.setHidden(ids, true),
    showAll: () => viewer.showAll(),
    frame: (expressID) => {
      if (expressID === undefined) viewer.fitToModel();
      else viewer.fitToElement(expressID);
    },
    frameAt: (point, radius) => viewer.fitToPoint(point, radius),
    viewFrom: (view) => viewer.viewFrom(view),
    camera: () => viewer.getCamera(),
    setCamera: (pose) => viewer.setCamera(pose),
    sections: () => viewer.getSections(),
    setSections: (states) => viewer.setSections(states),
    sectionBox: () => viewer.getSectionBox(),
    setSectionBox: (box) => viewer.setSectionBox(box),
    boxAround: (ids, pad) => viewer.boxAround(ids, pad),
    models: () => viewer.getModels(),
    setModelVisible: (index, visible) => viewer.setModelVisible(index, visible),
    modelOf,
    expressOf,
    colorBy: (assignment, colors) => {
      if (assignment.size) viewer.setColorOverride(assignment, colors);
      else viewer.clearColorOverride();
    },

    on: (event, handler) => {
      const unsubscribe = subscribe(event, handler);
      let live = true;
      const off = (): void => {
        if (!live) return;
        live = false;
        const index = bag.indexOf(off);
        if (index >= 0) bag.splice(index, 1);
        unsubscribe();
      };
      bag.push(off);
      return off;
    },
    measurements: () => viewer.getMeasurements(),
    addMeasurement: (a, b) => viewer.addMeasurement(a, b),
    removeMeasurement: (id) => viewer.removeMeasurement(id),
    // Findings are keyed by plugin id, so a re-run replaces the last set
    // rather than stacking a second copy into the report.
    publishFindings: (summary, findings) =>
      publishFindings({ id: manifest.id, source: manifest.name, summary, findings }),
    log: (text, kind) => deps.log(text, kind),
    toast: (text, kind) => toast(text, kind),
    run: (commandId) => deps.runCommand(commandId),

    read: <T,>(key: string, fallback: T): T => {
      try {
        const raw = localStorage.getItem(scope(key));
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    write: (key, value) => {
      try {
        localStorage.setItem(scope(key), JSON.stringify(value));
      } catch {
        deps.log(`${manifest.name} could not save its state (storage is full)`, "error");
      }
    },
    close: () => deps.close(manifest.id),
  };

  return {
    ctx,
    release: () => {
      for (const off of bag.splice(0)) {
        try {
          off();
        } catch {
          // an unsubscribe that throws must not keep the rest subscribed
        }
      }
    },
  };
}
