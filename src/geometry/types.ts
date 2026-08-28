import type { SweepProgress, SweepResult, SweepSpec } from "./clash/types.js";
import type { TriangleChunk } from "../viewer-core/scene/triangleStore.js";

export interface GeometryBounds {
  min: [number, number, number];
  max: [number, number, number];
}

export interface GeometryShapeFingerprint {
  hash: string;
  vertices: number;
  triangles: number;
}

export interface GeometrySignature {
  id: number;
  shapeHash: string;
  pieces: number;
  vertices: number;
  triangles: number;
  bounds: GeometryBounds;
  translation: [number, number, number];
  rotation: [number, number, number, number];
}

export interface GeometrySignatureSpec {
  ids: Float64Array;
}

export interface GeometrySignatureResult {
  signatures: GeometrySignature[];
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-signature";
  geometryRevision: number;
}

export interface DistanceSpec {
  a: number;
  b: number;
  origin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
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
  transforms?: Float64Array;
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

export type SectionAxis = "x" | "y" | "z";

export interface SectionPolyline {
  elementId: number;
  elementType: string;
  closed: boolean;
  points: Array<[number, number]>;
  length: number;
}

export interface SectionContourSpec {
  axis: SectionAxis;
  offset: number;
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
  tolerance?: number;
  maxSegments?: number;
}

export interface SectionContourResult {
  axis: SectionAxis;
  offset: number;
  polylines: SectionPolyline[];
  bounds: { min: [number, number]; max: [number, number] } | null;
  segmentCount: number;
  closedCount: number;
  openCount: number;
  testedElements: number;
  missing: number;
  truncated: boolean;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-section";
  geometryRevision: number;
}

/** One sample point on a surface, and where it faces. */
export interface SunSample {
  point: [number, number, number];
  normal: [number, number, number];
}

export interface SunSpec {
  /** Sample points, three numbers each, already nudged off the surface. */
  points: Float64Array;
  /** Sun directions, three numbers each, pointing from the sun to the model. */
  directions: Float64Array;
  /** Minutes each direction stands for, which is what turns a count into hours. */
  stepMinutes: number;
  /** Elements that may cast a shadow. */
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
  maxDistance?: number;
  epsilon?: number;
}

export interface SunResult {
  /** Sunlit hours per sample point, in the same order the points were given. */
  exposure: Float32Array;
  stepMinutes: number;
  directions: number;
  testedElements: number;
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-sun";
  geometryRevision: number;
}

export interface DeviationSpec {
  /** Scan points in scene coordinates, three numbers each. */
  points: Float64Array;
  /** Elements the scan is compared against. */
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
  /** Beyond this, a point is reported as having no nearby surface. */
  maxDistance?: number;
}

export interface DeviationResult {
  /** Distance to the nearest surface per point; NaN where nothing was near. */
  distances: Float32Array;
  /** Which element answered, per point; zero where nothing did. */
  elements: Float64Array;
  measured: number;
  points: number;
  maxDistance: number;
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-deviation";
  geometryRevision: number;
}

export interface VolumesSpec {
  ids: Float64Array;
  offsets: Float64Array;
  transforms?: Float64Array;
}

export interface ElementVolume {
  id: number;
  volume: number;
  triangles: number;
  closed: boolean;
}

export interface VolumesResult {
  volumes: ElementVolume[];
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-volume";
  geometryRevision: number;
}

export interface PlaneClassifySpec {
  normal: [number, number, number];
  constant: number;
  /**
   * Conjunctive plane set: a point is inside only when it satisfies every
   * plane. Supersedes the single normal/constant when present. The runner
   * normalizes all planes.
   */
  planes?: Array<{ normal: [number, number, number]; constant: number }>;
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
  epsilon?: number;
}

export interface PlaneClassifyResult {
  kept: number[];
  cut: number[];
  dropped: number[];
  testedElements: number;
  missing: number;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-plane";
  geometryRevision: number;
}

export interface MeshesSpec {
  ids: Float64Array;
  modelOrigin: [number, number, number];
  offsets: Float64Array;
  transforms?: Float64Array;
  /** Batch ceiling; the run stops at the element that would cross it. */
  maxTriangles?: number;
}

/** One element per entry, its placements merged and baked into scene space. */
export interface MeshesResult {
  ids: Float64Array;
  types: string[];
  vertexCounts: Uint32Array;
  indexCounts: Uint32Array;
  positions: Float32Array;
  indices: Uint32Array;
  missing: number;
  truncated: boolean;
  elapsedMs: number;
  fidelity: "mesh";
  engine: "browser-mesh";
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
  | { type: "sectionContours"; id: number; priority: 0; spec: SectionContourSpec }
  | { type: "signatures"; id: number; priority: 1; spec: GeometrySignatureSpec }
  | { type: "volumes"; id: number; priority: 1; spec: VolumesSpec }
  | { type: "sun"; id: number; priority: 1; spec: SunSpec }
  | { type: "deviation"; id: number; priority: 1; spec: DeviationSpec }
  | { type: "classifyPlane"; id: number; priority: 0; spec: PlaneClassifySpec }
  | { type: "meshes"; id: number; priority: 1; spec: MeshesSpec }
  | { type: "cancel"; id: number };

export type GeometryResponse =
  | { type: "clashProgress"; id: number; progress: SweepProgress }
  | { type: "clashResult"; id: number; result: SweepResult }
  | { type: "distanceResult"; id: number; result: DistanceResult }
  | { type: "laserResult"; id: number; result: LaserResult }
  | { type: "sectionContourResult"; id: number; result: SectionContourResult }
  | { type: "signatureResult"; id: number; result: GeometrySignatureResult }
  | { type: "volumesResult"; id: number; result: VolumesResult }
  | { type: "sunResult"; id: number; result: SunResult }
  | { type: "deviationResult"; id: number; result: DeviationResult }
  | { type: "classifyPlaneResult"; id: number; result: PlaneClassifyResult }
  | { type: "meshesResult"; id: number; result: MeshesResult }
  | { type: "fail"; id: number; message: string };
