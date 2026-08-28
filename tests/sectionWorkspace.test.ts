import { describe, expect, it } from "vitest";
import {
  contourSelection, fitBounds, hasSectionDrawing, scaleStep, withWorkspacePlane,
} from "../src/plugins/section-workspace/panel.js";
import type { SectionContourResult } from "../src/geometry/section.js";

function result(min: [number, number], max: [number, number]): SectionContourResult {
  return {
    axis: "y",
    offset: 0,
    polylines: [],
    bounds: { min, max },
    segmentCount: 0,
    closedCount: 0,
    openCount: 0,
    testedElements: 0,
    missing: 0,
    truncated: false,
    elapsedMs: 0,
    fidelity: "mesh",
    engine: "browser-section",
    geometryRevision: 1,
  };
}

describe("Section Workspace viewport", () => {
  it("fits wide geometry to a wide drawing without distorting its centre", () => {
    const view = fitBounds(result([10, 20], [50, 30]), 2);
    expect(view.width / view.height).toBeCloseTo(2);
    expect(view.x + view.width / 2).toBeCloseTo(30);
    expect(view.y + view.height / 2).toBeCloseTo(-25);
    expect(view.width).toBeGreaterThan(40);
    expect(view.height).toBeGreaterThan(10);
  });

  it("adds width when a tall cut is shown in a wide panel", () => {
    const view = fitBounds(result([-1, -20], [1, 20]), 1.5);
    expect(view.width / view.height).toBeCloseTo(1.5);
    expect(view.x + view.width / 2).toBeCloseTo(0);
  });

  it("uses stable one, two, or five metre drafting scale steps", () => {
    expect(scaleStep(60, 600)).toBe(5);
    expect(scaleStep(24, 600)).toBe(2);
    expect(scaleStep(12, 600)).toBe(1);
  });
});

describe("Section Workspace interaction state", () => {
  it("replaces its axis while preserving section planes on other axes", () => {
    expect(withWorkspacePlane([
      { axis: "x", offset: 2, flip: false },
      { axis: "z", offset: 7, flip: true },
    ], { axis: "x", offset: 4, flip: true })).toEqual([
      { axis: "z", offset: 7, flip: true },
      { axis: "x", offset: 4, flip: true },
    ]);

    expect(withWorkspacePlane([
      { axis: "x", offset: 2, flip: false },
      { axis: "z", offset: 7, flip: true },
    ], { axis: "y", offset: 4, flip: false }, "x")).toEqual([
      { axis: "z", offset: 7, flip: true },
      { axis: "y", offset: 4, flip: false },
    ]);
  });

  it("replaces selection normally and toggles it with a modifier", () => {
    expect(contourSelection([1, 2], 3, false)).toEqual([3]);
    expect(contourSelection([1, 2], 2, true)).toEqual([1]);
    expect(contourSelection([1, 2], 3, true)).toEqual([1, 2, 3]);
  });

  it("does not report a built but empty contour result as downloadable", () => {
    expect(hasSectionDrawing(result([0, 0], [1, 1]))).toBe(true);
    expect(hasSectionDrawing({ ...result([0, 0], [1, 1]), bounds: null })).toBe(false);
  });
});
