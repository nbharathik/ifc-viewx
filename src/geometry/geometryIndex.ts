import { modelOf } from "../viewer-core/ids.js";
import type { ModelTransform } from "../viewer-core/engine/types.js";
import { normalizedModelTransform } from "./modelTransform.js";
import type { TriangleChunk } from "../viewer-core/scene/triangleStore.js";
import type { Placement } from "./clash/narrow.js";
import { BufferAttribute, BufferGeometry } from "three";
import { MeshBVH } from "three-mesh-bvh";
import { GeometrySignatureBuilder, shapeFingerprint } from "./signature.js";
import type { GeometryShapeFingerprint, GeometrySignature } from "./types.js";

interface StoredGeometry {
  key: string;
  positions: Float32Array;
  indices: Uint32Array;
  bounds: Float32Array;
  fingerprint?: GeometryShapeFingerprint;
  localVolume?: number;
  localClosed?: boolean;
  bvh?: MeshBVH;
  bvhGeometry?: BufferGeometry;
  bvhBytes?: number;
}

interface StoredElement {
  type: string;
  geometryIDs: number[];
  matrices: Float64Array[];
  baseBounds?: CachedBaseBounds;
}

interface BaseBounds {
  min: [number, number, number];
  max: [number, number, number];
}

interface CachedBaseBounds {
  revision: number;
  value: BaseBounds | null;
}

export interface GeometryBounds {
  id: number;
  min: [number, number, number];
  max: [number, number, number];
}

export interface BvhPlacement extends Placement {
  bvh: MeshBVH;
}

export interface PlacedVolume {
  volume: number;
  triangles: number;
  closed: boolean;
  matrix: Float64Array;
}

export interface GeometryIndexOptions {
  /** Retained BVH budget. Defaults to 100 MB per reported GB of device memory. */
  bvhBudgetBytes?: number;
}

export interface GeometryIndexDiagnostics {
  bvhBudgetBytes: number;
  bvhBytes: number;
  bvhGeometries: number;
  bvhTriangles: number;
}

const MB = 1024 * 1024;
const BVH_BYTES_PER_TRIANGLE = 64;

