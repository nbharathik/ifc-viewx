// As-built deviation: how far each scanned point is from the model surface.
//
// The BVHs the clash engine already builds answer "what is the closest point
// on this mesh" directly. A scene-space placement tree first narrows each scan
// point to nearby BVHs, so open air never scans the whole building.
import { Vector3 } from "three";
import type { GeometryIndex } from "./geometryIndex.js";
import type { DeviationResult, DeviationSpec } from "./types.js";
import { unpackModelTransforms } from "./modelTransform.js";
import { PlacementBroadPhase, pointBoxDistanceSquared, prepareBvhPlacements } from "./placementBroadPhase.js";

export interface DeviationRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
  /** Test/diagnostic hook: placements admitted by the broad phase per point. */
  onCandidates?: (candidates: number, total: number) => void;
}

export async function runDeviation(
  index: GeometryIndex,
  spec: DeviationSpec,
  options: DeviationRunOptions = {},
): Promise<DeviationResult> {
  const started = Date.now();
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const requestedRadius = spec.maxDistance ?? 1;
  const radius = Number.isFinite(requestedRadius) ? Math.max(1e-3, requestedRadius) : 1;
  const count = Math.floor(spec.points.length / 3);
  const distances = new Float32Array(count).fill(NaN);
  const elements = new Float64Array(count);
  const { placements: prepared, missing } = prepareBvhPlacements(
    index,
    spec.ids,
    spec.modelOrigin,
    transforms,
    options.cancelled,
  );
  const broadPhase = new PlacementBroadPhase(prepared);
  const candidates: number[] = [];
  const world = new Vector3();
  const local = new Vector3();
  let measured = 0;

  for (let pointIndex = 0; pointIndex < count; pointIndex++) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    if (pointIndex > 0 && pointIndex % 256 === 0) await options.yieldTurn?.();
    world.set(spec.points[pointIndex * 3], spec.points[pointIndex * 3 + 1], spec.points[pointIndex * 3 + 2]);
    let best = radius;
    let bestId = 0;
    broadPhase.queryPoint(world, radius, candidates);
    // Tree order is spatial. Preparation order keeps the previous deterministic
    // winner when two surfaces are exactly equidistant.
    if (candidates.length > 1) candidates.sort((a, b) => a - b);
    options.onCandidates?.(candidates.length, prepared.length);
    for (const candidate of candidates) {
      const entry = prepared[candidate];
      if (pointBoxDistanceSquared(world, entry.min, entry.max) >= best * best) continue;
      local.copy(world).applyMatrix4(entry.inverse);
      // `best` is a scene-space distance. The BVH is in placement-local
      // coordinates, whose units may be scaled, so a local max threshold can
      // incorrectly discard a valid nearby world-space surface.
      const closest = entry.placement.bvh.closestPointToPoint(local);
      if (!closest) continue;
      const distance = closest.point.applyMatrix4(entry.matrix).distanceTo(world);
      if (distance < best) {
        best = distance;
        bestId = entry.id;
      }
    }
    if (bestId !== 0) {
      distances[pointIndex] = best;
      elements[pointIndex] = bestId;
      measured += 1;
    }
  }

  return {
    distances,
    elements,
    measured,
    points: count,
    maxDistance: radius,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-deviation",
    geometryRevision: index.revision,
  };
}
