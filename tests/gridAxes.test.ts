import { describe, expect, it } from "vitest";
import { extractGridAxes, lengthUnitFactor, planeAngleFactor, type GridAxesSource } from "../src/ifc/gridAxes.js";

const ref = (value: number) => ({ type: 5, value });
const val = (value: unknown) => ({ value });

type Entity = Record<string, unknown> & { ifcType?: string };

function sourceFor(
  entities: Record<number, Entity>,
  gridIds: number[],
  angleFactor = 1,
  coordinationMatrix?: number[],
): GridAxesSource {
  const line = (id: number) => {
    const found = entities[id];
    if (!found) return null;
    const { ifcType, ...rest } = found;
    return { expressID: id, ...rest };
  };
  return {
    grids: gridIds.map((id) => line(id)!),
    line,
    typeName: (id) => String(entities[id]?.ifcType ?? ""),
    angleFactor,
    coordinationMatrix,
  };
}

const polylineWorld = (sameSense: unknown): Record<number, Entity> => ({
  1: { ifcType: "IfcGrid", Name: val("Level grid"), UAxes: [ref(10)], VAxes: [ref(11)] },
  10: { ifcType: "IfcGridAxis", AxisTag: val("A"), AxisCurve: ref(20), SameSense: sameSense },
  11: { ifcType: "IfcGridAxis", AxisTag: val("1"), AxisCurve: ref(21), SameSense: val(true) },
  20: { ifcType: "IfcPolyline", Points: [ref(30), ref(31)] },
  21: { ifcType: "IfcPolyline", Points: [ref(30), ref(32)] },
  30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
  31: { ifcType: "IfcCartesianPoint", Coordinates: [val(10), val(0)] },
  32: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(6)] },
});

