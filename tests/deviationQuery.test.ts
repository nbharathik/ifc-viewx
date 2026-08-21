import { describe, expect, it, vi } from "vitest";
import { Box3, Matrix4, Vector3 } from "three";

import type { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { runDeviation } from "../src/geometry/deviationQuery.js";
import type { DeviationSpec } from "../src/geometry/types.js";

const localBox = (target: Box3): Box3 => target.set(
  new Vector3(0, 0, 0),
  new Vector3(1, 1, 1),
);

const placement = (matrix: Matrix4, closest: (point: Vector3) => Vector3) => ({
  matrix: new Float64Array(matrix.elements),
  positions: new Float32Array(),
  indices: new Uint32Array(),
  bvh: {
    getBoundingBox: localBox,
    closestPointToPoint: (point: Vector3) => ({ point: closest(point), distance: 0 }),
  },
});

const spec = (points: number[], ids: number[], patch: Partial<DeviationSpec> = {}): DeviationSpec => ({
  points: Float64Array.from(points),
  ids: Float64Array.from(ids),
  modelOrigin: [0, 0, 0],
  offsets: new Float64Array(),
  maxDistance: 1,
  ...patch,
});

describe("deviation spatial broad phase", () => {
  it("admits only nearby placements from a large, dispersed model", async () => {
    const total = 4_000;
    const closest = vi.fn((point: Vector3) => point.clone());
    const index = {
      revision: 8,
      worldBounds: (id: number) => ({
        id,
        min: [id * 10, 0, 0] as [number, number, number],
        max: [id * 10 + 1, 1, 1] as [number, number, number],
      }),
      bvhPlacements: (id: number) => [placement(new Matrix4().makeTranslation(id * 10, 0, 0), closest)],
    } as unknown as GeometryIndex;
    const candidateCounts: Array<[number, number]> = [];

    const result = await runDeviation(
      index,
      spec([10.5, 0.5, 0.5], Array.from({ length: total }, (_, index) => index + 1), { maxDistance: 0.75 }),
      { onCandidates: (candidates, placements) => candidateCounts.push([candidates, placements]) },
    );

    expect(candidateCounts).toEqual([[1, total]]);
    expect(closest).toHaveBeenCalledOnce();
    expect(result.measured).toBe(1);
    expect(result.elements[0]).toBe(1);
    expect(result.distances[0]).toBe(0);
  });

  it("indexes each transformed placement rather than its element's union box", async () => {
    const closest = vi.fn((point: Vector3) => point.clone());
    const index = {
      revision: 1,
      worldBounds: () => ({
        id: 1,
        min: [0, 0, 0] as [number, number, number],
        max: [101, 1, 1] as [number, number, number],
      }),
      bvhPlacements: () => [
        placement(new Matrix4(), closest),
        placement(new Matrix4().makeTranslation(100, 0, 0), closest),
      ],
    } as unknown as GeometryIndex;
    const admitted: number[] = [];

    const result = await runDeviation(index, spec([50, 0.5, 0.5], [1]), {
      onCandidates: (candidates) => admitted.push(candidates),
    });

    expect(admitted).toEqual([0]);
    expect(closest).not.toHaveBeenCalled();
    expect(result.measured).toBe(0);
    expect(Number.isNaN(result.distances[0])).toBe(true);
  });

  it("keeps an oversized site placement queryable without filling the grid", async () => {
    const closest = vi.fn((point: Vector3) => ({ point: point.clone(), distance: 0 }));
    const huge = {
      matrix: new Float64Array(new Matrix4().elements),
      positions: new Float32Array(),
      indices: new Uint32Array(),
      bvh: {
        getBoundingBox: (target: Box3) => target.set(
          new Vector3(-100, -100, -100),
          new Vector3(100, 100, 100),
        ),
        closestPointToPoint: closest,
      },
    };
    const index = {
      revision: 1,
      worldBounds: (id: number) => id === 100
        ? { id, min: [-100, -100, -100], max: [100, 100, 100] }
        : { id, min: [id * 100, 0, 0], max: [id * 100 + 1, 1, 1] },
      bvhPlacements: (id: number) => id === 100
        ? [huge]
        : [placement(new Matrix4().makeTranslation(id * 100, 0, 0), (point) => point.clone())],
    } as unknown as GeometryIndex;

    const result = await runDeviation(index, spec([0, 0, 0], [1, 2, 3, 100]));

    expect(closest).toHaveBeenCalledOnce();
    expect(result.measured).toBe(1);
    expect(result.elements[0]).toBe(100);
  });

  it("keeps deviation and bounds correct through model rotation and scale", async () => {
    const bvh = {
      getBoundingBox: (target: Box3) => target.set(
        new Vector3(1, -1, -1),
        new Vector3(1, 1, 1),
      ),
      closestPointToPoint: (point: Vector3) => ({
        point: new Vector3(1, point.y, point.z),
        distance: Math.abs(point.x - 1),
      }),
    };
    const index = {
      revision: 2,
      worldBounds: () => ({
        id: 1,
        min: [8, -2, 18] as [number, number, number],
        max: [12, 2, 18] as [number, number, number],
      }),
      bvhPlacements: () => [{
        matrix: new Float64Array(new Matrix4().elements),
        positions: new Float32Array(),
        indices: new Uint32Array(),
        bvh,
      }],
    } as unknown as GeometryIndex;

    const result = await runDeviation(index, spec([10, 0, 17.5], [1], {
      transforms: new Float64Array([0, 10, 0, 20, Math.PI / 2, 2]),
    }));

    expect(result.measured).toBe(1);
    expect(result.elements[0]).toBe(1);
    expect(result.distances[0]).toBeCloseTo(0.5, 6);
  });
});
