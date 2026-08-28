import type { IfcTaskGraph, IfcTaskRecord, ModelElement } from "@ifcviewx/sdk";

export type ConstructionState = "planned" | "active" | "delayed" | "completed";

export interface ImportedScheduleTask {
  externalId: string;
  name: string;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  progress: number;
  globalIds: string[];
  discipline: string;
}

export interface ScheduleFilterRule {
  type?: string;
  storey?: string;
  modelIndex?: number;
  nameContains?: string;
}

export interface ScheduleLink {
  kind: "selection" | "selection-set" | "filter" | "global-id";
  label: string;
  elementIds: number[];
  globalIds?: string[];
  rule?: ScheduleFilterRule;
}

export interface TaskMapping {
  taskKey: string;
  links: ScheduleLink[];
  updatedAt: string;
}

export interface ScheduleWorkspace {
  version: 1;
  modelKey: string;
  imported: ImportedScheduleTask[];
  mappings: Record<string, TaskMapping>;
}

export interface ScheduleTask {
  key: string;
  source: "ifc" | "csv" | "ifc+csv";
  externalId: string;
  name: string;
  description: string;
  scheduleName: string;
  plannedStart: string | null;
  plannedFinish: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  progress: number;
  modelIndex: number | null;
  modelName: string;
  parentKey: string | null;
  predecessorCount: number;
  isMilestone: boolean;
  elementIds: number[];
  nativeElementIds: number[];
  links: ScheduleLink[];
}

export interface ProgressSnapshot {
  state: ConstructionState;
  plannedProgress: number;
  actualProgress: number;
  varianceDays: number;
}

const DAY = 86_400_000;

const cleanHeader = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]/g, "");

function delimiterOf(text: string): string {
  const first = text.split(/\r?\n/, 1)[0] ?? "";
  const candidates = [",", "\t", ";"];
  return candidates.sort((a, b) => first.split(b).length - first.split(a).length)[0];
}