describe("IFC grid axis extraction", () => {
  it("reads polylines, labels and axis groups, padding 2D points with z 0", () => {
    const grids = extractGridAxes(sourceFor(polylineWorld(val(true)), [1]));

    expect(grids).toHaveLength(1);
    expect(grids[0]).toMatchObject({ expressID: 1, name: "Level grid" });
    expect(grids[0].axes).toHaveLength(2);
    expect(grids[0].axes[0]).toMatchObject({ label: "A", axisGroup: "U", points: [0, 0, 0, 10, 0, 0] });
    expect(grids[0].axes[1]).toMatchObject({ label: "1", axisGroup: "V", points: [0, 0, 0, 0, 6, 0] });
  });

  it("reverses point order when SameSense is false", () => {
    const grids = extractGridAxes(sourceFor(polylineWorld(val(false)), [1]));

    expect(grids[0].axes[0].points).toEqual([10, 0, 0, 0, 0, 0]);
  });

  it("evaluates trimmed lines with cartesian trims", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisTag: val("B"), AxisCurve: ref(20), SameSense: val(true) },
      20: {
        ifcType: "IfcTrimmedCurve",
        BasisCurve: ref(40),
        Trim1: [ref(31)],
        Trim2: [ref(32)],
        SenseAgreement: val(true),
        MasterRepresentation: val("CARTESIAN"),
      },
      40: { ifcType: "IfcLine", Pnt: ref(30), Dir: ref(41) },
      41: { ifcType: "IfcVector", Orientation: ref(42), Magnitude: val(2) },
      42: { ifcType: "IfcDirection", DirectionRatios: [val(1), val(0)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
      31: { ifcType: "IfcCartesianPoint", Coordinates: [val(2), val(3)] },
      32: { ifcType: "IfcCartesianPoint", Coordinates: [val(8), val(3)] },
    }, [1]));

    expect(grids[0].axes[0].points).toEqual([2, 3, 0, 8, 3, 0]);
  });

  it("evaluates trimmed lines with parameter trims scaled by the vector magnitude", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisCurve: ref(20), SameSense: val(true) },
      20: {
        ifcType: "IfcTrimmedCurve",
        BasisCurve: ref(40),
        Trim1: [val(1)],
        Trim2: [val(4)],
        SenseAgreement: val(true),
        MasterRepresentation: val("PARAMETER"),
      },
      40: { ifcType: "IfcLine", Pnt: ref(30), Dir: ref(41) },
      41: { ifcType: "IfcVector", Orientation: ref(42), Magnitude: val(2) },
      42: { ifcType: "IfcDirection", DirectionRatios: [val(1), val(0)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
    }, [1]));

    expect(grids[0].axes[0].points).toEqual([2, 0, 0, 8, 0, 0]);
  });

  it("tessellates circle arcs with degree trims and SenseAgreement false", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisCurve: ref(20), SameSense: val(true) },
      20: {
        ifcType: "IfcTrimmedCurve",
        BasisCurve: ref(40),
        Trim1: [val(90)],
        Trim2: [val(0)],
        SenseAgreement: val(false),
        MasterRepresentation: val("PARAMETER"),
      },
      40: { ifcType: "IfcCircle", Position: ref(41), Radius: val(5) },
      41: { ifcType: "IfcAxis2Placement2D", Location: ref(30) },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
    }, [1], Math.PI / 180));

    const points = grids[0].axes[0].points;
    expect(points.length).toBe(17 * 3);
    expect(points[0]).toBeCloseTo(0, 6);
    expect(points[1]).toBeCloseTo(5, 6);
    expect(points[2]).toBe(0);
    expect(points[points.length - 3]).toBeCloseTo(5, 6);
    expect(points[points.length - 2]).toBeCloseTo(0, 6);
    for (let i = 0; i < points.length; i += 3) {
      expect(Math.hypot(points[i], points[i + 1])).toBeCloseTo(5, 6);
      expect(points[i + 1]).toBeGreaterThanOrEqual(-1e-9);
    }
  });

  it("composes the local placement chain onto axis points", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", ObjectPlacement: ref(50), UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisCurve: ref(20), SameSense: val(true) },
      20: { ifcType: "IfcPolyline", Points: [ref(30), ref(31)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
      31: { ifcType: "IfcCartesianPoint", Coordinates: [val(1), val(0)] },
      50: { ifcType: "IfcLocalPlacement", RelativePlacement: ref(51), PlacementRelTo: ref(53) },
      51: { ifcType: "IfcAxis2Placement3D", Location: ref(52), RefDirection: ref(55) },
      52: { ifcType: "IfcCartesianPoint", Coordinates: [val(1), val(2), val(0)] },
      53: { ifcType: "IfcLocalPlacement", RelativePlacement: ref(54) },
      54: { ifcType: "IfcAxis2Placement3D", Location: ref(56) },
      55: { ifcType: "IfcDirection", DirectionRatios: [val(0), val(1), val(0)] },
      56: { ifcType: "IfcCartesianPoint", Coordinates: [val(10), val(0), val(5)] },
    }, [1]));

    const points = grids[0].axes[0].points;
    expect(points[0]).toBeCloseTo(11, 9);
    expect(points[1]).toBeCloseTo(2, 9);
    expect(points[2]).toBeCloseTo(5, 9);
    expect(points[3]).toBeCloseTo(11, 9);
    expect(points[4]).toBeCloseTo(3, 9);
    expect(points[5]).toBeCloseTo(5, 9);
  });

  it("reads indexed polycurves over cartesian point lists, ignoring Segments", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisTag: val("C"), AxisCurve: ref(20), SameSense: val(true) },
      20: { ifcType: "IfcIndexedPolyCurve", Points: ref(21), Segments: null },
      21: { ifcType: "IfcCartesianPointList2D", CoordList: [[val(0), val(2)], [val(12), val(2)]] },
    }, [1]));

    expect(grids[0].axes).toHaveLength(1);
    expect(grids[0].axes[0]).toMatchObject({ label: "C", axisGroup: "U", points: [0, 2, 0, 12, 2, 0] });
  });

  it("maps axes into the mesh frame through a Z-up to Y-up coordination matrix", () => {
    const zUpToYUp = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisTag: val("A"), AxisCurve: ref(20), SameSense: val(true) },
      20: { ifcType: "IfcPolyline", Points: [ref(30), ref(31)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(8)] },
      31: { ifcType: "IfcCartesianPoint", Coordinates: [val(10), val(8)] },
    }, [1], 1, zUpToYUp));

    expect(grids[0].axes[0].points).toEqual([0, 0, -8, 10, 0, -8]);
  });

  it("scales millimetre axes through the composed conversion matrix", () => {
    const s = 0.001;
    const conversion = [s, 0, 0, 0, 0, 0, -s, 0, 0, s, 0, 0, 0, 0, 0, 1];
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10)] },
      10: { ifcType: "IfcGridAxis", AxisTag: val("A"), AxisCurve: ref(20), SameSense: val(true) },
      20: { ifcType: "IfcPolyline", Points: [ref(30), ref(31)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(8000)] },
      31: { ifcType: "IfcCartesianPoint", Coordinates: [val(10000), val(8000)] },
    }, [1], 1, conversion));

    const points = grids[0].axes[0].points;
    const expected = [0, 0, -8, 10, 0, -8];
    for (let i = 0; i < expected.length; i++) expect(points[i]).toBeCloseTo(expected[i], 9);
  });

  it("skips axes whose curve is unsupported instead of throwing", () => {
    const grids = extractGridAxes(sourceFor({
      1: { ifcType: "IfcGrid", UAxes: [ref(10), ref(11)] },
      10: { ifcType: "IfcGridAxis", AxisCurve: ref(20), SameSense: val(true) },
      11: { ifcType: "IfcGridAxis", AxisTag: val("A"), AxisCurve: ref(21), SameSense: val(true) },
      20: { ifcType: "IfcLine", Pnt: ref(30), Dir: ref(41) },
      21: { ifcType: "IfcPolyline", Points: [ref(30), ref(31)] },
      30: { ifcType: "IfcCartesianPoint", Coordinates: [val(0), val(0)] },
      31: { ifcType: "IfcCartesianPoint", Coordinates: [val(4), val(0)] },
      41: { ifcType: "IfcVector", Orientation: ref(42), Magnitude: val(1) },
      42: { ifcType: "IfcDirection", DirectionRatios: [val(1), val(0)] },
    }, [1]));

    expect(grids[0].axes).toHaveLength(1);
    expect(grids[0].axes[0].label).toBe("A");
  });
});

