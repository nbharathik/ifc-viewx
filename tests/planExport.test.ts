import { describe, expect, it } from "vitest";

import { flipRows } from "../src/viewer-core/scene/scene.js";

/** One byte per pixel channel, so a row is identifiable by its first byte. */
function rows(side: number): Uint8Array {
  const data = new Uint8Array(side * side * 4);
  for (let row = 0; row < side; row++) {
    for (let column = 0; column < side; column++) {
      const at = (row * side + column) * 4;
      data[at] = row;
      data[at + 1] = column;
      data[at + 2] = 0;
      data[at + 3] = 255;
    }
  }
  return data;
}

describe("plan capture row order", () => {
  it("puts the last GL row first, so the plan is not saved upside down", () => {
    const side = 4;
    const out = new Uint8ClampedArray(side * side * 4);
    flipRows(rows(side), side, out);
    // GL row 3 (the top of the image) has to land in image row 0.
    expect(out[0]).toBe(3);
    expect(out[(1 * side) * 4]).toBe(2);
    expect(out[(2 * side) * 4]).toBe(1);
    expect(out[(3 * side) * 4]).toBe(0);
  });

  it("keeps pixels in their column, so nothing is mirrored sideways", () => {
    const side = 4;
    const out = new Uint8ClampedArray(side * side * 4);
    flipRows(rows(side), side, out);
    for (let column = 0; column < side; column++) {
      expect(out[column * 4 + 1]).toBe(column);
    }
  });

  it("copies every byte, alpha included", () => {
    const side = 3;
    const out = new Uint8ClampedArray(side * side * 4);
    flipRows(rows(side), side, out);
    expect([...out].filter((value, index) => index % 4 === 3 && value === 255)).toHaveLength(side * side);
  });

  it("is its own inverse", () => {
    const side = 5;
    const source = rows(side);
    const once = new Uint8ClampedArray(side * side * 4);
    flipRows(source, side, once);
    const twice = new Uint8ClampedArray(side * side * 4);
    flipRows(new Uint8Array(once), side, twice);
    expect([...twice]).toEqual([...source]);
  });
});