export function parseDelimited(text: string): string[][] {
  const delimiter = delimiterOf(text.replace(/^\uFEFF/, ""));
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^\uFEFF/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index];
    if (quoted) {
      if (char === '"' && input[index + 1] === '"') {
        cell += '"';
        index++;
      } else if (char === '"') quoted = false;
      else cell += char;
      continue;
    }
    if (char === '"') quoted = true;
    else if (char === delimiter) {
      row.push(cell.trim());
      cell = "";
    } else if (char === "\n") {
      row.push(cell.trim().replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell.trim().replace(/\r$/, ""));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

function excelDate(value: number): string | null {
  if (!Number.isFinite(value) || value < 1 || value > 2_958_465) return null;
  return new Date(Date.UTC(1899, 11, 30) + value * DAY).toISOString().slice(0, 10);
}

export function normalizeDate(value: string): string | null {
  const raw = value.trim();
  if (!raw) return null;
  if (/^\d+(?:\.\d+)?$/.test(raw)) return excelDate(Number(raw));
  const dotted = /^(\d{1,2})[./](\d{1,2})[./](\d{4})$/.exec(raw);
  if (dotted) {
    const iso = `${dotted[3]}-${dotted[2].padStart(2, "0")}-${dotted[1].padStart(2, "0")}`;
    return Number.isFinite(Date.parse(`${iso}T00:00:00Z`)) ? iso : null;
  }
  const slash = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(raw);
  const candidate = slash
    ? `${slash[1]}-${slash[2].padStart(2, "0")}-${slash[3].padStart(2, "0")}`
    : raw;
  return Number.isFinite(Date.parse(candidate)) ? candidate : null;
}

function percent(value: string | number | null | undefined): number {
  const raw = typeof value === "number" ? value : Number(String(value ?? "").replace(/%/g, "").trim());
  if (!Number.isFinite(raw)) return 0;
  const scaled = raw > 0 && raw <= 1 ? raw * 100 : raw;
  return Math.max(0, Math.min(100, scaled));
}

function valuesAt(row: string[], headers: string[], names: string[]): string {
  for (const name of names) {
    const index = headers.indexOf(name);
    if (index >= 0 && row[index]?.trim()) return row[index].trim();
  }
  return "";
}

export function parseScheduleCsv(text: string): ImportedScheduleTask[] {
  const table = parseDelimited(text);
  if (table.length < 2) throw new Error("The schedule CSV has no task rows");
  const headers = table[0].map(cleanHeader);
  const idNames = ["taskid", "activityid", "id", "identification", "wbs"];
  if (!idNames.some((name) => headers.includes(name))) {
    throw new Error("The schedule CSV needs a Task ID column");
  }
  const tasks: ImportedScheduleTask[] = [];
  const seen = new Set<string>();
  for (let index = 1; index < table.length; index++) {
    const row = table[index];
    const externalId = valuesAt(row, headers, idNames);
    if (!externalId) continue;
    const plannedStart = normalizeDate(valuesAt(row, headers, ["start", "plannedstart", "schedulestart"]));
    const plannedFinish = normalizeDate(valuesAt(row, headers, ["finish", "plannedfinish", "schedulefinish"]));
    const actualStart = normalizeDate(valuesAt(row, headers, ["actualstart", "started"]));
    const actualFinish = normalizeDate(valuesAt(row, headers, ["actualfinish", "completed", "finished"]));
    if (plannedStart && plannedFinish && dateValue(plannedFinish) < dateValue(plannedStart)) {
      throw new Error(`Task ${externalId} finishes before it starts`);
    }
    const key = externalId.toLowerCase();
    if (seen.has(key)) throw new Error(`Task ID ${externalId} appears more than once`);
    seen.add(key);
    const globalIds = valuesAt(row, headers, ["globalids", "globalid", "ifcglobalids"])
      .split(/[|;\s]+/)
      .map((value) => value.trim())
      .filter(Boolean);
    tasks.push({
      externalId,
      name: valuesAt(row, headers, ["taskname", "activityname", "name"]) || externalId,
      plannedStart,
      plannedFinish,
      actualStart,
      actualFinish,
      progress: percent(valuesAt(row, headers, ["progress", "completion", "complete", "percentcomplete"])),
      globalIds,
      discipline: valuesAt(row, headers, ["discipline", "model", "trade"]),
    });
  }
  if (!tasks.length) throw new Error("The schedule CSV has no usable task IDs");
  return tasks;
}

function durationMs(value: string | null): number | null {
  if (!value) return null;
  const match = /^P(?:(\d+(?:\.\d+)?)Y)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)W)?(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(value);
  if (!match) return null;
  const [, years, months, weeks, days, hours, minutes, seconds] = match.map((part) => Number(part || 0));
  return (((years * 365 + months * 30 + weeks * 7 + days) * 24 + hours) * 60 * 60 + minutes * 60 + seconds) * 1000;
}

