import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SunResult, SunSample, SunSpec } from "../src/geometry/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const captured = vi.hoisted(() => ({ calls: 0, spec: null as SunSpec | null }));

vi.mock("../src/geometry/service.js", () => ({
  geometryService: () => ({
    sun: async (spec: SunSpec): Promise<SunResult> => {
      captured.calls += 1;
      captured.spec = spec;
      return {
        exposure: new Float32Array(spec.points.length / 3),
        stepMinutes: spec.stepMinutes,
        directions: spec.directions.length / 3,
        testedElements: 0,
        missing: 0,
        elapsedMs: 0,
        fidelity: "mesh",
        engine: "browser-sun",
        geometryRevision: 1,
      };
    },
  }),
}));

import { measureSun } from "../src/geometry/sun.js";

const viewer = {
  getModels: () => [],
  getElementTypes: () => new Map<number, string>(),
  getModelOrigin: () => [0, 0, 0],
  isElementVisible: () => true,
} as unknown as Viewer;

const samples: SunSample[] = [{ point: [1, 2, 3], normal: [0, 3, 4] }];
const directions: Array<[number, number, number]> = [[0, 0, -5]];

describe("measureSun validation", () => {
  beforeEach(() => {
    captured.calls = 0;
    captured.spec = null;
  });

  it("normalizes vectors and offsets points by epsilon before scheduling work", async () => {
    await measureSun(viewer, samples, directions, 30, {
      ids: [1, Number.MAX_SAFE_INTEGER],
      epsilon: 0.1,
      maxDistance: 100,
    });

    expect(captured.calls).toBe(1);
    expect([...captured.spec!.points]).toEqual([1, 2.06, 3.08]);
    expect([...captured.spec!.directions]).toEqual([0, 0, -1]);
    expect([...captured.spec!.ids]).toEqual([1, Number.MAX_SAFE_INTEGER]);
    expect(captured.spec).toMatchObject({ stepMinutes: 30, epsilon: 0.1, maxDistance: 100 });
  });

  it("rejects malformed point, normal, and direction triples synchronously", () => {
    const invalid: Array<() => unknown> = [
      () => measureSun(viewer, [{ point: [0, 1] as never, normal: [0, 1, 0] }], directions, 30),
      () => measureSun(viewer, [{ point: [0, Number.NaN, 0], normal: [0, 1, 0] }], directions, 30),
      () => measureSun(viewer, [{ point: [0, 0, 0], normal: [0, 0, 0] }], directions, 30),
      () => measureSun(viewer, [{ point: [0, 0, 0], normal: [0, Number.POSITIVE_INFINITY, 0] }], directions, 30),
      () => measureSun(viewer, samples, [[0, 1] as never], 30),
      () => measureSun(viewer, samples, [[0, 0, 0]], 30),
      () => measureSun(viewer, samples, [[0, Number.NaN, 0]], 30),
    ];

    for (const invoke of invalid) expect(invoke).toThrow(/sun (sample|direction)/);
    expect(captured.calls).toBe(0);
  });

  it("rejects unsafe scalar ranges and element ids before scheduling work", () => {
    const invalid: Array<() => unknown> = [
      () => measureSun(viewer, samples, directions, 0),
      () => measureSun(viewer, samples, directions, Number.NaN),
      () => measureSun(viewer, samples, directions, 1_441),
      () => measureSun(viewer, samples, directions, 30, { epsilon: 0 }),
      () => measureSun(viewer, samples, directions, 30, { epsilon: 11 }),
      () => measureSun(viewer, samples, directions, 30, { maxDistance: Number.POSITIVE_INFINITY }),
      () => measureSun(viewer, samples, directions, 30, { epsilon: 0.1, maxDistance: 0.01 }),
      () => measureSun(viewer, samples, directions, 30, { ids: [1.5] }),
      () => measureSun(viewer, samples, directions, 30, { ids: [Number.POSITIVE_INFINITY] }),
      () => measureSun(viewer, samples, directions, 30, { ids: [Number.MAX_SAFE_INTEGER + 1] }),
    ];

    for (const invoke of invalid) expect(invoke).toThrow(/sun (stepMinutes|epsilon|maxDistance|element ids)/);
    expect(captured.calls).toBe(0);
  });
});
