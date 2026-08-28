// What a running plugin is handed.
//
// The helpers are the whole point: a panel that only calls these keeps working
// when core moves, and the subscriptions it makes are released for it when it
// closes, so a plugin cannot leak a listener into the viewer.
import { expressOf, modelOf } from "../viewer-core/ids.js";
import { toast } from "../ui/kit.js";
import { publishFindings } from "../results/findings.js";
import { classCounts, type PropertyIndex } from "../data/model.js";
import { detectClashes } from "../ifc/clash.js";
import type { ClashOptions, SweepResult } from "../geometry/clash/types.js";
import { measureDistance } from "../geometry/distance.js";
import type { DistanceOptions, DistanceResult } from "../geometry/distance.js";
import { measureLaser } from "../geometry/laser.js";
import type { LaserOptions, LaserResult } from "../geometry/laser.js";
import { extractSectionContours } from "../geometry/section.js";
import type { SectionAxis, SectionContourOptions, SectionContourResult } from "../geometry/section.js";
import { geometrySignatures } from "../geometry/signatures.js";
import type { GeometrySignatureOptions, GeometrySignatureResult } from "../geometry/signatures.js";
import { measureVolumes } from "../geometry/volumes.js";
import { measureSun } from "../geometry/sun.js";
import { measureDeviation } from "../geometry/deviation.js";
import type { DeviationOptions } from "../geometry/deviation.js";
import type { DeviationResult } from "../geometry/types.js";
import type { SunOptions } from "../geometry/sun.js";
import type { SunResult, SunSample } from "../geometry/types.js";
import type { VolumeOptions, VolumesResult } from "../geometry/volumes.js";
import { modelElements } from "../llm/actions.js";
import type {
  ExtensionCapabilities,
  ExtensionEvent,
  ModelElement,
  ModelInfo,
} from "./api.js";
import type { ReportFinding } from "../results/findings.js";
import { publishDocket, type DocketRow } from "../results/docket.js";
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
} from "../viewer-core/viewer.js";
import type { ServiceClient } from "../bridge/serviceClient.js";
import { applySavedView as applySavedViewDefinition, normalizeView } from "../views/definition.js";
import type {
  ApplyReport,
  SavedViewApplyOptions,
  ViewDefinition,
} from "../views/definition.js";
import type { ColorRule } from "../views/color.js";

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
  taskGraph(): ReturnType<Viewer["getTaskGraph"]>;
  tree(): SpatialNode | null;
  subtree(id: number): number[];
  bounds(id: number): ModelBounds | null;
  clash(a: number[], b: number[], options?: ClashOptions): Promise<SweepResult>;
  distance(a: number, b: number, options?: DistanceOptions): Promise<DistanceResult>;
  laser(origin: [number, number, number], options?: LaserOptions): Promise<LaserResult>;
  sectionContours(axis: SectionAxis, offset: number, options?: SectionContourOptions): Promise<SectionContourResult>;
  geometrySignatures(ids: number[], options?: GeometrySignatureOptions): Promise<GeometrySignatureResult>;
  volumes(ids: number[], options?: VolumeOptions): Promise<VolumesResult>;
  deviation(points: Float64Array, options?: DeviationOptions): Promise<DeviationResult>;
  sun(
    samples: SunSample[],
    directions: Array<[number, number, number]>,
    stepMinutes: number,
    options?: SunOptions,
  ): Promise<SunResult>;
  select(ids: number | number[] | null): void;
  selection(): number[];
  lastPick(): PickResult | null;
  setPickGuide(on: boolean): void;
  isVisible(id: number): boolean;
  rules(): ReturnType<Viewer["getRules"]>;
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
  modelBox(): SectionBox | null;
  georeferencedToScene(point: [number, number, number]): [number, number, number] | null;
  models(): FederatedModel[];
  setModelVisible(index: number, visible: boolean): void;
  modelOf(id: number): number;
  expressOf(id: number): number;
  colorBy(assignment: Map<number, number>, colors: Array<[number, number, number]>): void;
  measurements(): Measurement[];
  addMeasurement(a: [number, number, number], b: [number, number, number]): Measurement;
  removeMeasurement(id: number): void;
  setSun(direction: [number, number, number] | null): void;
  setPointCloud(positions: Float32Array | null, colors?: Float32Array | null, size?: number): void;
  setPointCloudSize(size: number): void;
  setPointCloudVisible(visible: boolean): void;
  capture(maxWidth?: number, type?: string, quality?: number): Promise<Blob | null>;
  recordStart(fps?: number): boolean;
  recordStop(): Promise<Blob | null>;
  applySavedView(view: ViewDefinition, options?: SavedViewApplyOptions): Promise<ApplyReport>;
  on(event: ExtensionEvent, handler: () => void): () => void;
  publishFindings(summary: string, findings: ReportFinding[]): void;
  publishResults(set: { title: string; summary: string; rows: DocketRow[] }): void;
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
  setColorRule(rule: ColorRule | null): Promise<void>;
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

