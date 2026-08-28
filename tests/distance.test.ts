import { describe, expect, it, vi } from "vitest";
import { runDistance } from "../src/geometry/distanceQuery.js";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { geometryService } from "../src/geometry/service.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";
import { runViewerAction } from "../src/llm/actions.js";

function boxMesh(
  expressID: number,
  size: [number, number, number],
  at: [number, number, number],
): IfcMesh {
  const [sx, sy, sz] = size.map((value) => value / 2) as [number, number, number];
  const positions: number[] = [];
  for (let i = 0; i < 8; i++) {
    positions.push(i & 1 ? sx : -sx, i & 2 ? sy : -sy, i & 4 ? sz : -sz);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return {
    expressID,
    ifcType: "IfcBuildingElementProxy",
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(indices),
    },
    geometryID: expressID,
    localBounds: { min: { x: -sx, y: -sy, z: -sz }, max: { x: sx, y: sy, z: sz } },
  };
}

function indexOf(meshes: IfcMesh[]): GeometryIndex {
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

const spec = (a: number, b: number, maxDistance?: number) => ({
  a,
  b,
  origin: [0, 0, 0] as [number, number, number],
  offsets: new Float64Array(0),
  maxDistance,
});

describe("geometry distance", () => {
  it("returns the shortest surface distance and both witness points", async () => {
    const index = indexOf([
      boxMesh(1, [2, 2, 2], [0, 0, 0]),
      boxMesh(2, [2, 2, 2], [5, 0, 0]),
    ]);
    const result = await runDistance(index, spec(1, 2));
    expect(result.distance).toBeCloseTo(3);
    expect(result.pointA?.[0]).toBeCloseTo(1);
    expect(result.pointB?.[0]).toBeCloseTo(4);
    expect(result.point?.[0]).toBeCloseTo(2.5);
    expect(result.intersecting).toBe(false);
    expect(result).toMatchObject({ fidelity: "mesh", engine: "browser-bvh", geometryRevision: 1 });
  });

  it("reports intersecting solids as zero distance", async () => {
    const index = indexOf([
      boxMesh(1, [2, 2, 2], [0, 0, 0]),
      boxMesh(2, [2, 2, 2], [1, 0, 0]),
    ]);
    const result = await runDistance(index, spec(1, 2));
    expect(result.distance).toBe(0);
    expect(result.intersecting).toBe(true);
    expect(result.pointA).toEqual(result.pointB);
  });

  it("honours a bounded search and reports missing mesh data", async () => {
    const index = indexOf([
      boxMesh(1, [2, 2, 2], [0, 0, 0]),
      boxMesh(2, [2, 2, 2], [5, 0, 0]),
    ]);
    expect((await runDistance(index, spec(1, 2, 2))).distance).toBeNull();
    const missing = await runDistance(index, spec(1, 99));
    expect(missing.missing).toBe(1);
    expect(missing.distance).toBeNull();
  });

  it("shares one lazy service per viewer", () => {
    const store = new TriangleStore();
    const viewer = { getTriangles: () => store } as unknown as Viewer;
    expect(geometryService(viewer)).toBe(geometryService(viewer));
    expect(geometryService(viewer).active).toBe(false);
  });

  it("puts an assistant distance result back into the viewer", async () => {
    const store = new TriangleStore();
    store.add([
      boxMesh(1, [2, 2, 2], [0, 0, 0]),
      boxMesh(2, [2, 2, 2], [5, 0, 0]),
    ], 0);
    const selectMany = vi.fn();
    const addMeasurement = vi.fn(() => ({ id: 42 }));
    const fitToPoint = vi.fn();
    const viewer = {
      getTriangles: () => store,
      getModels: () => [{ index: 0, offset: [0, 0, 0] }],
      getModelOrigin: () => [0, 0, 0],
      getSpatialTree: () => null,
      selectMany,
      addMeasurement,
      fitToPoint,
    } as unknown as Viewer;
    const report = JSON.parse(await runViewerAction(
      viewer,
      JSON.stringify({ action: "distance", a: 1, b: 2 }),
    ));
    expect(report).toMatchObject({ distanceMm: 3000, measurementId: 42 });
    expect(selectMany).toHaveBeenCalledWith([1, 2], "replace");
    expect(addMeasurement).toHaveBeenCalledOnce();
    expect(fitToPoint).toHaveBeenCalledOnce();
  });
});
