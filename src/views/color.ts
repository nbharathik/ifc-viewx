// Colour the model by a rule: IFC class, storey, or any property value.
//
// The assignment is one byte per element (a palette index) written into the
// state texture the batcher already keeps, so a rule costs no extra per-element
// GPU state and no second draw. Class and storey read the spatial tree and are
// instant; property rules need the shared property index, which builds once.
import { elementsOf, type ElementRow, type PropertyIndex } from "../data/model.js";
import { modelOf } from "../viewer-core/ids.js";
import type { OrganizeIndex, Viewer } from "../viewer-core/viewer.js";

export type ColorRule =
  | { kind: "none" }
  | { kind: "class" }
  | { kind: "storey" }
  | { kind: "model" }
  | { kind: "random" }
  | { kind: "material" }
  | { kind: "property"; key: string };

export interface ColorGroup {
  label: string;
  color: [number, number, number];
  count: number;
  ids: number[];
}

export interface ColorResult {
  groups: ColorGroup[];
  assignment: Map<number, number>;
  /** Elements the rule said nothing about, left at their own colour. */
  unset: number;
  /** Explicit palette when it is wider than one colour per group (random). */
  colors?: Array<[number, number, number]>;
}

/** Palette entries a rule may use; index 0 in the texture means untouched. */
const MAX_GROUPS = 254;
/** Above this many distinct numbers a property is banded instead of listed. */
const BAND_THRESHOLD = 12;
const BANDS = 8;

