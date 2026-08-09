import { describe, expect, it } from "vitest";
import { compareSnapshots, type CompareSnapshot } from "../src/compare/modelCompare.js";
import { GeometrySignatureBuilder } from "../src/geometry/signature.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";

const identity = (x = 0, y = 0, z = 0): number[] => [
  1, 0, 0, 0,
  0, 1, 0, 0,
  0, 0, 1, 0,
  x, y, z, 1,
];

function mesh(id: number, positions: number[], matrix = identity()): IfcMesh {
  const xs = positions.filter((_, index) => index % 3 === 0);
  const ys = positions.filter((_, index) => index % 3 === 1);
  const zs = positions.filter((_, index) => index % 3 === 2);
  return {
    expressID: id,
    ifcType: "IfcWall",
    geometryID: id,
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix,
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array([0, 1, 2]),
    },
    localBounds: {
      min: { x: Math.min(...xs), y: Math.min(...ys), z: Math.min(...zs) },
      max: { x: Math.max(...xs), y: Math.max(...ys), z: Math.max(...zs) },
    },
  };
}

function signature(value: IfcMesh) {
  const builder = new GeometrySignatureBuilder();
  builder.addMesh(value);
  return builder.finish()[0];
}

function row(overrides: Partial<CompareSnapshot> = {}): CompareSnapshot {
  return {
    globalId: "wall-guid",
    id: 1,
    type: "IfcWall",
    name: "Wall",
    storey: "Level 1",
    values: { Status: "Existing" },
    ...overrides,
  };
}

describe("geometry-aware model compare", () => {
  it("keeps shape identity independent from world translation", () => {
    const positions = [0, 0, 0, 2, 0, 0, 0, 3, 0];
    const before = signature(mesh(1, positions));
    const after = signature(mesh(1, positions, identity(4, 2, -1)));
    expect(after.shapeHash).toBe(before.shapeHash);
    expect(after.translation).toEqual([4, 2, -1]);
    expect(after.bounds.min).toEqual([4, 2, -1]);
  });

  it("classifies a pure placement change without calling it a shape change", () => {
    const positions = [0, 0, 0, 2, 0, 0, 0, 3, 0];
    const result = compareSnapshots(
      [row({ geometry: signature(mesh(1, positions, identity(0.5, 0, 0))) })],
      [row({ geometry: signature(mesh(1, positions)) })],
    );
    expect(result.entries[0]).toMatchObject({ kind: "placement", categories: ["placement"] });
    expect(result.entries[0].geometry?.translationDistance).toBeCloseTo(0.5);
    expect(result.entries[0].geometry?.shapeChanged).toBe(false);
  });

  it("keeps mixed geometry, level and property changes explicit", () => {
    const before = signature(mesh(1, [0, 0, 0, 2, 0, 0, 0, 3, 0]));
    const after = signature(mesh(1, [0, 0, 0, 4, 0, 0, 0, 3, 0]));
    const result = compareSnapshots(
      [row({ storey: "Level 2", values: { Status: "New" }, geometry: after })],
      [row({ geometry: before })],
    );
    expect(result.entries[0]).toMatchObject({
      kind: "mixed",
      categories: ["geometry", "containment", "properties"],
    });
    expect(result.entries[0].changes).toEqual([{ key: "Status", from: "Existing", to: "New" }]);
  });

  it("reports additions, removals and missing geometry completeness", () => {
    const result = compareSnapshots(
      [row({ globalId: "added" }), row({ globalId: "same", id: 2 })],
      [row({ globalId: "removed", id: 3 }), row({ globalId: "same", id: 4 })],
    );
    expect(result.counts).toMatchObject({ added: 1, removed: 1, unchanged: 1 });
    expect(result.geometryCompared).toBe(0);
    expect(result.geometryMissing).toBe(1);
  });
});
