// Shared model data and tabular output used by the app and extension SDK.
//
// The property index is the expensive part of every data plugin: one engine
// round trip per element. It is built once per model and shared, so opening a
// second data plugin costs nothing.
import { toast } from "../ui/kit.js";
import type { ComputedSet, ComputeContext } from "../data/computed.js";
import type { SpatialNode, Viewer } from "../viewer-core/viewer.js";
import type { ElementRow, ModelElement, Value, XlsxOptions } from "./types.js";

export type { ElementRow, ModelElement, Value, XlsxOptions } from "./types.js";

/** Spatial containers, which are structure rather than placed elements. */
const SPATIAL_TYPES = new Set(["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"]);

/**
 * Every placed element under a spatial tree, each tagged with the storey it
 * sits in. Deliberately not the raw entity histogram, which is dominated by
 * the geometry primitives nobody asks about.
 */
export function elementsOf(tree: SpatialNode | null): ModelElement[] {
  if (!tree) return [];
  const elements: ModelElement[] = [];
  const visit = (node: SpatialNode, storey: string): void => {
    if (node.type === "IfcBuildingStorey") storey = node.name ?? "(unnamed storey)";
    else if (!SPATIAL_TYPES.has(node.type)) {
      elements.push({ id: node.expressID, type: node.type, name: node.name ?? "", storey });
    }
    for (const child of node.children) visit(child, storey);
  };
  visit(tree, "");
  return elements;
}

/** Property reads in flight; the worker answers one at a time, this hides the
 *  round trip between them. */
const WINDOW = 12;
const REPORT_EVERY = 25;

/**
 * Every element with its properties. The build is progressive, cancellable and
 * cached, and a plugin only ever has to call `build`.
 */
export class PropertyIndex {
  private rows: ElementRow[] = [];
  private keys: Array<[string, number]> = [];
  private builtFor = "";
  private building: Promise<ElementRow[]> | null = null;
  private generation = 0;
  private revisionCount = 0;
  /** Derived properties folded into every row, so they read like real ones. */
  private computed: ComputedSet | null = null;
  private readonly listeners = new Set<(done: number, total: number) => void>();
  private readonly changed = new Set<() => void>();

  constructor(
    private readonly viewer: Viewer,
    private readonly modelKey: () => string,
  ) {}

  /**
   * Install the computed-property set. Rows already built are recomputed in
   * place, so a definition edited mid-session shows up everywhere at once.
   */
  setComputed(computed: ComputedSet | null): void {
    this.computed = computed;
    if (this.ready()) this.applyComputed();
    this.revisionCount++;
    for (const listener of this.changed) listener();
  }

  /** Increments whenever the rows or the computed values change. */
  revision(): number {
    return this.revisionCount;
  }

  onChange(listener: () => void): () => void {
    this.changed.add(listener);
    return () => this.changed.delete(listener);
  }

  private computeContext(): ComputeContext {
    return {
      geometry: (id: number) => {
        const bounds = this.viewer.getElementBounds(id);
        return bounds
          ? { min: [bounds.min.x, bounds.min.y, bounds.min.z], max: [bounds.max.x, bounds.max.y, bounds.max.z] }
          : null;
      },
    };
  }

  private applyComputed(): void {
    const context = this.computeContext();
    for (const row of this.rows) {
      if (!row) continue;
      if (this.computed) this.computed.applyTo(row, context);
      else {
        for (const key of Object.keys(row.props)) {
          if (key.startsWith("Computed.")) delete row.props[key];
        }
      }
    }
    this.keys = [];
  }

  ready(): boolean {
    return this.builtFor !== "" && this.builtFor === this.modelKey();
  }

  all(): ElementRow[] {
    return this.ready() ? this.rows : [];
  }

