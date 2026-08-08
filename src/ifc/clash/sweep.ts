// The sweep: geometry in, clashes out.
//
// Owns the retained triangles, pairs the two sets through the broad phase, and
// asks the narrow phase about every surviving pair. Lives apart from the
// worker entry so the whole engine can be driven directly from a test with no
// worker, no DOM and no IFC file.
import { candidatePairs, type BroadItem } from "./broadphase.js";
import {
  buildElement,
  clearanceGap,
  disposeElement,
  hardClash,
  type ElementMesh,
} from "./narrow.js";
import { modelOf } from "../../viewer-core/ids.js";
import { GeometryIndex } from "../../geometry/geometryIndex.js";
import { MM, type ClashPair, type SweepProgress, type SweepResult, type SweepSpec } from "./types.js";

/** Triangles of BVH kept alive between pairs before the oldest are dropped. */
const BVH_CACHE_TRIANGLES = 4_000_000;
/** Pairs tested between yields, so cancel and progress get a turn. */
const SLICE = 400;


export { GeometryIndex as ClashGeometryIndex };

/** BVHs kept between pairs, oldest dropped once the triangle budget is met. */
class MeshCache {
  private readonly entries = new Map<number, ElementMesh>();
  private triangles = 0;

  constructor(private readonly build: (id: number) => ElementMesh | null) {}

  get(id: number): ElementMesh | null {
    const hit = this.entries.get(id);
    if (hit) {
      this.entries.delete(id);
      this.entries.set(id, hit);
      return hit;
    }
    const built = this.build(id);
    if (!built) return null;
    this.entries.set(id, built);
    this.triangles += built.triangles;
    while (this.triangles > BVH_CACHE_TRIANGLES && this.entries.size > 1) {
      const oldest = this.entries.keys().next().value as number;
      const victim = this.entries.get(oldest)!;
      this.entries.delete(oldest);
      this.triangles -= victim.triangles;
      disposeElement(victim);
    }
    return built;
  }

  dispose(): void {
    for (const entry of this.entries.values()) disposeElement(entry);
    this.entries.clear();
    this.triangles = 0;
  }
}

export interface SweepHooks {
  onProgress?(progress: SweepProgress): void;
  /** Called between slices; a sweep stops as soon as it returns true. */
  cancelled?(): boolean;
  /** Lets the worker hand the event loop back so a cancel can be delivered. */
  yieldTurn?(): Promise<void>;
}

export async function runSweep(
  index: GeometryIndex,
  spec: SweepSpec,
  hooks: SweepHooks = {},
): Promise<SweepResult> {
  const started = Date.now();
  const offsets = new Map<number, [number, number, number]>();
  for (let i = 0; i + 3 < spec.offsets.length; i += 4) {
    offsets.set(spec.offsets[i], [spec.offsets[i + 1], spec.offsets[i + 2], spec.offsets[i + 3]]);
  }
  const offsetOf = (id: number): [number, number, number] => offsets.get(modelOf(id)) ?? [0, 0, 0];

  let missing = 0;
  const resolve = (ids: Float64Array): BroadItem[] => {
    const out: BroadItem[] = [];
    for (const id of ids) {
      const item = index.worldBounds(id, spec.origin, offsetOf(id));
      if (item) out.push(item);
      else missing += 1;
    }
    return out;
  };

  const setA = resolve(spec.a);
  const setB = resolve(spec.b);
  const tolerance = spec.toleranceMm / MM;
  const clearance = spec.clearanceMm / MM;

  const cache = new MeshCache((id) => {
    const parts = index.placements(id);
    if (parts.length === 0) return null;
    const box = index.worldBounds(id, spec.origin, offsetOf(id));
    if (!box) return null;
    const centre: [number, number, number] = [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ];
    return buildElement(id, parts, spec.origin, offsetOf(id), centre);
  });

  const hits: ClashPair[] = [];
  let pairsTested = 0;
  let truncated = false;
  let cancelled = false;

  // Candidate lists are collected first so the narrow phase can yield between
  // slices; the broad phase itself is a single fast pass over boxes.
  const work: Array<[BroadItem, BroadItem[]]> = [];
  candidatePairs(setA, setB, clearance, (item, candidates) => work.push([item, candidates]));

  const total = work.length;
  let sinceYield = 0;
  for (let w = 0; w < total; w++) {
    const [item, candidates] = work[w];
    const a = cache.get(item.id);
    if (a) {
      for (const candidate of candidates) {
        const b = cache.get(candidate.id);
        if (!b) continue;
        pairsTested += 1;
        const contact = hardClash(a, b, tolerance);
        if (contact) {
          hits.push({
            a: item.id,
            b: candidate.id,
            aType: index.typeOf(item.id),
            bType: index.typeOf(candidate.id),
            kind: "hard",
            distance: contact.depth,
            point: contact.point,
            extent: contact.extent,
            triangles: contact.triangles,
          });
        } else if (clearance > 0) {
          const gap = clearanceGap(a, b, clearance);
          if (gap) {
            hits.push({
              a: item.id,
              b: candidate.id,
              aType: index.typeOf(item.id),
              bType: index.typeOf(candidate.id),
              kind: "clearance",
              distance: gap.distance,
              point: gap.point,
              extent: [0, 0, 0],
              triangles: 0,
            });
          }
        }
        if (hits.length >= spec.limit) {
          truncated = true;
          break;
        }
      }
    }
    // A cached A is likely to be asked for again only by its own candidates,
    // so it is left to the cache rather than dropped here.
    sinceYield += candidates.length;
    if (truncated) break;
    if (sinceYield >= SLICE || w === total - 1) {
      sinceYield = 0;
      hooks.onProgress?.({ done: w + 1, total, hits: hits.length });
      if (hooks.yieldTurn) await hooks.yieldTurn();
      if (hooks.cancelled?.()) {
        cancelled = true;
        break;
      }
    }
  }

  cache.dispose();

  // Hard clashes first, deepest first; then the near misses, tightest first.
  hits.sort((x, y) => {
    if (x.kind !== y.kind) return x.kind === "hard" ? -1 : 1;
    return x.kind === "hard" ? y.distance - x.distance : x.distance - y.distance;
  });

  return {
    hits,
    pairsTested,
    elementsA: setA.length,
    elementsB: setB.length,
    truncated: truncated || cancelled,
    elapsedMs: Date.now() - started,
    missing,
    fidelity: "mesh",
    engine: "browser-bvh",
    geometryRevision: index.revision,
  };
}
