// A view is a definition, not a bookmark.
//
// Viewpoints stored a camera and died with the tab. A view stores the rules
// that produced the state: which elements a filter keeps, what the colour is
// keyed on, where the cuts are. Rules resolve against whatever model is open,
// so the same file applies to next week's revision and to a federation the
// author never saw.
import type { ElementRow, PropertyIndex } from "../data/model.js";
import type { ColorRule } from "./color.js";
import { modelOf } from "../viewer-core/ids.js";
import type {
  AnnotationState,
  CameraPose,
  MeasurementState,
  SectionBox,
  SectionState,
  SpatialNode,
  Viewer,
} from "../viewer-core/viewer.js";

export type TextOp = "is" | "contains" | "starts" | "not" | "exists" | "missing";

/**
 * What a rule selects, written so it can be evaluated against any model.
 * `ids` is the escape hatch for a hand-made selection: it is kept so nothing
 * is lost, and reported as not portable wherever that matters.
 */
export type Selector =
  | { kind: "all" }
  | { kind: "class"; values: string[] }
  | { kind: "storey"; values: string[] }
  | { kind: "model"; values: string[] }
  | { kind: "name"; op: TextOp; value: string }
  | { kind: "property"; set: string; name: string; op: TextOp; value: string }
  | { kind: "ids"; ids: number[] }
  | { kind: "any"; of: Selector[] }
  | { kind: "every"; of: Selector[] }
  | { kind: "not"; of: Selector };

export interface ViewFilter {
  label: string;
  mode: "keep" | "hide";
  selector: Selector;
}

export interface ViewDefinition {
  id: string;
  name: string;
  folder: string;
  description: string;
  filters: ViewFilter[];
  color: ColorRule | null;
  camera: CameraPose | null;
  projection: "perspective" | "orthographic" | null;
  sections: SectionState[];
  box: SectionBox | null;
  /** Elements drawn see-through, by rule. */
  xray: Selector | null;
  /** Elements hidden one at a time at capture time. */
  hidden: Selector | null;
  offsets: Array<[number, [number, number, number]]>;
  annotations: AnnotationState[];
  measurements: MeasurementState[];
  categories: { spaces: boolean; openings: boolean };
  ghostHidden: boolean;
  /** Small JPEG data URL, or empty when the viewport could not be captured. */
  thumbnail: string;
  updatedAt: string;
}

export const VIEW_FILE_FORMAT = "ifcviewx.views";
export const VIEW_FILE_VERSION = 1;

export interface ViewFile {
  format: typeof VIEW_FILE_FORMAT;
  version: number;
  views: ViewDefinition[];
}

const SPATIAL = new Set(["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"]);

const text = (value: unknown): string =>
  value === null || value === undefined ? "" : String(value);

/** One text comparison, shared by name and property selectors. */
export function matchText(values: string[], op: TextOp, wanted: string): boolean {
  const want = wanted.toLowerCase();
  const present = values.filter((value) => value !== "");
  if (op === "exists") return present.length > 0;
  if (op === "missing") return present.length === 0;
  const hit = present.some((value) => {
    const lower = value.toLowerCase();
    if (op === "contains") return lower.includes(want);
    if (op === "starts") return lower.startsWith(want);
    return lower === want;
  });
  return op === "not" ? !hit : hit;
}

/** Every value an element carries under this set and name. */
export function readRowProperty(row: ElementRow, set: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const found: string[] = [];
  for (const [key, value] of Object.entries(row.props)) {
    const dot = key.lastIndexOf(".");
    const setName = dot < 0 ? "" : key.slice(0, dot);
    const propName = dot < 0 ? key : key.slice(dot + 1);
    if (set && setName.toLowerCase() !== set.toLowerCase()) continue;
    if (propName.toLowerCase() !== wanted) continue;
    if (value !== null && value !== undefined && value !== "") found.push(text(value));
  }
  if (!set) {
    for (const [key, value] of Object.entries(row.attrs)) {
      if (key.toLowerCase() !== wanted) continue;
      if (value !== null && value !== undefined && value !== "") found.push(text(value));
    }
  }
  return found;
}

/** True when this selector cannot be answered without the property index. */
export function needsIndex(selector: Selector): boolean {
  if (selector.kind === "property") return true;
  if (selector.kind === "not") return needsIndex(selector.of);
  if (selector.kind === "any" || selector.kind === "every") return selector.of.some(needsIndex);
  return false;
}

