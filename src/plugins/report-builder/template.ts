// A report is a definition, not a rendered table.
//
// The template says what to select, which columns to read and how to fold
// them; the same file re-runs on the next revision and issues identically to
// CSV, a workbook and a printed page.
import { matchText, normalizeSelector, readRowProperty, type ElementRow, type Selector, type Value } from "@ifcviewx/sdk";

export type Aggregate = "none" | "count" | "sum" | "average" | "min" | "max";

export interface ReportColumn {
  /** "Set.Property", a bare attribute, or one of the model facts. */
  key: string;
  header: string;
  aggregate: Aggregate;
  /** Decimal places for a numeric column; -1 leaves the value alone. */
  decimals?: number;
}

export type ReportScope =
  | { kind: "everything" }
  | { kind: "visible" }
  | { kind: "selection" }
  | { kind: "query"; selector: Selector };

export interface ReportTemplate {
  id: string;
  name: string;
  description: string;
  scope: ReportScope;
  columns: ReportColumn[];
  groupBy: string;
  sortBy: string;
  sortDescending: boolean;
  /** Rows with no value in every column are usually noise in a schedule. */
  dropEmptyRows: boolean;
}

export const TEMPLATE_FORMAT = "ifcviewx.report";

export interface TemplateFile {
  format: typeof TEMPLATE_FORMAT;
  version: 1;
  templates: ReportTemplate[];
}

export const FACT_KEYS = ["Type", "Name", "Storey", "GlobalId", "Id"];

/** One value for one element, from wherever that name lives. */
export function readValue(row: ElementRow, key: string): Value {
  const lower = key.toLowerCase();
  if (lower === "type" || lower === "class") return row.type.replace(/^Ifc/, "");
  if (lower === "name") return row.name || String(row.attrs.Name ?? "");
  if (lower === "storey" || lower === "level") return row.storey;
  if (lower === "globalid") return row.globalId;
  if (lower === "id") return row.id;
  if (key in row.props) return row.props[key];
  const dot = key.lastIndexOf(".");
  const found = readRowProperty(row, dot < 0 ? "" : key.slice(0, dot), dot < 0 ? key : key.slice(dot + 1));
  if (found.length > 0) {
    const numeric = Number(found[0]);
    return Number.isFinite(numeric) && found[0].trim() !== "" ? numeric : found[0];
  }
  return null;
}

export interface ReportRow {
  id: number;
  cells: Value[];
}

export interface ReportGroup {
  key: string;
  rows: ReportRow[];
  ids: number[];
  /** One value per column: the aggregate, or blank where none applies. */
  totals: Value[];
}

export interface BuiltReport {
  template: ReportTemplate;
  headers: string[];
  rows: ReportRow[];
  groups: ReportGroup[];
  totals: Value[];
  /** Elements the scope selected but which carried nothing in any column. */
  dropped: number;
}