function defaultBvhBudget(): number {
  const memory = typeof navigator === "undefined"
    ? 2
    : Number((navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 2);
  return Math.max(100 * MB, Math.min(800 * MB, memory * 100 * MB));
}

export class GeometryIndex {
  private readonly geometries = new Map<number, Map<number, StoredGeometry>>();
  private readonly elements = new Map<number, StoredElement>();
  private readonly bvhLru = new Map<string, StoredGeometry>();
  private readonly bvhBudgetBytes: number;
  private retainedBvhBytes = 0;
  private retainedBvhTriangles = 0;
  private version = 0;

  constructor(options: GeometryIndexOptions = {}) {
    this.bvhBudgetBytes = Math.max(1024, options.bvhBudgetBytes ?? defaultBvhBudget());
  }

  addChunk(chunk: TriangleChunk): void {
    if (chunk.geometryIDs.length === 0 && chunk.elementIDs.length === 0) return;
    this.version += 1;
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
      const geometryID = chunk.geometryIDs[i];
      const existing = table.get(geometryID);
      if (existing) this.disposeBvh(existing);
      table.set(geometryID, {
        key: `${chunk.model}:${geometryID}`,
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
      element.baseBounds = undefined;
    }
  }

  dropModel(model: number): void {
    const table = this.geometries.get(model);
    if (table) for (const geometry of table.values()) this.disposeBvh(geometry);
    const hadGeometry = this.geometries.delete(model);
    let removed = false;
    for (const id of [...this.elements.keys()]) {
      if (modelOf(id) === model) removed = this.elements.delete(id) || removed;
    }
    if (hadGeometry || removed) this.version += 1;
  }

  clear(): void {
    if (this.geometries.size || this.elements.size) this.version += 1;
    for (const table of this.geometries.values()) {
      for (const geometry of table.values()) this.disposeBvh(geometry);
    }
    this.geometries.clear();
    this.elements.clear();
    this.bvhLru.clear();
    this.retainedBvhBytes = 0;
    this.retainedBvhTriangles = 0;
  }

  has(id: number): boolean {
    return this.elements.has(id);
  }

  ids(): number[] {
    return [...this.elements.keys()];
  }

  typeOf(id: number): string {
    return this.elements.get(id)?.type ?? "";
  }

  get elementCount(): number {
    return this.elements.size;
  }

  get geometryCount(): number {
    let count = 0;
    for (const table of this.geometries.values()) count += table.size;
    return count;
  }

  get revision(): number {
    return this.version;
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

  /** Per-placement local volumes with lazy per-geometry caching. */
  placedVolumes(id: number): PlacedVolume[] {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return [];
    const out: PlacedVolume[] = [];
    for (let i = 0; i < element.geometryIDs.length; i++) {
      const geometry = table.get(element.geometryIDs[i]);
      if (!geometry) continue;
      if (geometry.localVolume === undefined) {
        geometry.localVolume = signedLocalVolume(geometry.positions, geometry.indices);
        geometry.localClosed = edgeManifold(geometry.positions, geometry.indices);
      }
      out.push({
        volume: geometry.localVolume,
        triangles: geometry.indices.length / 3,
        closed: geometry.localClosed ?? false,
        matrix: element.matrices[i],
      });
    }
    return out;
  }

  /** The same placements with one lazy BVH shared by every instance of a mesh. */
  bvhPlacements(id: number): BvhPlacement[] {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return [];
    const out: BvhPlacement[] = [];
    for (let index = 0; index < element.geometryIDs.length; index++) {
      const geometry = table.get(element.geometryIDs[index]);
      if (!geometry) continue;
      out.push({
        positions: geometry.positions,
        indices: geometry.indices,
        matrix: element.matrices[index],
        bvh: this.bvhFor(geometry),
      });
    }
    return out;
  }

  diagnostics(): GeometryIndexDiagnostics {
    return {
      bvhBudgetBytes: this.bvhBudgetBytes,
      bvhBytes: this.retainedBvhBytes,
      bvhGeometries: this.bvhLru.size,
      bvhTriangles: this.retainedBvhTriangles,
    };
  }

  private bvhFor(stored: StoredGeometry): MeshBVH {
    if (stored.bvh) {
      this.bvhLru.delete(stored.key);
      this.bvhLru.set(stored.key, stored);
      return stored.bvh;
    }
    const geometry = new BufferGeometry();
    geometry.setAttribute("position", new BufferAttribute(stored.positions, 3));
    geometry.setIndex(new BufferAttribute(stored.indices, 1));
    const bvh = new MeshBVH(geometry, { indirect: true, verbose: false });
    const triangles = stored.indices.length / 3;
    stored.bvh = bvh;
    stored.bvhGeometry = geometry;
    stored.bvhBytes = Math.ceil(triangles * BVH_BYTES_PER_TRIANGLE);
    this.retainedBvhBytes += stored.bvhBytes;
    this.retainedBvhTriangles += triangles;
    this.bvhLru.set(stored.key, stored);
    this.trimBvhs(stored);
    return bvh;
  }

  private trimBvhs(protectedGeometry: StoredGeometry): void {
    while (this.retainedBvhBytes > this.bvhBudgetBytes && this.bvhLru.size > 1) {
      const oldest = this.bvhLru.values().next().value as StoredGeometry | undefined;
      if (!oldest) break;
      if (oldest === protectedGeometry) {
        this.bvhLru.delete(oldest.key);
        this.bvhLru.set(oldest.key, oldest);
        continue;
      }
      this.disposeBvh(oldest);
    }
  }

  private disposeBvh(stored: StoredGeometry): void {
    if (!stored.bvh) return;
    const triangles = stored.indices.length / 3;
    this.retainedBvhBytes = Math.max(0, this.retainedBvhBytes - (stored.bvhBytes ?? 0));
    this.retainedBvhTriangles = Math.max(0, this.retainedBvhTriangles - triangles);
    this.bvhLru.delete(stored.key);
    stored.bvhGeometry?.dispose();
    stored.bvh = undefined;
    stored.bvhGeometry = undefined;
    stored.bvhBytes = undefined;
  }

  signature(id: number): GeometrySignature | null {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return null;
    const builder = new GeometrySignatureBuilder();
    for (let index = 0; index < element.geometryIDs.length; index++) {
      const geometry = table.get(element.geometryIDs[index]);
      if (!geometry) continue;
      geometry.fingerprint ??= shapeFingerprint(geometry.positions, geometry.indices, geometry.bounds);
      builder.add(id, geometry.fingerprint, geometry.bounds, element.matrices[index]);
    }
    return builder.finish()[0] ?? null;
  }

  worldBounds(
    id: number,
    origin: [number, number, number],
    placement: ModelTransform | [number, number, number],
  ): GeometryBounds | null {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return null;
    const base = this.baseBounds(element, table);
    if (!base) return null;
    const transform = normalizedModelTransform(placement);
    // Same Y-up plan rotation scenePlacementMatrix applies.
    const cosine = Math.cos(transform.rotationZ) * transform.scale;
    const sine = Math.sin(transform.rotationZ) * transform.scale;
    const min: [number, number, number] = [Infinity, Infinity, Infinity];
    const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
    for (let corner = 0; corner < 8; corner++) {
      const x = corner & 1 ? base.max[0] : base.min[0];
      const y = corner & 2 ? base.max[1] : base.min[1];
      const z = corner & 4 ? base.max[2] : base.min[2];
      const point: [number, number, number] = [
        cosine * x + sine * z + transform.translation[0] - origin[0],
        transform.scale * y + transform.translation[1] - origin[1],
        -sine * x + cosine * z + transform.translation[2] - origin[2],
      ];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis]);
        max[axis] = Math.max(max[axis], point[axis]);
      }
    }
    return { id, min, max };
  }

  private baseBounds(element: StoredElement, table: Map<number, StoredGeometry>): BaseBounds | null {
    if (element.baseBounds?.revision === this.version) return element.baseBounds.value;
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
        const x = m[0] * lx + m[4] * ly + m[8] * lz + m[12];
        const y = m[1] * lx + m[5] * ly + m[9] * lz + m[13];
        const z = m[2] * lx + m[6] * ly + m[10] * lz + m[14];
        if (x < min[0]) min[0] = x;
        if (y < min[1]) min[1] = y;
        if (z < min[2]) min[2] = z;
        if (x > max[0]) max[0] = x;
        if (y > max[1]) max[1] = y;
        if (z > max[2]) max[2] = z;
        any = true;
      }
    }
    const value = any ? { min, max } : null;
    element.baseBounds = { revision: this.version, value };
    return value;
  }
}