/**
 * One recorder for the session. Two panels recording the same canvas at once
 * would fight over the stream, so the second is told the first has it.
 */
const recorder = (() => {
  let media: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let stream: MediaStream | null = null;
  return {
    start(viewer: Viewer, fps = 30): boolean {
      if (media) return false;
      if (typeof MediaRecorder === "undefined") return false;
      stream = viewer.captureStream(fps);
      if (!stream) return false;
      // VP9 where it exists, whatever the browser prefers where it does not.
      const preferred = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"];
      const type = preferred.find((candidate) => MediaRecorder.isTypeSupported?.(candidate));
      try {
        media = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
      } catch {
        stream.getTracks().forEach((track) => track.stop());
        stream = null;
        return false;
      }
      chunks = [];
      media.ondataavailable = (event) => {
        if (event.data.size > 0) chunks.push(event.data);
      };
      media.start(200);
      return true;
    },
    stop(): Promise<Blob | null> {
      const active = media;
      if (!active) return Promise.resolve(null);
      return new Promise((resolve) => {
        active.onstop = () => {
          const blob = new Blob(chunks, { type: active.mimeType || "video/webm" });
          chunks = [];
          media = null;
          stream?.getTracks().forEach((track) => track.stop());
          stream = null;
          resolve(blob);
        };
        active.stop();
      });
    },
  };
})();

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
    taskGraph: () => viewer.getTaskGraph(),
    tree: () => viewer.getSpatialTree(),
    subtree: (expressID) => viewer.getSubtreeElementIds(expressID),
    bounds: (expressID) => viewer.getElementBounds(expressID),
    clash: (a, b, options) => detectClashes(viewer, a, b, options),
    distance: (a, b, options) => measureDistance(viewer, a, b, options),
    laser: (origin, options) => measureLaser(viewer, origin, options),
    sectionContours: (axis, offset, options) => extractSectionContours(viewer, axis, offset, options),
    geometrySignatures: (ids, options) => geometrySignatures(viewer, ids, options),
    volumes: (ids, options) => measureVolumes(viewer, ids, options),
    sun: (samples, directions, stepMinutes, options) => measureSun(viewer, samples, directions, stepMinutes, options),
    deviation: (points, options) => measureDeviation(viewer, points, options),

    select: (ids) => {
      if (ids === null) viewer.clearSelection();
      else if (typeof ids === "number") viewer.select(ids);
      else viewer.selectMany(ids);
    },
    selection: () => viewer.getSelectedIds(),
    lastPick: () => viewer.getLastPick(),
    setPickGuide: (on) => viewer.setPickGuide(on),
    isVisible: (id) => viewer.isElementVisible(id),
    rules: () => viewer.getRules(),
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
    modelBox: () => (viewer.getStats() ? viewer.getModelBox() : null),
    georeferencedToScene: (point) => viewer.georeferencedToScene(point),
    models: () => viewer.getModels(),
    setModelVisible: (index, visible) => viewer.setModelVisible(index, visible),
    modelOf,
    expressOf,
    setSun: (direction) => viewer.setSun(direction),
    setPointCloud: (positions, colors, size) => viewer.setPointCloud(positions, colors, size),
    setPointCloudSize: (size) => viewer.setPointCloudSize(size),
    setPointCloudVisible: (visible) => viewer.setPointCloudVisible(visible),
    capture: (maxWidth, type, quality) => viewer.captureImage(maxWidth, type, quality),
    recordStart: (fps) => recorder.start(viewer, fps),
    recordStop: () => recorder.stop(),
    applySavedView: async (view, options) => {
      const normalized = normalizeView(view);
      if (!normalized) throw new TypeError("Invalid saved-view definition");
      return await applySavedViewDefinition(normalized, {
        viewer,
        index: deps.index(),
        setColorRule: deps.setColorRule,
      }, options);
    },
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
    // One set per panel: a second run replaces the first rather than stacking
    // two dockets a reviewer then has to tell apart.
    publishResults: (set) =>
      publishDocket({ id: `plugin:${manifest.id}`, producer: manifest.name, title: set.title, summary: set.summary, rows: set.rows }),
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
