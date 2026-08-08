import { describe, expect, it, vi } from "vitest";
import { runLaser } from "../src/geometry/laserQuery.js";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";
import { runViewerAction } from "../src/llm/actions.js";

function boxMesh(id: number, size: [number, number, number], at: [number, number, number]): IfcMesh {
  const [sx, sy, sz] = size.map((value) => value / 2) as [number, number, number];
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) positions.push(i & 1 ? sx : -sx, i & 2 ? sy : -sy, i & 4 ? sz : -sz);
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const indices = quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]);
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
    localBounds: { min: { x: -sx, y: -sy, z: -sz }, max: { x: sx, y: sy, z: sz } },
  };
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

describe("three-axis laser", () => {
  it("finds the nearest visible surface in both directions of every axis", async () => {
    const index = indexed([
      boxMesh(1, [0.2, 0.2, 0.2], [0, 0, 0]),
      boxMesh(2, [2, 10, 10], [5, 0, 0]),
      boxMesh(3, [2, 10, 10], [-4, 0, 0]),
      boxMesh(4, [10, 2, 10], [0, 6, 0]),
      boxMesh(5, [10, 2, 10], [0, -3, 0]),
      boxMesh(6, [10, 10, 2], [0, 0, 8]),
      boxMesh(7, [10, 10, 2], [0, 0, -2]),
    ]);
    const result = await runLaser(index, {
      origin: [0.1, 0, 0],
      source: 1,
      ids: new Float64Array([1, 2, 3, 4, 5, 6, 7]),
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
    expect(result.axes[0].negative?.distance).toBeCloseTo(3.1);
    expect(result.axes[0].positive?.distance).toBeCloseTo(3.9);
    expect(result.axes[0].span).toBeCloseTo(7);
    expect(result.axes[1].negative?.distance).toBeCloseTo(2);
    expect(result.axes[1].positive?.distance).toBeCloseTo(5);
    expect(result.axes[2].negative?.distance).toBeCloseTo(1);
    expect(result.axes[2].positive?.distance).toBeCloseTo(7);
    expect(result.sourceNormal).not.toBeNull();
    expect(result).toMatchObject({ source: 1, fidelity: "mesh", engine: "browser-ray", missing: 0 });
  });

  it("honours the visible id set, range, and cancellation", async () => {
    const index = indexed([
      boxMesh(1, [0.2, 0.2, 0.2], [0, 0, 0]),
      boxMesh(2, [2, 10, 10], [5, 0, 0]),
    ]);
    const base = {
      origin: [0.1, 0, 0] as [number, number, number],
      source: 1,
      ids: new Float64Array([1, 2]),
      modelOrigin: [0, 0, 0] as [number, number, number],
      offsets: new Float64Array(),
      maxDistance: 3,
    };
    expect((await runLaser(index, base)).axes[0].positive).toBeNull();
    const hidden = await runLaser(index, { ...base, ids: new Float64Array() });
    expect(hidden.axes.every((axis) => !axis.negative && !axis.positive)).toBe(true);
    await expect(runLaser(index, base, { cancelled: () => true })).rejects.toMatchObject({ name: "AbortError" });
  });

  it("returns typed axis rows and puts reversible witness spans in the viewer", async () => {
    const meshes = [
      boxMesh(1, [0.2, 0.2, 0.2], [0, 0, 0]),
      boxMesh(2, [2, 10, 10], [5, 0, 0]),
      boxMesh(3, [2, 10, 10], [-4, 0, 0]),
      boxMesh(4, [10, 2, 10], [0, 6, 0]),
      boxMesh(5, [10, 2, 10], [0, -3, 0]),
      boxMesh(6, [10, 10, 2], [0, 0, 8]),
      boxMesh(7, [10, 10, 2], [0, 0, -2]),
    ];
    const store = new TriangleStore();
    store.add(meshes, 0);
    const addMeasurement = vi.fn((_a, _b) => ({ id: addMeasurement.mock.calls.length + 1 }));
    const selectMany = vi.fn();
    const fitToPoint = vi.fn();
    const viewer = {
      getTriangles: () => store,
      getSpatialTree: () => null,
      getModels: () => [{ index: 0, offset: [0, 0, 0] }],
      getModelOrigin: () => [0, 0, 0],
      getElementTypes: () => new Map(meshes.map((mesh) => [mesh.expressID, mesh.ifcType])),
      isElementVisible: () => true,
      getLastPick: () => ({ expressID: 1, point: [0.1, 0, 0] }),
      addMeasurement,
      selectMany,
      fitToPoint,
    } as unknown as Viewer;
    const report = JSON.parse(await runViewerAction(viewer, JSON.stringify({ action: "laser" })));

    expect(report.rows).toHaveLength(6);
    expect(report.axes).toEqual([
      { axis: "x", negativeMm: 3100, positiveMm: 3900, spanMm: 7000 },
      { axis: "y", negativeMm: 2000, positiveMm: 5000, spanMm: 7000 },
      { axis: "z", negativeMm: 1000, positiveMm: 7000, spanMm: 8000 },
    ]);
    expect(addMeasurement).toHaveBeenCalledTimes(3);
    expect(selectMany).toHaveBeenCalledWith([1, 3, 2, 5, 4, 7, 6], "replace");
    expect(fitToPoint).toHaveBeenCalledOnce();
  });
});