function signedLocalVolume(positions: Float32Array, indices: Uint32Array): number {
  if (indices.length < 3) return 0;
  const rx = positions[indices[0] * 3];
  const ry = positions[indices[0] * 3 + 1];
  const rz = positions[indices[0] * 3 + 2];
  let sum = 0;
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3, b = indices[t + 1] * 3, c = indices[t + 2] * 3;
    const ax = positions[a] - rx, ay = positions[a + 1] - ry, az = positions[a + 2] - rz;
    const bx = positions[b] - rx, by = positions[b + 1] - ry, bz = positions[b + 2] - rz;
    const cx = positions[c] - rx, cy = positions[c + 1] - ry, cz = positions[c + 2] - rz;
    sum += ax * (by * cz - bz * cy) + ay * (bz * cx - bx * cz) + az * (bx * cy - by * cx);
  }
  return sum / 6;
}

/** Closed iff every directed edge appears once and its reverse once, so inconsistent winding fails too. */
function edgeManifold(positions: Float32Array, indices: Uint32Array): boolean {
  if (indices.length === 0 || indices.length % 3 !== 0) return false;
  // web-ifc emits flat-shaded vertices duplicated at every crease, so weld by
  // quantized position first or a shared edge counts once under two different
  // indices and every real element reads as open.
  const scale = 1e5;
  const canonical = new Map<string, number>();
  const remap = new Uint32Array(positions.length / 3);
  for (let v = 0; v < remap.length; v++) {
    const key = `${Math.round(positions[v * 3] * scale)}:` +
      `${Math.round(positions[v * 3 + 1] * scale)}:${Math.round(positions[v * 3 + 2] * scale)}`;
    let welded = canonical.get(key);
    if (welded === undefined) canonical.set(key, (welded = v));
    remap[v] = welded;
  }
  const edges = new Map<string, number>();
  for (let t = 0; t < indices.length; t += 3) {
    const a = remap[indices[t]], b = remap[indices[t + 1]], c = remap[indices[t + 2]];
    if (a === b || b === c || c === a) continue;
    for (const key of [`${a}:${b}`, `${b}:${c}`, `${c}:${a}`]) {
      edges.set(key, (edges.get(key) ?? 0) + 1);
    }
  }
  if (edges.size === 0) return false;
  for (const [key, count] of edges) {
    if (count !== 1) return false;
    const colon = key.indexOf(":");
    if (edges.get(`${key.slice(colon + 1)}:${key.slice(0, colon)}`) !== 1) return false;
  }
  return true;
}