export function dateValue(value: string | null): number {
  if (!value) return Number.NaN;
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00Z` : value;
  return Date.parse(dateOnly);
}

function isoFromMs(value: number): string {
  return new Date(value).toISOString();
}

function nativeRange(task: IfcTaskRecord, graph: IfcTaskGraph): [string | null, string | null] {
  const schedule = graph.schedules.find((item) => task.scheduleIds.includes(item.expressID));
  let start = task.taskTime?.scheduleStart ?? null;
  let finish = task.taskTime?.scheduleFinish ?? null;
  const duration = durationMs(task.taskTime?.scheduleDuration ?? null);
  if (!finish && start && duration !== null) finish = isoFromMs(dateValue(start) + duration);
  if (!start && finish && duration !== null) start = isoFromMs(dateValue(finish) - duration);
  return [start ?? schedule?.startTime ?? null, finish ?? schedule?.finishTime ?? null];
}

function nativeKey(task: IfcTaskRecord): string {
  return `ifc:${task.expressID}`;
}

function idsFor(task: IfcTaskRecord, mapping: TaskMapping | undefined): number[] {
  return [...new Set([...task.productIds, ...(mapping?.links.flatMap((link) => link.elementIds) ?? [])])];
}

function importedMatch(task: IfcTaskRecord, imported: ImportedScheduleTask[]): ImportedScheduleTask | undefined {
  const identities = new Set([
    task.identification.toLowerCase(),
    task.globalId.toLowerCase(),
    String(task.expressID).toLowerCase(),
  ].filter(Boolean));
  return imported.find((item) => identities.has(item.externalId.toLowerCase()));
}

export function buildScheduleTasks(graph: IfcTaskGraph, workspace: ScheduleWorkspace): ScheduleTask[] {
  const matched = new Set<ImportedScheduleTask>();
  const scheduleNames = new Map(graph.schedules.map((schedule) => [schedule.expressID, schedule.name || schedule.identification]));
  const native = graph.tasks.map((task): ScheduleTask => {
    const overlay = importedMatch(task, workspace.imported);
    if (overlay) matched.add(overlay);
    const [nativeStart, nativeFinish] = nativeRange(task, graph);
    const key = nativeKey(task);
    const mapping = workspace.mappings[key];
    return {
      key,
      source: overlay ? "ifc+csv" : "ifc",
      externalId: overlay?.externalId || task.identification || task.globalId || String(task.expressID),
      name: overlay?.name || task.name || task.identification || `Task #${task.expressID}`,
      description: task.description,
      scheduleName: task.scheduleIds.map((id) => scheduleNames.get(id)).filter(Boolean).join(", "),
      plannedStart: overlay?.plannedStart ?? nativeStart,
      plannedFinish: overlay?.plannedFinish ?? nativeFinish,
      actualStart: overlay?.actualStart ?? task.taskTime?.actualStart ?? null,
      actualFinish: overlay?.actualFinish ?? task.taskTime?.actualFinish ?? null,
      progress: overlay ? overlay.progress : percent(task.taskTime?.completion),
      modelIndex: task.modelIndex,
      modelName: overlay?.discipline || task.modelName,
      parentKey: task.parentTaskId === null ? null : `ifc:${task.parentTaskId}`,
      predecessorCount: task.predecessorIds.length,
      isMilestone: task.isMilestone,
      elementIds: idsFor(task, mapping),
      nativeElementIds: [...task.productIds],
      links: mapping?.links ?? [],
    };
  });
  const external = workspace.imported.filter((item) => !matched.has(item)).map((item): ScheduleTask => {
    const key = `csv:${item.externalId.toLowerCase()}`;
    const mapping = workspace.mappings[key];
    return {
      key,
      source: "csv",
      externalId: item.externalId,
      name: item.name,
      description: "",
      scheduleName: "Imported schedule",
      plannedStart: item.plannedStart,
      plannedFinish: item.plannedFinish,
      actualStart: item.actualStart,
      actualFinish: item.actualFinish,
      progress: item.progress,
      modelIndex: null,
      modelName: item.discipline || "External schedule",
      parentKey: null,
      predecessorCount: 0,
      isMilestone: item.plannedStart !== null && item.plannedStart === item.plannedFinish,
      elementIds: mapping?.links.flatMap((link) => link.elementIds) ?? [],
      nativeElementIds: [],
      links: mapping?.links ?? [],
    };
  });
  return [...native, ...external];
}

export function snapshotAt(task: ScheduleTask, at: number, now = Date.now()): ProgressSnapshot {
  const start = dateValue(task.plannedStart);
  const finish = dateValue(task.plannedFinish);
  const actualFinish = dateValue(task.actualFinish);
  const hasRange = Number.isFinite(start) && Number.isFinite(finish);
  const plannedProgress = !hasRange || at < start
    ? 0
    : at >= finish
      ? 100
      : Math.max(0, Math.min(100, ((at - start) / Math.max(1, finish - start)) * 100));
  const actualProgress = task.progress;
  const completed = Number.isFinite(actualFinish) ? at >= actualFinish : actualProgress >= 99.5 && at >= Math.min(now, Number.isFinite(start) ? start : now);
  const comparableAt = Math.min(at, now);
  const lateFinish = Number.isFinite(actualFinish) && Number.isFinite(finish) ? actualFinish - finish : 0;
  const overdue = !completed && Number.isFinite(finish) && comparableAt > finish ? comparableAt - finish : 0;
  const varianceDays = Math.max(lateFinish, overdue, 0) / DAY;
  const behind = at <= now && plannedProgress - actualProgress > 5;
  const state: ConstructionState = completed
    ? "completed"
    : varianceDays > 0 || behind
      ? "delayed"
      : Number.isFinite(start) && at < start
        ? "planned"
        : "active";
  return { state, plannedProgress, actualProgress, varianceDays };
}

