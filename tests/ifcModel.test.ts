import { describe, expect, it, vi } from "vitest";
import type { IfcAPI } from "web-ifc";

import { IfcModel } from "../src/ifc/model.js";

function vector(values: number[]) {
  return {
    size: () => values.length,
    get: (index: number) => values[index],
    delete: vi.fn(),
  };
}

describe("IfcModel wasm resources", () => {
  it("copies and releases type result vectors", () => {
    const ids = vector([4, 8, 15]);
    const api = {
      GetTypeCodeFromName: () => 123,
      GetLineIDsWithType: () => ids,
    } as unknown as IfcAPI;

    expect(new IfcModel(api, 7).byType("IfcWall")).toEqual([4, 8, 15]);
    expect(ids.delete).toHaveBeenCalledOnce();
  });

  it("counts every STEP line and releases the result vector", () => {
    const lines = vector([1, 3, 7, 9]);
    const api = { GetAllLines: () => lines } as unknown as IfcAPI;

    expect(new IfcModel(api, 7).entityCount()).toBe(4);
    expect(lines.delete).toHaveBeenCalledOnce();
  });
});
