import { describe, expect, it } from "vitest";
import { runClassifyPlane } from "../src/geometry/planeQuery.js";
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

describe("classify by plane", () => {
  it("splits elements into kept and dropped sides", async () => {
    const index = indexed([boxMesh(1), boxMesh(2, [10, 0, 0])]);
    const result = await runClassifyPlane(index, {
      normal: [1, 0, 0],
      constant: -5,
      ids: new Float64Array([1, 2]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({
      kept: [2], cut: [], dropped: [1],
      testedElements: 2, missing: 0,
      fidelity: "mesh", engine: "browser-plane",
    });
  });

  it("accepts an unnormalized normal", async () => {
    const index = indexed([boxMesh(1), boxMesh(2, [10, 0, 0])]);
    const result = await runClassifyPlane(index, {
      normal: [2, 0, 0],
      constant: -10,
      ids: new Float64Array([1, 2]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({ kept: [2], cut: [], dropped: [1] });
  });

  it("marks straddling elements as cut", async () => {
    const index = indexed([boxMesh(1), boxMesh(2, [10, 0, 0])]);
    const result = await runClassifyPlane(index, {
      normal: [1, 0, 0],
      constant: 0,
      ids: new Float64Array([1, 2]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({ kept: [2], cut: [1], dropped: [] });
  });

  it("refines conservative bounds of a rotated model with the vertex pass", async () => {
    // Plan rotation about Y: the local box corner (0, 0, 2) swings to
    // x -1.41 while every actual vertex stays at x >= 0, so the AABB
    // straddles the plane and only the vertex pass can keep the element.
    const triangle = mesh(1, [0, 0, 0, 2, 0, 2, 2, 0, 0], [0, 1, 2]);
    const result = await runClassifyPlane(indexed([triangle]), {
      normal: [1, 0, 0],
      constant: 0.7,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      transforms: new Float64Array([0, 0, 0, 0, -Math.PI / 4, 1]),
    });
    expect(result).toMatchObject({ kept: [1], cut: [], dropped: [] });
  });

  it("keeps an element whose face lies exactly on the plane", async () => {
    const result = await runClassifyPlane(indexed([boxMesh(1)]), {
      normal: [1, 0, 0],
      constant: 1,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({ kept: [1], cut: [], dropped: [] });
  });

  it("keeps an element entirely inside the epsilon slab", async () => {
    const flat = mesh(1, [-1, -1, 0, 1, 1, 0, 1, -1, 0], [0, 1, 2]);
    const result = await runClassifyPlane(indexed([flat]), {
      normal: [0, 0, 1],
      constant: 0,
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
      epsilon: 0.1,
    });
    expect(result).toMatchObject({ kept: [1], cut: [], dropped: [] });
  });

  it("drops an element cut by each plane alone but excluded by their conjunction", async () => {
    // A diagonal beam along x + y = -5: the x > 0 plane and the y > 0 plane
    // each cut it, yet no vertex satisfies both, so the render clips it fully.
    const beam = mesh(1, [-10, 5, 0, 5, -10, 0, -2.5, -2.5, 3], [0, 1, 2]);
    const base = {
      ids: new Float64Array([1]),
      modelOrigin: [0, 0, 0] as [number, number, number],
      offsets: new Float64Array(),
    };
    const planeX = { normal: [1, 0, 0] as [number, number, number], constant: 0 };
    const planeY = { normal: [0, 1, 0] as [number, number, number], constant: 0 };
    const byX = await runClassifyPlane(indexed([beam]), { ...base, ...planeX });
    const byY = await runClassifyPlane(indexed([beam]), { ...base, ...planeY });
    expect(byX).toMatchObject({ kept: [], cut: [1], dropped: [] });
    expect(byY).toMatchObject({ kept: [], cut: [1], dropped: [] });
    const both = await runClassifyPlane(indexed([beam]), { ...base, ...planeX, planes: [planeX, planeY] });
    expect(both).toMatchObject({ kept: [], cut: [], dropped: [1] });
  });

  it("keeps a genuine two-plane cut that leaves a corner region as cut", async () => {
    const planes = [
      { normal: [1, 0, 0] as [number, number, number], constant: 0 },
      { normal: [0, 1, 0] as [number, number, number], constant: 0 },
    ];
    const result = await runClassifyPlane(indexed([boxMesh(1), boxMesh(2, [5, 5, 0]), boxMesh(3, [5, -5, 0])]), {
      normal: planes[0].normal,
      constant: planes[0].constant,
      planes,
      ids: new Float64Array([1, 2, 3]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({ kept: [2], cut: [1], dropped: [3] });
  });

  it("counts unknown ids as missing and cancels cooperatively", async () => {
    const index = indexed([boxMesh(1)]);
    const spec = {
      normal: [1, 0, 0] as [number, number, number],
      constant: 0,
      ids: new Float64Array([1, 99]),
      modelOrigin: [0, 0, 0] as [number, number, number],
      offsets: new Float64Array(),
    };
    const result = await runClassifyPlane(index, spec);
    expect(result).toMatchObject({ missing: 1, testedElements: 1 });
    await expect(runClassifyPlane(index, spec, { cancelled: () => true })).rejects.toMatchObject({ name: "AbortError" });
  });
});
