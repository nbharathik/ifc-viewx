// Clash detection over the geometry the viewer already drew.
//
// The answer comes from triangles. Boxes and BVH nodes only narrow the search
// down to pairs worth testing; whether two elements clash is decided by real
// mesh intersection, and how close two elements come is a real minimum surface
// distance. The work runs in a worker, so a sweep over a whole discipline does
// not cost the viewport a frame.
//
// This file is the seam. The panel and the assistant both come through here,
// so they can never disagree about a model, and neither one has to know that
// there is a worker behind it. The pieces are in ./clash/.
import { CLASH_LIMIT, MM } from "./clash/types.js";
import type { ClashPair, SweepProgress, SweepResult, SweepSpec } from "./clash/types.js";
import { elementsOf } from "../sdk/data.js";
import type { ModelElement } from "../sdk/types.js";
import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "../geometry/service.js";

export type { ClashKind, ClashPair, SweepProgress, SweepResult } from "./clash/types.js";
export { CLASH_LIMIT } from "./clash/types.js";

export const STRUCTURE = ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn", "IfcFooting", "IfcRoof", "IfcMember", "IfcPlate"];
export const MEP = ["IfcDuctSegment", "IfcDuctFitting", "IfcPipeSegment", "IfcPipeFitting", "IfcCableCarrierSegment", "IfcCableSegment", "IfcFlowTerminal", "IfcAirTerminal", "IfcSanitaryTerminal", "IfcValve", "IfcPump", "IfcTank", "IfcSpaceHeater", "IfcElectricAppliance"];
export const OPENINGS = ["IfcDoor", "IfcWindow", "IfcStair", "IfcRailing", "IfcFurnishingElement", "IfcCovering"];

/** Anything under this is a graze rather than a clash, unless asked otherwise. */
export const DEFAULT_TOLERANCE_MM = 10;

/** What a sweep needs to know beyond the two sets. */
export interface ClashOptions {
  /** Intersections thinner than this are dropped. */
  toleranceMm?: number;
  /** Above zero, pairs that do not touch are also checked for a tight gap. */
  clearanceMm?: number;
  limit?: number;
  onProgress?(progress: SweepProgress): void;
  signal?: AbortSignal;
}

/** Element ids of these classes that actually reached the scene as geometry. */
export function idsOfTypes(elements: ModelElement[], types: Set<string>, hasGeometry: (id: number) => boolean): number[] {
  const out: number[] = [];
  for (const element of elements) {
    if (types.has(element.type) && hasGeometry(element.id)) out.push(element.id);
  }
  return out;
}

/** The federated nudges, flattened for the worker as model, x, y, z. */
function modelOffsets(viewer: Viewer): Float64Array {
  const models = viewer.getModels();
  const out = new Float64Array(models.length * 4);
  models.forEach((model, i) => {
    out[i * 4] = model.index;
    out[i * 4 + 1] = model.offset[0];
    out[i * 4 + 2] = model.offset[1];
    out[i * 4 + 3] = model.offset[2];
  });
  return out;
}

function sweepSpec(viewer: Viewer, a: number[], b: number[], options: ClashOptions = {}): SweepSpec {
  return {
    a: Float64Array.from(a),
    b: Float64Array.from(b),
    origin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    toleranceMm: options.toleranceMm ?? DEFAULT_TOLERANCE_MM,
    clearanceMm: Math.max(0, options.clearanceMm ?? 0),
    limit: options.limit ?? CLASH_LIMIT,
  };
}

export function detectClashes(viewer: Viewer, a: number[], b: number[], options: ClashOptions = {}): Promise<SweepResult> {
  return geometryService(viewer).clash(sweepSpec(viewer, a, b, options), options.onProgress, options.signal);
}

export function cancelClash(viewer: Viewer): void {
  geometryService(viewer).cancelClash();
}

/** Deepest penetration in a set of results, in metres. */
export function worstDepth(hits: ClashPair[]): number {
  let max = 0;
  for (const hit of hits) if (hit.kind === "hard" && hit.distance > max) max = hit.distance;
  return max;
}

/** The sweep flattened to what an assistant can read in one answer. */
export async function clashReport(
  viewer: Viewer,
  aTypes: string[],
  bTypes: string[],
  toleranceMm: number,
  clearanceMm = 0,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  const a = aTypes.length ? aTypes : STRUCTURE;
  const b = bTypes.length ? bTypes : MEP;
  const elements = elementsOf(viewer.getSpatialTree());
  const has = (id: number): boolean => viewer.hasGeometry(id);
  const idsA = idsOfTypes(elements, new Set(a), has);
  const idsB = idsOfTypes(elements, new Set(b), has);
  // Naming the empty side matters: "0 clashes" against an empty set reads as a
  // clean model when it actually means the classes were not in the file.
  if (idsA.length === 0 || idsB.length === 0) {
    const empty = idsA.length === 0 ? `A (${a.join(", ")})` : `B (${b.join(", ")})`;
    throw new Error(`No elements with geometry in set ${empty}. Run a counts action to see which classes this model has.`);
  }

  const names = new Map(elements.map((element) => [element.id, element.name]));
  const result = await detectClashes(viewer, idsA, idsB, { toleranceMm, clearanceMm, signal });
  const hard = result.hits.filter((hit) => hit.kind === "hard");
  const near = result.hits.filter((hit) => hit.kind === "clearance");
  const worst = result.hits.slice(0, 20);

  return {
    setA: a,
    setB: b,
    toleranceMm,
    clearanceMm,
    elementsA: result.elementsA,
    elementsB: result.elementsB,
    pairsTested: result.pairsTested,
    clashes: hard.length,
    clearanceFailures: near.length,
    shown: worst.length,
    truncated: result.truncated || worst.length < result.hits.length,
    method: "triangle-level mesh intersection over the loaded geometry, accelerated by per-element BVHs",
    worst: worst.map((hit) => ({
      a: { id: hit.a, type: hit.aType, name: names.get(hit.a) ?? "" },
      b: { id: hit.b, type: hit.bType, name: names.get(hit.b) ?? "" },
      kind: hit.kind,
      [hit.kind === "hard" ? "penetrationMm" : "gapMm"]: Math.round(hit.distance * MM),
      at: hit.point.map((value) => Number(value.toFixed(3))),
    })),
  };
}
