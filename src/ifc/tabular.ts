// The spreadsheet round trip: model to table, edited table back to staged edits.
//
// Both directions live here on purpose. Export and import share one column
// grammar, and the moment they are in different files they drift: a column
// renamed on the way out stops matching on the way back in, and the failure is
// silent because an unmatched column just looks like "nothing changed".
//
// The join key is GlobalId, never expressID. An expressID is a STEP line
// number, so it is per file and per federated model; a spreadsheet that has
// been through Excel and back must still find its element, and a GlobalId is
// the only identifier IFC promises to keep.
import type { EditOp } from "./edits.js";

/** Fixed columns, in this order, before the property columns. */
export const FIXED_COLUMNS = ["GlobalId", "Model", "ExpressID", "Class", "Name", "Storey"] as const;

/** Columns a re-import will never write back to the model. */
const READ_ONLY = new Set<string>(["GlobalId", "Model", "ExpressID", "Class", "Storey"]);

/**
 * Header spellings that mean a fixed column. The schedule panel has always
 * written `expressID` and `Type`, and older exports are in the wild, so a
 * re-import understands both rather than reporting a column it wrote itself
 * as unknown.
 */
const ALIASES: Record<string, string> = {
  expressid: "ExpressID",
  type: "Class",
  ifcclass: "Class",
  globalid: "GlobalId",
  guid: "GlobalId",
  name: "Name",
  storey: "Storey",
  model: "Model",
};

/** Resolve a header to its canonical column name. */
export function canonicalColumn(header: string): string {
  const key = header.trim().toLowerCase();
  return ALIASES[key] ?? header.trim();
}

/** One element as a row: the fixed columns plus "Set.Property" values. */
export interface TableRow {
  globalId: string;
  model: number;
  expressID: number;
  ifcClass: string;
  name: string;
  storey: string;
  /** Keyed "Pset_WallCommon.IsExternal", exactly as the column is headed. */
  props: Record<string, string>;
}

export interface Table {
  columns: string[];
  rows: TableRow[];
}

/**
 * RFC 4180 with the concessions a real spreadsheet needs: a UTF-8 BOM, CRLF or
 * LF, quoted fields carrying commas, quotes and newlines, and a trailing
 * newline. Hand-rolled rather than pulled in: the format is small, and the
 * failure modes we care about are exactly the ones a general parser hides.
 */
export function parseDelimited(text: string, delimiter = ","): string[][] {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;

  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quoted) {
      if (c !== '"') {
        field += c;
        continue;
      }
      // A doubled quote inside a quoted field is one literal quote.
      if (body[i + 1] === '"') {
        field += '"';
        i++;
        continue;
      }
      quoted = false;
      continue;
    }
    if (c === '"' && field === "") {
      quoted = true;
      started = true;
      continue;
    }
    if (c === delimiter) {
      row.push(field);
      field = "";
      started = true;
      continue;
    }
    if (c === "\r") continue;
    if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      started = false;
      continue;
    }
    field += c;
    started = true;
  }
  // A file ending without a newline still has a last row; one ending with a
  // newline does not have an extra empty one.
  if (started || field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Guess the delimiter, because a German Excel writes semicolons. */
export function sniffDelimiter(text: string): string {
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  const counts: Array<[string, number]> = [",", ";", "\t"].map((d) => [d, line.split(d).length - 1]);
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ",";
}

/** Column list for a set of rows: the fixed ones, then every property seen. */
export function columnsOf(rows: TableRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) for (const key of Object.keys(row.props)) seen.add(key);
  return [...FIXED_COLUMNS, ...[...seen].sort()];
}

export function buildTable(rows: TableRow[], columns = columnsOf(rows)): string[][] {
  const cells = (row: TableRow): string[] =>
    columns.map((column) => {
      switch (column) {
        case "GlobalId": return row.globalId;
        case "Model": return String(row.model);
        case "ExpressID": return String(row.expressID);
        case "Class": return row.ifcClass;
        case "Name": return row.name;
        case "Storey": return row.storey;
        default: return row.props[column] ?? "";
      }
    });
  return [columns, ...rows.map(cells)];
}

/**
 * A schedule report as table rows. The schedule already produces GlobalId,
 * Type, Name and Storey plus one column per property, so this is a rename
 * rather than a second extraction, and the two cannot disagree about content.
 */
export function fromScheduleRows(
  rows: Array<Record<string, unknown>>,
  columns: string[],
  model = 0,
): TableRow[] {
  const text = (value: unknown): string => (value === null || value === undefined ? "" : String(value));
  const skip = new Set(["expressID", "GlobalId", "Type", "Name", "Storey"]);
  return rows.map((row) => {
    const props: Record<string, string> = {};
    for (const column of columns) {
      if (skip.has(column)) continue;
      props[column] = text(row[column]);
    }
    return {
      globalId: text(row.GlobalId),
      model,
      expressID: Number(row.expressID) || 0,
      ifcClass: text(row.Type),
      name: text(row.Name),
      storey: text(row.Storey),
      props,
    };
  });
}

