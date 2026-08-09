import {
  angleAt,
  formatAngle,
  formatArea,
  formatCoordinate,
  formatLength,
  ringArea,
  ringPerimeter,
} from "../viewer-core/viewer.js";
import type {
  MeasurementFormat,
  MeasurementObject,
  MeasurementState,
  SnapKind,
} from "../viewer-core/viewer.js";

type Point = [number, number, number];

export function measurementTypeLabel(item: MeasurementObject): string {
  if (item.kind === "distance") {
    return item.semantic.split("-").map((word) => word[0].toUpperCase() + word.slice(1)).join(" ");
  }
  if (item.kind === "path") return "Chained path";
  if (item.kind === "coordinate") return "Coordinate";
  return item.kind[0].toUpperCase() + item.kind.slice(1);
}

export function measurementValue(item: MeasurementObject, format: MeasurementFormat): string {
  if (item.kind === "distance") return formatLength(item.distance, format);
  if (item.kind === "angle") return formatAngle(item.angle ?? 0);
  if (item.kind === "area") return formatArea(item.area ?? 0, format);
  if (item.kind === "path") return formatLength(item.perimeter, format);
  return formatCoordinate(item.points[0], format);
}

function csvCell(value: unknown): string {
  let text = String(value ?? "");
  // Spreadsheet applications treat these prefixes as formulas even in an
  // imported CSV. The leading apostrophe is removed again by our importer.
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** Full-fidelity geometry plus readable columns; the same file can be imported. */
export function measurementsToCsv(items: MeasurementObject[], format: MeasurementFormat): string {
  const header = [
    "id", "kind", "label", "visible", "value", "unit", "type",
    "horizontal", "vertical", "slope_percent", "slope_angle", "points", "ends",
  ];
  const rows = items.map((item) => {
    const points = item.kind === "distance" ? [item.a, item.b] : item.points;
    const ends = item.kind === "distance" ? item.ends : [];
    return [
      item.id,
      item.kind,
      item.label,
      item.visible,
      measurementValue(item, format),
      format.unit,
      measurementTypeLabel(item),
      item.kind === "distance" ? item.horizontal : "",
      item.kind === "distance" ? item.vertical : "",
      item.kind === "distance" ? item.slopePercent ?? "vertical" : "",
      item.kind === "distance" ? item.slopeAngle : "",
      JSON.stringify(points),
      JSON.stringify(ends),
    ].map(csvCell).join(",");
  });
  return [header.join(","), ...rows].join("\r\n");
}

function parseRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"') quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
    } else if (char === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some(Boolean)) rows.push(row);
      row = [];
      cell = "";
    } else cell += char;
  }
  row.push(cell.replace(/\r$/, ""));
  if (row.some(Boolean)) rows.push(row);
  return rows;
}

const isPoint = (value: unknown): value is Point =>
  Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);

/** Parse only the geometry-bearing columns emitted above; display values are ignored. */
export function measurementsFromCsv(text: string): MeasurementState[] {
  const rows = parseRows(text);
  const header = rows.shift()?.map((cell) => cell.trim().toLowerCase()) ?? [];
  const at = (name: string): number => header.indexOf(name);
  if (at("kind") < 0 || at("points") < 0) throw new Error("Not an IFCView measurement CSV");
  const states: MeasurementState[] = [];
  for (const row of rows) {
    const kind = row[at("kind")]?.trim();
    const labelCell = row[at("label")] ?? "";
    const label = labelCell.startsWith("'") && /^[=+\-@]/.test(labelCell.slice(1)) ? labelCell.slice(1) : labelCell;
    const id = Number(row[at("id")]);
    const visible = row[at("visible")] !== "false";
    let points: unknown;
    try {
      points = JSON.parse(row[at("points")] ?? "[]");
    } catch {
      continue;
    }
    if (kind === "distance" && Array.isArray(points) && isPoint(points[0]) && isPoint(points[1])) {
      let ends: [SnapKind, SnapKind] = ["surface", "surface"];
      try {
        const parsed = JSON.parse(row[at("ends")] ?? "[]") as unknown;
        if (
          Array.isArray(parsed) && parsed.length === 2
          && parsed.every((entry) => ["vertex", "midpoint", "edge", "surface"].includes(entry))
        ) ends = parsed as [SnapKind, SnapKind];
      } catch { /* old or hand-edited file: surface is the safe fallback */ }
      states.push({ kind: "distance", ...(id > 0 ? { id } : {}), label, visible, a: points[0], b: points[1], ends });
      continue;
    }
    if (!["path", "angle", "area", "coordinate"].includes(kind ?? "") || !Array.isArray(points) || !points.every(isPoint)) continue;
    const minimum = kind === "coordinate" ? 1 : kind === "path" ? 2 : 3;
    if (points.length < minimum) continue;
    states.push({
      kind: kind as "path" | "angle" | "area" | "coordinate",
      ...(id > 0 ? { id } : {}),
      label,
      visible,
      points,
    });
  }
  return states;
}

/** Test helper for proving imported geometry recomputes the same values. */
export function stateValue(state: MeasurementState): number | Point {
  if ("a" in state) return Math.hypot(state.b[0] - state.a[0], state.b[1] - state.a[1], state.b[2] - state.a[2]);
  if (state.kind === "angle") return angleAt(state.points[0], state.points[1], state.points[2]);
  if (state.kind === "area") return ringArea(state.points);
  if (state.kind === "path") return ringPerimeter(state.points, false);
  return state.points[0];
}
