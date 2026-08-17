import { describe, expect, it, vi } from "vitest";
import { runVolumes } from "../src/geometry/volumeQuery.js";
import { GeometryIndex } from "../src/geometry/geometryIndex.js";
import { geometryService } from "../src/geometry/service.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

function mesh(
  id: number,
  positions: number[],
  indices: number[],
  at: [number, number, number] = [0, 0, 0],
  matrix?: number[],
): IfcMesh {
  const xs = positions.filter((_, index) => index % 3 === 0);
  const ys = positions.filter((_, index) => index % 3 === 1);
  const zs = positions.filter((_, index) => index % 3 === 2);
  return {
    expressID: id,
    ifcType: "IfcBuildingElementProxy",
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: matrix ?? [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
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

function boxMesh(id: number, at: [number, number, number] = [0, 0, 0], matrix?: number[]): IfcMesh {
  const positions: number[] = [];
  for (let index = 0; index < 8; index++) {
    positions.push(index & 1 ? 1 : -1, index & 2 ? 1 : -1, index & 4 ? 1 : -1);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  return mesh(id, positions, quads.flatMap(([a, b, c, d]) => [a, b, c, a, c, d]), at, matrix);
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

describe("volumes", () => {
  it("measures a closed box in cubic metres", async () => {
    const result = await runVolumes(indexed([boxMesh(1)]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
    });
    expect(result).toMatchObject({ missing: 0, fidelity: "mesh", engine: "browser-volume" });
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toMatchObject({ id: 1, triangles: 12, closed: true });
    expect(result.volumes[0].volume).toBeCloseTo(8);
  });

  it("applies the model scale cubed", async () => {
    const result = await runVolumes(indexed([boxMesh(1)]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
      transforms: new Float64Array([0, 0, 0, 0, 0, 2]),
    });
    expect(result.volumes[0].volume).toBeCloseTo(64);
  });

  it("keeps a mirrored placement positive", async () => {
    const mirrored = boxMesh(1, [0, 0, 0], [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]);
    const result = await runVolumes(indexed([mirrored]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
    });
    expect(result.volumes[0].volume).toBeCloseTo(8);
  });

  it("sums multiple placements of one element", async () => {
    const second = boxMesh(1, [10, 0, 0]);
    second.geometryID = 2;
    const result = await runVolumes(indexed([boxMesh(1), second]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
    });
    expect(result.volumes).toHaveLength(1);
    expect(result.volumes[0]).toMatchObject({ id: 1, triangles: 24, closed: true });
    expect(result.volumes[0].volume).toBeCloseTo(16);
  });

  it("marks a box with one inverted face as not closed", async () => {
    const flipped = boxMesh(1);
    const indices = flipped.geometry.indices;
    for (let t = indices.length - 6; t < indices.length; t += 3) {
      const swap = indices[t + 1];
      indices[t + 1] = indices[t + 2];
      indices[t + 2] = swap;
    }
    const result = await runVolumes(indexed([flipped]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
    });
    expect(result.volumes[0]).toMatchObject({ id: 1, triangles: 12, closed: false });
  });

  it("marks open meshes as not closed", async () => {
    const triangle = mesh(2, [-1, -1, 0, 1, 1, 0, 1, -1, 0], [0, 1, 2]);
    const result = await runVolumes(indexed([triangle]), {
      ids: new Float64Array([2]),
      offsets: new Float64Array(),
    });
    expect(result.volumes[0]).toMatchObject({ id: 2, triangles: 1, closed: false });
  });

  it("counts unknown ids as missing", async () => {
    const result = await runVolumes(indexed([boxMesh(1)]), {
      ids: new Float64Array([1, 99]),
      offsets: new Float64Array(),
    });
    expect(result.volumes).toHaveLength(1);
    expect(result.missing).toBe(1);
  });

  it("cancels cooperatively", async () => {
    await expect(runVolumes(indexed([boxMesh(1)]), {
      ids: new Float64Array([1]),
      offsets: new Float64Array(),
    }, { cancelled: () => true })).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("geometry service inline cancellation", () => {
  function fastClock() {
    let tick = 0;
    return vi.spyOn(performance, "now").mockImplementation(() => (tick += 10));
  }

  function inlineService(store: TriangleStore) {
    return geometryService({ getTriangles: () => store } as unknown as Viewer);
  }

  async function started(service: { active: boolean }): Promise<void> {
    while (!service.active) await new Promise((resolve) => setTimeout(resolve, 1));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }

  it("aborts an in-flight inline volumes run when the geometry clears", async () => {
    const clock = fastClock();
    try {
      const store = new TriangleStore();
      store.add([boxMesh(1)], 0);
      const service = inlineService(store);
      const running = service.volumes({ ids: new Float64Array(200).fill(1), offsets: new Float64Array() });
      await started(service);
      await service.distance({
        a: 90, b: 91,
        origin: [0, 0, 0] as [number, number, number],
        offsets: new Float64Array(0),
      });
      store.clear();
      await expect(running).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      clock.mockRestore();
    }
  });

  it("leaves an inline volumes run alone when the clash is cancelled", async () => {
    const clock = fastClock();
    try {
      const store = new TriangleStore();
      store.add([boxMesh(1)], 0);
      const service = inlineService(store);
      const running = service.volumes({ ids: new Float64Array(40).fill(1), offsets: new Float64Array() });
      await started(service);
      service.cancelClash();
      const result = await running;
      expect(result.volumes).toHaveLength(40);
      expect(result.volumes[0]).toMatchObject({ id: 1, closed: true });
    } finally {
      clock.mockRestore();
    }
  });
});