export function scheduleRange(tasks: ScheduleTask[], statusDate?: number): [number, number] {
  const dates = tasks.flatMap((task) => [task.plannedStart, task.plannedFinish, task.actualStart, task.actualFinish])
    .map(dateValue)
    .filter(Number.isFinite);
  if (statusDate !== undefined && Number.isFinite(statusDate)) dates.push(statusDate);
  if (!dates.length) {
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    return [today.getTime() - 14 * DAY, today.getTime() + 30 * DAY];
  }
  return [Math.min(...dates), Math.max(...dates)];
}

export function matchFilter(elements: ModelElement[], rule: ScheduleFilterRule): number[] {
  const needle = rule.nameContains?.trim().toLowerCase() ?? "";
  return elements.filter((element) =>
    (!rule.type || element.type === rule.type)
    && (!rule.storey || element.storey === rule.storey)
    && (rule.modelIndex === undefined || Math.floor(element.id / 2 ** 32) === rule.modelIndex)
    && (!needle || element.name.toLowerCase().includes(needle)),
  ).map((element) => element.id);
}

export function addLink(workspace: ScheduleWorkspace, taskKey: string, link: ScheduleLink): void {
  const current = workspace.mappings[taskKey] ?? { taskKey, links: [], updatedAt: "" };
  const signature = `${link.kind}:${link.label}`;
  current.links = [...current.links.filter((item) => `${item.kind}:${item.label}` !== signature), {
    ...link,
    elementIds: [...new Set(link.elementIds.filter((id) => Number.isSafeInteger(id) && id > 0))],
  }];
  current.updatedAt = new Date().toISOString();
  workspace.mappings[taskKey] = current;
}

export function emptyWorkspace(modelKey: string): ScheduleWorkspace {
  return { version: 1, modelKey, imported: [], mappings: {} };
}

export function readWorkspace(value: unknown, modelKey: string): ScheduleWorkspace {
  if (!value || typeof value !== "object") throw new Error("The mapping file is not a JSON object");
  const record = value as Partial<ScheduleWorkspace>;
  if (record.version !== 1 || !Array.isArray(record.imported) || !record.mappings || typeof record.mappings !== "object") {
    throw new Error("The mapping file is not a supported 4D workspace");
  }
  const workspace = emptyWorkspace(modelKey);
  workspace.imported = record.imported.filter((item): item is ImportedScheduleTask =>
    Boolean(item && typeof item === "object" && typeof item.externalId === "string"));
  for (const [key, raw] of Object.entries(record.mappings)) {
    if (!raw || typeof raw !== "object" || !Array.isArray(raw.links)) continue;
    const links = raw.links.filter((link): link is ScheduleLink =>
      Boolean(link && typeof link === "object" && typeof link.kind === "string" && Array.isArray(link.elementIds)))
      .map((link) => ({ ...link, elementIds: link.elementIds.filter((id) => Number.isSafeInteger(id) && id > 0) }));
    workspace.mappings[key] = { taskKey: key, links, updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : "" };
  }
  return workspace;
}

export function formatDay(value: number | string | null): string {
  const time = typeof value === "number" ? value : dateValue(value);
  return Number.isFinite(time)
    ? new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "2-digit", timeZone: "UTC" }).format(time)
    : "No date";
}

export function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Task names and ids come from the IFC file or an imported CSV, so a cell can
  // arrive already shaped like a spreadsheet formula.
  if (typeof value === "string" && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
