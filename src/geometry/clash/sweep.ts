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
  meshContact,
  type ElementMesh,
} from "./narrow.js";
import { modelOf } from "../../viewer-core/ids.js";
import { unpackModelTransforms } from "../modelTransform.js";
import type { ModelTransform } from "../../viewer-core/engine/types.js";
import { GeometryIndex } from "../geometryIndex.js";
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
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const transformOf = (id: number): ModelTransform => transforms.get(modelOf(id)) ?? {
    translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none",
  };

  const missingIds = new Set<number>();
  const resolve = (ids: Float64Array): BroadItem[] => {
    const out: BroadItem[] = [];
    const seen = new Set<number>();
    for (const id of ids) {
      if (!Number.isFinite(id) || id <= 0 || seen.has(id)) continue;
      seen.add(id);
      const item = index.worldBounds(id, spec.origin, transformOf(id));
      if (item && item.min.every(Number.isFinite) && item.max.every(Number.isFinite) &&
        item.min[0] <= item.max[0] && item.min[1] <= item.max[1] && item.min[2] <= item.max[2]) out.push(item);
      else missingIds.add(id);
    }
    return out;
  };

  const setA = resolve(spec.a);
  const setB = resolve(spec.b);
  const tolerance = (Number.isFinite(spec.toleranceMm) ? Math.max(0, spec.toleranceMm) : 0) / MM;
  const clearance = (Number.isFinite(spec.clearanceMm) ? Math.max(0, spec.clearanceMm) : 0) / MM;
  const limit = Number.isFinite(spec.limit) ? Math.max(1, Math.floor(spec.limit)) : 1;
  const unusableIds = new Set<number>();

  const cache = new MeshCache((id) => {
    const parts = index.placements(id);
    if (parts.length === 0) {
      unusableIds.add(id);
      return null;
    }
    const box = index.worldBounds(id, spec.origin, transformOf(id));
    if (!box) {
      unusableIds.add(id);
      return null;
    }
    const centre: [number, number, number] = [
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ];
    const built = buildElement(id, parts, spec.origin, transformOf(id), centre);
    if (!built) unusableIds.add(id);
    return built;
  });

  const hits: ClashPair[] = [];
  let pairsTested = 0;
  let truncated = false;
  let cancelled = false;

  // Candidate lists are collected first so the narrow phase can yield between
  // slices; the broad phase itself is a single fast pass over boxes.
  const work: Array<[BroadItem, BroadItem[]]> = [];
  candidatePairs(setA, setB, clearance, (item, candidates) => work.push([item, candidates]));

  const total = work.reduce((sum, [, candidates]) => sum + candidates.length, 0);
  let done = 0;
  let sinceYield = 0;
  try {
    if (hooks.cancelled?.()) cancelled = true;
    for (let w = 0; w < work.length && !cancelled; w++) {
      const [item, candidates] = work[w];
      const a = cache.get(item.id);
      for (const candidate of candidates) {
        const b = a ? cache.get(candidate.id) : null;
        if (a && b) {
          pairsTested += 1;
          const contact = meshContact(a, b);
          if (contact && contact.depth > tolerance) {
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
          // A real penetration suppressed by the hard-clash tolerance is not a
          // zero-gap clearance failure. Only misses and surface touches proceed
          // to the distance query.
          } else if (clearance > 0 && (!contact || contact.depth <= 1e-9)) {
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
          if (hits.length >= limit) {
            truncated = true;
          }
        }
        done += 1;
        sinceYield += 1;
        if (truncated) break;
        if (sinceYield >= SLICE || done === total) {
          sinceYield = 0;
          hooks.onProgress?.({ done, total, hits: hits.length });
          if (hooks.yieldTurn) await hooks.yieldTurn();
          if (hooks.cancelled?.()) {
            cancelled = true;
            break;
          }
        }
      }
      // A cached A is likely to be asked for again only by its own candidates,
      // so it is left to the cache rather than dropped here.
      if (truncated || cancelled) break;
    }

    if (total === 0) hooks.onProgress?.({ done: 0, total: 0, hits: 0 });
  } finally {
    cache.dispose();
  }

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
    missing: new Set([...missingIds, ...unusableIds]).size,
    fidelity: "mesh",
    engine: "browser-bvh",
    geometryRevision: index.revision,
  };
}