export interface ResolveContext {
  viewer: Viewer;
  /** Property index rows; empty is fine for every selector but `property`. */
  rows: ElementRow[];
}

interface ElementFacts {
  storeys: Map<number, string>;
}

function walkStoreys(tree: SpatialNode | null): ElementFacts {
  const storeys = new Map<number, string>();
  if (!tree) return { storeys };
  const visit = (node: SpatialNode, storey: string): void => {
    let current = storey;
    if (node.type === "IfcBuildingStorey") current = node.name ?? "(unnamed storey)";
    else if (!SPATIAL.has(node.type)) storeys.set(node.expressID, current);
    for (const child of node.children) visit(child, current);
  };
  visit(tree, "");
  return { storeys };
}

/** Element ids a selector picks out of the model that is open right now. */
export function resolveSelector(selector: Selector, context: ResolveContext): number[] {
  const { viewer } = context;
  const types = viewer.getElementTypes();
  if (selector.kind === "any") {
    const out = new Set<number>();
    for (const inner of selector.of) {
      for (const id of resolveSelector(inner, context)) out.add(id);
    }
    return [...out];
  }
  if (selector.kind === "every") {
    if (selector.of.length === 0) return [];
    let kept: number[] | null = null;
    for (const inner of selector.of) {
      const ids = new Set(resolveSelector(inner, context));
      kept = kept === null ? [...ids] : kept.filter((id) => ids.has(id));
    }
    return kept ?? [];
  }
  if (selector.kind === "not") {
    const excluded = new Set(resolveSelector(selector.of, context));
    return [...types.keys()].filter((id) => !excluded.has(id));
  }
  if (selector.kind === "ids") return selector.ids.filter((id) => types.has(id));
  if (selector.kind === "all") return [...types.keys()];

  if (selector.kind === "class") {
    const wanted = new Set(selector.values.map((value) => value.toLowerCase()));
    const out: number[] = [];
    for (const [id, type] of types) {
      if (wanted.has(type.toLowerCase()) || wanted.has(type.replace(/^Ifc/, "").toLowerCase())) out.push(id);
    }
    return out;
  }

  if (selector.kind === "storey") {
    const wanted = new Set(selector.values.map((value) => value.toLowerCase()));
    const { storeys } = walkStoreys(viewer.getSpatialTree());
    const out: number[] = [];
    for (const [id, storey] of storeys) {
      if (types.has(id) && wanted.has(storey.toLowerCase())) out.push(id);
    }
    return out;
  }

  if (selector.kind === "model") {
    const wanted = new Set(selector.values.map((value) => value.toLowerCase()));
    const names = new Map(viewer.getModels().map((model) => [model.index, (model.name || `Model ${model.index + 1}`).toLowerCase()]));
    const out: number[] = [];
    for (const id of types.keys()) {
      const name = names.get(modelOf(id));
      if (name !== undefined && wanted.has(name)) out.push(id);
    }
    return out;
  }

  if (selector.kind === "name") {
    const out: number[] = [];
    const named = new Map<number, string>();
    const visit = (node: SpatialNode): void => {
      named.set(node.expressID, node.name ?? "");
      for (const child of node.children) visit(child);
    };
    const tree = viewer.getSpatialTree();
    if (tree) visit(tree);
    for (const id of types.keys()) {
      if (matchText([named.get(id) ?? ""], selector.op, selector.value)) out.push(id);
    }
    return out;
  }

  const out: number[] = [];
  for (const row of context.rows) {
    if (!types.has(row.id)) continue;
    if (matchText(readRowProperty(row, selector.set, selector.name), selector.op, selector.value)) out.push(row.id);
  }
  return out;
}

