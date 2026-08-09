import { bench, describe } from "vitest";
import { SphereGeometry } from "three";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { runLaser } from "../src/geometry/laserQuery.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";

function fixture(count: number): { index: GeometryIndex; ids: Float64Array } {
  const sphere = new SphereGeometry(1, 48, 24);
  const position = sphere.getAttribute("position");
  const sourceIndex = sphere.getIndex();
  const positions = new Float32Array(position.array);
  const indices = sourceIndex
    ? new Uint32Array(sourceIndex.array)
    : new Uint32Array(Array.from({ length: position.count }, (_, index) => index));
  sphere.dispose();
  const normals = new Float32Array(positions.length);
  const meshes: IfcMesh[] = [];
  for (let id = 1; id <= count; id++) {
    meshes.push({
      expressID: id,
      ifcType: "IfcBuildingElementProxy",
      color: { r: 1, g: 1, b: 1, a: 1 },
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, id * 3, 0, 0, 1],
      geometry: { positions, indices, normals },
      geometryID: 1,
      localBounds: { min: { x: -1, y: -1, z: -1 }, max: { x: 1, y: 1, z: 1 } },
    });
  }
  const index = new GeometryIndex();
  const store = new TriangleStore();
  store.connect({
    chunk: (chunk) => index.addChunk(chunk),
    dropModel: (model) => index.dropModel(model),
    clear: () => index.clear(),
    dispose: () => index.clear(),
  });
  store.add(meshes, 0);
  return { index, ids: new Float64Array(meshes.map((mesh) => mesh.expressID)) };
}

const scene = fixture(100);

describe("axis laser throughput", () => {
  bench("100 instanced 2,208-triangle meshes", async () => {
    await runLaser(scene.index, {
      origin: [0, 0, 0],
      ids: scene.ids,
      modelOrigin: [0, 0, 0],
      offsets: new Float64Array(),
    });
  }, { iterations: 8, warmupIterations: 2 });
});
