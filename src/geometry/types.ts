import type { SweepProgress, SweepResult, SweepSpec } from "../ifc/clash/types.js";
import type { TriangleChunk } from "../viewer-core/scene/triangleStore.js";

export interface DistanceSpec {
  a: number;
  b: number;
  origin: [number, number, number];
  offsets: Float64Array;
  maxDistance?: number;
}

export interface DistanceResult {
  a: number;
  b: number;
  distance: number | null;
  pointA: [number, number, number] | null;
  pointB: [number, number, number] | null;
  point: [number, number, number] | null;
  intersecting: boolean;
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-bvh";
  geometryRevision: number;
}

export type LaserAxis = "x" | "y" | "z";

export interface LaserHit {
  axis: LaserAxis;
  direction: -1 | 1;
  elementId: number;
  elementType: string;
  distance: number;
  point: [number, number, number];
  normal: [number, number, number];
}

export interface LaserAxisResult {
  axis: LaserAxis;
  negative: LaserHit | null;
  positive: LaserHit | null;
  span: number | null;
}

export interface LaserSpec {
  origin: [number, number, number];
  source?: number;
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  maxDistance?: number;
  epsilon?: number;
}

export interface LaserResult {
  origin: [number, number, number];
  source: number | null;
  sourceNormal: [number, number, number] | null;
  axes: [LaserAxisResult, LaserAxisResult, LaserAxisResult];
  testedElements: number;
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-ray";
  geometryRevision: number;
}

export interface GeometryDiagnostics {
  active: boolean;
  pending: number;
  retainedTriangles: number;
  retainedBytes: number;
  truncated: boolean;
}

export type GeometryRequest =
  | { type: "geometry"; chunk: TriangleChunk }
  | { type: "dropModel"; model: number }
  | { type: "clear" }
  | { type: "clash"; id: number; priority: 2; spec: SweepSpec }
  | { type: "distance"; id: number; priority: 0; spec: DistanceSpec }
  | { type: "laser"; id: number; priority: 0; spec: LaserSpec }
  | { type: "cancel"; id: number };

export type GeometryResponse =
  | { type: "clashProgress"; id: number; progress: SweepProgress }
  | { type: "clashResult"; id: number; result: SweepResult }
  | { type: "distanceResult"; id: number; result: DistanceResult }
  | { type: "laserResult"; id: number; result: LaserResult }
  | { type: "fail"; id: number; message: string };
