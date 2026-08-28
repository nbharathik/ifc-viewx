// Transfer format for streaming meshes out of the parser worker: each unique
// geometry crosses once, placements reference it by geometryID, and all typed
// arrays are transferable (no copies).
import type { IfcGridInfo, IfcMesh, IfcTaskGraph, LoadProgress, LoadedModelMeta, MeshGeometry, OrganizeIndex, Vec3 } from './types.js';

/** Unique geometries new in this batch, concatenated into shared arrays. */
export interface GeometryTable {
  /** geometryExpressIDs, one per geometry. */
  ids: Uint32Array;
  /** Vertex count per geometry (positions/normals hold 3 floats per vertex). */
  vertexCounts: Uint32Array;
  /** Index count per geometry. */
  indexCounts: Uint32Array;
  /** Local AABB per geometry: minX,minY,minZ,maxX,maxY,maxZ. */
  localBounds: Float64Array;
  positions: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
}

/** Placements (mesh instances) in this batch. */
export interface PlacementTable {
  expressIDs: Uint32Array;
  geometryIDs: Uint32Array;
  /** 16 doubles per placement. Kept f64 so georeferenced offsets survive. */
  matrices: Float64Array;
  /** r,g,b,a per placement. */
  colors: Float32Array;
  /** IFC class name per placement (strings clone cheaply at this size). */
  ifcTypes: string[];
}

export interface MeshBatch {
  geometries: GeometryTable;
  placements: PlacementTable;
}

/** Messages from the client to the worker. */
export type WorkerRequest =
  | { type: 'init'; wasmPath?: string; wasmAbsolute?: boolean; wasmBinary?: Uint8Array }
  | { type: 'load'; id: number; url?: string; bytes?: Uint8Array; fileName?: string; downloadMs?: number; skipGeometry?: boolean }
  | { type: 'loadCategory'; id: number; modelID: number; category: string }
  | { type: 'getProperties'; id: number; modelID: number; expressID: number }
  | { type: 'getCounts'; id: number; modelID: number }
  | { type: 'getTaskGraph'; id: number; modelID: number }
  | { type: 'getOrganizeIndex'; id: number; modelID: number }
  | { type: 'getGridAxes'; id: number; modelID: number }
  | { type: 'dispose'; modelID: number };

/** Messages from the worker to the client. */
export type WorkerResponse =
  | { type: 'booted' }
  | { type: 'initDone'; error?: string }
  | { type: 'progress'; id: number; progress: LoadProgress }
  | { type: 'meshBatch'; id: number; batch: MeshBatch }
  | { type: 'loadDone'; id: number; result: LoadedModelMeta }
  | { type: 'categoryDone'; id: number }
  | { type: 'properties'; id: number; result: unknown }
  | { type: 'counts'; id: number; result: Record<string, number> }
  | { type: 'taskGraph'; id: number; result: IfcTaskGraph }
  | { type: 'organizeIndex'; id: number; result: OrganizeIndex }
  | { type: 'gridAxes'; id: number; result: IfcGridInfo[] }
  | { type: 'fail'; id: number; message: string };

/** Accumulates meshes worker-side and drains them as one transferable batch. */
export class BatchBuilder {
  private readonly seenGeometry: Set<number>;
  private geoIds: number[] = [];
  private geoVertexCounts: number[] = [];
  private geoIndexCounts: number[] = [];
  private geoBounds: number[] = [];
  private geoParts: MeshGeometry[] = [];
  private geoFloats = 0;
  private geoInts = 0;

  private expressIDs: number[] = [];
  private geometryIDs: number[] = [];
  private matrices: number[] = [];
  private colors: number[] = [];
  private ifcTypes: string[] = [];

  /** @param seenGeometry geometryIDs already sent in earlier batches of this stream. */
  constructor(seenGeometry: Set<number>) {
    this.seenGeometry = seenGeometry;
  }

  get placementCount(): number {
    return this.expressIDs.length;
  }

  /** Approximate payload bytes accumulated so far (geometry dominates). */
  get pendingBytes(): number {
    return this.geoFloats * 4 + this.geoInts * 4 + this.expressIDs.length * 160;
  }

  add(mesh: IfcMesh): void {
    if (!this.seenGeometry.has(mesh.geometryID)) {
      this.seenGeometry.add(mesh.geometryID);
      const g = mesh.geometry;
      this.geoIds.push(mesh.geometryID);
      this.geoVertexCounts.push(g.positions.length / 3);
      this.geoIndexCounts.push(g.indices.length);
      const { min, max } = mesh.localBounds;
      this.geoBounds.push(min.x, min.y, min.z, max.x, max.y, max.z);
      this.geoParts.push(g);
      this.geoFloats += g.positions.length + g.normals.length;
      this.geoInts += g.indices.length;
    }
    this.expressIDs.push(mesh.expressID);
    this.geometryIDs.push(mesh.geometryID);
    for (let i = 0; i < 16; i++) this.matrices.push(mesh.matrix[i]);
    this.colors.push(mesh.color.r, mesh.color.g, mesh.color.b, mesh.color.a);
    this.ifcTypes.push(mesh.ifcType);
  }

