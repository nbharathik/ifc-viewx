// Data contracts shared by the main thread and the clash worker.
//
// Nothing here imports three or web-ifc: the panel, the assistant, the worker
// and the tests all speak these shapes, so the engine can be exercised in Node
// without a renderer.

import type { TriangleChunk } from "../../viewer-core/scene/triangleStore.js";

export type ClashKind = "hard" | "clearance";

/** One pair of elements that failed the test, with where and how badly. */
export interface ClashPair {
  /** Packed element ids; `expressOf` unpacks the STEP line number. */
  a: number;
  b: number;
  aType: string;
  bType: string;
  kind: ClashKind;
  /**
   * Hard: the thinnest dimension of the intersecting region, which is how far
   * one element has to move to come clear. Clearance: the gap between them.
   */
  distance: number;
  /** Scene-space centre of the contact, for framing the camera on it. */
  point: [number, number, number];
  /** Size of the contact region. Zero on all axes for a clearance result. */
  extent: [number, number, number];
  /** Intersecting triangle pairs found, capped per pair. */
  triangles: number;
}

export interface SweepSpec {
  /** Packed element ids on each side. Order does not matter. */
  a: Float64Array;
  b: Float64Array;
  /** Origin the batcher subtracted from IFC coordinates. */
  origin: [number, number, number];
  /** Per-model nudges, as model index followed by xyz. */
  offsets: Float64Array;
  /** Intersections thinner than this are grazes and are dropped. */
  toleranceMm: number;
  /** Above zero, pairs that miss are also tested for a gap under this. */
  clearanceMm: number;
  /** Results collected before the sweep stops and says it is incomplete. */
  limit: number;
}

export interface SweepResult {
  hits: ClashPair[];
  /** Pairs the broad phase handed to the triangle test. */
  pairsTested: number;
  /** Elements whose geometry the broad phase could resolve. */
  elementsA: number;
  elementsB: number;
  truncated: boolean;
  elapsedMs: number;
  /** Requested elements with no retained geometry, so the answer is partial. */
  missing: number;
}

export interface SweepProgress {
  done: number;
  total: number;
  hits: number;
}

export type ClashRequest =
  | { type: "geometry"; chunk: TriangleChunk }
  | { type: "dropModel"; model: number }
  | { type: "clear" }
  | { type: "sweep"; id: number; spec: SweepSpec }
  | { type: "cancel" };

export type ClashResponse =
  | { type: "progress"; id: number; progress: SweepProgress }
  | { type: "result"; id: number; result: SweepResult }
  | { type: "fail"; id: number; message: string };

/** Millimetres per metre. Tolerances are quoted in mm, geometry is in metres. */
export const MM = 1000;

/** Results collected before a sweep stops and reports itself incomplete. */
export const CLASH_LIMIT = 4000;
