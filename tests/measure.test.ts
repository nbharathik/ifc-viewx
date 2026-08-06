import { describe, expect, it } from "vitest";

import {
  angleAt,
  formatAngle,
  formatArea,
  formatLength,
  ringArea,
  ringPerimeter,
} from "../src/viewer-core/viewer.js";

type P = [number, number, number];

describe("ring area", () => {
  it("measures an axis-aligned square", () => {
    const square: P[] = [
      [0, 0, 0],
      [4, 0, 0],
      [4, 3, 0],
      [0, 3, 0],
    ];
    expect(ringArea(square)).toBeCloseTo(12, 9);
  });

  it("measures a triangle", () => {
    expect(
      ringArea([
        [0, 0, 0],
        [6, 0, 0],
        [0, 8, 0],
      ]),
    ).toBeCloseTo(24, 9);
  });

  it("is unchanged by rotating the whole ring", () => {
    const square: P[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    // Rotate 40 degrees about X, so the ring is no longer axis aligned.
    const t = (0.4 * Math.PI) / 2;
    const turned = square.map(([x, y, z]): P => [x, y * Math.cos(t) - z * Math.sin(t), y * Math.sin(t) + z * Math.cos(t)]);
    expect(ringArea(turned)).toBeCloseTo(4, 9);
  });

  it("is unchanged by translating the whole ring", () => {
    const square: P[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    const moved = square.map(([x, y, z]): P => [x + 1000, y - 55, z + 7]);
    expect(ringArea(moved)).toBeCloseTo(ringArea(square), 9);
  });

  it("does not care which way round the points were clicked", () => {
    const square: P[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    expect(ringArea([...square].reverse())).toBeCloseTo(ringArea(square), 9);
  });

  it("returns zero for anything that is not a ring yet", () => {
    expect(ringArea([])).toBe(0);
    expect(ringArea([[0, 0, 0]])).toBe(0);
    expect(
      ringArea([
        [0, 0, 0],
        [1, 0, 0],
      ]),
    ).toBe(0);
  });

  it("returns zero for three points on a line", () => {
    expect(
      ringArea([
        [0, 0, 0],
        [1, 0, 0],
        [2, 0, 0],
      ]),
    ).toBeCloseTo(0, 9);
  });
});

describe("angle", () => {
  it("measures a right angle", () => {
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0])).toBeCloseTo(90, 9);
  });

  it("measures a straight line as 180 degrees", () => {
    expect(angleAt([-1, 0, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(180, 9);
  });

  it("measures a doubled-back arm as zero", () => {
    expect(angleAt([1, 0, 0], [0, 0, 0], [2, 0, 0])).toBeCloseTo(0, 6);
  });

  it("measures out of plane", () => {
    expect(angleAt([1, 0, 0], [0, 0, 0], [0, 0, 1])).toBeCloseTo(90, 9);
    expect(angleAt([1, 1, 0], [0, 0, 0], [1, 0, 0])).toBeCloseTo(45, 9);
  });

  it("is unchanged by translation", () => {
    const a = angleAt([1, 0, 0], [0, 0, 0], [0, 1, 0]);
    const b = angleAt([101, 50, -3], [100, 50, -3], [100, 51, -3]);
    expect(b).toBeCloseTo(a, 9);
  });

  it("reports zero rather than NaN when an arm has no length", () => {
    expect(angleAt([0, 0, 0], [0, 0, 0], [1, 0, 0])).toBe(0);
  });
});

describe("perimeter", () => {
  it("adds the closing edge only when the ring is closed", () => {
    const square: P[] = [
      [0, 0, 0],
      [2, 0, 0],
      [2, 2, 0],
      [0, 2, 0],
    ];
    expect(ringPerimeter(square, true)).toBeCloseTo(8, 9);
    expect(ringPerimeter(square, false)).toBeCloseTo(6, 9);
  });

  it("measures the two arms of an angle", () => {
    expect(
      ringPerimeter(
        [
          [3, 0, 0],
          [0, 0, 0],
          [0, 4, 0],
        ],
        false,
      ),
    ).toBeCloseTo(7, 9);
  });
});

describe("formatting", () => {
  it("keeps short lengths in millimetres", () => {
    expect(formatLength(0.025)).toBe("25 mm");
    expect(formatLength(2.5)).toBe("2.50 m");
  });

  it("keeps small areas in square centimetres", () => {
    expect(formatArea(0.02)).toBe("200 cm2");
    expect(formatArea(12.345)).toBe("12.35 m2");
    expect(formatArea(1234.5)).toBe("1234.5 m2");
  });

  it("reports an angle to a tenth of a degree", () => {
    expect(formatAngle(90)).toBe("90.0 deg");
    expect(formatAngle(44.449)).toBe("44.4 deg");
  });
});