/** A one-line account of what a selector picks, for a rule label. */
export function describeSelector(selector: Selector): string {
  if (selector.kind === "any") return selector.of.map(describeSelector).join(" or ");
  if (selector.kind === "every") return selector.of.map(describeSelector).join(" and ");
  if (selector.kind === "not") return `not ${describeSelector(selector.of)}`;
  if (selector.kind === "all") return "Everything";
  if (selector.kind === "ids") return `${selector.ids.length.toLocaleString()} picked elements`;
  if (selector.kind === "class") return selector.values.map((value) => value.replace(/^Ifc/, "")).join(", ");
  if (selector.kind === "storey" || selector.kind === "model") return selector.values.join(", ");
  const opLabel: Record<TextOp, string> = {
    is: "is", contains: "contains", starts: "starts with", not: "is not", exists: "is present", missing: "is missing",
  };
  const tail = selector.op === "exists" || selector.op === "missing" ? "" : ` "${selector.value}"`;
  if (selector.kind === "name") return `Name ${opLabel[selector.op]}${tail}`;
  const key = selector.set ? `${selector.set}.${selector.name}` : selector.name;
  return `${key} ${opLabel[selector.op]}${tail}`;
}

/** True when a selector never names a specific element. */
export function selectorPortable(selector: Selector): boolean {
  if (selector.kind === "ids") return false;
  if (selector.kind === "not") return selectorPortable(selector.of);
  if (selector.kind === "any" || selector.kind === "every") return selector.of.every(selectorPortable);
  return true;
}

/** True when the definition survives being handed to somebody else's model. */
export const isPortable = (view: ViewDefinition): boolean =>
  view.filters.every((filter) => selectorPortable(filter.selector)) &&
  (view.xray === null || selectorPortable(view.xray)) &&
  (view.hidden === null || selectorPortable(view.hidden));

// -- capture ----------------------------------------------------------------

