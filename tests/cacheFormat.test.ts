import { describe, expect, it } from "vitest";
import {
  FORMAT_VERSION,
  deserializeBatch,
  isFormatBytes,
  serializeBatch,
} from "../src/viewer-core/engine/cache.js";
import type { MeshBatch } from "../src/viewer-core/engine/packets.js";

const MAGIC = 0x58434649;
const MAGIC_END = 0x444e4558;

function container(version = FORMAT_VERSION): Uint8Array {
  const bytes = new Uint8Array(18);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, version, true);
  bytes.set(new TextEncoder().encode("{}"), 8);
  view.setUint32(10, 2, true);
  view.setUint32(14, MAGIC_END, true);
  return bytes;
}

describe("IFCX preflight", () => {
  it("accepts a committed current container", () => {
    expect(isFormatBytes(container())).toBe(true);
  });

  it("rejects a wrong version or missing trailer", () => {
    expect(isFormatBytes(container(FORMAT_VERSION + 1))).toBe(false);
    expect(isFormatBytes(container().subarray(0, 14))).toBe(false);
  });
});

const batch = (): MeshBatch => ({
  geometries: {
    ids: new Uint32Array([10]),
    vertexCounts: new Uint32Array([3]),
    indexCounts: new Uint32Array([3]),
    localBounds: new Float64Array([0, 0, 0, 1, 1, 0]),
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array(9),
    indices: new Uint32Array([0, 1, 2]),
  },
  placements: {
    expressIDs: new Uint32Array([20]),
    geometryIDs: new Uint32Array([10]),
    matrices: new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]),
    colors: new Float32Array([1, 0, 0, 1]),
    ifcTypes: ["IfcWall"],
  },
});

describe("IFCX mesh chunks", () => {
  it("round trips a valid batch", () => {
    const restored = deserializeBatch(serializeBatch(batch()));
    expect([...restored.geometries.positions]).toEqual([...batch().geometries.positions]);
    expect(restored.placements.ifcTypes).toEqual(["IfcWall"]);
  });

  it("rejects incomplete and overflow-sized chunk headers", () => {
    expect(() => deserializeBatch(new ArrayBuffer(19))).toThrow("corrupt cache chunk");
    const bytes = new ArrayBuffer(20);
    new DataView(bytes).setUint32(4, 0xffffffff, true);
    expect(() => deserializeBatch(bytes)).toThrow("corrupt cache chunk");
  });

  it("rejects inconsistent geometry counts and type tables", () => {
    const invalid = batch();
    invalid.geometries.vertexCounts[0] = 2;
    expect(() => serializeBatch(invalid)).toThrow("invalid mesh batch");

    const bytes = serializeBatch(batch());
    const view = new DataView(bytes);
    const typeBytes = view.getUint32(16, true);
    new Uint8Array(bytes, bytes.byteLength - typeBytes).set(new TextEncoder().encode('{"bad":123}'));
    expect(() => deserializeBatch(bytes)).toThrow("corrupt cache chunk");
  });
});
