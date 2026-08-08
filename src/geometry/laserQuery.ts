import { modelOf } from "../viewer-core/ids.js";
import type { GeometryIndex } from "./geometryIndex.js";
import type { LaserAxis, LaserAxisResult, LaserHit, LaserResult, LaserSpec } from "./types.js";

export interface LaserRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
}

type Point = [number, number, number];

const AXES: LaserAxis[] = ["x", "y", "z"];
const DIRECTIONS: Array<{ axis: LaserAxis; index: number; sign: -1 | 1; vector: Point }> = [
  { axis: "x", index: 0, sign: -1, vector: [-1, 0, 0] },
  { axis: "x", index: 0, sign: 1, vector: [1, 0, 0] },
  { axis: "y", index: 1, sign: -1, vector: [0, -1, 0] },
  { axis: "y", index: 1, sign: 1, vector: [0, 1, 0] },
  { axis: "z", index: 2, sign: -1, vector: [0, 0, -1] },
  { axis: "z", index: 2, sign: 1, vector: [0, 0, 1] },
];

function offsetsOf(values: Float64Array): Map<number, Point> {
  const offsets = new Map<number, Point>();
  for (let i = 0; i + 3 < values.length; i += 4) {
    offsets.set(values[i], [values[i + 1], values[i + 2], values[i + 3]]);
  }
  return offsets;
}

function transform(
  positions: Float32Array,
  at: number,
  matrix: Float64Array,
  modelOrigin: Point,
  offset: Point,
): Point {
  const x = positions[at];
  const y = positions[at + 1];
  const z = positions[at + 2];
  return [
    matrix[0] * x + matrix[4] * y + matrix[8] * z + matrix[12] - modelOrigin[0] + offset[0],
    matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13] - modelOrigin[1] + offset[1],
    matrix[2] * x + matrix[6] * y + matrix[10] * z + matrix[14] - modelOrigin[2] + offset[2],
  ];
}

function normal(a: Point, b: Point, c: Point): Point | null {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const x = uy * vz - uz * vy;
  const y = uz * vx - ux * vz;
  const z = ux * vy - uy * vx;
  const length = Math.hypot(x, y, z);
  return length > 1e-12 ? [x / length, y / length, z / length] : null;
}

function rayTriangle(origin: Point, direction: Point, a: Point, b: Point, c: Point): number | null {
  const e1x = b[0] - a[0];
  const e1y = b[1] - a[1];
  const e1z = b[2] - a[2];
  const e2x = c[0] - a[0];
  const e2y = c[1] - a[1];
  const e2z = c[2] - a[2];
  const px = direction[1] * e2z - direction[2] * e2y;
  const py = direction[2] * e2x - direction[0] * e2z;
  const pz = direction[0] * e2y - direction[1] * e2x;
  const det = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(det) < 1e-12) return null;
  const inv = 1 / det;
  const tx = origin[0] - a[0];
  const ty = origin[1] - a[1];
  const tz = origin[2] - a[2];
  const u = (tx * px + ty * py + tz * pz) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return null;
  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (direction[0] * qx + direction[1] * qy + direction[2] * qz) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return null;
  return (e2x * qx + e2y * qy + e2z * qz) * inv;
}

function closestPoint(point: Point, a: Point, b: Point, c: Point): Point {
  const ab: Point = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const ac: Point = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const ap: Point = [point[0] - a[0], point[1] - a[1], point[2] - a[2]];
  const d1 = ab[0] * ap[0] + ab[1] * ap[1] + ab[2] * ap[2];
  const d2 = ac[0] * ap[0] + ac[1] * ap[1] + ac[2] * ap[2];
  if (d1 <= 0 && d2 <= 0) return a;
  const bp: Point = [point[0] - b[0], point[1] - b[1], point[2] - b[2]];
  const d3 = ab[0] * bp[0] + ab[1] * bp[1] + ab[2] * bp[2];
  const d4 = ac[0] * bp[0] + ac[1] * bp[1] + ac[2] * bp[2];
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) {
    const v = d1 / (d1 - d3);
    return [a[0] + ab[0] * v, a[1] + ab[1] * v, a[2] + ab[2] * v];
  }
  const cp: Point = [point[0] - c[0], point[1] - c[1], point[2] - c[2]];
  const d5 = ab[0] * cp[0] + ab[1] * cp[1] + ab[2] * cp[2];
  const d6 = ac[0] * cp[0] + ac[1] * cp[1] + ac[2] * cp[2];
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) {
    const w = d2 / (d2 - d6);
    return [a[0] + ac[0] * w, a[1] + ac[1] * w, a[2] + ac[2] * w];
  }
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
    const w = (d4 - d3) / (d4 - d3 + d5 - d6);
    return [b[0] + (c[0] - b[0]) * w, b[1] + (c[1] - b[1]) * w, b[2] + (c[2] - b[2]) * w];
  }
  const denom = 1 / (va + vb + vc);
  const v = vb * denom;
  const w = vc * denom;
  return [a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w];
}