/** One cell that differs between the exported table and the one coming back. */
export interface CellChange {
  globalId: string;
  expressID: number;
  model: number;
  column: string;
  before: string;
  after: string;
}

export interface TableDiff {
  changes: CellChange[];
  /** Rows whose GlobalId is not in the model. Reported, never guessed at. */
  unknown: string[];
  /** Rows in the model the file did not mention. Left alone. */
  untouched: number;
  /** Columns the file added that no element carries. Cannot be written. */
  unknownColumns: string[];
  /** Columns that exist but this importer will not write back. */
  readOnlyEdits: string[];
}

/**
 * Compare an incoming sheet against the model rows it claims to describe.
 *
 * Only cells that actually differ become changes. A file exported and brought
 * straight back therefore produces nothing at all, which is the property that
 * makes the round trip safe to use casually.
 */
export function diffTable(current: TableRow[], incoming: string[][]): TableDiff {
  const header = (incoming[0] ?? []).map(canonicalColumn);
  const idColumn = header.indexOf("GlobalId");
  const diff: TableDiff = { changes: [], unknown: [], untouched: 0, unknownColumns: [], readOnlyEdits: [] };
  if (idColumn < 0) {
    // Without the join key nothing can be matched, and matching by row order
    // would write the wrong element the moment someone sorts the sheet.
    diff.unknownColumns = header.slice();
    return diff;
  }

  const byGlobalId = new Map(current.map((row) => [row.globalId, row]));
  const known = new Set(columnsOf(current));
  for (const column of header) {
    if (!known.has(column) && column !== "") diff.unknownColumns.push(column);
  }

  const touched = new Set<string>();
  for (let r = 1; r < incoming.length; r++) {
    const line = incoming[r];
    const globalId = (line[idColumn] ?? "").trim();
    if (!globalId) continue;
    const row = byGlobalId.get(globalId);
    if (!row) {
      diff.unknown.push(globalId);
      continue;
    }
    touched.add(globalId);
    for (let c = 0; c < header.length; c++) {
      const column = header[c];
      if (!column || !known.has(column)) continue;
      const after = (line[c] ?? "").trim();
      const before = valueOf(row, column);
      if (after === before) continue;
      if (READ_ONLY.has(column)) {
        if (!diff.readOnlyEdits.includes(column)) diff.readOnlyEdits.push(column);
        continue;
      }
      diff.changes.push({ globalId, expressID: row.expressID, model: row.model, column, before, after });
    }
  }
  diff.untouched = current.length - touched.size;
  return diff;
}

function valueOf(row: TableRow, column: string): string {
  switch (column) {
    case "GlobalId": return row.globalId;
    case "Model": return String(row.model);
    case "ExpressID": return String(row.expressID);
    case "Class": return row.ifcClass;
    case "Name": return row.name;
    case "Storey": return row.storey;
    default: return row.props[column] ?? "";
  }
}

/** Text back to the type IFC wants, so "true" does not land as a string. */
export function coerce(text: string): string | number | boolean {
  const trimmed = text.trim();
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toLowerCase() === "true";
  // Only a plain decimal number; "1.2.3" and "12A" stay text, and so does a
  // leading-zero code like "007" that a spreadsheet would otherwise mangle.
  if (/^-?\d+(\.\d+)?$/.test(trimmed) && !/^-?0\d/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return n;
  }
  return text;
}

/**
 * Turn cell changes into staged edits, grouped so elements sharing a new value
 * become one operation. Grouping is not cosmetic: each op runs against a copy
 * of the model, so a thousand single-element ops would be a thousand passes.
 */
export function toEditOps(diff: TableDiff): EditOp[] {
  const groups = new Map<string, { column: string; value: string; ids: number[] }>();
  for (const change of diff.changes) {
    const key = `${change.column}\u0000${change.after}`;
    const group = groups.get(key);
    if (group) group.ids.push(change.expressID);
    else groups.set(key, { column: change.column, value: change.after, ids: [change.expressID] });
  }

  const ops: EditOp[] = [];
  for (const { column, value, ids } of groups.values()) {
    const dot = column.indexOf(".");
    if (dot > 0) {
      ops.push({
        op: "setProperty",
        ids,
        set: column.slice(0, dot),
        property: column.slice(dot + 1),
        value: coerce(value),
      });
    } else {
      ops.push({ op: "setAttribute", ids, attribute: column, value: coerce(value) });
    }
  }
  return ops;
}

/** One line a user can read, for the staged-import preview. */
export function describeDiff(diff: TableDiff): string {
  const parts = [`${diff.changes.length} cell${diff.changes.length === 1 ? "" : "s"} changed`];
  const elements = new Set(diff.changes.map((change) => change.globalId)).size;
  if (elements) parts.push(`across ${elements} element${elements === 1 ? "" : "s"}`);
  if (diff.unknown.length) parts.push(`${diff.unknown.length} row(s) matched no element`);
  if (diff.unknownColumns.length) parts.push(`unknown column(s): ${diff.unknownColumns.join(", ")}`);
  if (diff.readOnlyEdits.length) parts.push(`${diff.readOnlyEdits.join(", ")} cannot be edited here`);
  return parts.join("; ");
}
