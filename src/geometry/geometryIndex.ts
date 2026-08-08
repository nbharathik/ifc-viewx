import { modelOf } from "../viewer-core/ids.js";
import type { TriangleChunk } from "../viewer-core/scene/triangleStore.js";
import type { Placement } from "../ifc/clash/narrow.js";

interface StoredGeometry {
  positions: Float32Array;
  indices: Uint32Array;
  bounds: Float32Array;
}

interface StoredElement {
  type: string;
  geometryIDs: number[];
  matrices: Float64Array[];
}

export interface GeometryBounds {
  id: number;
  min: [number, number, number];
  max: [number, number, number];
}

export class GeometryIndex {
  private readonly geometries = new Map<number, Map<number, StoredGeometry>>();
  private readonly elements = new Map<number, StoredElement>();
  private version = 0;

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
    const hadGeometry = this.geometries.delete(model);
    let removed = false;
    for (const id of [...this.elements.keys()]) {
      if (modelOf(id) === model) removed = this.elements.delete(id) || removed;
    }
    if (hadGeometry || removed) this.version += 1;
  }

  clear(): void {
    if (this.geometries.size || this.elements.size) this.version += 1;
    this.geometries.clear();
    this.elements.clear();
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

  worldBounds(
    id: number,
    origin: [number, number, number],
    offset: [number, number, number],
  ): GeometryBounds | null {
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
