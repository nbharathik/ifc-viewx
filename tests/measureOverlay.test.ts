import { describe, expect, it } from "vitest";

import { needsMeasureLayout } from "../src/viewer-core/scene/scene.js";

describe("Measurement overlay layout", () => {
  it("initialises for the first live or placed measurement", () => {
    const a: [number, number, number] = [0, 0, 0];
    const b: [number, number, number] = [1, 0, 0];

    expect(needsMeasureLayout([], null, null, false)).toBe(false);
    expect(needsMeasureLayout([], { a, end: b }, b, false)).toBe(true);
    expect(needsMeasureLayout([{ a, b }], null, null, false)).toBe(true);
  });
});
