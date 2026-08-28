import { describe, expect, it } from "vitest";
import { ModelBatcher, packNormalBuffer } from "../src/viewer-core/scene/batcher.js";
import type { IfcMesh } from "../src/viewer-core/engine/types.js";

describe("normalized GPU normal packing", () => {
  it("packs the full signed range and clamps malformed components", () => {
    expect([...packNormalBuffer([-2, -1, -0.5, 0, 0.5, 1, 2, Number.NaN])]).toEqual([
      -32767, -32767, -16383, 0, 16384, 32767, 32767, 0,
    ]);
  });

  it("round-trips unit directions within signed-short precision", () => {
    const source = new Float32Array([0.57735026, -0.70710677, 0.123456]);
    const packed = packNormalBuffer(source);
    for (let i = 0; i < source.length; i++) {
      expect(packed[i] / 32767).toBeCloseTo(source[i], 4);
    }
    expect(packed.byteLength).toBe(source.byteLength / 2);
  });

  it("uploads merged geometry with a normalized signed-short normal attribute", () => {
    const mesh: IfcMesh = {
      expressID: 1,
      geometryID: 1,
      ifcType: "IfcWall",
      color: { r: 0.8, g: 0.8, b: 0.8, a: 1 },
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
      geometry: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      },
      localBounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 } },
    };
    const batcher = new ModelBatcher();
    batcher.ingest([mesh]);
    let normal: import("three").BufferAttribute | null = null;
    batcher.group.traverse((node) => {
      const attribute = (node as import("three").Mesh).geometry?.getAttribute("normal");
      if (attribute) normal = attribute as import("three").BufferAttribute;
    });
    expect(normal).not.toBeNull();
    expect(normal!.array).toBeInstanceOf(Int16Array);
    expect(normal!.normalized).toBe(true);
    batcher.dispose();
  });
});
