import { describe, expect, it, vi } from "vitest";

import type { DeviationSpec } from "../src/geometry/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const captured = vi.hoisted(() => ({ spec: null as DeviationSpec | null }));

vi.mock("../src/geometry/service.js", () => ({
  geometryService: () => ({
    deviation: async (spec: DeviationSpec) => {
      captured.spec = spec;
      return { distances: new Float32Array(1), elements: new Float64Array(1) };
    },
  }),
}));

import { measureDeviation } from "../src/geometry/deviation.js";

const viewer = {
  getModels: () => [],
  getElementTypes: () => new Map<number, string>(),
  getModelOrigin: () => [0, 0, 0],
  isElementVisible: () => true,
} as unknown as Viewer;

describe("measureDeviation", () => {
  it("does not hand the caller-owned scan buffer to the worker", async () => {
    const points = new Float64Array([1, 2, 3]);

    await measureDeviation(viewer, points, { ids: [] });

    expect(captured.spec?.points).not.toBe(points);
    expect([...points]).toEqual([1, 2, 3]);
    expect([...captured.spec!.points]).toEqual([1, 2, 3]);
  });

  it("rejects malformed input before scheduling geometry work", () => {
    expect(() => measureDeviation(viewer, new Float64Array([1, 2, 3, 4]), { ids: [] }))
      .toThrow(/XYZ triples/);
    expect(() => measureDeviation(viewer, new Float64Array([1, 2, 3]), { ids: [], maxDistance: Number.NaN }))
      .toThrow(/positive finite/);
  });
});
