// The contract between the app and a plugin.
//
// A plugin folder is allowed to know about this file and nothing else in the
// app, which is what lets core be reorganised without breaking anyone's work.
// Everything here is either a plain description of a plugin or a narrow view
// of the viewer, so the surface stays small enough to document on one page.
import type { PropertyIndex } from "./data.js";
import type { ClashOptions, SweepResult } from "../ifc/clash.js";
import type { ReportFinding } from "../ui/report.js";
import type { ServiceClient } from "../bridge/serviceClient.js";
import type {
  FederatedModel,
  ItemProperties,
  ModelBounds,
  SectionBox,
  SectionState,
  SpatialNode,
  Viewer,
  ViewPreset,
} from "../viewer-core/viewer.js";

/**
 * Where a plugin runs. `web` is a panel this tab mounts, `local` needs the
 * Local Studio service, `core` is a tool the app already carries and the
 * catalog only points at.
 */
export type PluginTier = "web" | "local" | "core";

export interface PluginManifest {
  /** Folder name, and the id everything else refers to. */
  id: string;
  name: string;
  /** One line, shown under the name in the catalog. */
  tagline: string;
  /** A paragraph on what it does and why it works the way it does. */
  about: string;
  /** Any name from the app's icon set; `blocks` is the safe default. */
  icon: string;
  category: string;
  tier: PluginTier;
  /** Extra search terms, space separated. */
  keywords: string;
  /** Bullets shown when the entry is expanded. */
  does: string[];
  /** Who wrote it. Absent means it ships with the app. */
  author?: string;
  /** Home page or repository, linked from the catalog. */
  url?: string;
  /** `local`: the service capability that has to be present. */
  capability?: string;
  /** `local` and `core`: the command that opens it. */
  command?: string;
  /**
   * The panel. Left out, the registry wires it to `./panel.js` in the same
   * folder, so a plugin only sets this when its panel lives somewhere else.
   */
  load?: () => Promise<PluginModule>;
  /** Described but not built. Never offers an action. */
  soon?: boolean;
}

export interface PluginModule {
  mount: PluginMount;
}

/**
 * Called once when the plugin opens. Return an object to be told when it
 * closes or is handed something; return nothing if there is nothing to clean
 * up. Subscriptions made through `ctx.on` are released either way.
 */
export type PluginMount = (
  host: HTMLElement,
  ctx: PluginContext,
  payload?: unknown,
) => PluginInstance | void;

export interface PluginInstance {
  dispose?(): void;
  /** Opened again while already running, with something to work on. */
  receive?(payload: unknown): void;
}

export type PluginEvent =
  | "model"
  | "selection"
  | "visibility"
  | "section"
  | "measure"
  | "service";

/** Identity of what is loaded. `key` changes whenever the model does. */
export interface ModelInfo {
  key: string;
  name: string;
  loaded: boolean;
}

/**
 * The edit pipeline. Both calls route through the same tier choice the
 * assistant uses, and an edit is always staged for approval, never applied.
 */
export interface PluginPython {
  /** True when the local service runs this, not this tab. */
  runsNatively(): boolean;
  /** Read-only run; resolves with the text output. */
  query(code: string, onStatus?: (text: string) => void): Promise<string>;
  /** Runs on a copy and stages the result; resolves with the report. */
  propose(code: string, onStatus?: (text: string) => void): Promise<string>;
}

/** One placed element, taken from the spatial tree. */
export interface ModelElement {
  id: number;
  type: string;
  name: string;
  storey: string;
}

/**
 * What a plugin is given. The helpers cover what panels actually do; `viewer`
 * and `service` are underneath them for the cases they do not, and using those
 * is the one thing that can break when core moves.
 */
export interface PluginContext {
  readonly viewer: Viewer;
  readonly service: ServiceClient;
  readonly python: PluginPython;

  model(): ModelInfo;

  // -- reading the model -----------------------------------------------------
  /** Every placed element with its class, name and storey. Cached. */
  elements(): ModelElement[];
  /** Element counts per IFC class, largest first. */
  classes(): Array<[string, number]>;
  /** The full property index, built once and shared by every plugin. */
  index(): PropertyIndex;
  properties(expressID: number): Promise<ItemProperties | null>;
  tree(): SpatialNode | null;
  /** Element ids under a spatial node. */
  subtree(expressID: number): number[];
  bounds(expressID: number): ModelBounds | null;
  /**
   * Triangle-level clash detection between two sets of element ids, run in a
   * worker over the geometry already loaded. Hard clashes come from real mesh
   * intersection; set `clearanceMm` to also catch pairs that pass too close.
   */
  clash(a: number[], b: number[], options?: ClashOptions): Promise<SweepResult>;

  // -- driving the viewport --------------------------------------------------
  select(ids: number | number[] | null): void;
  selection(): number[];
  isolate(ids: number[], label?: string): void;
  hide(ids: number[]): void;
  showAll(): void;
  /** Frame one element, or the whole model when no id is given. */
  frame(expressID?: number): void;
  /** Frame a point in space, such as where two elements collide. */
  frameAt(point: [number, number, number], radius?: number): void;
  viewFrom(view: ViewPreset): void;
  sections(): SectionState[];
  setSections(states: SectionState[]): void;
  /** Six planes at once. Replaces any per-axis section, and vice versa. */
  sectionBox(): SectionBox | null;
  setSectionBox(box: SectionBox | null): void;
  /** A padded box around these elements, or null when none has geometry. */
  boxAround(ids: number[], pad?: number): SectionBox | null;
  /** Colour elements by group; an empty map takes the colouring back off. */
  colorBy(assignment: Map<number, number>, colors: Array<[number, number, number]>): void;

  // -- federated models ------------------------------------------------------
  /**
   * Every open model. Element ids carry their model, so `modelOf(id)` names
   * the file an id came from and a plugin can work per discipline.
   */
  models(): FederatedModel[];
  setModelVisible(index: number, visible: boolean): void;
  /** Which model an element id belongs to, and its raw STEP line number. */
  modelOf(id: number): number;
  expressOf(id: number): number;

  // -- app -------------------------------------------------------------------
  /** Released when the plugin closes, so there is nothing to unsubscribe. */
  on(event: PluginEvent, handler: () => void): void;
  /** Contribute to the offline report. Publishing again replaces the last set. */
  publishFindings(summary: string, findings: ReportFinding[]): void;
  /** A line in the activity log. */
  log(text: string, kind?: "info" | "success" | "error"): void;
  /** A transient message over the viewport. */
  toast(text: string, kind?: "info" | "success" | "error"): void;
  /** Run one of the app's commands by id, such as `file.check`. */
  run(commandId: string): void;
  /** Per-plugin storage, namespaced by id and survives a reload. */
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
  close(): void;
}
