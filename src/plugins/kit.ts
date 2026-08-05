// Shared plugin parts: the cached property index every data plugin reads, the
// table and toolbar bits their panels are made of, CSV and file output, and a
// store-only zip writer for BCF.
import { h, icon, toast } from "../ui/kit.js";
import { modelElements, type IndexedElement } from "../llm/actions.js";
import type { Viewer } from "../viewer-core/viewer.js";

export type Value = string | number | boolean | null;

export interface ElementRow extends IndexedElement {
  globalId: string;
  /** Direct IFC attributes, keyed by name. */
  attrs: Record<string, Value>;
  /** Property and quantity set values, keyed "SetName.PropertyName". */
  props: Record<string, Value>;
}

/** Property reads in flight; the worker answers one at a time, this hides the
 *  round trip between them. */
const WINDOW = 12;
const REPORT_EVERY = 25;

/**
 * Every element with its properties, built once per model and shared by every
 * plugin that needs it. The build is the expensive part (one engine round trip
 * per element), so it is progressive, cancellable and cached.
 */
export class PropertyIndex {
  private rows: ElementRow[] = [];
  private keys: Array<[string, number]> = [];
  private builtFor = "";
  private building: Promise<ElementRow[]> | null = null;
  private generation = 0;
  private readonly listeners = new Set<(done: number, total: number) => void>();

