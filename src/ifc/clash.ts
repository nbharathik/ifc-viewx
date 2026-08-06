// Clash detection over the bounding boxes the viewer already holds.
//
// Broad phase is a uniform grid built over set B; elements too large to bucket
// sensibly go in an oversized list tested against everything. Narrow phase is
// the box overlap itself, reported as depth and volume so a list sorts by how
// bad the hit is rather than by chance.
//
// The sweep lives here rather than in the clash plugin because the assistant
// runs it too, and core must not import a plugin folder. The plugin reaches it
// through the SDK, which re-exports this file.
import { elementsOf } from "../sdk/data.js";
import { nextFrame } from "../sdk/ui.js";
import type { ModelBounds, Viewer } from "../viewer-core/viewer.js";
import type { ModelElement } from "../sdk/types.js";

export interface ClashBox {
  id: number;
  type: string;
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

export interface ClashHit {
  a: ClashBox;
  b: ClashBox;
  depth: number;
  volume: number;
}

export interface ClashSweep {
  hits: ClashHit[];
  tested: number;
  truncated: boolean;
}

/**
 * What the sweep reads. The panel passes its context straight in, the assistant
 * entry point wraps the viewer it is handed, and both run the same code.
 */
export interface BoxSource {
  elements(): ModelElement[];
  bounds(expressID: number): ModelBounds | null;
}

export const STRUCTURE = ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn", "IfcFooting", "IfcRoof", "IfcMember", "IfcPlate"];
export const MEP = ["IfcDuctSegment", "IfcDuctFitting", "IfcPipeSegment", "IfcPipeFitting", "IfcCableCarrierSegment", "IfcCableSegment", "IfcFlowTerminal", "IfcAirTerminal", "IfcSanitaryTerminal", "IfcValve", "IfcPump", "IfcTank", "IfcSpaceHeater", "IfcElectricAppliance"];
export const OPENINGS = ["IfcDoor", "IfcWindow", "IfcStair", "IfcRailing", "IfcFurnishingElement", "IfcCovering"];

/** Cells one element may occupy before it is treated as oversized. */
const MAX_SPAN = 64;
const SLICE = 250;

/** Hits collected before a sweep gives up and says so. */
export const CLASH_LIMIT = 4000;

/** Every element of these classes that the viewer has a bounding box for. */
export function boxesFor(source: BoxSource, types: Set<string>): ClashBox[] {
  const out: ClashBox[] = [];
  for (const element of source.elements()) {
    if (!types.has(element.type)) continue;
    const bounds = source.bounds(element.id);
    if (!bounds) continue;
    out.push({
      id: element.id,
      type: element.type,
      name: element.name,
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    });
  }
  return out;
}

/**
 * The sweep itself, with no UI in it, so the panel and the assistant can never
 * disagree about a model. Yields between slices so a long sweep does not
 * freeze the tab.
 */
export async function sweepBoxes(
  a: ClashBox[],
  b: ClashBox[],
  toleranceMm: number,
  onProgress?: (done: number, total: number, hits: number) => void,
): Promise<ClashSweep> {
  const tol = toleranceMm / 1000;
  const hits: ClashHit[] = [];
  let tested = 0;
  let truncated = false;

  const cell = cellSize(b);
  const buckets = new Map<number, ClashBox[]>();
  const oversized: ClashBox[] = [];
  for (const box of b) {
    const span = cellsOf(box, cell);
    if (span.length > MAX_SPAN) oversized.push(box);
    else for (const key of span) push(buckets, key, box);
  }

  const seen = new Set<string>();
  const candidates = new Set<ClashBox>();
  for (let start = 0; start < a.length; start += SLICE) {
    for (const box of a.slice(start, start + SLICE)) {
      candidates.clear();
      const span = cellsOf(box, cell);
      // An element too big to bucket has to see everything, or it would be
      // compared against a handful of arbitrary cells.
      if (span.length > MAX_SPAN) for (const other of b) candidates.add(other);
      else for (const key of span) for (const other of buckets.get(key) ?? []) candidates.add(other);
      for (const other of oversized) candidates.add(other);
      for (const other of candidates) {
        if (other.id === box.id) continue;
        tested += 1;
        const hit = overlap(box, other, tol);
        if (!hit) continue;
        const pair = box.id < other.id ? `${box.id}:${other.id}` : `${other.id}:${box.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        hits.push(hit);
        if (hits.length >= CLASH_LIMIT) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    onProgress?.(Math.min(start + SLICE, a.length), a.length, hits.length);
    await nextFrame();
    if (truncated) break;
  }

  hits.sort((x, y) => y.volume - x.volume);
  return { hits, tested, truncated };
}

/** The sweep flattened to what an LLM can read in one report. */
export async function clashReport(
  viewer: Viewer,
  aTypes: string[],
  bTypes: string[],
  toleranceMm: number,
): Promise<Record<string, unknown>> {
  const a = aTypes.length ? aTypes : STRUCTURE;
  const b = bTypes.length ? bTypes : MEP;
  const elements = elementsOf(viewer.getSpatialTree());
  const source: BoxSource = { elements: () => elements, bounds: (id) => viewer.getElementBounds(id) };
  const boxesA = boxesFor(source, new Set(a));
  const boxesB = boxesFor(source, new Set(b));
  // Naming the empty side matters: "0 clashes" against an empty set reads as
  // a clean model when it actually means the classes were not in the file.
  if (boxesA.length === 0 || boxesB.length === 0) {
    const empty = boxesA.length === 0 ? `A (${a.join(", ")})` : `B (${b.join(", ")})`;
    throw new Error(`No elements with geometry in set ${empty}. Run a counts action to see which classes this model has.`);
  }
  const { hits, tested, truncated } = await sweepBoxes(boxesA, boxesB, toleranceMm);
  const worst = hits.slice(0, 20);
  return {
    setA: a,
    setB: b,
    toleranceMm,
    elementsA: boxesA.length,
    elementsB: boxesB.length,
    pairTests: tested,
    clashes: hits.length,
    shown: worst.length,
    truncated: truncated || worst.length < hits.length,
    method: "axis-aligned bounding boxes, so this screens for coordination problems rather than proving them",
    worst: worst.map((hit) => ({
      a: { id: hit.a.id, type: hit.a.type, name: hit.a.name },
      b: { id: hit.b.id, type: hit.b.type, name: hit.b.name },
      depthMm: Math.round(hit.depth * 1000),
      volumeM3: Number(hit.volume.toFixed(4)),
    })),
  };
}

export function deepestHit(hits: ClashHit[]): number {
  let max = 0;
  for (const hit of hits) if (hit.depth > max) max = hit.depth;
  return max;
}

function overlap(a: ClashBox, b: ClashBox, tolerance: number): ClashHit | null {
  const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  if (dx <= tolerance) return null;
  const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  if (dy <= tolerance) return null;
  const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (dz <= tolerance) return null;
  return { a, b, depth: Math.min(dx, dy, dz), volume: dx * dy * dz };
}

/** Grid pitch from the median box, so cells hold a handful of elements each. */
function cellSize(boxes: ClashBox[]): number {
  if (boxes.length === 0) return 1;
  const sizes = boxes.map((box) => Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]));
  sizes.sort((a, b) => a - b);
  return Math.max(0.25, sizes[Math.floor(sizes.length / 2)] * 2);
}

function cellsOf(box: ClashBox, cell: number): number[] {
  const lo = box.min.map((value) => Math.floor(value / cell));
  const hi = box.max.map((value) => Math.floor(value / cell));
  const keys: number[] = [];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        keys.push(hash(x, y, z));
        if (keys.length > MAX_SPAN) return keys;
      }
    }
  }
  return keys;
}

/** Cheap 3D cell hash; collisions only cost an extra narrow-phase test. */
function hash(x: number, y: number, z: number): number {
  return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0) >>> 0;
}

function push(map: Map<number, ClashBox[]>, key: number, box: ClashBox): void {
  const list = map.get(key);
  if (list) list.push(box);
  else map.set(key, [box]);
}
