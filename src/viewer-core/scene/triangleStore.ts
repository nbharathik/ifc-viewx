// A lean CPU-side copy of the triangles the batcher was handed.
//
// Merged chunks free their arrays after GPU upload, so once a model is drawn
// its geometry only exists in graphics memory. Anything that has to answer a
// question about real surfaces rather than boxes needs it back. This keeps
// positions and indices, one entry per unique geometry rather than one per
// placement and no normals or colours, which is roughly a quarter of what the
// renderer holds for the same model.
//
// Nothing is re-parsed: this is the same data the batcher ingested, packed for
// a single transfer to whichever worker ends up doing the analysis.
import type { IfcMesh } from '../engine/types.js';
import { packId } from '../ids.js';

/** Triangle data for a run of placements, packed for one structured-clone hop. */
export interface TriangleChunk {
  /** Federated model slot the placements belong to. */
  model: number;
  /** Geometry ids new in this chunk; a repeat is never sent twice. */
  geometryIDs: Uint32Array;
  vertexCounts: Uint32Array;
  indexCounts: Uint32Array;
  /** Local AABB per geometry: minX,minY,minZ,maxX,maxY,maxZ. */
  localBounds: Float32Array;
  /** Local-space xyz triples, concatenated in `geometryIDs` order. */
  positions: Float32Array;
  /** Local indices, concatenated; each run is rebased by its reader. */
  indices: Uint32Array;
  /** Packed element id per placement. */
  elementIDs: Float64Array;
  geometryOf: Uint32Array;
  /** 16 doubles per placement, f64 so georeferenced placements stay exact. */
  matrices: Float64Array;
  /** IFC class per placement. */
  types: string[];
}

/**
 * Triangles retained before the store stops and marks itself incomplete. At
 * 24 bytes a triangle this is well past what the renderer itself will hold,
 * so it is a backstop against a pathological file rather than a normal limit.
 */
const RETENTION_TRIANGLE_LIMIT = 30_000_000;

/**
 * Whoever is holding the triangles once they leave here. Connecting drains the
 * backlog into it, and every later change to the open models is passed on, so
 * a consumer in a worker cannot drift out of step with the viewport.
 */
export interface TriangleSink {
  chunk(chunk: TriangleChunk): void;
  dropModel(model: number): void;
  clear(): void;
  /** The viewer is going away, so anything holding these can go with it. */
  dispose(): void;
}

export class TriangleStore {
  /** Geometry ids already packed, per model, so a repeat crosses once. */
  private readonly seen = new Map<number, Set<number>>();
  private queue: TriangleChunk[] = [];
  private sink: TriangleSink | null = null;
  private triangles = 0;
  private bytes = 0;
  private full = false;

  /** Send new chunks straight on, starting with whatever has piled up. */
  connect(sink: TriangleSink): void {
    this.sink = sink;
    const backlog = this.queue;
    this.queue = [];
    for (const chunk of backlog) sink.chunk(chunk);
  }

  /** Drop the retained triangles and tell the consumer to shut down. */
  dispose(): void {
    const sink = this.sink;
    this.sink = null;
    this.seen.clear();
    this.queue = [];
    this.triangles = 0;
    this.bytes = 0;
    this.full = false;
    sink?.dispose();
  }

  /** Bytes held, whether still queued here or already handed over. */
  get retainedBytes(): number {
    return this.bytes;
  }

  get triangleCount(): number {
    return this.triangles;
  }

  /** True once the cap stopped retention, so an answer can say it is partial. */
  get truncated(): boolean {
    return this.full;
  }

  add(meshes: IfcMesh[], modelIndex: number): void {
    if (this.full || meshes.length === 0) return;

    let seen = this.seen.get(modelIndex);
    if (!seen) {
      seen = new Set();
      this.seen.set(modelIndex, seen);
    }

    const fresh: IfcMesh[] = [];
    let vertexFloats = 0;
    let indexCount = 0;
    for (const mesh of meshes) {
      if (seen.has(mesh.geometryID)) continue;
      seen.add(mesh.geometryID);
      fresh.push(mesh);
      vertexFloats += mesh.geometry.positions.length;
      indexCount += mesh.geometry.indices.length;
    }

    if (this.triangles + indexCount / 3 > RETENTION_TRIANGLE_LIMIT) {
      this.full = true;
      return;
    }
    this.triangles += indexCount / 3;
    this.bytes += vertexFloats * 4 + indexCount * 4 + meshes.length * 152;

    const chunk: TriangleChunk = {
      model: modelIndex,
      geometryIDs: new Uint32Array(fresh.length),
      vertexCounts: new Uint32Array(fresh.length),
      indexCounts: new Uint32Array(fresh.length),
      localBounds: new Float32Array(fresh.length * 6),
      positions: new Float32Array(vertexFloats),
      indices: new Uint32Array(indexCount),
      elementIDs: new Float64Array(meshes.length),
      geometryOf: new Uint32Array(meshes.length),
      matrices: new Float64Array(meshes.length * 16),
      types: new Array<string>(meshes.length),
    };

    let po = 0;
    let io = 0;
    for (let i = 0; i < fresh.length; i++) {
      const mesh = fresh[i];
      const g = mesh.geometry;
      chunk.geometryIDs[i] = mesh.geometryID;
      chunk.vertexCounts[i] = g.positions.length / 3;
      chunk.indexCounts[i] = g.indices.length;
      const b = i * 6;
      chunk.localBounds[b] = mesh.localBounds.min.x;
      chunk.localBounds[b + 1] = mesh.localBounds.min.y;
      chunk.localBounds[b + 2] = mesh.localBounds.min.z;
      chunk.localBounds[b + 3] = mesh.localBounds.max.x;
      chunk.localBounds[b + 4] = mesh.localBounds.max.y;
      chunk.localBounds[b + 5] = mesh.localBounds.max.z;
      chunk.positions.set(g.positions, po);
      chunk.indices.set(g.indices, io);
      po += g.positions.length;
      io += g.indices.length;
    }

    for (let i = 0; i < meshes.length; i++) {
      const mesh = meshes[i];
      chunk.elementIDs[i] = packId(modelIndex, mesh.expressID);
      chunk.geometryOf[i] = mesh.geometryID;
      for (let m = 0; m < 16; m++) chunk.matrices[i * 16 + m] = mesh.matrix[m];
      chunk.types[i] = mesh.ifcType;
    }

    if (this.sink) this.sink.chunk(chunk);
    else this.queue.push(chunk);
  }

  dropModel(modelIndex: number): void {
    this.seen.delete(modelIndex);
    this.queue = this.queue.filter((chunk) => chunk.model !== modelIndex);
    this.sink?.dropModel(modelIndex);
  }

  clear(): void {
    this.seen.clear();
    this.queue = [];
    this.triangles = 0;
    this.bytes = 0;
    this.full = false;
    this.sink?.clear();
  }
}

/** Every buffer in a chunk, so posting one costs a pointer swap and no copy. */
export function chunkTransfers(chunk: TriangleChunk): Transferable[] {
  return [
    chunk.geometryIDs.buffer,
    chunk.vertexCounts.buffer,
    chunk.indexCounts.buffer,
    chunk.localBounds.buffer,
    chunk.positions.buffer,
    chunk.indices.buffer,
    chunk.elementIDs.buffer,
    chunk.geometryOf.buffer,
    chunk.matrices.buffer,
  ] as Transferable[];
}
