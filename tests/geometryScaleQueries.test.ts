import { describe, expect, it } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";

import { runDeviation } from "../src/geometry/deviationQuery.js";
import { runSun } from "../src/geometry/sunQuery.js";
import type { GeometryIndex } from "../src/geometry/geometryIndex.js";
import type { DeviationSpec, SunSpec } from "../src/geometry/types.js";

const placement = (surfaceX: number) => ({
  matrix: new Float64Array(new Matrix4().elements),
  positions: new Float32Array(),
  indices: new Uint32Array(),
  bvh: {
    getBoundingBox: (target: Box3) => target.set(
      new Vector3(surfaceX, -1, -1),
      new Vector3(surfaceX, 1, 1),
    ),
    closestPointToPoint: (point: Vector3) => ({ point: new Vector3(surfaceX, point.y, point.z), distance: Math.abs(point.x - surfaceX) }),
    raycastFirst: () => ({ point: new Vector3(surfaceX, 0, 0), distance: surfaceX }),
  },
});

const index = (surfaceX: number): GeometryIndex => ({
  revision: 1,
  worldBounds: () => ({ min: [0, -1, -1], max: [3, 1, 1] }),
  bvhPlacements: () => [placement(surfaceX)],
}) as unknown as GeometryIndex;

const transformed = new Float64Array([0, 0, 0, 0, 0, 0.1]);

describe("scaled geometry queries", () => {
  it("measures deviation thresholds in scene metres, not BVH-local units", async () => {
    const spec: DeviationSpec = {
      points: new Float64Array([2, 0, 0]),
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      transforms: transformed,
      maxDistance: 1,
    };
    const result = await runDeviation(index(15), spec);
    expect(result.measured).toBe(1);
    expect(result.distances[0]).toBeCloseTo(0.5, 5);
  });

  it("compares sun-ray hits with the scene-space shadow distance", async () => {
    const spec: SunSpec = {
      points: new Float64Array([0, 0, 0]),
      directions: new Float64Array([-1, 0, 0]),
      stepMinutes: 60,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      transforms: transformed,
      epsilon: 0.001,
      maxDistance: 1,
    };
    const result = await runSun(index(5), spec);
    expect(result.exposure[0]).toBe(0);
  });
});