/** Golden-angle hues, so neighbouring groups never land on the same colour. */
function paletteColor(index: number): [number, number, number] {
  const hue = ((index * 137.508) % 360) / 360;
  const light = index % 2 === 0 ? 0.56 : 0.66;
  return hslToRgb(hue, 0.62, light);
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  if (s === 0) {
    const v = Math.round(l * 255);
    return [v, v, v];
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const channel = (t: number): number => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return [
    Math.round(channel(h + 1 / 3) * 255),
    Math.round(channel(h) * 255),
    Math.round(channel(h - 1 / 3) * 255),
  ];
}

const labelOf = (value: unknown): string => {
  if (value === null || value === undefined || value === "") return "(not set)";
  if (typeof value === "boolean") return value ? "True" : "False";
  return String(value);
};

/** Groups in a stable, readable order: biggest first, "(not set)" last. */
function order(entries: Map<string, number[]>): Array<[string, number[]]> {
  return [...entries.entries()].sort((a, b) => {
    if (a[0] === "(not set)") return 1;
    if (b[0] === "(not set)") return -1;
    return b[1].length - a[1].length || a[0].localeCompare(b[0]);
  });
}

/** Build a result from ready-made label groups; the shared core of every rule. */
export function computeColorsFromEntries(
  entries: Map<string, number[]>,
  hasGeometry: (id: number) => boolean,
): ColorResult {
  const sorted = order(entries);
  const groups: ColorGroup[] = [];
  const assignment = new Map<number, number>();
  let unset = 0;
  for (const [label, ids] of sorted) {
    const placed = ids.filter(hasGeometry);
    if (placed.length === 0) continue;
    if (groups.length >= MAX_GROUPS) {
      unset += placed.length;
      continue;
    }
    const index = groups.length + 1;
    for (const id of placed) assignment.set(id, index);
    groups.push({ label, color: paletteColor(groups.length), count: placed.length, ids: placed });
  }
  return { groups, assignment, unset };
}

/** Numbers band into equal-count ranges; anything else groups by exact value. */
function bandValues(rows: ElementRow[], key: string): Map<string, number[]> | null {
  const numeric: Array<{ id: number; value: number }> = [];
  for (const row of rows) {
    const value = row.props[key];
    if (typeof value !== "number" || !Number.isFinite(value)) {
      if (value !== undefined && value !== null && value !== "") return null;
      continue;
    }
    numeric.push({ id: row.id, value });
  }
  const distinct = new Set(numeric.map((entry) => entry.value));
  if (numeric.length === 0 || distinct.size <= BAND_THRESHOLD) return null;

  numeric.sort((a, b) => a.value - b.value);
  const entries = new Map<string, number[]>();
  const per = Math.ceil(numeric.length / BANDS);
  for (let band = 0; band < BANDS; band++) {
    const slice = numeric.slice(band * per, (band + 1) * per);
    if (slice.length === 0) continue;
    const lo = slice[0].value;
    const hi = slice[slice.length - 1].value;
    entries.set(`${round(lo)} to ${round(hi)}`, slice.map((entry) => entry.id));
  }
  for (const row of rows) {
    const value = row.props[key];
    if (value === undefined || value === null || value === "") push(entries, "(not set)", row.id);
  }
  return entries;
}

const round = (value: number): string =>
  Math.abs(value) >= 100 ? value.toFixed(0) : Number(value.toFixed(3)).toString();

function push(map: Map<string, number[]>, key: string, id: number): void {
  const list = map.get(key);
  if (list) list.push(id);
  else map.set(key, [id]);
}

/**
 * Compute the groups for a rule. Property rules need `rows` from the built
 * index; the caller builds it first, since that is the part with a progress bar.
 */
export function computeColors(viewer: Viewer, rule: ColorRule, rows: ElementRow[]): ColorResult {
  const empty: ColorResult = { groups: [], assignment: new Map(), unset: 0 };
  if (rule.kind === "none") return empty;
  const hasGeometry = (id: number): boolean => viewer.hasGeometry(id);
  const entries = new Map<string, number[]>();

  if (rule.kind === "class") {
    for (const element of elementsOf(viewer.getSpatialTree())) {
      push(entries, element.type.replace(/^Ifc/, ""), element.id);
    }
    return computeColorsFromEntries(entries, hasGeometry);
  }

  if (rule.kind === "storey") {
    for (const element of elementsOf(viewer.getSpatialTree())) {
      push(entries, element.storey || "(no storey)", element.id);
    }
    return computeColorsFromEntries(entries, hasGeometry);
  }

  if (rule.kind === "model") {
    const names = new Map(viewer.getModels().map((m) => [m.index, m.name || `Model ${m.index + 1}`]));
    for (const element of elementsOf(viewer.getSpatialTree())) {
      push(entries, names.get(modelOf(element.id)) ?? "(unknown model)", element.id);
    }
    return computeColorsFromEntries(entries, hasGeometry);
  }

  if (rule.kind === "random") {
    // Every element gets its own hue; one legend row stands in for them all,
    // and the palette carries the full spread rather than one colour per group.
    const assignment = new Map<number, number>();
    const ids: number[] = [];
    for (const element of elementsOf(viewer.getSpatialTree())) {
      if (!hasGeometry(element.id)) continue;
      // Knuth's multiplicative hash spreads consecutive ids across the palette.
      assignment.set(element.id, 1 + (((element.id * 2654435761) >>> 0) % MAX_GROUPS));
      ids.push(element.id);
    }
    if (ids.length === 0) return empty;
    const colors: Array<[number, number, number]> = [];
    for (let i = 0; i < MAX_GROUPS; i++) colors.push(paletteColor(i));
    return {
      groups: [{ label: "Random per element", color: [156, 163, 175], count: ids.length, ids }],
      assignment,
      unset: 0,
      colors,
    };
  }

  // Materials live in the async organize index; the dock feeds them through
  // materialColorEntries and computeColorsFromEntries instead.
  if (rule.kind === "material") return empty;

  if (rows.length === 0) return empty;
  const banded = bandValues(rows, rule.key);
  if (banded) return computeColorsFromEntries(banded, hasGeometry);
  for (const row of rows) push(entries, labelOf(row.props[rule.key]), row.id);
  return computeColorsFromEntries(entries, hasGeometry);
}

/** Material assignments from the organize index, as entries for the pipeline. */
export function materialColorEntries(index: OrganizeIndex): Map<string, number[]> {
  const entries = new Map<string, number[]>();
  for (const material of index.materials) {
    for (const id of material.ids) push(entries, material.name || "(unnamed)", id);
  }
  return entries;
}

/** Apply a computed result to the viewer, or clear when it is empty. */
export function applyColors(viewer: Viewer, result: ColorResult): void {
  if (result.groups.length === 0) return void viewer.clearColorOverride();
  viewer.setColorOverride(
    result.assignment,
    result.colors ?? result.groups.map((group) => group.color),
  );
}

/**
 * User-picked colours for explicit selections, layered over whatever rule is
 * active. Owned by the colour card; survives rule switches until cleared.
 */
export class CustomColors {
  private readonly byColor = new Map<string, { color: [number, number, number]; ids: Set<number> }>();

  set(ids: Iterable<number>, color: [number, number, number]): void {
    const key = color.join(",");
    const entry = this.byColor.get(key) ?? { color, ids: new Set<number>() };
    for (const id of ids) {
      for (const other of this.byColor.values()) other.ids.delete(id);
      entry.ids.add(id);
    }
    this.byColor.set(key, entry);
    for (const [key2, other] of this.byColor) {
      if (other.ids.size === 0) this.byColor.delete(key2);
    }
  }

  clear(): void {
    this.byColor.clear();
  }

  isEmpty(): boolean {
    return this.byColor.size === 0;
  }

  /** The rule's result with the custom groups stacked on top. */
  overlay(result: ColorResult): ColorResult {
    if (this.isEmpty()) return result;
    const colors = [...(result.colors ?? result.groups.map((group) => group.color))];
    const groups = [...result.groups];
    const assignment = new Map(result.assignment);
    let unset = result.unset;
    for (const { color, ids } of this.byColor.values()) {
      if (colors.length >= MAX_GROUPS) {
        unset += ids.size;
        continue;
      }
      colors.push(color);
      const index = colors.length;
      const list = [...ids];
      for (const id of list) assignment.set(id, index);
      groups.push({ label: "Custom colour", color, count: list.length, ids: list });
    }
    return { groups, assignment, unset, colors };
  }
}

export const cssColor = (rgb: [number, number, number]): string => `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;

/** Property keys worth offering, most common first, quantities included. */
export function colorableKeys(index: PropertyIndex): Array<[string, number]> {
  return index.propertyKeys().slice(0, 300);
}
