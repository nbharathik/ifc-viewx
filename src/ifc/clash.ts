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
import { CLASH_LIMIT, MM } from "../geometry/clash/types.js";
import type { ClashOptions, ClashPair, SweepResult, SweepSpec } from "../geometry/clash/types.js";
import { elementsOf, type ModelElement } from "../data/model.js";
import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "../geometry/service.js";
import { clashClassPair } from "../geometry/clash/workflow.js";
import { packedModelTransforms } from "../geometry/modelTransform.js";

export type { ClashKind, ClashOptions, ClashPair, SweepProgress, SweepResult } from "../geometry/clash/types.js";
export { CLASH_LIMIT } from "../geometry/clash/types.js";
export {
  clashClassPair,
  clashFingerprint,
  groupClashes,
  resolvedClashes,
  reviewClashes,
} from "../geometry/clash/workflow.js";
export type {
  ClashCurrentState,
  ClashDecision,
  ClashElementIdentity,
  ClashGroupMode,
  ClashIgnoreRule,
  ClashReviewGroup,
  ClashReviewRow,
  ClashReviewState,
} from "../geometry/clash/workflow.js";

export const STRUCTURE = ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn", "IfcFooting", "IfcRoof", "IfcMember", "IfcPlate"];
export const MEP = ["IfcDuctSegment", "IfcDuctFitting", "IfcPipeSegment", "IfcPipeFitting", "IfcCableCarrierSegment", "IfcCableSegment", "IfcFlowTerminal", "IfcAirTerminal", "IfcSanitaryTerminal", "IfcValve", "IfcPump", "IfcTank", "IfcSpaceHeater", "IfcElectricAppliance"];
export const OPENINGS = ["IfcDoor", "IfcWindow", "IfcStair", "IfcRailing", "IfcFurnishingElement", "IfcCovering"];

/** Anything under this is a graze rather than a clash, unless asked otherwise. */
export const DEFAULT_TOLERANCE_MM = 10;

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
    transforms: packedModelTransforms(viewer.getModels()),
    toleranceMm: options.toleranceMm ?? DEFAULT_TOLERANCE_MM,
    clearanceMm: Math.max(0, options.clearanceMm ?? 0),
    limit: options.limit ?? CLASH_LIMIT,
  };
}

export async function detectClashes(viewer: Viewer, a: number[], b: number[], options: ClashOptions = {}): Promise<SweepResult> {
  const result = await geometryService(viewer).clash(sweepSpec(viewer, a, b, options), options.onProgress, options.signal);
  for (const hit of result.hits) {
    const projected = typeof viewer.sceneToGeoreferenced === 'function'
      ? viewer.sceneToGeoreferenced(hit.point)
      : null;
    if (projected) hit.georeferenced = projected;
  }
  return result;
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
  const elementById = new Map(elements.map((element) => [element.id, element]));
  const result = await detectClashes(viewer, idsA, idsB, { toleranceMm, clearanceMm, signal });
  const hard = result.hits.filter((hit) => hit.kind === "hard");
  const near = result.hits.filter((hit) => hit.kind === "clearance");
  const row = (hit: ClashPair): Record<string, unknown> => {
    const elementA = elementById.get(hit.a);
    const elementB = elementById.get(hit.b);
    const level = elementA?.storey && elementB?.storey && elementA.storey !== elementB.storey
      ? `${elementA.storey} / ${elementB.storey}`
      : elementA?.storey || elementB?.storey || "No level";
    return {
      a: { id: hit.a, type: hit.aType, name: names.get(hit.a) ?? "", storey: elementA?.storey ?? "" },
      b: { id: hit.b, type: hit.bType, name: names.get(hit.b) ?? "", storey: elementB?.storey ?? "" },
      kind: hit.kind,
      severity: hit.kind === "hard" && hit.distance * MM > 50 ? "critical" : hit.kind === "hard" ? "hard" : "clearance",
      classPair: clashClassPair(hit.aType, hit.bType).replaceAll("Ifc", ""),
      level,
      primary: `${hit.aType.replace(/^Ifc/, "")} #${hit.a}`,
      [hit.kind === "hard" ? "penetrationMm" : "gapMm"]: Math.round(hit.distance * MM),
      at: hit.point.map((value) => Number(value.toFixed(3))),
      ...(hit.georeferenced ? {
        projectedAt: hit.georeferenced.coordinates.map((value) => Number(value.toFixed(3))),
        crs: hit.georeferenced.crs,
      } : {}),
    };
  };
  const rows = result.hits.map(row);

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
    shown: Math.min(rows.length, 40),
    truncated: result.truncated,
    sweepTruncated: result.truncated,
    method: "triangle-level mesh intersection over the loaded geometry, accelerated by per-element BVHs",
    rows,
    worst: rows.slice(0, 20),
  };
}