describe("unit factor resolution", () => {
  const line = (entities: Record<number, Entity>) => (id: number) => {
    const found = entities[id];
    if (!found) return null;
    const { ifcType, ...rest } = found;
    return { expressID: id, ...rest };
  };
  const typeName = (entities: Record<number, Entity>) => (id: number) => String(entities[id]?.ifcType ?? "");

  it("resolves a conversion based degree unit", () => {
    const entities: Record<number, Entity> = {
      90: { ifcType: "IfcSIUnit", UnitType: val("LENGTHUNIT") },
      91: { ifcType: "IfcConversionBasedUnit", UnitType: val("PLANEANGLEUNIT"), ConversionFactor: ref(92) },
      92: { ifcType: "IfcMeasureWithUnit", ValueComponent: val(0.017453292519943295) },
    };
    const assignment = { Units: [ref(90), ref(91)] };
    expect(planeAngleFactor(assignment, line(entities), typeName(entities))).toBeCloseTo(Math.PI / 180, 12);
  });

  it("treats SI radians and missing assignments as factor 1", () => {
    const entities: Record<number, Entity> = {
      91: { ifcType: "IfcSIUnit", UnitType: val("PLANEANGLEUNIT"), Name: val("RADIAN") },
    };
    expect(planeAngleFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBe(1);
    expect(planeAngleFactor(null, () => null, () => "")).toBe(1);
  });

  it("resolves SI length prefixes", () => {
    const entities: Record<number, Entity> = {
      90: { ifcType: "IfcSIUnit", UnitType: val("PLANEANGLEUNIT"), Name: val("RADIAN") },
      91: { ifcType: "IfcSIUnit", UnitType: val("LENGTHUNIT"), Prefix: val("MILLI"), Name: val("METRE") },
    };
    expect(lengthUnitFactor({ Units: [ref(90), ref(91)] }, line(entities), typeName(entities))).toBe(0.001);

    entities[91].Prefix = val("CENTI");
    expect(lengthUnitFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBe(0.01);
    entities[91].Prefix = val("DECI");
    expect(lengthUnitFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBe(0.1);
  });

  it("resolves conversion based lengths through their SI component", () => {
    const entities: Record<number, Entity> = {
      91: { ifcType: "IfcConversionBasedUnit", UnitType: val("LENGTHUNIT"), ConversionFactor: ref(92) },
      92: { ifcType: "IfcMeasureWithUnit", ValueComponent: val(25.4), UnitComponent: ref(93) },
      93: { ifcType: "IfcSIUnit", UnitType: val("LENGTHUNIT"), Prefix: val("MILLI"), Name: val("METRE") },
    };
    expect(lengthUnitFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBeCloseTo(0.0254, 12);
  });

  it("treats unprefixed metres and missing assignments as factor 1", () => {
    const entities: Record<number, Entity> = {
      91: { ifcType: "IfcSIUnit", UnitType: val("LENGTHUNIT"), Name: val("METRE") },
    };
    expect(lengthUnitFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBe(1);
    expect(lengthUnitFactor(null, () => null, () => "")).toBe(1);
  });

  it("does not treat a blank conversion factor as zero", () => {
    const entities: Record<number, Entity> = {
      91: { ifcType: "IfcConversionBasedUnit", UnitType: val("LENGTHUNIT"), ConversionFactor: ref(92) },
      92: { ifcType: "IfcMeasureWithUnit", ValueComponent: val("  ") },
    };
    expect(lengthUnitFactor({ Units: [ref(91)] }, line(entities), typeName(entities))).toBe(1);
  });
});
