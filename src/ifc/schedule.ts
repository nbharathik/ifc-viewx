// Element schedules: one row per element of a class, with property columns
// resolved through the element type. Type inheritance is the part a plain
// instance read gets wrong.
import { IfcModel, val } from "./model.js";

export interface ScheduleReport {
  type: string;
  total: number;
  returned: number;
  truncated: boolean;
  columns: string[];
  availableProperties: string[];
  rows: Array<Record<string, unknown>>;
}

const BASE_COLUMNS = ["expressID", "GlobalId", "Type", "Name", "Storey"];

export function schedule(
  model: IfcModel,
  ifcType = "IfcElement",
  properties: string[] = [],
  limit = 500,
): ScheduleReport {
  const ids = model.byType(ifcType);
  const capped = ids.slice(0, Math.max(1, Math.min(limit, 20_000)));
  const available = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];

  for (const id of capped) {
    const line = model.line(id);
    if (!line) continue;
    const flat = model.flatProperties(id);
    for (const key of flat.keys()) if (key.includes(".")) available.add(key);
    const storey = model.storeyOf(id);
    const row: Record<string, unknown> = {
      expressID: id,
      GlobalId: val(line.GlobalId),
      Type: model.typeName(id),
      Name: val(line.Name),
      Storey: storey === null ? null : val(model.line(storey)?.Name),
    };
    for (const property of properties) row[property] = flat.get(property) ?? null;
    rows.push(row);
  }

  return {
    type: ifcType,
    total: ids.length,
    returned: rows.length,
    truncated: ids.length > capped.length,
    columns: [...BASE_COLUMNS, ...properties],
    availableProperties: [...available].sort(),
    rows,
  };
}
