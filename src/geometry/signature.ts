import type { IfcMesh } from "../viewer-core/engine/types.js";
import type { GeometryBounds, GeometryShapeFingerprint, GeometrySignature } from "./types.js";

const SAMPLE_LIMIT = 2048;
const QUANTIZE = 10_000;
const FNV_OFFSET = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

const mix = (hash: number, value: number): number => Math.imul(hash ^ value, FNV_PRIME) >>> 0;

function sampleHash(values: ArrayLike<number>, seed: number): number {
  let hash = seed;
  const stride = Math.max(1, Math.floor(values.length / SAMPLE_LIMIT));
  for (let index = 0; index < values.length; index += stride) {
    hash = mix(hash, Math.round(values[index] * QUANTIZE));
  }
  return mix(hash, values.length);
}

export function shapeFingerprint(
  positions: Float32Array,
  indices: Uint32Array,
  bounds: ArrayLike<number>,
): GeometryShapeFingerprint {
  let hash = sampleHash(positions, FNV_OFFSET);
  hash = sampleHash(indices, hash);
  for (let index = 0; index < 6; index++) hash = mix(hash, Math.round(bounds[index] * QUANTIZE));
  return {
    hash: hash.toString(16).padStart(8, "0"),
    vertices: Math.floor(positions.length / 3),
    triangles: Math.floor(indices.length / 3),
  };
}

interface Piece {
  shape: GeometryShapeFingerprint;
  bounds: ArrayLike<number>;
  matrix: ArrayLike<number>;
}

function quaternion(matrix: ArrayLike<number>): [number, number, number, number] {
  const sx = Math.hypot(matrix[0], matrix[1], matrix[2]) || 1;
  const sy = Math.hypot(matrix[4], matrix[5], matrix[6]) || 1;
  const sz = Math.hypot(matrix[8], matrix[9], matrix[10]) || 1;
  const m00 = matrix[0] / sx;
  const m01 = matrix[4] / sy;
  const m02 = matrix[8] / sz;
  const m10 = matrix[1] / sx;
  const m11 = matrix[5] / sy;
  const m12 = matrix[9] / sz;
  const m20 = matrix[2] / sx;
  const m21 = matrix[6] / sy;
  const m22 = matrix[10] / sz;
  const trace = m00 + m11 + m22;
  let x = 0;
  let y = 0;
  let z = 0;
  let w = 1;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = s / 4;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = s / 4;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = s / 4;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = s / 4;
  }
  return [x, y, z, w];
}

function transformBounds(bounds: ArrayLike<number>, matrix: ArrayLike<number>, out: GeometryBounds): void {
  for (let corner = 0; corner < 8; corner++) {
    const lx = corner & 1 ? bounds[3] : bounds[0];
    const ly = corner & 2 ? bounds[4] : bounds[1];
    const lz = corner & 4 ? bounds[5] : bounds[2];
    const x = matrix[0] * lx + matrix[4] * ly + matrix[8] * lz + matrix[12];
    const y = matrix[1] * lx + matrix[5] * ly + matrix[9] * lz + matrix[13];
    const z = matrix[2] * lx + matrix[6] * ly + matrix[10] * lz + matrix[14];
    out.min[0] = Math.min(out.min[0], x);
    out.min[1] = Math.min(out.min[1], y);
    out.min[2] = Math.min(out.min[2], z);
    out.max[0] = Math.max(out.max[0], x);
    out.max[1] = Math.max(out.max[1], y);
    out.max[2] = Math.max(out.max[2], z);
  }
}

export class GeometrySignatureBuilder {
  private readonly elements = new Map<number, Piece[]>();
  private readonly shapes = new Map<string, GeometryShapeFingerprint>();

  addMesh(mesh: IfcMesh, model = 0): void {
    const key = `${model}:${mesh.geometryID}`;
    let shape = this.shapes.get(key);
    if (!shape) {
      const bounds = mesh.localBounds;
      shape = shapeFingerprint(mesh.geometry.positions, mesh.geometry.indices, [
        bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z,
      ]);
      this.shapes.set(key, shape);
    }
    this.add(mesh.expressID, shape, [
      mesh.localBounds.min.x, mesh.localBounds.min.y, mesh.localBounds.min.z,
      mesh.localBounds.max.x, mesh.localBounds.max.y, mesh.localBounds.max.z,
    ], mesh.matrix);
  }

  add(id: number, shape: GeometryShapeFingerprint, bounds: ArrayLike<number>, matrix: ArrayLike<number>): void {
    const pieces = this.elements.get(id) ?? [];
    pieces.push({ shape, bounds, matrix });
    this.elements.set(id, pieces);
  }

  finish(): GeometrySignature[] {
    return [...this.elements].map(([id, pieces]) => signatureOf(id, pieces));
  }
}

function signatureOf(id: number, pieces: Piece[]): GeometrySignature {
  const bounds: GeometryBounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };
  let vertices = 0;
  let triangles = 0;
  let hash = FNV_OFFSET;
  for (const piece of [...pieces].sort((a, b) => a.shape.hash.localeCompare(b.shape.hash))) {
    vertices += piece.shape.vertices;
    triangles += piece.shape.triangles;
    for (let index = 0; index < piece.shape.hash.length; index++) hash = mix(hash, piece.shape.hash.charCodeAt(index));
    transformBounds(piece.bounds, piece.matrix, bounds);
  }
  const first = pieces[0]?.matrix;
  return {
    id,
    shapeHash: hash.toString(16).padStart(8, "0"),
    pieces: pieces.length,
    vertices,
    triangles,
    bounds,
    translation: first ? [first[12], first[13], first[14]] : [0, 0, 0],
    rotation: first ? quaternion(first) : [0, 0, 0, 1],
  };
}
