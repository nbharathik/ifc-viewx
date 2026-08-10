import { describe, expect, it } from "vitest";
import { clearanceStatus, exactSelectionPair } from "../src/plugins/smart-measure/panel.js";

describe("Smart Measure selection pair", () => {
  it("accepts exactly two different elements and preserves their order", () => {
    expect(exactSelectionPair([12, 34])).toEqual([12, 34]);
  });

  it("does not silently choose from incomplete, duplicate, or larger selections", () => {
    expect(exactSelectionPair([])).toBeNull();
    expect(exactSelectionPair([12])).toBeNull();
    expect(exactSelectionPair([12, 12])).toBeNull();
    expect(exactSelectionPair([12, 34, 56])).toBeNull();
  });
});

describe("Smart Measure clearance status", () => {
  it("keeps unavailable geometry distinct from a failed clearance", () => {
    expect(clearanceStatus(null, false, 50)).toBe("unknown");
    expect(clearanceStatus(0, true, 50)).toBe("fail");
    expect(clearanceStatus(0.04, false, 50)).toBe("fail");
    expect(clearanceStatus(0.05, false, 50)).toBe("pass");
  });
});
