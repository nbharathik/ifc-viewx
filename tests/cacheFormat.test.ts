import { describe, expect, it } from "vitest";
import { FORMAT_VERSION, isFormatBytes } from "../src/viewer-core/engine/cache.js";

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
