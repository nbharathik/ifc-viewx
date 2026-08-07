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
  type Placement,
} from "./narrow.js";
import { modelOf } from "../../viewer-core/ids.js";
import type { TriangleChunk } from "../../viewer-core/scene/triangleStore.js";
import { MM, type ClashPair, type SweepProgress, type SweepResult, type SweepSpec } from "./types.js";

interface StoredGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  /** minX,minY,minZ,maxX,maxY,maxZ in the geometry's own space. */
  bounds: Float32Array;
}

interface StoredElement {
  type: string;
  geometryIDs: number[];
  matrices: Float64Array[];
}

/** Triangles of BVH kept alive between pairs before the oldest are dropped. */
const BVH_CACHE_TRIANGLES = 4_000_000;
/** Pairs tested between yields, so cancel and progress get a turn. */
const SLICE = 400;

export class ClashGeometryIndex {
  private readonly geometries = new Map<number, Map<number, StoredGeometry>>();
  private readonly elements = new Map<number, StoredElement>();

  addChunk(chunk: TriangleChunk): void {
    let table = this.geometries.get(chunk.model);
    if (!table) {
      table = new Map();
      this.geometries.set(chunk.model, table);
    }
    let po = 0;
    let io = 0;
    for (let i = 0; i < chunk.geometryIDs.length; i++) {
      const vertexFloats = chunk.vertexCounts[i] * 3;
      const indexCount = chunk.indexCounts[i];
      table.set(chunk.geometryIDs[i], {
        positions: chunk.positions.subarray(po, po + vertexFloats),
        indices: chunk.indices.subarray(io, io + indexCount),
        bounds: chunk.localBounds.subarray(i * 6, i * 6 + 6),
      });
      po += vertexFloats;
      io += indexCount;
    }
    for (let i = 0; i < chunk.elementIDs.length; i++) {
      const id = chunk.elementIDs[i];
      let element = this.elements.get(id);
      if (!element) {
        element = { type: chunk.types[i], geometryIDs: [], matrices: [] };
        this.elements.set(id, element);
      }
      element.geometryIDs.push(chunk.geometryOf[i]);
      element.matrices.push(chunk.matrices.subarray(i * 16, i * 16 + 16));
    }
  }

  dropModel(model: number): void {
    this.geometries.delete(model);
    for (const id of [...this.elements.keys()]) {
      if (modelOf(id) === model) this.elements.delete(id);
    }
  }

  clear(): void {
    this.geometries.clear();
    this.elements.clear();
  }

  has(id: number): boolean {
    return this.elements.has(id);
  }

  typeOf(id: number): string {
    return this.elements.get(id)?.type ?? "";
  }

  get elementCount(): number {
    return this.elements.size;
  }

  placements(id: number): Placement[] {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return [];
    const out: Placement[] = [];
    for (let i = 0; i < element.geometryIDs.length; i++) {
      const geometry = table.get(element.geometryIDs[i]);
      if (geometry) {
        out.push({ positions: geometry.positions, indices: geometry.indices, matrix: element.matrices[i] });
      }
    }
    return out;
  }

  /**
   * Scene-space AABB from the geometry's own box rather than its vertices:
   * eight corners instead of a full pass, and being conservative under
   * rotation is exactly what a broad phase wants.
   */
  worldBounds(id: number, origin: [number, number, number], offset: [number, number, number]): BroadItem | null {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return null;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    let any = false;
    for (let i = 0; i < element.geometryIDs.length; i++) {
      const geometry = table.get(element.geometryIDs[i]);
      if (!geometry) continue;
      const b = geometry.bounds;
      const m = element.matrices[i];
      for (let corner = 0; corner < 8; corner++) {
        const lx = corner & 1 ? b[3] : b[0];
        const ly = corner & 2 ? b[4] : b[1];
        const lz = corner & 4 ? b[5] : b[2];
        const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12] - origin[0] + offset[0];
        const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13] - origin[1] + offset[1];
        const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14] - origin[2] + offset[2];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
        any = true;
      }
    }
    return any ? { id, min, max } : null;
  }
}

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
  index: ClashGeometryIndex,
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
  };
}