  /** Build the batch and reset. Returns null when nothing accumulated. */
  drain(): { batch: MeshBatch; transfer: Transferable[] } | null {
    if (this.expressIDs.length === 0) return null;

    let posLen = 0;
    let idxLen = 0;
    for (const g of this.geoParts) {
      posLen += g.positions.length;
      idxLen += g.indices.length;
    }
    const positions = new Float32Array(posLen);
    const normals = new Float32Array(posLen);
    const indices = new Uint32Array(idxLen);
    let po = 0;
    let io = 0;
    for (const g of this.geoParts) {
      positions.set(g.positions, po);
      normals.set(g.normals, po);
      indices.set(g.indices, io);
      po += g.positions.length;
      io += g.indices.length;
    }

    const batch: MeshBatch = {
      geometries: {
        ids: new Uint32Array(this.geoIds),
        vertexCounts: new Uint32Array(this.geoVertexCounts),
        indexCounts: new Uint32Array(this.geoIndexCounts),
        localBounds: new Float64Array(this.geoBounds),
        positions,
        normals,
        indices,
      },
      placements: {
        expressIDs: new Uint32Array(this.expressIDs),
        geometryIDs: new Uint32Array(this.geometryIDs),
        matrices: new Float64Array(this.matrices),
        colors: new Float32Array(this.colors),
        ifcTypes: this.ifcTypes,
      },
    };
    const transfer = [
      batch.geometries.ids.buffer,
      batch.geometries.vertexCounts.buffer,
      batch.geometries.indexCounts.buffer,
      batch.geometries.localBounds.buffer,
      batch.geometries.positions.buffer,
      batch.geometries.normals.buffer,
      batch.geometries.indices.buffer,
      batch.placements.expressIDs.buffer,
      batch.placements.geometryIDs.buffer,
      batch.placements.matrices.buffer,
      batch.placements.colors.buffer,
    ];

    this.geoIds = [];
    this.geoVertexCounts = [];
    this.geoIndexCounts = [];
    this.geoBounds = [];
    this.geoParts = [];
    this.geoFloats = 0;
    this.geoInts = 0;
    this.expressIDs = [];
    this.geometryIDs = [];
    this.matrices = [];
    this.colors = [];
    this.ifcTypes = [];

    return { batch, transfer };
  }
}

interface RegistryEntry {
  geometry: MeshGeometry;
  localBounds: { min: Vec3; max: Vec3 };
}

/**
 * Client-side geometry registry: rehydrates batches into IfcMesh objects whose
 * geometry is shared per geometryID (subarray views into the batch buffers).
 */
export class GeometryRegistry {
  private readonly entries = new Map<number, RegistryEntry>();

  clear(): void {
    this.entries.clear();
  }

  unpack(batch: MeshBatch): IfcMesh[] {
    const g = batch.geometries;
    let po = 0;
    let io = 0;
    for (let i = 0; i < g.ids.length; i++) {
      const vc = g.vertexCounts[i];
      const ic = g.indexCounts[i];
      const b = i * 6;
      this.entries.set(g.ids[i], {
        geometry: {
          positions: g.positions.subarray(po, po + vc * 3),
          normals: g.normals.subarray(po, po + vc * 3),
          indices: g.indices.subarray(io, io + ic),
        },
        localBounds: {
          min: { x: g.localBounds[b], y: g.localBounds[b + 1], z: g.localBounds[b + 2] },
          max: { x: g.localBounds[b + 3], y: g.localBounds[b + 4], z: g.localBounds[b + 5] },
        },
      });
      po += vc * 3;
      io += ic;
    }

    const p = batch.placements;
    const meshes: IfcMesh[] = new Array(p.expressIDs.length);
    for (let i = 0; i < p.expressIDs.length; i++) {
      const entry = this.entries.get(p.geometryIDs[i]);
      if (!entry) continue;
      const m = i * 16;
      const c = i * 4;
      meshes[i] = {
        expressID: p.expressIDs[i],
        ifcType: p.ifcTypes[i],
        geometryID: p.geometryIDs[i],
        geometry: entry.geometry,
        localBounds: entry.localBounds,
        matrix: Array.from(p.matrices.subarray(m, m + 16)),
        color: {
          r: p.colors[c],
          g: p.colors[c + 1],
          b: p.colors[c + 2],
          a: p.colors[c + 3],
        },
      };
    }
    return meshes.filter(Boolean);
  }
}
