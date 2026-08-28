import { describe, expect, it } from "vitest";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import type { TriangleChunk } from "../src/viewer-core/scene/triangleStore.js";

type Bounds = [number, number, number, number, number, number];

interface PlacementSpec {
  id: number;
  geometryID: number;
  matrix: number[];
}

function matrixAt(x: number, y: number, z: number): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
}

function chunk(
  geometries: Array<{ id: number; bounds: Bounds }>,
  placements: PlacementSpec[],
): TriangleChunk {
  return {
    model: 0,
    geometryIDs: Uint32Array.from(geometries, ({ id }) => id),
    vertexCounts: new Uint32Array(geometries.length),
    indexCounts: new Uint32Array(geometries.length),
    localBounds: Float32Array.from(geometries.flatMap(({ bounds }) => bounds)),
    positions: new Float32Array(0),
    indices: new Uint32Array(0),
    elementIDs: Float64Array.from(placements, ({ id }) => id),
    geometryOf: Uint32Array.from(placements, ({ geometryID }) => geometryID),
    matrices: Float64Array.from(placements.flatMap(({ matrix }) => matrix)),
    types: placements.map(() => "IfcWall"),
  };
}

describe("geometry index world bounds", () => {
  it("reuses transformed bounds across origins and offsets without exposing the cache", () => {
    const index = new GeometryIndex();
    const rotatedAndScaled = [
      0, 2, 0, 0,
      -1, 0, 0, 0,
      0, 0, 1, 0,
      10, -4, 3, 1,
    ];
    index.addChunk(chunk(
      [{ id: 7, bounds: [-1, -2, -3, 4, 5, 6] }],
      [{ id: 1, geometryID: 7, matrix: rotatedAndScaled }],
    ));

    const base = index.worldBounds(1, [0, 0, 0], [0, 0, 0]);
    expect(base).toEqual({ id: 1, min: [5, -6, 0], max: [12, 4, 9] });

    base!.min[0] = 999;
    expect(index.worldBounds(1, [100, -20, 2], [3, 4, -5])).toEqual({
      id: 1,
      min: [-92, 18, -7],
      max: [-85, 28, 2],
    });
    expect(index.worldBounds(1, [0, 0, 0], [0, 0, 0])?.min[0]).toBe(5);
  });

  it("invalidates cached bounds when another placement arrives in a later chunk", () => {
    const index = new GeometryIndex();
    index.addChunk(chunk(
      [{ id: 10, bounds: [-1, -2, -3, 1, 2, 3] }],
      [{ id: 42, geometryID: 10, matrix: matrixAt(10, 0, 0) }],
    ));
    expect(index.worldBounds(42, [0, 0, 0], [0, 0, 0])).toEqual({
      id: 42,
      min: [9, -2, -3],
      max: [11, 2, 3],
    });

    index.addChunk(chunk([], [
      { id: 42, geometryID: 10, matrix: matrixAt(-5, 7, 1) },
    ]));
    expect(index.worldBounds(42, [0, 0, 0], [0, 0, 0])).toEqual({
      id: 42,
      min: [-6, -2, -3],
      max: [11, 9, 4],
    });
  });

  it("invalidates cached bounds when referenced geometry is replaced", () => {
    const index = new GeometryIndex();
    index.addChunk(chunk(
      [{ id: 12, bounds: [0, 0, 0, 1, 1, 1] }],
      [{ id: 8, geometryID: 12, matrix: matrixAt(2, 3, 4) }],
    ));
    expect(index.worldBounds(8, [0, 0, 0], [0, 0, 0])).toEqual({
      id: 8,
      min: [2, 3, 4],
      max: [3, 4, 5],
    });

    index.addChunk(chunk([{ id: 12, bounds: [-4, -3, -2, 6, 5, 4] }], []));
    expect(index.worldBounds(8, [0, 0, 0], [0, 0, 0])).toEqual({
      id: 8,
      min: [-2, 0, 2],
      max: [8, 8, 8],
    });
  });
});