  constructor(
    private readonly viewer: Viewer,
    private readonly modelKey: () => string,
  ) {}

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
    const elements = modelElements(this.viewer);
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
    return rows;
  }

  private async rowFor(element: IndexedElement): Promise<ElementRow> {
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

// -- output -----------------------------------------------------------------
export function download(name: string, data: BlobPart, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = h("a", { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function toCsv(headers: string[], rows: Array<Array<Value | undefined>>): string {
  const cell = (value: Value | undefined): string => {
    const text = value === null || value === undefined ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  return [headers, ...rows].map((row) => row.map(cell).join(",")).join("\r\n");
}

export function saveCsv(name: string, headers: string[], rows: Array<Array<Value | undefined>>): void {
  download(name, `﻿${toCsv(headers, rows)}`, "text/csv;charset=utf-8");
}

/** Tab separated, which is what a spreadsheet expects from the clipboard. */
export function copyTable(headers: string[], rows: Array<Array<Value | undefined>>): void {
  const text = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? "")).join("\t")).join("\n");
  void navigator.clipboard
    ?.writeText(text)
    .then(() => toast(`${rows.length.toLocaleString()} row(s) copied`, "success"))
    .catch(() => toast("The browser blocked the clipboard", "error"));
}

// -- panel parts -------------------------------------------------------------
/** The page every plugin panel is built inside. */
export function page(...children: Node[]): HTMLElement {
  return h("div", { class: "page plug-page" }, children);
}

export function bar(...children: Array<Node | string>): HTMLElement {
  return h("div", { class: "plug-bar" }, children.map((c) => (typeof c === "string" ? h("span", { class: "plug-bar-label", text: c }) : c)));
}

export function button(label: string, run: () => void, kind = ""): HTMLButtonElement {
  const node = h("button", { class: `btn sm ${kind}`.trim(), type: "button", text: label });
  node.addEventListener("click", run);
  return node;
}

export function field(label: string, control: HTMLElement): HTMLElement {
  return h("label", { class: "plug-field" }, [h("span", { text: label }), control]);
}

export function select(options: Array<[string, string]>, value: string, onChange: (value: string) => void): HTMLSelectElement {
  const node = h("select", { class: "plug-select" });
  node.append(...options.map(([key, label]) => h("option", { value: key, text: label })));
  node.value = value;
  node.addEventListener("change", () => onChange(node.value));
  return node;
}

export function number(value: number, onChange: (value: number) => void, step = 1, min = 0): HTMLInputElement {
  const node = h("input", { type: "number", class: "plug-num", value: String(value), step: String(step), min: String(min) });
  node.addEventListener("change", () => onChange(Number(node.value)));
  return node;
}

export function progress(): { root: HTMLElement; set(done: number, total: number, label?: string): void; hide(): void } {
  const fill = h("i");
  const text = h("span", { class: "plug-progress-text" });
  const root = h("div", { class: "plug-progress hidden" }, [h("div", { class: "plug-progress-track" }, [fill]), text]);
  return {
    root,
    set(done, total, label) {
      root.classList.remove("hidden");
      const percent = total > 0 ? Math.round((done / total) * 100) : 0;
      fill.style.width = `${percent}%`;
      text.textContent = label ?? `${done.toLocaleString()} of ${total.toLocaleString()}`;
    },
    hide() {
      root.classList.add("hidden");
    },
  };
}

/** Headline numbers above a result table. */
export function stats(items: Array<[string, string, string?]>): HTMLElement {
  return h("div", { class: "plug-stats" }, items.map(([label, value, tone]) =>
    h("div", { class: `plug-stat${tone ? ` ${tone}` : ""}` }, [
      h("b", { text: value }),
      h("span", { text: label }),
    ]),
  ));
}

export interface GridRow {
  cells: Array<Value>;
  pick?: () => void;
  tone?: "err" | "warn" | "ok";
  title?: string;
}

/** A scrollable table with sticky headers; numbers align and format themselves. */
export function grid(headers: string[], rows: GridRow[], onSort?: (column: number) => void): HTMLElement {
  const head = h("tr", {}, headers.map((label, column) => {
    const cell = h("th", { text: label });
    if (onSort) {
      cell.classList.add("sortable");
      cell.addEventListener("click", () => onSort(column));
    }
    return cell;
  }));
  const body = h("tbody");
  for (const row of rows) {
    const tr = h("tr", { class: row.tone ?? "", title: row.title ?? "" });
    for (const value of row.cells) {
      const numeric = typeof value === "number";
      tr.appendChild(h("td", {
        class: numeric ? "num" : "",
        text: numeric ? formatNumber(value) : String(value ?? ""),
      }));
    }
    if (row.pick) {
      tr.classList.add("pick");
      tr.addEventListener("click", row.pick);
    }
    body.appendChild(tr);
  }
  return h("div", { class: "grid-wrap" }, [h("table", { class: "grid" }, [h("thead", {}, [head]), body])]);
}

export function formatNumber(value: number): string {
  if (!Number.isFinite(value)) return "";
  if (Number.isInteger(value)) return value.toLocaleString();
  const digits = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 1 ? 2 : 3;
  return value.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function note(text: string): HTMLElement {
  return h("div", { class: "note", text });
}

export function hint(iconName: string, text: string): HTMLElement {
  return h("div", { class: "plug-hint" }, [icon(iconName, 13), h("span", { text })]);
}

/** Multi-select list of IFC classes with counts, used by clash and takeoff. */
export function classPicker(
  counts: Array<[string, number]>,
  selected: Set<string>,
  onChange: () => void,
): HTMLElement {
  const list = h("div", { class: "plug-picker" });
  for (const [name, count] of counts) {
    const row = h("button", {
      class: "plug-pick",
      type: "button",
      "aria-pressed": String(selected.has(name)),
      title: `${name} (${count})`,
    }, [
      icon("check", 12),
      h("span", { class: "grow", text: name.replace(/^Ifc/, "") }),
      h("span", { class: "n", text: count.toLocaleString() }),
    ]);
    row.addEventListener("click", () => {
      if (selected.has(name)) selected.delete(name);
      else selected.add(name);
      row.setAttribute("aria-pressed", String(selected.has(name)));
      onChange();
    });
    list.appendChild(row);
  }
  return list;
}

/** Elements of the loaded model grouped by IFC class, largest first. */
export function classCounts(rows: Array<{ type: string }>): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.type, (counts.get(row.type) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}