const newId = (): string => `view-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export interface CaptureOptions {
  name: string;
  folder?: string;
  description?: string;
  /** Selectors for the rules currently applied, keyed by visibility rule id. */
  selectors?: Map<string, Selector>;
  thumbnail?: string;
}

/**
 * Everything currently narrowing or recolouring the view, as a definition.
 * A rule the caller could not describe is stored as its ids, which is honest
 * rather than silently dropping it.
 */
export function captureView(viewer: Viewer, color: ColorRule | null, options: CaptureOptions): ViewDefinition {
  const selectors = options.selectors ?? new Map<string, Selector>();
  const filters: ViewFilter[] = viewer.getRules().map((rule) => ({
    label: rule.label,
    mode: rule.mode,
    selector: selectors.get(rule.id) ?? (rule as { selector?: Selector }).selector ?? { kind: "ids", ids: [...rule.ids] },
  }));
  const hiddenIds = viewer.getHiddenIds();
  const xrayIds = [...viewer.getElementTypes().keys()].filter((id) => viewer.isElementXray(id));
  return {
    id: newId(),
    name: options.name,
    folder: options.folder ?? "",
    description: options.description ?? "",
    filters,
    color,
    camera: viewer.getCamera(),
    projection: viewer.getProjection(),
    sections: viewer.getSections(),
    box: viewer.getSectionBox(),
    xray: xrayIds.length ? { kind: "ids", ids: xrayIds } : null,
    hidden: hiddenIds.length ? { kind: "ids", ids: hiddenIds } : null,
    offsets: viewer.getElementOffsets(),
    annotations: viewer.getAnnotationStates(),
    measurements: viewer.getMeasurementStates(),
    categories: {
      spaces: viewer.isCategoryVisible("IfcSpace"),
      openings: viewer.isCategoryVisible("IfcOpeningElement"),
    },
    ghostHidden: viewer.isGhostHidden(),
    thumbnail: options.thumbnail ?? "",
    updatedAt: new Date().toISOString(),
  };
}

export interface ApplyReport {
  /** Rules that resolved to nothing on this model. */
  empty: string[];
  matched: number;
}

export interface SavedViewApplyOptions {
  /** False lets callers animate the saved camera after the rest of the view lands. */
  camera?: boolean;
  signal?: AbortSignal;
}

export interface SavedViewApplyContext {
  viewer: Viewer;
  index: Pick<PropertyIndex, "ready" | "all" | "build">;
  /** Keeps the shared colour UI and the rendered override in sync. */
  setColorRule(rule: ColorRule | null): Promise<void> | void;
}

/** Every part of a view that can require property rows to resolve. */
export const viewNeedsIndex = (view: ViewDefinition): boolean =>
  view.filters.some((filter) => needsIndex(filter.selector)) ||
  (view.hidden !== null && needsIndex(view.hidden)) ||
  (view.xray !== null && needsIndex(view.xray)) ||
  view.color?.kind === "property";

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
};

/**
 * Put a definition on screen. Rules are resolved first and applied as one
 * visibility change, so a view lands in a single undo step.
 */
export function applyView(view: ViewDefinition, context: ResolveContext): ApplyReport {
  const { viewer } = context;
  const report: ApplyReport = { empty: [], matched: 0 };

  viewer.showAll();
  viewer.clearXray();
  viewer.clearElementOffsets();
  for (const filter of view.filters) {
    const ids = resolveSelector(filter.selector, context);
    if (ids.length === 0) {
      report.empty.push(filter.label);
      continue;
    }
    report.matched += ids.length;
    viewer.addRule({ label: filter.label, mode: filter.mode, ids, selector: filter.selector });
  }
  if (view.hidden) {
    const ids = resolveSelector(view.hidden, context);
    if (ids.length) viewer.setHidden(ids, true);
  }
  if (view.xray) {
    const ids = resolveSelector(view.xray, context);
    if (ids.length) viewer.setXray(ids, true);
  }
  viewer.setGhostHidden(view.ghostHidden);
  viewer.setSections(view.sections ?? []);
  viewer.setSectionBox(view.box ?? null);
  if (view.offsets?.length) viewer.setElementOffsetEntries(view.offsets);
  if (view.annotations) viewer.setAnnotationStates(view.annotations);
  if (view.measurements) viewer.setMeasurementStates(view.measurements);
  if (view.projection) viewer.setProjection(view.projection);
  if (view.camera) viewer.setCamera(view.camera);
  return report;
}

/**
 * Apply the complete saved-view state. This is shared by the Views pane and
 * extension host so neither surface can drift into a partial approximation.
 */
export async function applySavedView(
  view: ViewDefinition,
  context: SavedViewApplyContext,
  options: SavedViewApplyOptions = {},
): Promise<ApplyReport> {
  throwIfAborted(options.signal);
  let rows: ElementRow[] = [];
  if (viewNeedsIndex(view)) {
    rows = context.index.ready() ? context.index.all() : await context.index.build();
  }
  throwIfAborted(options.signal);

  const report = applyView(options.camera === false ? { ...view, camera: null } : view, {
    viewer: context.viewer,
    rows,
  });
  throwIfAborted(options.signal);
  await context.setColorRule(view.color);
  throwIfAborted(options.signal);

  if (view.categories.spaces !== context.viewer.isCategoryVisible("IfcSpace")) {
    await context.viewer.setCategoryVisible("IfcSpace", view.categories.spaces);
    throwIfAborted(options.signal);
  }
  if (view.categories.openings !== context.viewer.isCategoryVisible("IfcOpeningElement")) {
    await context.viewer.setCategoryVisible("IfcOpeningElement", view.categories.openings);
    throwIfAborted(options.signal);
  }
  return report;
}

// -- storage ----------------------------------------------------------------

const STORE_KEY = "ifcviewx.views.v1";

const TEXT_OPS = new Set<TextOp>(["is", "contains", "starts", "not", "exists", "missing"]);
const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
export const MAX_SELECTOR_STRING_LENGTH = 500;
const strings = (value: unknown): string[] | null => Array.isArray(value) && value.length <= 2_048 &&
  value.every((item) => typeof item === "string" && item.length <= MAX_SELECTOR_STRING_LENGTH)
  ? value.slice()
  : null;

export const MAX_VIEW_FILE_VIEWS = 512;
export const MAX_VIEW_FILE_BYTES = 8 * 1024 * 1024;
const MAX_VIEW_FILTERS = 512;
const MAX_VIEW_SECTIONS = 8;
const MAX_VIEW_OFFSETS = 50_000;
const MAX_VIEW_ANNOTATIONS = 10_000;
const MAX_VIEW_MEASUREMENTS = 10_000;
const MAX_MEASUREMENT_POINTS = 10_000;
const MAX_NAME_LENGTH = 500;
const MAX_DESCRIPTION_LENGTH = 10_000;
const MAX_LABEL_LENGTH = 500;

const boundedString = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

const finiteVector = (value: unknown): [number, number, number] | null =>
  Array.isArray(value) && value.length === 3 && value.every((entry) => typeof entry === "number" && Number.isFinite(entry))
    ? [value[0] as number, value[1] as number, value[2] as number]
    : null;

const positiveInteger = (value: unknown): number | null =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;

function normalizeColorRule(value: unknown): ColorRule | null {
  const item = record(value);
  if (!item || typeof item.kind !== "string") return null;
  if (["none", "class", "storey", "model", "random", "material"].includes(item.kind)) {
    return { kind: item.kind } as ColorRule;
  }
  if (item.kind !== "property") return null;
  const key = boundedString(item.key, MAX_LABEL_LENGTH);
  return key && key.trim() ? { kind: "property", key } : null;
}

function normalizeCamera(value: unknown): CameraPose | null {
  const item = record(value);
  if (!item) return null;
  const position = finiteVector(item.position);
  const target = finiteVector(item.target);
  if (!position || !target) return null;
  const distance = Math.hypot(
    position[0] - target[0],
    position[1] - target[1],
    position[2] - target[2],
  );
  if (!Number.isFinite(distance) || distance < 1e-9) return null;
  return { position, target };
}

function normalizeSection(value: unknown): SectionState | null {
  const item = record(value);
  if (!item || typeof item.offset !== "number" || !Number.isFinite(item.offset) || typeof item.flip !== "boolean") return null;
  if (item.axis === "x" || item.axis === "y" || item.axis === "z") {
    return { axis: item.axis, offset: item.offset, flip: item.flip };
  }
  if (item.axis !== undefined) return null;
  const normal = finiteVector(item.normal);
  const normalLength = normal ? Math.hypot(...normal) : 0;
  if (!normal || !Number.isFinite(normalLength) || normalLength < 1e-9) return null;
  const id = item.id === undefined ? "" : boundedString(item.id, MAX_LABEL_LENGTH);
  const name = item.name === undefined ? "" : boundedString(item.name, MAX_LABEL_LENGTH);
  if (id === null || name === null) return null;
  return { id, name, normal, offset: item.offset, flip: item.flip };
}

function normalizeBox(value: unknown): SectionBox | null {
  const item = record(value);
  if (!item) return null;
  const min = finiteVector(item.min);
  const max = finiteVector(item.max);
  if (!min || !max || min.some((entry, index) => entry > max[index])) return null;
  return { min, max };
}

function normalizeOffsets(value: unknown): ViewDefinition["offsets"] | null {
  if (!Array.isArray(value) || value.length > MAX_VIEW_OFFSETS) return null;
  const offsets: ViewDefinition["offsets"] = [];
  for (const raw of value) {
    if (!Array.isArray(raw) || raw.length !== 2) return null;
    const id = positiveInteger(raw[0]);
    const offset = finiteVector(raw[1]);
    if (id === null || !offset) return null;
    offsets.push([id, offset]);
  }
  return offsets;
}

function normalizeTimestamp(value: unknown): string | null {
  const text = boundedString(value, 64);
  if (text === null) return null;
  const time = Date.parse(text);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function normalizeAnnotation(value: unknown): AnnotationState | null {
  const item = record(value);
  if (!item || (item.kind !== undefined && item.kind !== "note")) return null;
  const text = boundedString(item.text, 200);
  const at = finiteVector(item.at);
  if (text === null || !text.trim() || !at) return null;
  let id: number | undefined;
  let elementId: number | undefined;
  if (item.id !== undefined) {
    const parsed = positiveInteger(item.id);
    if (parsed === null) return null;
    id = parsed;
  }
  if (item.elementId !== undefined) {
    const parsed = positiveInteger(item.elementId);
    if (parsed === null) return null;
    elementId = parsed;
  }
  if (item.visible !== undefined && typeof item.visible !== "boolean") return null;
  let createdAt: string | undefined;
  if (item.createdAt !== undefined) {
    const parsed = normalizeTimestamp(item.createdAt);
    if (parsed === null) return null;
    createdAt = parsed;
  }
  return {
    kind: "note",
    ...(id === undefined ? {} : { id }),
    text,
    at,
    ...(elementId === undefined ? {} : { elementId }),
    ...(item.visible === undefined ? {} : { visible: item.visible }),
    ...(createdAt === undefined ? {} : { createdAt }),
  };
}

type SavedSnapKind = "vertex" | "midpoint" | "edge" | "surface";
const SNAP_KINDS = new Set<SavedSnapKind>(["vertex", "midpoint", "edge", "surface"]);
const isSnapKind = (value: unknown): value is SavedSnapKind =>
  typeof value === "string" && SNAP_KINDS.has(value as SavedSnapKind);
const SHAPE_KINDS = new Set(["path", "angle", "area", "coordinate", "count"]);

function normalizeMeasurement(value: unknown): MeasurementState | null {
  const item = record(value);
  if (!item) return null;
  let id: number | undefined;
  let label: string | undefined;
  if (item.id !== undefined) {
    const parsed = positiveInteger(item.id);
    if (parsed === null) return null;
    id = parsed;
  }
  if (item.label !== undefined) {
    const parsed = boundedString(item.label, MAX_LABEL_LENGTH);
    if (parsed === null) return null;
    label = parsed;
  }
  if (item.visible !== undefined && typeof item.visible !== "boolean") return null;
  const common = {
    ...(id === undefined ? {} : { id }),
    ...(label === undefined ? {} : { label }),
    ...(item.visible === undefined ? {} : { visible: item.visible }),
  };

  if (item.kind === undefined || item.kind === "distance") {
    const a = finiteVector(item.a);
    const b = finiteVector(item.b);
    if (!a || !b || !Array.isArray(item.ends) || item.ends.length !== 2 ||
      !item.ends.every(isSnapKind)) return null;
    return { kind: "distance", ...common, a, b, ends: [item.ends[0], item.ends[1]] };
  }

  if (typeof item.kind !== "string" || !SHAPE_KINDS.has(item.kind) || !Array.isArray(item.points) ||
    item.points.length > MAX_MEASUREMENT_POINTS) return null;
  const minimum = item.kind === "coordinate" || item.kind === "count" ? 1 : item.kind === "path" ? 2 : 3;
  if (item.points.length < minimum) return null;
  const points: Array<[number, number, number]> = [];
  for (const rawPoint of item.points) {
    const point = finiteVector(rawPoint);
    if (!point) return null;
    points.push(point);
  }
  return { kind: item.kind, ...common, points } as MeasurementState;
}

function normalizeStateArray<T>(
  value: unknown,
  max: number,
  normalize: (entry: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(value) || value.length > max) return null;
  const out: T[] = [];
  for (const entry of value) {
    const normalized = normalize(entry);
    if (normalized === null) return null;
    out.push(normalized);
  }
  return out;
}

/** Validate recursive selectors crossing a file/storage boundary. */
export function normalizeSelector(value: unknown, depth = 0): Selector | null {
  const item = record(value);
  if (!item || depth > 12 || typeof item.kind !== "string") return null;
  if (item.kind === "all") return { kind: "all" };
  if (item.kind === "class" || item.kind === "storey" || item.kind === "model") {
    const values = strings(item.values);
    return values ? { kind: item.kind, values } : null;
  }
  if (item.kind === "ids") {
    if (!Array.isArray(item.ids) || item.ids.length > 100_000 ||
      !item.ids.every((id) => typeof id === "number" && Number.isSafeInteger(id) && id >= 0)) return null;
    return { kind: "ids", ids: item.ids.slice() as number[] };
  }
  if (item.kind === "name") {
    const value = boundedString(item.value, MAX_SELECTOR_STRING_LENGTH);
    if (typeof item.op !== "string" || !TEXT_OPS.has(item.op as TextOp) || value === null) return null;
    return { kind: "name", op: item.op as TextOp, value };
  }
  if (item.kind === "property") {
    const set = boundedString(item.set, MAX_SELECTOR_STRING_LENGTH);
    const name = boundedString(item.name, MAX_SELECTOR_STRING_LENGTH);
    const value = boundedString(item.value, MAX_SELECTOR_STRING_LENGTH);
    if (set === null || name === null || !name || value === null ||
      typeof item.op !== "string" || !TEXT_OPS.has(item.op as TextOp)) return null;
    return { kind: "property", set, name, op: item.op as TextOp, value };
  }
  if (item.kind === "not") {
    const of = normalizeSelector(item.of, depth + 1);
    return of ? { kind: "not", of } : null;
  }
  if (item.kind === "any" || item.kind === "every") {
    if (!Array.isArray(item.of) || item.of.length > 256) return null;
    const of = item.of.map((inner) => normalizeSelector(inner, depth + 1));
    if (of.some((inner) => inner === null)) return null;
    return { kind: item.kind, of: of as Selector[] };
  }
  return null;
}

/** Accept anything shaped like a view; drop the rest rather than throw. */
export function normalizeView(raw: unknown): ViewDefinition | null {
  if (typeof raw !== "object" || raw === null) return null;
  const value = raw as Partial<ViewDefinition>;
  const name = boundedString(value.name, MAX_NAME_LENGTH);
  const folder = value.folder === undefined ? "" : boundedString(value.folder, MAX_NAME_LENGTH);
  const description = value.description === undefined ? "" : boundedString(value.description, MAX_DESCRIPTION_LENGTH);
  if (name === null || !name.trim() || folder === null || description === null) return null;
  const filters: ViewFilter[] = [];
  if (Array.isArray(value.filters)) {
    if (value.filters.length > MAX_VIEW_FILTERS) return null;
    for (const rawFilter of value.filters) {
      const filter = record(rawFilter);
      const selector = normalizeSelector(filter?.selector);
      if (!filter || !selector || (filter.mode !== "keep" && filter.mode !== "hide")) continue;
      const label = filter.label === undefined ? "Filter" : boundedString(filter.label, MAX_LABEL_LENGTH);
      if (label === null) return null;
      filters.push({ label, mode: filter.mode, selector });
    }
  } else if (value.filters !== undefined) return null;

  const color = value.color === undefined || value.color === null ? null : normalizeColorRule(value.color);
  const camera = value.camera === undefined || value.camera === null ? null : normalizeCamera(value.camera);
  const box = value.box === undefined || value.box === null ? null : normalizeBox(value.box);
  const sections = value.sections === undefined
    ? []
    : normalizeStateArray(value.sections, MAX_VIEW_SECTIONS, normalizeSection);
  const offsets = value.offsets === undefined ? [] : normalizeOffsets(value.offsets);
  const annotations = value.annotations === undefined
    ? []
    : normalizeStateArray(value.annotations, MAX_VIEW_ANNOTATIONS, normalizeAnnotation);
  const measurements = value.measurements === undefined
    ? []
    : normalizeStateArray(value.measurements, MAX_VIEW_MEASUREMENTS, normalizeMeasurement);
  if ((value.color !== undefined && value.color !== null && color === null) ||
    (value.camera !== undefined && value.camera !== null && camera === null) ||
    (value.box !== undefined && value.box !== null && box === null) ||
    sections === null || offsets === null || annotations === null || measurements === null) return null;
  if (value.projection !== undefined && value.projection !== null &&
    value.projection !== "orthographic" && value.projection !== "perspective") return null;
  const updatedAt = value.updatedAt === undefined ? null : normalizeTimestamp(value.updatedAt);
  if (value.updatedAt !== undefined && updatedAt === null) return null;

  const categories = value.categories === undefined ? null : record(value.categories);
  if (value.categories !== undefined && !categories) return null;
  if ((categories?.spaces !== undefined && typeof categories.spaces !== "boolean") ||
    (categories?.openings !== undefined && typeof categories.openings !== "boolean")) return null;

  const id = typeof value.id === "string" && value.id.length <= MAX_LABEL_LENGTH && value.id ? value.id : newId();
  const thumbnail = typeof value.thumbnail === "string" && value.thumbnail.length <= 750_000 &&
    /^data:image\/(?:png|jpeg|webp);base64,[a-z0-9+/=\s]+$/i.test(value.thumbnail)
    ? value.thumbnail
    : "";
  if (value.thumbnail !== undefined && typeof value.thumbnail !== "string") return null;
  if (value.ghostHidden !== undefined && typeof value.ghostHidden !== "boolean") return null;

  return {
    id,
    name,
    folder,
    description,
    filters,
    color,
    camera,
    projection: value.projection ?? null,
    sections,
    box,
    xray: normalizeSelector(value.xray),
    hidden: normalizeSelector(value.hidden),
    offsets,
    annotations,
    measurements,
    categories: {
      spaces: categories?.spaces === true,
      openings: categories?.openings === true,
    },
    ghostHidden: value.ghostHidden === true,
    thumbnail,
    updatedAt: updatedAt ?? new Date().toISOString(),
  };
}

export function parseViewFile(text_: string): ViewDefinition[] {
  if (text_.length > MAX_VIEW_FILE_BYTES || new TextEncoder().encode(text_).byteLength > MAX_VIEW_FILE_BYTES) {
    throw new Error("A saved-view file may not exceed 8 MB");
  }
  const parsed: unknown = JSON.parse(text_);
  if (record(parsed) && (
    ((parsed as Partial<ViewFile>).format !== undefined && (parsed as Partial<ViewFile>).format !== VIEW_FILE_FORMAT) ||
    ((parsed as Partial<ViewFile>).version !== undefined && (parsed as Partial<ViewFile>).version !== VIEW_FILE_VERSION)
  )) return [];
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as ViewFile).views)
      ? (parsed as ViewFile).views
      : [];
  return list.slice(0, MAX_VIEW_FILE_VIEWS).map(normalizeView).filter((view): view is ViewDefinition => view !== null);
}

export function serializeViews(views: ViewDefinition[]): string {
  if (!Array.isArray(views) || views.length > MAX_VIEW_FILE_VIEWS) {
    throw new Error(`A saved-view file may contain at most ${MAX_VIEW_FILE_VIEWS} views`);
  }
  const normalized = views.map(normalizeView);
  if (normalized.some((view) => view === null)) throw new Error("A saved-view definition is invalid");
  const file: ViewFile = {
    format: VIEW_FILE_FORMAT,
    version: VIEW_FILE_VERSION,
    views: normalized as ViewDefinition[],
  };
  const source = JSON.stringify(file, null, 2);
  if (new TextEncoder().encode(source).byteLength > MAX_VIEW_FILE_BYTES) {
    throw new Error("A saved-view file may not exceed 8 MB");
  }
  return source;
}

/** Saved views for this browser. Views are model-independent, so is the key. */
export class ViewStore {
  private views: ViewDefinition[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage | null = safeStorage()) {
    this.views = this.read();
  }

  private read(): ViewDefinition[] {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      return raw ? parseViewFile(raw) : [];
    } catch {
      return [];
    }
  }

  private write(): boolean {
    try {
      if (!this.storage) return false;
      this.storage.setItem(STORE_KEY, serializeViews(this.views));
      return true;
    } catch {
      return false;
    } finally {
      for (const listener of this.listeners) listener();
    }
  }

  list(): ViewDefinition[] {
    return [...this.views];
  }

  folders(): string[] {
    return [...new Set(this.views.map((view) => view.folder).filter(Boolean))].sort();
  }

  get(id: string): ViewDefinition | undefined {
    return this.views.find((view) => view.id === id);
  }

  /** Add or replace by id; a name collision inside a folder replaces too. */
  save(view: ViewDefinition): boolean {
    const normalized = normalizeView(view);
    if (!normalized) return false;
    const at = this.views.findIndex(
      (existing) => existing.id === normalized.id ||
        (existing.name === normalized.name && existing.folder === normalized.folder),
    );
    if (at >= 0) this.views[at] = { ...normalized, id: this.views[at].id };
    else {
      if (this.views.length >= MAX_VIEW_FILE_VIEWS) return false;
      this.views.push(normalized);
    }
    return this.write();
  }

  remove(id: string): boolean {
    const before = this.views.length;
    this.views = this.views.filter((view) => view.id !== id);
    if (this.views.length === before) return false;
    return this.write();
  }

  rename(id: string, name: string, folder: string): boolean {
    const view = this.get(id);
    if (!view || boundedString(name, MAX_NAME_LENGTH) === null || !name.trim() ||
      boundedString(folder, MAX_NAME_LENGTH) === null) return false;
    view.name = name;
    view.folder = folder;
    view.updatedAt = new Date().toISOString();
    return this.write();
  }

  /** Merge an imported file; returns how many landed. */
  merge(views: ViewDefinition[]): number {
    let added = 0;
    for (const raw of views.slice(0, MAX_VIEW_FILE_VIEWS)) {
      const view = normalizeView(raw);
      if (!view) continue;
      const at = this.views.findIndex((existing) => existing.name === view.name && existing.folder === view.folder);
      if (at >= 0) this.views[at] = { ...view, id: this.views[at].id };
      else {
        if (this.views.length >= MAX_VIEW_FILE_VIEWS) break;
        this.views.push(view);
      }
      added++;
    }
    this.write();
    return added;
  }

  clear(): void {
    this.views = [];
    this.write();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}
