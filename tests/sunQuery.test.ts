import { describe, expect, it, vi } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";

import type { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { runSun } from "../src/geometry/sunQuery.js";
import type { SunSpec } from "../src/geometry/types.js";

describe("sun placement broad phase", () => {
  it("raycasts only placements reached by each finite sun ray", async () => {
    const total = 4_000;
    const getBoundingBox = vi.fn((target: Box3) => target.set(
      new Vector3(0, 0, 0),
      new Vector3(1, 1, 1),
    ));
    const raycastFirst = vi.fn(() => ({ point: new Vector3(0.5, 0.5, 0.5), distance: 0 }));
    const bvh = { getBoundingBox, raycastFirst };
    const index = {
      revision: 3,
      worldBounds: (id: number) => ({
        id,
        min: [id * 10, 0, 0] as [number, number, number],
        max: [id * 10 + 1, 1, 1] as [number, number, number],
      }),
      bvhPlacements: (id: number) => [{
        matrix: new Float64Array(new Matrix4().makeTranslation(id * 10, 0, 0).elements),
        positions: new Float32Array(),
        indices: new Uint32Array(),
        bvh,
      }],
    } as unknown as GeometryIndex;
    const spec: SunSpec = {
      points: new Float64Array([0, 0.5, 0.5]),
      // The first stored vector becomes a +X ray; the second becomes -X.
      directions: new Float64Array([-1, 0, 0, 1, 0, 0]),
      stepMinutes: 60,
      ids: Float64Array.from({ length: total }, (_, index) => index + 1),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      epsilon: 0.001,
      maxDistance: 15,
    };
    const admitted: Array<[number, number]> = [];

    const result = await runSun(index, spec, {
      onCandidates: (candidates, placements) => admitted.push([candidates, placements]),
    });

    expect(admitted).toEqual([[1, total], [0, total]]);
    expect(raycastFirst).toHaveBeenCalledOnce();
    expect(getBoundingBox).toHaveBeenCalledOnce();
    expect(result.exposure[0]).toBe(1);
  });

  it("rejects malformed direct specs before touching the geometry index", async () => {
    const worldBounds = vi.fn();
    const bvhPlacements = vi.fn();
    const emptyIndex = { revision: 1, worldBounds, bvhPlacements } as unknown as GeometryIndex;
    const valid: SunSpec = {
      points: new Float64Array([0, 0, 0]),
      directions: new Float64Array([-1, 0, 0]),
      stepMinutes: 60,
      ids: new Float64Array(),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      epsilon: 0.001,
      maxDistance: 10,
    };
    const invalid: SunSpec[] = [
      { ...valid, points: new Float64Array() },
      { ...valid, points: new Float64Array([0, 0, 0, 1]) },
      { ...valid, points: new Float64Array([0, Number.NaN, 0]) },
      { ...valid, directions: new Float64Array() },
      { ...valid, directions: new Float64Array([-1, 0, 0, 1]) },
      { ...valid, directions: new Float64Array([0, 0, 0]) },
      { ...valid, directions: new Float64Array([Number.POSITIVE_INFINITY, 0, 0]) },
      { ...valid, stepMinutes: 0 },
      { ...valid, stepMinutes: Number.NaN },
      { ...valid, ids: new Float64Array([1.5]) },
      { ...valid, ids: new Float64Array([Number.NaN]) },
      { ...valid, ids: new Float64Array([Number.MAX_SAFE_INTEGER + 1]) },
      { ...valid, modelOrigin: [0, Number.NaN, 0] },
      { ...valid, offsets: new Float64Array([0, 0, 0]) },
      { ...valid, transforms: new Float64Array([0, 0, 0, 0, 0]) },
      { ...valid, transforms: new Float64Array([0, 0, 0, 0, 0, 0]) },
      { ...valid, epsilon: 0 },
      { ...valid, maxDistance: Number.POSITIVE_INFINITY },
      { ...valid, epsilon: 1, maxDistance: 0.5 },
    ];

    for (const spec of invalid) await expect(runSun(emptyIndex, spec)).rejects.toThrow(/sun/);
    expect(worldBounds).not.toHaveBeenCalled();
    expect(bvhPlacements).not.toHaveBeenCalled();
  });

  it("normalizes a non-zero direction too small for squared-length normalization", async () => {
    const raycastFirst = vi.fn(() => ({ point: new Vector3(1.5, 0.5, 0.5), distance: 1.5 }));
    const tinyIndex = {
      revision: 4,
      worldBounds: () => ({ min: [1, 0, 0], max: [2, 1, 1] }),
      bvhPlacements: () => [{
        matrix: new Float64Array(new Matrix4().elements),
        positions: new Float32Array(),
        indices: new Uint32Array(),
        bvh: {
          getBoundingBox: (target: Box3) => target.set(new Vector3(1, 0, 0), new Vector3(2, 1, 1)),
          raycastFirst,
        },
      }],
    } as unknown as GeometryIndex;
    const spec: SunSpec = {
      points: new Float64Array([0, 0.5, 0.5]),
      directions: new Float64Array([-Number.MIN_VALUE, 0, 0]),
      stepMinutes: 60,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      epsilon: 0.001,
      maxDistance: 10,
    };

    const result = await runSun(tinyIndex, spec);

    expect(raycastFirst).toHaveBeenCalledOnce();
    expect(result.exposure[0]).toBe(0);
  });
});