const asNumber = (value: Value): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === "") return null;
  const parsed = Number(String(value).replace(/[^0-9.eE+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
};

const blank = (value: Value): boolean => value === null || value === undefined || value === "";

function fold(values: Value[], aggregate: Aggregate, rowCount: number): Value {
  if (aggregate === "none") return "";
  if (aggregate === "count") return rowCount;
  const numbers = values.map(asNumber).filter((value): value is number => value !== null);
  if (numbers.length === 0) return "";
  if (aggregate === "sum") return round(numbers.reduce((total, value) => total + value, 0));
  if (aggregate === "average") return round(numbers.reduce((total, value) => total + value, 0) / numbers.length);
  if (aggregate === "min") return round(numbers.reduce((best, value) => Math.min(best, value), Infinity));
  return round(numbers.reduce((best, value) => Math.max(best, value), -Infinity));
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

export interface BuildInput {
  template: ReportTemplate;
  rows: ElementRow[];
  /** Ids the scope allows; null means the template's own scope decides. */
  scopeIds: Set<number> | null;
}

export function buildReportTable({ template, rows, scopeIds }: BuildInput): BuiltReport {
  const columns = template.columns.length ? template.columns : [{ key: "Type", header: "Class", aggregate: "count" as Aggregate }];
  const scope = template.scope;
  const wanted = scopeIds
    ? rows.filter((row) => scopeIds.has(row.id))
    : scope.kind === "query"
      ? rows.filter((row) => matchesSelector(row, scope.selector))
      : rows;

  let dropped = 0;
  const built: ReportRow[] = [];
  for (const row of wanted) {
    const cells = columns.map((column) => {
      const value = readValue(row, column.key);
      if (typeof value === "number" && Number.isInteger(column.decimals) && column.decimals! >= 0 && column.decimals! <= 12) {
        return Number(value.toFixed(column.decimals));
      }
      return value;
    });
    if (template.dropEmptyRows && cells.every(blank)) {
      dropped++;
      continue;
    }
    built.push({ id: row.id, cells });
  }

  const sortAt = columns.findIndex((column) => column.key === template.sortBy);
  if (sortAt >= 0) {
    built.sort((a, b) => {
      const left = a.cells[sortAt];
      const right = b.cells[sortAt];
      const leftNumber = asNumber(left);
      const rightNumber = asNumber(right);
      const order = leftNumber !== null && rightNumber !== null
        ? leftNumber - rightNumber
        : String(left ?? "").localeCompare(String(right ?? ""));
      return template.sortDescending ? -order : order;
    });
  }

  const totals = columns.map((column, index) => fold(built.map((row) => row.cells[index]), column.aggregate, built.length));

  const groupAt = columns.findIndex((column) => column.key === template.groupBy);
  const groups: ReportGroup[] = [];
  if (groupAt >= 0) {
    const buckets = new Map<string, ReportRow[]>();
    for (const row of built) {
      const key = String(row.cells[groupAt] ?? "(not set)");
      const bucket = buckets.get(key);
      if (bucket) bucket.push(row);
      else buckets.set(key, [row]);
    }
    for (const [key, bucket] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
      groups.push({
        key,
        rows: bucket,
        ids: bucket.map((row) => row.id),
        totals: columns.map((column, index) => fold(bucket.map((row) => row.cells[index]), column.aggregate, bucket.length)),
      });
    }
  }

  return {
    template,
    headers: columns.map((column) => column.header || column.key),
    rows: built,
    groups,
    totals,
    dropped,
  };
}

/** The saved-view selector language, answered from one index row. */
export function matchesSelector(row: ElementRow, selector: Selector): boolean {
  switch (selector.kind) {
    case "all":
      return true;
    case "ids":
      return selector.ids.includes(row.id);
    case "class":
      return selector.values.some((value) => value.toLowerCase().replace(/^ifc/, "") === row.type.toLowerCase().replace(/^ifc/, ""));
    case "storey":
      return selector.values.some((value) => value.toLowerCase() === row.storey.toLowerCase());
    case "model":
      return false;
    case "name":
      return matchText([row.name], selector.op, selector.value);
    case "property":
      return matchText(readRowProperty(row, selector.set, selector.name), selector.op, selector.value);
    case "any":
      return selector.of.some((inner) => matchesSelector(row, inner));
    case "every":
      return selector.of.every((inner) => matchesSelector(row, inner));
    case "not":
      return !matchesSelector(row, selector.of);
  }
}

// -- files ------------------------------------------------------------------

export function serializeTemplates(templates: ReportTemplate[]): string {
  const file: TemplateFile = { format: TEMPLATE_FORMAT, version: 1, templates };
  return JSON.stringify(file, null, 2);
}

export function parseTemplates(source: string): ReportTemplate[] {
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
    const file = parsed as Partial<TemplateFile>;
    if ((file.format !== undefined && file.format !== TEMPLATE_FORMAT) ||
      (file.version !== undefined && file.version !== 1)) return [];
  }
  const list: unknown = Array.isArray(parsed) ? parsed : (parsed as TemplateFile)?.templates;
  if (!Array.isArray(list)) return [];
  return list
    .map((raw): ReportTemplate | null => {
      if (typeof raw !== "object" || raw === null) return null;
      const value = raw as Partial<ReportTemplate>;
      if (typeof value.name !== "string" || !value.name.trim()) return null;
      const rawScope = typeof value.scope === "object" && value.scope !== null ? value.scope as Record<string, unknown> : {};
      let scope: ReportScope = { kind: "everything" };
      if (rawScope.kind === "visible" || rawScope.kind === "selection" || rawScope.kind === "everything") {
        scope = { kind: rawScope.kind };
      } else if (rawScope.kind === "query") {
        const selector = normalizeSelector(rawScope.selector);
        if (!selector) return null;
        scope = { kind: "query", selector };
      }
      const aggregates = new Set<Aggregate>(["none", "count", "sum", "average", "min", "max"]);
      return {
        id: typeof value.id === "string" && value.id ? value.id : `rt-${Math.random().toString(36).slice(2, 9)}`,
        name: value.name,
        description: typeof value.description === "string" ? value.description : "",
        scope,
        columns: Array.isArray(value.columns)
          ? value.columns.slice(0, 256)
              .filter((column): column is ReportColumn => typeof column === "object" && column !== null && typeof column.key === "string")
              .map((column) => ({
                key: column.key,
                header: typeof column.header === "string" && column.header ? column.header : column.key,
                aggregate: aggregates.has(column.aggregate) ? column.aggregate : "none",
                ...(Number.isInteger(column.decimals) && column.decimals! >= -1 && column.decimals! <= 12
                  ? { decimals: column.decimals }
                  : {}),
              }))
          : [],
        groupBy: typeof value.groupBy === "string" ? value.groupBy : "",
        sortBy: typeof value.sortBy === "string" ? value.sortBy : "",
        sortDescending: value.sortDescending === true,
        dropEmptyRows: value.dropEmptyRows !== false,
      };
    })
    .filter((value): value is ReportTemplate => value !== null);
}

/** Schedules a project asks for on nearly every job. */
export const REPORT_PRESETS: Array<{ label: string; template: Omit<ReportTemplate, "id"> }> = [
  {
    label: "Door schedule",
    template: {
      name: "Door schedule",
      description: "Every door with its type, size and fire rating, grouped by storey.",
      scope: { kind: "query", selector: { kind: "class", values: ["IfcDoor"] } },
      columns: [
        { key: "Storey", header: "Level", aggregate: "none" },
        { key: "Name", header: "Mark", aggregate: "count" },
        { key: "OverallWidth", header: "Width", aggregate: "none", decimals: 3 },
        { key: "OverallHeight", header: "Height", aggregate: "none", decimals: 3 },
        { key: "FireRating", header: "Fire rating", aggregate: "none" },
        { key: "IsExternal", header: "External", aggregate: "none" },
      ],
      groupBy: "Storey",
      sortBy: "Name",
      sortDescending: false,
      dropEmptyRows: false,
    },
  },
  {
    label: "Room data sheet",
    template: {
      name: "Room data sheet",
      description: "Spaces with their number, name and area, grouped by storey.",
      scope: { kind: "query", selector: { kind: "class", values: ["IfcSpace"] } },
      columns: [
        { key: "Storey", header: "Level", aggregate: "none" },
        { key: "LongName", header: "Room", aggregate: "count" },
        { key: "Name", header: "Number", aggregate: "none" },
        { key: "NetFloorArea", header: "Net area", aggregate: "sum", decimals: 2 },
        { key: "GrossFloorArea", header: "Gross area", aggregate: "sum", decimals: 2 },
      ],
      groupBy: "Storey",
      sortBy: "Name",
      sortDescending: false,
      dropEmptyRows: false,
    },
  },
  {
    label: "Valuation quantities",
    template: {
      name: "Valuation quantities",
      description: "Volumes and areas grouped by classification, the way a quantity surveyor cuts them.",
      scope: { kind: "everything" },
      columns: [
        { key: "Computed.Cost code", header: "Cost code", aggregate: "none" },
        { key: "Type", header: "Class", aggregate: "count" },
        { key: "NetVolume", header: "Volume", aggregate: "sum", decimals: 3 },
        { key: "NetArea", header: "Area", aggregate: "sum", decimals: 2 },
      ],
      groupBy: "Computed.Cost code",
      sortBy: "Type",
      sortDescending: false,
      dropEmptyRows: true,
    },
  },
  {
    label: "Classification coverage",
    template: {
      name: "Classification coverage",
      description: "Every class with how many of its elements carry a classification reference.",
      scope: { kind: "everything" },
      columns: [
        { key: "Type", header: "Class", aggregate: "count" },
        { key: "Name", header: "Name", aggregate: "none" },
        { key: "Classification", header: "Classification", aggregate: "none" },
        { key: "Storey", header: "Level", aggregate: "none" },
      ],
      groupBy: "Type",
      sortBy: "Name",
      sortDescending: false,
      dropEmptyRows: false,
    },
  },
];