  /** Property keys across the model, most common first. */
  propertyKeys(): Array<[string, number]> {
    if (this.keys.length || !this.ready()) return this.keys;
    const counts = new Map<string, number>();
    for (const row of this.rows) {
      for (const key of Object.keys(row.props)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    this.keys = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return this.keys;
  }

  invalidate(): void {
    this.generation++;
    this.rows = [];
    this.keys = [];
    this.builtFor = "";
    this.building = null;
  }

  build(onProgress?: (done: number, total: number) => void): Promise<ElementRow[]> {
    if (this.ready()) {
      onProgress?.(this.rows.length, this.rows.length);
      return Promise.resolve(this.rows);
    }
    if (onProgress) this.listeners.add(onProgress);
    if (!this.building) {
      this.building = this.run().finally(() => {
        this.building = null;
        this.listeners.clear();
      });
    }
    return this.building;
  }

  private async run(): Promise<ElementRow[]> {
    const gen = this.generation;
    const key = this.modelKey();
    const elements = elementsOf(this.viewer.getSpatialTree());
    const total = elements.length;
    const rows: ElementRow[] = new Array<ElementRow>(total);
    let done = 0;
    let next = 0;
    const pump = async (): Promise<void> => {
      for (;;) {
        const at = next++;
        if (at >= total) return;
        rows[at] = await this.rowFor(elements[at]);
        done += 1;
        if (done % REPORT_EVERY === 0 || done === total) {
          for (const listener of this.listeners) listener(done, total);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(WINDOW, total)) }, pump));
    if (gen !== this.generation) return this.run();
    this.rows = rows;
    this.keys = [];
    this.builtFor = key;
    this.applyComputed();
    this.revisionCount++;
    for (const listener of this.changed) listener();
    return rows;
  }

  private async rowFor(element: ModelElement): Promise<ElementRow> {
    const row: ElementRow = { ...element, globalId: "", attrs: {}, props: {} };
    const properties = await this.viewer.getProperties(element.id).catch(() => null);
    if (!properties) return row;
    for (const attribute of properties.attributes) row.attrs[attribute.name] = attribute.value;
    row.globalId = String(row.attrs.GlobalId ?? "");
    for (const set of properties.psets) {
      for (const property of set.properties) row.props[`${set.name}.${property.name}`] = property.value;
    }
    return row;
  }
}

/** Elements grouped by IFC class, largest first. */
export function classCounts(rows: Array<{ type: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// -- output -----------------------------------------------------------------
export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(headers: string[], rows: Array<Array<Value | undefined>>): string {
  const cell = (value: Value | undefined): string => {
    const raw = value === null || value === undefined ? "" : String(value);
    // IFC property values are untrusted input. Spreadsheet applications can
    // execute leading formula operators in CSV cells; preserve actual numeric
    // values, but force operator-prefixed strings to remain literal text.
    const text = typeof value === "string" && /^[=+\-@\t\r\n]/.test(raw) ? `'${raw}` : raw;
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

/** Written with a BOM, which is what a spreadsheet needs to read it as UTF-8. */
export function saveCsv(name: string, headers: string[], rows: Array<Array<Value | undefined>>): void {
  download(name, `\uFEFF${toCsv(headers, rows)}`, "text/csv;charset=utf-8");
}

const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

/** The saveCsv call with a real workbook behind it: numbers stay numbers. */
export async function saveXlsx(
  name: string,
  headers: string[],
  rows: Array<Array<Value | undefined>>,
  options: XlsxOptions = {},
): Promise<void> {
  download(name, await toXlsx(headers, rows, options), XLSX_TYPE);
}

/** The same workbook as bytes, for a caller that ships it somewhere other than a download. */
export async function toXlsx(
  headers: string[],
  rows: Array<Array<Value | undefined>>,
  options: XlsxOptions = {},
): Promise<ArrayBuffer> {
  const { buildXlsx } = await import("./xlsx.js");
  return buildXlsx(headers, rows, options);
}

/** Tab separated, which is what a spreadsheet expects from the clipboard. */
export function copyTable(headers: string[], rows: Array<Array<Value | undefined>>): void {
  // A pasted cell is read as a formula the same way an imported CSV cell is, so
  // operator-prefixed strings are forced to stay literal text here too.
  const cell = (value: Value | undefined): string => {
    const raw = value === null || value === undefined ? "" : String(value);
    return typeof value === "string" && /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  };
  const text = [headers, ...rows].map((row) => row.map(cell).join("\t")).join("\n");
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast(`${rows.length.toLocaleString()} row(s) copied`, "success"))
    .catch(() => toast("The browser blocked the clipboard", "error"));
}