function directionCanHit(
  origin: Point,
  min: Point,
  max: Point,
  index: number,
  sign: -1 | 1,
  epsilon: number,
  maxDistance: number,
): boolean {
  const a = (index + 1) % 3;
  const b = (index + 2) % 3;
  if (origin[a] < min[a] - epsilon || origin[a] > max[a] + epsilon) return false;
  if (origin[b] < min[b] - epsilon || origin[b] > max[b] + epsilon) return false;
  if (sign > 0) {
    return max[index] > origin[index] + epsilon && Math.max(0, min[index] - origin[index]) <= maxDistance;
  }
  return min[index] < origin[index] - epsilon && Math.max(0, origin[index] - max[index]) <= maxDistance;
}

export async function runLaser(
  index: GeometryIndex,
  spec: LaserSpec,
  options: LaserRunOptions = {},
): Promise<LaserResult> {
  const started = Date.now();
  const offsets = offsetsOf(spec.offsets);
  const epsilon = Math.max(1e-6, spec.epsilon ?? 1e-4);
  const maxDistance = Math.max(epsilon, spec.maxDistance ?? Infinity);
  const ids = [...spec.ids];
  const hits: Array<LaserHit | null> = new Array(6).fill(null);
  let sourceNormal: Point | null = null;
  let sourceDistance = Infinity;
  let missing = 0;

  for (let elementIndex = 0; elementIndex < ids.length; elementIndex++) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    if (elementIndex > 0 && elementIndex % 128 === 0) await options.yieldTurn?.();
    const id = ids[elementIndex];
    const offset = offsets.get(modelOf(id)) ?? [0, 0, 0];
    const bounds = index.worldBounds(id, spec.modelOrigin, offset);
    if (!bounds) {
      missing += 1;
      continue;
    }
    const candidates = DIRECTIONS.map((direction) =>
      directionCanHit(spec.origin, bounds.min, bounds.max, direction.index, direction.sign, epsilon, maxDistance));
    const findSource = id === spec.source;
    if (!findSource && candidates.every((candidate) => !candidate)) continue;
    const placements = index.placements(id);
    for (const placement of placements) {
      const { positions, indices, matrix } = placement;
      for (let at = 0; at + 2 < indices.length; at += 3) {
        const a = transform(positions, indices[at] * 3, matrix, spec.modelOrigin, offset);
        const b = transform(positions, indices[at + 1] * 3, matrix, spec.modelOrigin, offset);
        const c = transform(positions, indices[at + 2] * 3, matrix, spec.modelOrigin, offset);
        const faceNormal = normal(a, b, c);
        if (!faceNormal) continue;
        if (findSource) {
          const nearest = closestPoint(spec.origin, a, b, c);
          const distance = Math.hypot(
            nearest[0] - spec.origin[0], nearest[1] - spec.origin[1], nearest[2] - spec.origin[2],
          );
          if (distance < sourceDistance) {
            sourceDistance = distance;
            sourceNormal = faceNormal;
          }
        }
        if (findSource) continue;
        for (let directionIndex = 0; directionIndex < DIRECTIONS.length; directionIndex++) {
          if (!candidates[directionIndex]) continue;
          const direction = DIRECTIONS[directionIndex];
          const distance = rayTriangle(spec.origin, direction.vector, a, b, c);
          if (distance === null || distance <= epsilon || distance > maxDistance) continue;
          const previous = hits[directionIndex];
          if (previous && previous.distance <= distance) continue;
          hits[directionIndex] = {
            axis: direction.axis,
            direction: direction.sign,
            elementId: id,
            elementType: index.typeOf(id),
            distance,
            point: [
              spec.origin[0] + direction.vector[0] * distance,
              spec.origin[1] + direction.vector[1] * distance,
              spec.origin[2] + direction.vector[2] * distance,
            ],
            normal: faceNormal,
          };
        }
      }
    }
  }

  const axes = AXES.map((axis, index): LaserAxisResult => {
    const negative = hits[index * 2];
    const positive = hits[index * 2 + 1];
    return {
      axis,
      negative,
      positive,
      span: negative && positive ? negative.distance + positive.distance : null,
    };
  }) as [LaserAxisResult, LaserAxisResult, LaserAxisResult];
  return {
    origin: [...spec.origin],
    source: spec.source ?? null,
    sourceNormal,
    axes,
    testedElements: ids.length - missing,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-ray",
    geometryRevision: index.revision,
  };
}
