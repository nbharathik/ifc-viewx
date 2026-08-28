import type {
  IfcScheduleTime,
  IfcTaskGraph,
  IfcTaskRecord,
  IfcTaskSequenceRecord,
  IfcWorkScheduleRecord,
} from "../viewer-core/engine/types.js";

type Line = Record<string, unknown> & { expressID?: number };

export interface TaskGraphLines {
  schedules: Line[];
  tasks: Line[];
  controls: Line[];
  nests: Line[];
  aggregates: Line[];
  processAssignments: Line[];
  sequences: Line[];
  line(expressID: number): Line | null;
}

function scalar(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return scalar((value as { value: unknown }).value);
  }
  return value;
}

function text(value: unknown): string {
  const raw = scalar(value);
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  if (raw && typeof raw === "object" && "name" in raw) return String((raw as { name: unknown }).name ?? "");
  return "";
}

function nullableText(value: unknown): string | null {
  const found = text(value).trim();
  return found || null;
}

function numberValue(value: unknown): number | null {
  const raw = scalar(value);
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return null;
  const numeric = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function booleanValue(value: unknown): boolean {
  const raw = scalar(value);
  if (typeof raw === "boolean") return raw;
  return String(raw).toLowerCase() === "true";
}

function ref(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("value" in value)) return null;
  const id = (value as { value: unknown }).value;
  return typeof id === "number" ? id : null;
}

function refs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(ref).filter((id): id is number => id !== null);
}

function lineId(line: Line): number | null {
  return typeof line.expressID === "number" ? line.expressID : null;
}

function add(map: Map<number, Set<number>>, key: number, value: number): void {
  let values = map.get(key);
  if (!values) {
    values = new Set();
    map.set(key, values);
  }
  values.add(value);
}

function timeOf(task: Line, source: TaskGraphLines): IfcScheduleTime | null {
  const id = ref(task.TaskTime);
  const time = id === null ? null : source.line(id);
  if (!time) return null;
  return {
    scheduleStart: nullableText(time.ScheduleStart),
    scheduleFinish: nullableText(time.ScheduleFinish),
    scheduleDuration: nullableText(time.ScheduleDuration),
    actualStart: nullableText(time.ActualStart),
    actualFinish: nullableText(time.ActualFinish),
    actualDuration: nullableText(time.ActualDuration),
    remainingTime: nullableText(time.RemainingTime),
    completion: numberValue(time.Completion),
    statusTime: nullableText(time.StatusTime),
  };
}

function lagOf(sequence: Line, source: TaskGraphLines): string | null {
  const id = ref(sequence.TimeLag);
  if (id === null) return nullableText(sequence.TimeLag);
  const lag = source.line(id);
  return lag ? nullableText(lag.LagValue) : null;
}

function descendants(root: number, children: Map<number, Set<number>>, found = new Set<number>()): Set<number> {
  const pending = [...(children.get(root) ?? [])];
  while (pending.length) {
    const child = pending.pop()!;
    if (found.has(child)) continue;
    found.add(child);
    pending.push(...(children.get(child) ?? []));
  }
  return found;
}

export function extractTaskGraph(source: TaskGraphLines): IfcTaskGraph {
  const taskIds = new Set(source.tasks.map(lineId).filter((id): id is number => id !== null));
  const scheduleIds = new Set(source.schedules.map(lineId).filter((id): id is number => id !== null));
  const children = new Map<number, Set<number>>();
  const parent = new Map<number, number>();
  const scheduleMembers = new Map<number, Set<number>>();
  const taskSchedules = new Map<number, Set<number>>();
  const products = new Map<number, Set<number>>();
  const predecessors = new Map<number, Set<number>>();
  const successors = new Map<number, Set<number>>();

  const relateHierarchy = (relation: Line): void => {
    const root = ref(relation.RelatingObject);
    if (root === null) return;
    for (const child of refs(relation.RelatedObjects)) {
      if (taskIds.has(root) && taskIds.has(child)) {
        add(children, root, child);
        if (!parent.has(child)) parent.set(child, root);
      } else if (scheduleIds.has(root) && taskIds.has(child)) {
        add(scheduleMembers, root, child);
      }
    }
  };
  for (const relation of source.nests) relateHierarchy(relation);
  for (const relation of source.aggregates) relateHierarchy(relation);

  for (const relation of source.controls) {
    const schedule = ref(relation.RelatingControl);
    if (schedule === null || !scheduleIds.has(schedule)) continue;
    for (const task of refs(relation.RelatedObjects)) if (taskIds.has(task)) add(scheduleMembers, schedule, task);
  }

  for (const [schedule, roots] of scheduleMembers) {
    const all = new Set<number>();
    for (const root of roots) {
      all.add(root);
      descendants(root, children, all);
    }
    scheduleMembers.set(schedule, all);
    for (const task of all) add(taskSchedules, task, schedule);
  }

  for (const relation of source.processAssignments) {
    const task = ref(relation.RelatingProcess);
    if (task === null || !taskIds.has(task)) continue;
    for (const product of refs(relation.RelatedObjects)) add(products, task, product);
  }

  const sequences: IfcTaskSequenceRecord[] = [];
  for (const relation of source.sequences) {
    const predecessorId = ref(relation.RelatingProcess);
    const successorId = ref(relation.RelatedProcess);
    const expressID = lineId(relation);
    if (expressID === null || predecessorId === null || successorId === null) continue;
    if (!taskIds.has(predecessorId) || !taskIds.has(successorId)) continue;
    add(successors, predecessorId, successorId);
    add(predecessors, successorId, predecessorId);
    sequences.push({
      expressID,
      predecessorId,
      successorId,
      sequenceType: text(relation.SequenceType),
      timeLag: lagOf(relation, source),
      modelIndex: 0,
      modelName: "",
    });
  }

  const schedules: IfcWorkScheduleRecord[] = source.schedules.flatMap((line) => {
    const expressID = lineId(line);
    if (expressID === null) return [];
    return [{
      expressID,
      globalId: text(line.GlobalId),
      name: text(line.Name),
      description: text(line.Description),
      identification: text(line.Identification),
      status: text(line.Status),
      predefinedType: text(line.PredefinedType),
      creationDate: nullableText(line.CreationDate),
      startTime: nullableText(line.StartTime),
      finishTime: nullableText(line.FinishTime),
      taskIds: [...(scheduleMembers.get(expressID) ?? [])],
      modelIndex: 0,
      modelName: "",
    }];
  });

  const tasks: IfcTaskRecord[] = source.tasks.flatMap((line) => {
    const expressID = lineId(line);
    if (expressID === null) return [];
    return [{
      expressID,
      globalId: text(line.GlobalId),
      name: text(line.Name),
      description: text(line.Description),
      identification: text(line.Identification),
      status: text(line.Status),
      predefinedType: text(line.PredefinedType),
      workMethod: text(line.WorkMethod),
      priority: numberValue(line.Priority),
      isMilestone: booleanValue(line.IsMilestone),
      taskTime: timeOf(line, source),
      scheduleIds: [...(taskSchedules.get(expressID) ?? [])],
      parentTaskId: parent.get(expressID) ?? null,
      childTaskIds: [...(children.get(expressID) ?? [])],
      productIds: [...(products.get(expressID) ?? [])],
      predecessorIds: [...(predecessors.get(expressID) ?? [])],
      successorIds: [...(successors.get(expressID) ?? [])],
      modelIndex: 0,
      modelName: "",
    }];
  });

  return { schedules, tasks, sequences };
}
