import { modelOf } from "../viewer-core/ids.js";
import { DoubleSide, Matrix3, Matrix4, Ray, Vector3 } from "three";
import type { BvhPlacement, GeometryIndex } from "./geometryIndex.js";
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

function sceneMatrix(matrix: Float64Array, modelOrigin: Point, offset: Point, target: Matrix4): Matrix4 {
  target.fromArray(matrix);
  const values = target.elements;
  values[12] = matrix[12] - modelOrigin[0] + offset[0];
  values[13] = matrix[13] - modelOrigin[1] + offset[1];
  values[14] = matrix[14] - modelOrigin[2] + offset[2];
  return target;
}

function placementNormal(
  placement: BvhPlacement,
  faceIndex: number,
  normalMatrix: Matrix3,
  target: Vector3,
): Point | null {
  const resolved = placement.bvh.indirect ? placement.bvh.resolveTriangleIndex(faceIndex) : faceIndex;
  const at = resolved * 3;
  if (at < 0 || at + 2 >= placement.indices.length) return null;
  const ai = placement.indices[at] * 3;
  const bi = placement.indices[at + 1] * 3;
  const ci = placement.indices[at + 2] * 3;
  const positions = placement.positions;
  const ab = new Vector3(
    positions[bi] - positions[ai],
    positions[bi + 1] - positions[ai + 1],
    positions[bi + 2] - positions[ai + 2],
  );
  const ac = target.set(
    positions[ci] - positions[ai],
    positions[ci + 1] - positions[ai + 1],
    positions[ci + 2] - positions[ai + 2],
  );
  target.crossVectors(ab, ac).applyNormalMatrix(normalMatrix).normalize();
  return target.lengthSq() > 1e-12 ? [target.x, target.y, target.z] : null;
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
  const worldOrigin = new Vector3(...spec.origin);
  const worldMatrix = new Matrix4();
  const inverseMatrix = new Matrix4();
  const normalMatrix = new Matrix3();
  const localRay = new Ray();
  const localPoint = new Vector3();
  const normalVector = new Vector3();

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
    const placements = index.bvhPlacements(id);
    for (const placement of placements) {
      const matrix = sceneMatrix(placement.matrix, spec.modelOrigin, offset, worldMatrix);
      inverseMatrix.copy(matrix).invert();
      normalMatrix.getNormalMatrix(matrix);
      if (findSource) {
        localPoint.copy(worldOrigin).applyMatrix4(inverseMatrix);
        const closest = placement.bvh.closestPointToPoint(localPoint);
        if (!closest) continue;
        const worldPoint = closest.point.applyMatrix4(matrix);
        const distance = worldPoint.distanceTo(worldOrigin);
        if (distance < sourceDistance) {
          sourceDistance = distance;
          sourceNormal = placementNormal(placement, closest.faceIndex, normalMatrix, normalVector);
        }
        continue;
      }
      for (let directionIndex = 0; directionIndex < DIRECTIONS.length; directionIndex++) {
        if (!candidates[directionIndex]) continue;
        const direction = DIRECTIONS[directionIndex];
        localRay.origin.copy(worldOrigin);
        localRay.direction.set(...direction.vector);
        localRay.applyMatrix4(inverseMatrix);
        const hit = placement.bvh.raycastFirst(localRay, DoubleSide);
        if (!hit) continue;
        const worldPoint = hit.point.applyMatrix4(matrix);
        const distance = worldPoint.distanceTo(worldOrigin);
        if (distance <= epsilon || distance > maxDistance) continue;
        const previous = hits[directionIndex];
        if (previous && previous.distance <= distance) continue;
        const normal = hit.face?.normal
          ? hit.face.normal.clone().applyNormalMatrix(normalMatrix).normalize()
          : null;
        hits[directionIndex] = {
          axis: direction.axis,
          direction: direction.sign,
          elementId: id,
          elementType: index.typeOf(id),
          distance,
          point: [worldPoint.x, worldPoint.y, worldPoint.z],
          normal: normal ? [normal.x, normal.y, normal.z] : [0, 0, 0],
        };
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
