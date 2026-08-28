import type { Value } from "../data/model.js";
import type { GeometrySignature } from "../geometry/types.js";

export type CompareKind = "added" | "removed" | "geometry" | "placement" | "containment" | "properties" | "mixed" | "unchanged";

export interface CompareSnapshot {
  globalId: string;
  id: number;
  type: string;
  name: string;
  storey: string;
  values: Record<string, Value>;
  geometry?: GeometrySignature;
}

export interface PropertyChange {
  key: string;
  from: Value;
  to: Value;
}

export interface GeometryDelta {
  shapeChanged: boolean;
  translation: [number, number, number];
  translationDistance: number;
  rotationDegrees: number;
  size: [number, number, number];
  beforeTriangles: number;
  afterTriangles: number;
}

export interface CompareEntry {
  globalId: string;
  id: number;
  type: string;
  name: string;
  storey: string;
  kind: CompareKind;
  categories: Array<"geometry" | "placement" | "containment" | "properties">;
  changes: PropertyChange[];
  geometry?: GeometryDelta;
  before?: CompareSnapshot;
  after?: CompareSnapshot;
}

export interface CompareResult {
  entries: CompareEntry[];
  counts: Record<CompareKind, number>;
  geometryCompared: number;
  geometryMissing: number;
}

const EPSILON = 1e-6;
const PLACEMENT_METRES = 0.0005;
const ROTATION_DEGREES = 0.05;

export function propertyDifferences(before: Record<string, Value>, after: Record<string, Value>): PropertyChange[] {
  const changes: PropertyChange[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (same(from, to)) continue;
    changes.push({ key, from, to });
  }
  return changes.sort((a, b) => a.key.localeCompare(b.key));
}

function same(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < EPSILON;
  return String(a ?? "") === String(b ?? "");
}

const sizeOf = (signature: GeometrySignature): [number, number, number] => [
  signature.bounds.max[0] - signature.bounds.min[0],
  signature.bounds.max[1] - signature.bounds.min[1],
  signature.bounds.max[2] - signature.bounds.min[2],
];

function geometryDelta(before: GeometrySignature, after: GeometrySignature): GeometryDelta {
  const translation: [number, number, number] = [
    after.translation[0] - before.translation[0],
    after.translation[1] - before.translation[1],
    after.translation[2] - before.translation[2],
  ];
  const dot = Math.min(1, Math.abs(
    before.rotation[0] * after.rotation[0]
      + before.rotation[1] * after.rotation[1]
      + before.rotation[2] * after.rotation[2]
      + before.rotation[3] * after.rotation[3],
  ));
  const beforeSize = sizeOf(before);
  const afterSize = sizeOf(after);
  const size: [number, number, number] = [
    afterSize[0] - beforeSize[0],
    afterSize[1] - beforeSize[1],
    afterSize[2] - beforeSize[2],
  ];
  return {
    shapeChanged: before.shapeHash !== after.shapeHash
      || before.vertices !== after.vertices
      || before.triangles !== after.triangles
      || before.pieces !== after.pieces
      || size.some((delta) => Math.abs(delta) > EPSILON),
    translation,
    translationDistance: Math.hypot(...translation),
    rotationDegrees: 2 * Math.acos(dot) * 180 / Math.PI,
    size,
    beforeTriangles: before.triangles,
    afterTriangles: after.triangles,
  };
}

function emptyCounts(): Record<CompareKind, number> {
  return { added: 0, removed: 0, geometry: 0, placement: 0, containment: 0, properties: 0, mixed: 0, unchanged: 0 };
}

export function compareSnapshots(current: CompareSnapshot[], baseline: CompareSnapshot[]): CompareResult {
  const beforeByGlobal = new Map(baseline.filter((row) => row.globalId).map((row) => [row.globalId, row]));
  const seen = new Set<string>();
  const entries: CompareEntry[] = [];
  let geometryCompared = 0;
  let geometryMissing = 0;

  for (const after of current) {
    if (!after.globalId) continue;
    const before = beforeByGlobal.get(after.globalId);
    seen.add(after.globalId);
    if (!before) {
      entries.push({
        globalId: after.globalId,
        id: after.id,
        type: after.type,
        name: after.name,
        storey: after.storey,
        kind: "added",
        categories: [],
        changes: [],
        after,
      });
      continue;
    }
    const changes = propertyDifferences(before.values, after.values);
    if (before.type !== after.type) changes.unshift({ key: "IFC class", from: before.type, to: after.type });
    const categories: CompareEntry["categories"] = [];
    let geometry: GeometryDelta | undefined;
    if (before.geometry && after.geometry) {
      geometryCompared += 1;
      geometry = geometryDelta(before.geometry, after.geometry);
      if (geometry.shapeChanged) categories.push("geometry");
      if (geometry.translationDistance > PLACEMENT_METRES || geometry.rotationDegrees > ROTATION_DEGREES) {
        categories.push("placement");
      }
    } else {
      geometryMissing += 1;
    }
    if (before.storey !== after.storey) categories.push("containment");
    if (changes.length) categories.push("properties");
    const kind: CompareKind = categories.length === 0 ? "unchanged" : categories.length === 1 ? categories[0] : "mixed";
    entries.push({
      globalId: after.globalId,
      id: after.id,
      type: after.type,
      name: after.name,
      storey: after.storey,
      kind,
      categories,
      changes,
      geometry,
      before,
      after,
    });
  }

  for (const before of baseline) {
    if (!before.globalId || seen.has(before.globalId)) continue;
    entries.push({
      globalId: before.globalId,
      id: 0,
      type: before.type,
      name: before.name,
      storey: before.storey,
      kind: "removed",
      categories: [],
      changes: [],
      before,
    });
  }
  const counts = emptyCounts();
  for (const entry of entries) counts[entry.kind] += 1;
  return { entries, counts, geometryCompared, geometryMissing };
}
