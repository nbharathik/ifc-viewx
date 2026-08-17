import { describe, expect, it } from "vitest";
import { exportMesh } from "../src/export/mesh.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh, SpatialNode } from "../src/viewer-core/engine/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

/** A unit cube at `at`, 12 triangles, one geometry per element. */
function boxMesh(id: number, at: [number, number, number] = [0, 0, 0], type = "IfcWall"): IfcMesh {
  const positions: number[] = [];
  for (let corner = 0; corner < 8; corner++) {
    positions.push(corner & 1 ? 1 : -1, corner & 2 ? 1 : -1, corner & 4 ? 1 : -1);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  return {
    expressID: id,
    ifcType: type,
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d])),
    },
    geometryID: id,
    localBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
  };
}

interface FakeOptions {
  hidden?: number[];
  selected?: number[];
  guids?: Record<number, string>;
}

function fakeViewer(meshes: IfcMesh[], options: FakeOptions = {}) {
  const store = new TriangleStore();
  store.add(meshes, 0);
  const hidden = new Set(options.hidden ?? []);
  const types = new Map(meshes.map((mesh) => [mesh.expressID, mesh.ifcType]));
  const tree: SpatialNode = {
    expressID: 900, type: "IfcBuildingStorey", name: "Level 1",
    children: meshes.map((mesh) => ({ expressID: mesh.expressID, type: mesh.ifcType, name: `E${mesh.expressID}`, children: [] })),
  };
  return {
    getTriangles: () => store,
    getModelOrigin: () => [0, 0, 0] as [number, number, number],
    getModels: () => [{
      index: 0, name: "tower.ifc", visible: true, offset: [0, 0, 0] as [number, number, number],
      transform: { translation: [0, 0, 0] as [number, number, number], rotationZ: 0, scale: 1, source: "none" as const },
    }],
    getElementTypes: () => types,
    getSpatialTree: () => tree,
    getSelectedIds: () => options.selected ?? [],
    hasGeometry: (id: number) => types.has(id),
    isElementVisible: (id: number) => !hidden.has(id),
    getProperties: (id: number) => Promise.resolve({
      expressID: id,
      type: types.get(id) ?? "",
      attributes: [{ name: "GlobalId", value: options.guids?.[id] ?? null }],
      psets: [], classifications: [], materials: [],
    }),
  } as unknown as Viewer;
}

describe("exportMesh", () => {
  it("writes every element as a named OBJ object", async () => {
    const viewer = fakeViewer([boxMesh(1), boxMesh(2, [5, 0, 0], "IfcSlab")], {
      guids: { 1: "0GUID000000000000000A1" },
    });
    const result = await exportMesh(viewer, "obj");
    const text = await result.blob.text();
    expect(result).toMatchObject({ elements: 2, triangles: 24, truncated: false, fileName: "tower.obj" });
    expect(text).toContain("o 0GUID000000000000000A1");
    expect(text).toContain("o 2");
    expect(text.match(/^v /gm)).toHaveLength(16);
    expect(text.match(/^f /gm)).toHaveLength(24);
  });

  it("bakes the placement matrix into scene space", async () => {
    const viewer = fakeViewer([boxMesh(1, [10, 0, 0])]);
    const text = await (await exportMesh(viewer, "obj")).blob.text();
    const xs = [...text.matchAll(/^v (-?[\d.]+) /gm)].map((match) => Number(match[1]));
    expect(Math.min(...xs)).toBeCloseTo(9);
    expect(Math.max(...xs)).toBeCloseTo(11);
  });

  it("scopes to the selection and to visible elements", async () => {
    const meshes = [boxMesh(1), boxMesh(2, [5, 0, 0]), boxMesh(3, [10, 0, 0])];
    const selected = await exportMesh(fakeViewer(meshes, { selected: [2] }), "obj", { selectedOnly: true });
    expect(selected.elements).toBe(1);
    const visible = await exportMesh(fakeViewer(meshes, { hidden: [3] }), "obj", { visibleOnly: true });
    expect(visible.elements).toBe(2);
    const explicit = await exportMesh(fakeViewer(meshes), "obj", { ids: [1, 3] });
    expect(explicit.elements).toBe(2);
  });

  it("writes a binary STL with the right triangle count", async () => {
    const result = await exportMesh(fakeViewer([boxMesh(1), boxMesh(2, [5, 0, 0])]), "stl");
    const bytes = await result.blob.arrayBuffer();
    expect(result.fileName).toBe("tower.stl");
    expect(bytes.byteLength).toBe(84 + 24 * 50);
    expect(new DataView(bytes).getUint32(80, true)).toBe(24);
  });

  it("writes an ASCII STL when asked", async () => {
    const text = await (await exportMesh(fakeViewer([boxMesh(1)]), "stl", { stlBinary: false })).blob.text();
    expect(text.startsWith("solid exported")).toBe(true);
    expect(text.match(/^\s*facet normal /gm)).toHaveLength(12);
  });

  it("writes a glb starting with the glTF magic", async () => {
    const result = await exportMesh(fakeViewer([boxMesh(1)]), "glb");
    const bytes = await result.blob.arrayBuffer();
    expect(result.fileName).toBe("tower.glb");
    expect(bytes.byteLength).toBeGreaterThan(0);
    expect(new DataView(bytes).getUint32(0, true)).toBe(0x46546c67);
    expect(new DataView(bytes).getUint32(4, true)).toBe(2);
  });

  it("writes gltf json carrying the element name and userData", async () => {
    const viewer = fakeViewer([boxMesh(1)], { guids: { 1: "0GUID000000000000000A1" } });
    const text = await (await exportMesh(viewer, "gltf")).blob.text();
    const gltf = JSON.parse(text) as { nodes?: Array<{ name?: string; extras?: Record<string, unknown> }> };
    const node = gltf.nodes?.find((entry) => entry.name === "0GUID000000000000000A1");
    expect(node).toBeTruthy();
    expect(node?.extras).toMatchObject({ ifcType: "IfcWall", storey: "Level 1", modelName: "tower.ifc" });
  });

  it("refuses an empty scope", async () => {
    await expect(exportMesh(fakeViewer([boxMesh(1)], { hidden: [1] }), "obj", { visibleOnly: true }))
      .rejects.toThrow(/Nothing to export/);
  });
});
