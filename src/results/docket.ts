export type DocketSeverity = "error" | "warning" | "info";

export interface DocketRow {
  id: string;
  severity: DocketSeverity;
  title: string;
  detail?: string;
  group?: string;
  ids: number[];
  point?: [number, number, number];
  assignee?: string;
  status?: "open" | "accepted" | "rejected";
}

export interface DocketSet {
  id: string;
  producer: string;
  title: string;
  summary: string;
  rows: DocketRow[];
  at: number;
}

type Listener = (sets: DocketSet[]) => void;

const sets = new Map<string, DocketSet>();
const listeners = new Set<Listener>();
const MAX_DOCKET_SETS = 128;
const MAX_DOCKET_ROWS = 50_000;
const MAX_ROW_IDS = 10_000;

const boundedText = (value: unknown, label: string, max: number, required = false): string => {
  if (typeof value !== "string" || value.length > max || (required && !value.trim())) {
    throw new TypeError(`Invalid results ${label}`);
  }
  return value;
};

function normalizeRow(row: DocketRow): DocketRow {
  if (!row || typeof row !== "object") throw new TypeError("Invalid results row");
  if (row.severity !== "error" && row.severity !== "warning" && row.severity !== "info") {
    throw new TypeError("Invalid results severity");
  }
  if (!Array.isArray(row.ids) || row.ids.length > MAX_ROW_IDS ||
    !row.ids.every((id) => Number.isSafeInteger(id) && id > 0)) throw new TypeError("Invalid results element ids");
  let point: [number, number, number] | undefined;
  if (row.point !== undefined) {
    if (!Array.isArray(row.point) || row.point.length !== 3 ||
      !row.point.every((value) => Number.isFinite(value) && Math.abs(value) <= 1e12)) {
      throw new TypeError("Invalid results point");
    }
    point = [row.point[0], row.point[1], row.point[2]];
  }
  if (row.status !== undefined && row.status !== "open" && row.status !== "accepted" && row.status !== "rejected") {
    throw new TypeError("Invalid results status");
  }
  return {
    id: boundedText(row.id, "row id", 500, true),
    severity: row.severity,
    title: boundedText(row.title, "row title", 2_000, true),
    ...(row.detail === undefined ? {} : { detail: boundedText(row.detail, "row detail", 20_000) }),
    ...(row.group === undefined ? {} : { group: boundedText(row.group, "row group", 2_000) }),
    ids: [...new Set(row.ids)],
    ...(point ? { point } : {}),
    ...(row.assignee === undefined ? {} : { assignee: boundedText(row.assignee, "assignee", 500) }),
    ...(row.status === undefined ? {} : { status: row.status }),
  };
}

export function publishDocket(set: Omit<DocketSet, "at">): void {
  if (!set || typeof set !== "object" || !Array.isArray(set.rows) || set.rows.length > MAX_DOCKET_ROWS) {
    throw new TypeError(`A results set may contain at most ${MAX_DOCKET_ROWS.toLocaleString()} rows`);
  }
  const id = boundedText(set.id, "set id", 500, true);
  if (!sets.has(id) && sets.size >= MAX_DOCKET_SETS) throw new Error("Too many result producers are active");
  const normalized: DocketSet = {
    id,
    producer: boundedText(set.producer, "producer", 500, true),
    title: boundedText(set.title, "title", 2_000, true),
    summary: boundedText(set.summary, "summary", 20_000),
    rows: set.rows.map(normalizeRow),
    at: Date.now(),
  };
  sets.set(id, normalized);
  emit();
}

export function clearDocket(id?: string): void {
  if (id === undefined) sets.clear();
  else sets.delete(id);
  emit();
}

export function docketSets(): DocketSet[] {
  return [...sets.values()].sort((a, b) => b.at - a.at);
}

export function onDocketChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function emit(): void {
  const list = docketSets();
  for (const listener of listeners) listener(list);
}
