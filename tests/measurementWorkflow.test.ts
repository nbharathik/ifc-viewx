import { describe, expect, it } from "vitest";

import {
  constrainMeasurementPoint,
  formatArea,
  formatCoordinate,
  formatLength,
  measurementSemantic,
} from "../src/viewer-core/viewer.js";
import type { MeasurementFormat, MeasurementObject } from "../src/viewer-core/viewer.js";
import {
  measurementsFromCsv,
  measurementsToCsv,
  stateValue,
} from "../src/ui/measurementLedger.js";

const engineering: MeasurementFormat = {
  unit: "engineering",
  precision: { mode: "decimals", value: 2 },
  zeroSuppression: 1,
};
const architectural: MeasurementFormat = {
  unit: "architectural",
  precision: { mode: "denominator", value: 16 },
  zeroSuppression: 0,
};

describe("measurement semantics and constraints", () => {
  it("classifies endpoints independently of pick order", () => {
    expect(measurementSemantic(["vertex", "surface"])).toBe("point-to-face");
    expect(measurementSemantic(["surface", "midpoint"])).toBe("line-to-face");
    expect(measurementSemantic(["edge", "midpoint"])).toBe("line-to-line");
    expect(measurementSemantic(["surface", "surface"])).toBe("face-to-face");
  });

  it("locks only the selected world axis and never mutates inputs", () => {
    const origin: [number, number, number] = [1, 2, 3];
    const point: [number, number, number] = [8, 9, 10];
    expect(constrainMeasurementPoint(origin, point, "x")).toEqual([8, 2, 3]);
    expect(constrainMeasurementPoint(origin, point, "y")).toEqual([1, 9, 3]);
    expect(constrainMeasurementPoint(origin, point, "z")).toEqual([1, 2, 10]);
    expect(constrainMeasurementPoint(origin, point, "free")).toEqual(point);
    expect(point).toEqual([8, 9, 10]);
  });

  it("locks parallel or perpendicular to the picked start surface", () => {
    const origin: [number, number, number] = [1, 2, 3];
    const point: [number, number, number] = [5, 8, 9];
    const normal: [number, number, number] = [0, 2, 0];
    expect(constrainMeasurementPoint(origin, point, "perpendicular", normal)).toEqual([1, 8, 3]);
    expect(constrainMeasurementPoint(origin, point, "parallel", normal)).toEqual([5, 2, 9]);
    expect(constrainMeasurementPoint(origin, point, "parallel", null)).toEqual(point);
  });
});

describe("measurement unit formatting", () => {
  it("keeps arithmetic in metres while formatting metric presets", () => {
    expect(formatLength(2.3456, {
      unit: "millimetres", precision: { mode: "decimals", value: 0 }, zeroSuppression: 8,
    })).toBe("2346 mm");
    expect(formatArea(1, {
      unit: "centimetres", precision: { mode: "decimals", value: 0 }, zeroSuppression: 8,
    })).toBe("10000 cm2");
  });

  it("formats engineering and architectural feet and inches", () => {
    expect(formatLength(3.81, engineering)).toBe("12'-6.00\"");
    expect(formatLength(0.1651, architectural)).toBe('6 1/2"');
    expect(formatCoordinate([0.3048, 0.6096, 0.9144], architectural)).toBe(`X 1'  Y 2'  Z 3'`);
  });

  it("honours component zero suppression", () => {
    expect(formatLength(3.6576, { ...engineering, zeroSuppression: 0 })).toBe("12'");
    expect(formatLength(3.6576, { ...engineering, zeroSuppression: 1 })).toBe("12'-0.00\"");
    expect(formatLength(0.1524, { ...engineering, zeroSuppression: 0 })).toBe('6.00"');
  });
});

describe("measurement ledger CSV", () => {
  it("round trips distance, path, area and coordinate witness geometry", () => {
    const items: MeasurementObject[] = [
      {
        kind: "distance", id: 1, label: "Clearance, east", visible: true,
        semantic: "point-to-face", a: [0, 0, 0], b: [3, 4, 0],
        distance: 5, horizontal: 3, vertical: 4, slopePercent: 400 / 3,
        slopeAngle: 53.13010235415598, complete: true,
        ends: ["vertex", "surface"],
      },
      {
        kind: "path", id: 2, label: "Route", visible: false,
        points: [[0, 0, 0], [2, 0, 0], [2, 3, 0]], perimeter: 5,
      },
      {
        kind: "area", id: 3, label: "Room", visible: true,
        points: [[0, 0, 0], [4, 0, 0], [4, 3, 0], [0, 3, 0]], perimeter: 14, area: 12,
      },
      {
        kind: "coordinate", id: 4, label: "Setout", visible: true,
        points: [[10, 2, -3]], perimeter: 0,
      },
    ];
    const imported = measurementsFromCsv(measurementsToCsv(items, engineering));
    expect(imported).toHaveLength(4);
    expect(imported[0]).toMatchObject({ kind: "distance", label: "Clearance, east", ends: ["vertex", "surface"] });
    expect(stateValue(imported[0])).toBeCloseTo(5, 9);
    expect(imported[1]).toMatchObject({ kind: "path", visible: false });
    expect(stateValue(imported[1])).toBeCloseTo(5, 9);
    expect(stateValue(imported[2])).toBeCloseTo(12, 9);
    expect(stateValue(imported[3])).toEqual([10, 2, -3]);
  });

  it("rejects unrelated CSV input", () => {
    expect(() => measurementsFromCsv("name,value\nwall,3")).toThrow(/measurement CSV/i);
  });
});
