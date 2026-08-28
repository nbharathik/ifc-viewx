import { describe, expect, it } from "vitest";
import { boxPlanes, padBox, sanitizeBox, type SectionBox } from "../src/viewer-core/viewer.js";

const BOX: SectionBox = { min: [0, 0, 0], max: [10, 4, 6] };

/**
 * The half-space a plane keeps, written the way scene.setClipPlanes builds it:
 * unflipped keeps `value < offset`, flipped keeps `value > offset`.
 */
const keeps = (plane: { offset: number; flip: boolean }, value: number): boolean =>
  plane.flip ? value > plane.offset : value < plane.offset;

const inside = (planes: ReturnType<typeof boxPlanes>, point: [number, number, number]): boolean =>
  planes.every((plane) => keeps(plane, point[plane.axis === "x" ? 0 : plane.axis === "y" ? 1 : 2]));

describe("boxPlanes", () => {
  it("makes six planes, two per axis", () => {
    const planes = boxPlanes(BOX);
    expect(planes).toHaveLength(6);
    for (const axis of ["x", "y", "z"] as const) {
      expect(planes.filter((plane) => plane.axis === axis)).toHaveLength(2);
    }
  });

  it("pairs one flipped and one unflipped plane per axis", () => {
    const planes = boxPlanes(BOX);
    for (const axis of ["x", "y", "z"] as const) {
      const pair = planes.filter((plane) => plane.axis === axis);
      expect(pair.map((plane) => plane.flip).sort()).toEqual([false, true]);
    }
  });

  it("keeps a point inside the box", () => {
    expect(inside(boxPlanes(BOX), [5, 2, 3])).toBe(true);
  });

  it("clips a point outside on each of the six sides", () => {
    const planes = boxPlanes(BOX);
    const outside: Array<[number, number, number]> = [
      [-1, 2, 3], [11, 2, 3],
      [5, -1, 3], [5, 5, 3],
      [5, 2, -1], [5, 2, 7],
    ];
    for (const point of outside) expect(inside(planes, point)).toBe(false);
  });

  it("survives a negative-coordinate box, which a rebased model produces", () => {
    const planes = boxPlanes({ min: [-30, -12, -8], max: [-10, -4, -2] });
    expect(inside(planes, [-20, -8, -5])).toBe(true);
    expect(inside(planes, [-5, -8, -5])).toBe(false);
  });
});

describe("padBox", () => {
  it("grows by a share of the longest side, equally on both ends", () => {
    const padded = padBox(BOX, 0.1); // longest side is 10, so grow is 1
    expect(padded.min).toEqual([-1, -1, -1]);
    expect(padded.max).toEqual([11, 5, 7]);
  });

  it("still grows a degenerate box, so a flat element is not clipped away", () => {
    const flat = padBox({ min: [1, 2, 3], max: [1, 2, 3] }, 0.05);
    expect(flat.max[0] - flat.min[0]).toBeGreaterThan(0);
  });
});

describe("sanitizeBox", () => {
  it("leaves a healthy box alone", () => {
    expect(sanitizeBox(BOX)).toEqual(BOX);
  });

  it("keeps a collapsed axis open, so the model does not vanish", () => {
    const fixed = sanitizeBox({ min: [5, 0, 0], max: [5, 4, 6] });
    expect(fixed.min[0]).toBeLessThan(fixed.max[0]);
    expect(inside(boxPlanes(fixed), [4.9995, 2, 3])).toBe(true);
  });

  it("keeps an inverted axis open too", () => {
    const fixed = sanitizeBox({ min: [8, 0, 0], max: [2, 4, 6] });
    expect(fixed.min[0]).toBeLessThan(fixed.max[0]);
  });
});
