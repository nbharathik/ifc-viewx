import { modelOf } from "../viewer-core/ids.js";
import type { TriangleChunk } from "../viewer-core/scene/triangleStore.js";
import type { Placement } from "../ifc/clash/narrow.js";
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
    offset: [number, number, number],
  ): GeometryBounds | null {
    const element = this.elements.get(id);
    const table = this.geometries.get(modelOf(id));
    if (!element || !table) return null;
    const base = this.baseBounds(element, table);
    if (!base) return null;
    return {
      id,
      min: [
        base.min[0] - origin[0] + offset[0],
        base.min[1] - origin[1] + offset[1],
        base.min[2] - origin[2] + offset[2],
      ],
      max: [
        base.max[0] - origin[0] + offset[0],
        base.max[1] - origin[1] + offset[1],
        base.max[2] - origin[2] + offset[2],
      ],
    };
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
