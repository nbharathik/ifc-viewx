import { describe, expect, it } from "vitest";

import { clampToPlan } from "../src/viewer-core/scene/scene.js";

// A plan framed on a building centred at (10, -4) with a 20 m half extent.
const CX = 10;
const CZ = -4;
const HALF = 20;
const EDGE = HALF * 0.94;

describe("plan locator placement", () => {
  it("leaves a position inside the frame exactly where it is", () => {
    const at = clampToPlan(14, -9, CX, CZ, HALF);
    expect(at).toEqual({ x: 14, z: -9, pinned: false });
  });

  it("moves with the camera while inside, so flying reads as motion", () => {
    const a = clampToPlan(2, -4, CX, CZ, HALF);
    const b = clampToPlan(6, -4, CX, CZ, HALF);
    expect(a.x).not.toBe(b.x);
    expect(a.pinned).toBe(false);
    expect(b.pinned).toBe(false);
  });

  it("pins to the border on the side the camera is on", () => {
    const east = clampToPlan(500, -4, CX, CZ, HALF);
    expect(east.pinned).toBe(true);
    expect(east.x).toBeCloseTo(CX + EDGE);
    expect(east.z).toBeCloseTo(CZ);
    const west = clampToPlan(-500, -4, CX, CZ, HALF);
    expect(west.x).toBeCloseTo(CX - EDGE);
  });

  it("pins to a corner when both axes are outside", () => {
    const at = clampToPlan(900, 900, CX, CZ, HALF);
    expect(at).toMatchObject({ pinned: true });
    expect(at.x).toBeCloseTo(CX + EDGE);
    expect(at.z).toBeCloseTo(CZ + EDGE);
  });

  it("keeps the pin inside the drawn frame, never on its very edge", () => {
    const at = clampToPlan(1e6, 1e6, CX, CZ, HALF);
    expect(Math.abs(at.x - CX)).toBeLessThan(HALF);
    expect(Math.abs(at.z - CZ)).toBeLessThan(HALF);
  });

  it("treats a position exactly on the limit as still inside", () => {
    const at = clampToPlan(CX + EDGE, CZ, CX, CZ, HALF);
    expect(at.pinned).toBe(false);
  });
});
