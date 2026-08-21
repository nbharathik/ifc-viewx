// Sunlight hours, by ray casting rather than by shadow map.
//
// A shadow map answers "is this pixel lit right now" at whatever resolution
// the map happens to have. A planning submission asks "how many hours does
// this window see the sun on 21 March", which is a different question: it is
// per sample point, over a whole day, and it has to be defensible. So each
// sample point is tested against every sun direction with a real ray, and the
// answer is a count of unobstructed directions with the step length attached.
import { DoubleSide, Ray, Vector3 } from "three";
import type { GeometryIndex } from "./geometryIndex.js";
import type { SunResult, SunSample, SunSpec } from "./types.js";
import { unpackModelTransforms } from "./modelTransform.js";
import { PlacementBroadPhase, prepareBvhPlacements } from "./placementBroadPhase.js";
import { assertSunIds, finiteXyz, sunScalars, unitXyz } from "./sunValidation.js";

export interface SunRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
  /** Test/diagnostic hook: placements admitted by the ray broad phase. */
  onCandidates?: (candidates: number, total: number) => void;
}

interface ValidatedSunSpec {
  pointCount: number;
  directionCount: number;
  directions: Float64Array;
  ids: number[];
  epsilon: number;
  maxDistance: number;
  stepMinutes: number;
}

function packedRecords(values: Float64Array, width: number, label: string, scaleIndex = -1): void {
  if (values.length % width !== 0) throw new Error(`${label} must contain complete records of ${width} numbers`);
  for (let at = 0; at < values.length; at += width) {
    if (!Number.isSafeInteger(values[at]) || values[at] < 0) {
      throw new Error(`${label} model indexes must be non-negative safe integers`);
    }
    for (let index = 1; index < width; index++) {
      if (!Number.isFinite(values[at + index])) throw new Error(`${label} must contain finite values`);
    }
    if (scaleIndex >= 0 && values[at + scaleIndex] <= 0) {
      throw new Error(`${label} scales must be positive`);
    }
  }
}

function validateSunSpec(spec: SunSpec): ValidatedSunSpec {
  if (!(spec.points instanceof Float64Array) || spec.points.length === 0 || spec.points.length % 3 !== 0) {
    throw new Error("sun points must be a non-empty Float64Array of complete XYZ triples");
  }
  if (!(spec.directions instanceof Float64Array) || spec.directions.length === 0 || spec.directions.length % 3 !== 0) {
    throw new Error("sun directions must be a non-empty Float64Array of complete XYZ triples");
  }
  if (!(spec.ids instanceof Float64Array)) throw new Error("sun ids must be a Float64Array");
  if (!(spec.offsets instanceof Float64Array)) throw new Error("sun offsets must be a Float64Array");
  if (spec.transforms !== undefined && !(spec.transforms instanceof Float64Array)) {
    throw new Error("sun transforms must be a Float64Array");
  }
  if (!Array.isArray(spec.modelOrigin) || spec.modelOrigin.length !== 3) {
    throw new Error("sun modelOrigin must be an XYZ triple");
  }
  finiteXyz(spec.modelOrigin[0], spec.modelOrigin[1], spec.modelOrigin[2], "sun modelOrigin");

  const directions = new Float64Array(spec.directions.length);
  for (let at = 0; at < spec.points.length; at += 3) {
    finiteXyz(spec.points[at], spec.points[at + 1], spec.points[at + 2], `sun point ${at / 3 + 1}`);
  }
  for (let at = 0; at < spec.directions.length; at += 3) {
    const unit = unitXyz(
      spec.directions[at],
      spec.directions[at + 1],
      spec.directions[at + 2],
      `sun direction ${at / 3 + 1}`,
    );
    directions.set(unit, at);
  }
  assertSunIds(spec.ids);
  packedRecords(spec.offsets, 4, "sun offsets");
  if (spec.transforms) packedRecords(spec.transforms, 6, "sun transforms", 5);
  const scalars = sunScalars(spec.stepMinutes, spec.epsilon, spec.maxDistance);
  return {
    pointCount: spec.points.length / 3,
    directionCount: directions.length / 3,
    directions,
    ids: [...spec.ids],
    ...scalars,
  };
}

export async function runSun(
  index: GeometryIndex,
  spec: SunSpec,
  options: SunRunOptions = {},
): Promise<SunResult> {
  const started = Date.now();
  const validated = validateSunSpec(spec);
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const { directions, directionCount, epsilon, ids, maxDistance, pointCount, stepMinutes } = validated;
  const exposure = new Float32Array(pointCount);

  // One transformed placement tree is reused across every sample and sun
  // direction; mesh BVHs only see placements the finite ray can reach.
  const { placements: prepared, missing } = prepareBvhPlacements(
    index,
    ids,
    spec.modelOrigin,
    transforms,
    options.cancelled,
  );
  const broadPhase = new PlacementBroadPhase(prepared);
  const candidates: number[] = [];

  const localRay = new Ray();
  const origin = new Vector3();
  const direction = new Vector3();
  const rayOrigin = new Vector3();
  const worldHit = new Vector3();
  for (let pointIndex = 0; pointIndex < pointCount; pointIndex++) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    if (pointIndex > 0 && pointIndex % 32 === 0) await options.yieldTurn?.();
    origin.set(spec.points[pointIndex * 3], spec.points[pointIndex * 3 + 1], spec.points[pointIndex * 3 + 2]);
    let lit = 0;
    for (let directionIndex = 0; directionIndex < directionCount; directionIndex++) {
      direction.set(
        -directions[directionIndex * 3],
        -directions[directionIndex * 3 + 1],
        -directions[directionIndex * 3 + 2],
      );
      // The stored direction points from the sun toward the model, so the ray
      // toward the sun is its negation.
      rayOrigin.copy(origin).addScaledVector(direction, epsilon);
      let blocked = false;
      broadPhase.queryRay(rayOrigin, direction, maxDistance, candidates);
      options.onCandidates?.(candidates.length, prepared.length);
      for (const candidate of candidates) {
        const entry = prepared[candidate];
        localRay.origin.copy(rayOrigin);
        localRay.direction.copy(direction);
        localRay.applyMatrix4(entry.inverse);
        const hit = entry.placement.bvh.raycastFirst(localRay, DoubleSide);
        if (!hit) continue;
        worldHit.copy(hit.point).applyMatrix4(entry.matrix);
        if (worldHit.distanceTo(rayOrigin) > maxDistance) continue;
        blocked = true;
        break;
      }
      if (!blocked) lit += 1;
    }
    exposure[pointIndex] = (lit * stepMinutes) / 60;
  }

  return {
    exposure,
    stepMinutes,
    directions: directionCount,
    testedElements: ids.length - missing,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-sun",
    geometryRevision: index.revision,
  };
}

export type { SunSample };
