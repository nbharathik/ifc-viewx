import { describe, expect, it } from "vitest";

import { bearing, compassPoint, heading, metres, speedLabel, storeyAt } from "../src/viewer-core/flyStats.js";

describe("flight bearing", () => {
  it("calls scene -Z north, which is plan screen-up", () => {
    expect(bearing(0, -1)).toBeCloseTo(0);
  });

  it("runs clockwise: +X is east, +Z is south", () => {
    expect(bearing(1, 0)).toBeCloseTo(90);
    expect(bearing(0, 1)).toBeCloseTo(180);
    expect(bearing(-1, 0)).toBeCloseTo(270);
  });

  it("never reports a negative bearing", () => {
    expect(bearing(-0.4, -1)).toBeGreaterThanOrEqual(0);
    expect(bearing(-0.001, -1)).toBeLessThan(360);
  });
});

describe("heading with a vertical view", () => {
  it("uses the view direction whenever there is one to use", () => {
    expect(heading([1, -0.2, 0], [0, 1, 0])).toBeCloseTo(90);
  });

  it("falls back to the top of the screen when looking straight down", () => {
    // Looking down with the screen top toward scene -Z reads as north, and
    // the residue in the view direction must not decide it.
    expect(heading([-0.001, -1, -0.001], [0, 0, -1])).toBeCloseTo(0);
    expect(heading([-0.001, -1, -0.001], [1, 0, 0])).toBeCloseTo(90);
  });

  it("falls back the same way looking straight up", () => {
    expect(heading([0, 1, 0], [0, 0, 1])).toBeCloseTo(180);
  });
});

describe("compass point", () => {
  it("names the eight points", () => {
    expect(compassPoint(0)).toBe("N");
    expect(compassPoint(45)).toBe("NE");
    expect(compassPoint(90)).toBe("E");
    expect(compassPoint(180)).toBe("S");
    expect(compassPoint(315)).toBe("NW");
  });

  it("wraps back to north rather than running off the list", () => {
    expect(compassPoint(359)).toBe("N");
    expect(compassPoint(360)).toBe("N");
    expect(compassPoint(720)).toBe("N");
  });
});

describe("storey at a height", () => {
  const bands = [
    { name: "Ground floor", elevation: 0 },
    { name: "First floor", elevation: 3 },
    { name: "Roof", elevation: 6 },
  ];

  it("reports the storey you are standing on, not the one above", () => {
    expect(storeyAt(bands, 1.7)).toBe("Ground floor");
    expect(storeyAt(bands, 4.2)).toBe("First floor");
  });

  it("counts standing exactly on a level as being on it", () => {
    expect(storeyAt(bands, 3)).toBe("First floor");
  });

  it("says nothing rather than guessing when below the lowest storey", () => {
    expect(storeyAt(bands, -2)).toBeNull();
  });

  it("holds the top storey once above it all", () => {
    expect(storeyAt(bands, 40)).toBe("Roof");
  });

  it("copes with no storeys at all", () => {
    expect(storeyAt([], 1)).toBeNull();
  });
});

describe("readout formatting", () => {
  it("keeps one decimal and never prints a negative zero", () => {
    expect(metres(12.34)).toBe("12.3");
    expect(metres(-0.02)).toBe("0.0");
    expect(metres(-4.55)).toBe("-4.5");
  });

  it("shows fine detail at walking pace and rounds when moving fast", () => {
    expect(speedLabel(1.25)).toBe("1.3 m/s");
    expect(speedLabel(48.6)).toBe("49 m/s");
  });
});
