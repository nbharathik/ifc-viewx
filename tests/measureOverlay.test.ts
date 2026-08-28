import { describe, expect, it } from "vitest";

import { needsMeasureLayout } from "../src/viewer-core/scene/scene.js";
import { selectMeasureLabels } from "../src/viewer-core/viewer.js";

describe("Measurement overlay layout", () => {
  it("initialises for the first live or placed measurement", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];

    expect(needsMeasureLayout([], null, null, false)).toBe(false);
    expect(needsMeasureLayout([], { a, end: b }, b, false)).toBe(true);
    expect(needsMeasureLayout([{ a, b }], null, null, false)).toBe(true);
  });

  it("keeps priority order while removing overlaps and enforcing a budget", () => {
    const labels = [
      { id: "live", x: 100, y: 100, width: 60, height: 20 },
      { id: "covered", x: 105, y: 100, width: 60, height: 20 },
      { id: "separate", x: 220, y: 100, width: 60, height: 20 },
      { id: "over-budget", x: 340, y: 100, width: 60, height: 20 },
    ];

    expect(selectMeasureLabels(labels, 2).map((label) => label.id)).toEqual(["live", "separate"]);
  });
});
