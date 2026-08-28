import { describe, expect, it } from "vitest";
import { runSectionContours } from "../src/geometry/sectionQuery.js";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";

function mesh(
  id: number,
  positions: number[],
  indices: number[],
  at: [number, number, number] = [0, 0, 0],
): IfcMesh {
  const xs = positions.filter((_, index) => index % 3 === 0);
  const ys = positions.filter((_, index) => index % 3 === 1);
  const zs = positions.filter((_, index) => index % 3 === 2);
  return {
    expressID: id,
    ifcType: "IfcBuildingElementProxy",
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(indices),
    },
    geometryID: id,
    localBounds: {
      min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
      max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
    },
  };
}

function boxMesh(id: number, at: [number, number, number] = [0, 0, 0]): IfcMesh {
  const positions: number[] = [];
  for (let index = 0; index < 8; index++) {
    positions.push(index & 1 ? 1 : -1, index & 2 ? 1 : -1, index & 4 ? 1 : -1);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  return mesh(id, positions, quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]), at);
}

function indexed(meshes: IfcMesh[]): GeometryIndex {
  const index = new GeometryIndex();
  const store = new TriangleStore();
  store.connect({
    chunk: (chunk) => index.addChunk(chunk),
    dropModel: (model) => index.dropModel(model),
    clear: () => index.clear(),
    dispose: () => index.clear(),
  });
  store.add(meshes, 0);
  return index;
}

describe("section contours", () => {
  it("stitches a box slice into one closed element-owned loop", async () => {
    const index = indexed([boxMesh(1)]);
    const result = await runSectionContours(index, {
      axis: "y",
      offset: 0,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });

    expect(result).toMatchObject({
      axis: "y",
      offset: 0,
      segmentCount: 8,
      closedCount: 1,
      openCount: 0,
      fidelity: "mesh",
      engine: "browser-section",
      truncated: false,
    });
    expect(result.polylines).toHaveLength(1);
    expect(result.polylines[0]).toMatchObject({ elementId: 1, closed: true });
    expect(result.polylines[0].points).toHaveLength(4);
    expect(result.polylines[0].length).toBeCloseTo(8);
    expect(result.bounds).toEqual({ min: [-1, -1], max: [1, 1] });
  });

  it("keeps open surfaces open and applies placement transforms", async () => {
    const triangle = mesh(2, [-1, -1, 0, 1, 1, 0, 1, -1, 0], [0, 1, 2], [4, 0, 3]);
    const result = await runSectionContours(indexed([triangle]), {
      axis: "y",
      offset: 0,
      ids: new Float64Array([2]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });

    expect(result.openCount).toBe(1);
    expect(result.polylines[0].points).toEqual([[4, 3], [5, 3]]);
  });

  it("stops open paths at non-manifold branch nodes", async () => {
    const branch = mesh(4, [
      -1, 0, 0, 0, 0, 0, -0.5, 1, 0,
      0, 0, 0, 1, 0, 0, 0.5, 1, 0,
      0, 0, 0, 0, 0, 1, 0, 1, 0.5,
    ], [0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const result = await runSectionContours(indexed([branch]), {
      axis: "y",
      offset: 0,
      ids: new Float64Array([4]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });

    expect(result.openCount).toBe(3);
    expect(result.polylines.every((line) => line.points.length === 2)).toBe(true);
  });

  it("bounds work, reports partial output, and cancels cooperatively", async () => {
    const index = indexed([boxMesh(1), boxMesh(2, [5, 0, 0])]);
    const spec = {
      axis: "y" as const,
      offset: 0,
      ids: new Float64Array([1, 2]),
      modelOrigin: [0, 0, 0] as [number, number, number],
      offsets: new Float64Array(),
      maxSegments: 2,
    };
    const partial = await runSectionContours(index, spec);
    expect(partial.truncated).toBe(true);
    expect(partial.segmentCount).toBe(2);
    await expect(runSectionContours(index, spec, { cancelled: () => true })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("yields inside one large mesh before observing cancellation", async () => {
    const triangleCount = 4_100;
    const repeated = Array.from({ length: triangleCount }, () => [0, 1, 2]).flat();
    const large = mesh(3, [-1, -1, 0, 1, 1, 0, 1, -1, 0], repeated);
    let cancelled = false;
    let yields = 0;
    await expect(runSectionContours(indexed([large]), {
      axis: "y",
      offset: 0,
      ids: new Float64Array([3]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    }, {
      cancelled: () => cancelled,
      yieldTurn: async () => {
        yields += 1;
        cancelled = true;
      },
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(1);
  });
});
