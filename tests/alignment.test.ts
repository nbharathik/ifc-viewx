import { describe, expect, it } from "vitest";

import { chainage, positionAt, readAlignments, sampleAt } from "../src/ifc/alignment.js";
import { schemaRow, SCHEMA_MATRIX } from "../src/ifc/schemas.js";
import type { IfcModel } from "../src/ifc/model.js";

/** web-ifc wraps every attribute; the reader has to unwrap exactly this shape. */
const v = (value: unknown) => ({ value });
const r = (id: number) => ({ value: id });

interface Entity {
  type: string;
  line: Record<string, unknown>;
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function fakeModel(entities: Record<number, Entity>, coordination: number[] = IDENTITY): IfcModel {
  const ids = Object.keys(entities).map(Number);
  return {
    api: { GetCoordinationMatrix: () => coordination },
    id: 0,
    schema: "IFC4X3",
    byType: (name: string) => ids.filter((id) => entities[id].type === name),
    typeName: (id: number) => entities[id]?.type ?? "",
    isType: (id: number, name: string) => entities[id]?.type === name,
    line: (id: number) => entities[id]?.line ?? null,
  } as unknown as IfcModel;
}

/**
 * A straight 100 m run, then a 90 degree left arc of radius 50, with a
 * vertical profile that climbs at 2% and then levels off.
 */
function roadModel(): Record<number, Entity> {
  return {
    1: { type: "IfcAlignment", line: { Name: v("A1 mainline") } },
    2: { type: "IfcAlignmentHorizontal", line: {} },
    3: { type: "IfcAlignmentVertical", line: {} },
    10: { type: "IfcAlignmentSegment", line: { DesignParameters: r(11) } },
    11: {
      type: "IfcAlignmentHorizontalSegment",
      line: {
        StartPoint: r(12),
        StartDirection: v(0),
        StartRadiusOfCurvature: v(0),
        EndRadiusOfCurvature: v(0),
        SegmentLength: v(100),
        PredefinedType: v("LINE"),
      },
    },
    12: { type: "IfcCartesianPoint", line: { Coordinates: [v(0), v(0)] } },
    13: { type: "IfcAlignmentSegment", line: { DesignParameters: r(14) } },
    14: {
      type: "IfcAlignmentHorizontalSegment",
      line: {
        StartPoint: r(15),
        StartDirection: v(0),
        StartRadiusOfCurvature: v(50),
        EndRadiusOfCurvature: v(50),
        SegmentLength: v((Math.PI / 2) * 50),
        PredefinedType: v("CIRCULARARC"),
      },
    },
    15: { type: "IfcCartesianPoint", line: { Coordinates: [v(100), v(0)] } },
    20: { type: "IfcAlignmentSegment", line: { DesignParameters: r(21) } },
    21: {
      type: "IfcAlignmentVerticalSegment",
      line: {
        StartDistAlong: v(0),
        HorizontalLength: v(100),
        StartHeight: v(10),
        StartGradient: v(0.02),
        EndGradient: v(0.02),
        PredefinedType: v("CONSTANTGRADIENT"),
      },
    },
    30: {
      type: "IfcRelNests",
      line: { RelatingObject: r(1), RelatedObjects: [r(2), r(3)] },
    },
    31: {
      type: "IfcRelNests",
      line: { RelatingObject: r(2), RelatedObjects: [r(10), r(13)] },
    },
    32: {
      type: "IfcRelNests",
      line: { RelatingObject: r(3), RelatedObjects: [r(20)] },
    },
  };
}

describe("reading an alignment", () => {
  it("finds it, names it and reports its segment counts", () => {
    const report = readAlignments(fakeModel(roadModel()));
    expect(report.alignments).toHaveLength(1);
    const alignment = report.alignments[0];
    expect(alignment.name).toBe("A1 mainline");
    expect(alignment.horizontalSegments).toBe(2);
    expect(alignment.verticalSegments).toBe(1);
    expect(alignment.hasVertical).toBe(true);
  });

  it("runs the straight along its own bearing", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    const at = positionAt(alignment, 50);
    expect(at?.point[0]).toBeCloseTo(50, 6);
    expect(at?.point[2]).toBeCloseTo(0, 6);
  });

  it("turns the circular arc through the right angle and radius", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    // A quarter turn left from IFC (100,0) ends at scene (150,height,-50).
    const end = positionAt(alignment, alignment.length);
    expect(end?.point[0]).toBeCloseTo(150, 1);
    expect(end?.point[2]).toBeCloseTo(-50, 1);
    expect(end?.direction).toBeCloseTo(Math.PI / 2, 2);
  });

  it("lifts the path onto the vertical profile", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    expect(positionAt(alignment, 0)?.point[1]).toBeCloseTo(10, 6);
    expect(positionAt(alignment, 100)?.point[1]).toBeCloseTo(12, 6);
  });

  it("totals the length from the segments themselves", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    expect(alignment.length).toBeCloseTo(100 + (Math.PI / 2) * 50, 2);
  });

  it("integrates a transition curve between its two curvatures", () => {
    const entities = roadModel();
    entities[14].line.StartRadiusOfCurvature = v(0);
    entities[14].line.EndRadiusOfCurvature = v(50);
    entities[14].line.PredefinedType = v("CLOTHOID");
    entities[14].line.SegmentLength = v(60);
    const alignment = readAlignments(fakeModel(entities)).alignments[0];
    const end = positionAt(alignment, alignment.length);
    // A clothoid from straight into radius 50 over 60 m turns 0.6 rad.
    expect(end?.direction).toBeCloseTo(0.6, 2);
    expect(end?.point[0]).toBeGreaterThan(100);
    expect(alignment.approximated).toEqual([]);
  });

  it("names a transition kind it approximated rather than pretending it solved it", () => {
    const entities = roadModel();
    entities[14].line.PredefinedType = v("BLOSSCURVE");
    entities[14].line.StartRadiusOfCurvature = v(0);
    const alignment = readAlignments(fakeModel(entities)).alignments[0];
    expect(alignment.approximated).toEqual(["OTHER"]);
  });

  it("counts an alignment with no usable segments as empty rather than listing it", () => {
    const entities = roadModel();
    delete entities[31];
    const report = readAlignments(fakeModel(entities));
    expect(report.alignments).toHaveLength(0);
    expect(report.empty).toBe(1);
  });

  it("returns a flat path when there is no vertical profile", () => {
    const entities = roadModel();
    delete entities[32];
    const alignment = readAlignments(fakeModel(entities)).alignments[0];
    expect(alignment.hasVertical).toBe(false);
    expect(alignment.points.every((point) => point.point[1] === 0)).toBe(true);
  });

  it("converts project length and plane-angle units before returning scene samples", () => {
    const entities = roadModel();
    entities[31].line.RelatedObjects = [r(10)];
    entities[11].line.StartDirection = v(90);
    entities[11].line.SegmentLength = v(1000);
    entities[21].line.HorizontalLength = v(1000);
    entities[21].line.StartHeight = v(2000);
    entities[21].line.StartGradient = v(0);
    entities[100] = { type: "IfcUnitAssignment", line: { Units: [r(101), r(102)] } };
    entities[101] = { type: "IfcSIUnit", line: { UnitType: v("LENGTHUNIT"), Prefix: v("MILLI") } };
    entities[102] = {
      type: "IfcConversionBasedUnit",
      line: { UnitType: v("PLANEANGLEUNIT"), ConversionFactor: r(103) },
    };
    entities[103] = {
      type: "IfcMeasureWithUnit",
      line: { ValueComponent: v(Math.PI / 180), UnitComponent: r(104) },
    };
    entities[104] = { type: "IfcSIUnit", line: { UnitType: v("PLANEANGLEUNIT") } };

    const alignment = readAlignments(fakeModel(entities)).alignments[0];
    const start = positionAt(alignment, 0);
    const end = positionAt(alignment, alignment.length);
    expect(alignment.length).toBeCloseTo(1, 9);
    expect(start?.point).toEqual([0, 2, 0]);
    expect(end?.point[0]).toBeCloseTo(0, 9);
    expect(end?.point[1]).toBeCloseTo(2, 9);
    expect(end?.point[2]).toBeCloseTo(-1, 9);
    expect(end?.direction).toBeCloseTo(Math.PI / 2, 9);
  });

  it("matches rendered geometry through root placement and coordination transforms", () => {
    const entities = roadModel();
    entities[31].line.RelatedObjects = [r(10)];
    entities[1].line.ObjectPlacement = r(200);
    entities[200] = {
      type: "IfcLocalPlacement",
      line: { PlacementRelTo: null, RelativePlacement: r(201) },
    };
    entities[201] = {
      type: "IfcAxis2Placement3D",
      line: { Location: r(202), Axis: r(203), RefDirection: r(204) },
    };
    entities[202] = { type: "IfcCartesianPoint", line: { Coordinates: [v(10), v(20), v(3)] } };
    entities[203] = { type: "IfcDirection", line: { DirectionRatios: [v(0), v(0), v(1)] } };
    entities[204] = { type: "IfcDirection", line: { DirectionRatios: [v(0), v(1), v(0)] } };
    const coordination = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 100, 5, -7, 1];

    const alignment = readAlignments(fakeModel(entities, coordination)).alignments[0];
    expect(positionAt(alignment, 0)?.point).toEqual([110, 18, -27]);
    expect(positionAt(alignment, 100)?.point).toEqual([110, 20, -127]);
    expect(positionAt(alignment, 50)?.direction).toBeCloseTo(Math.PI / 2, 9);
  });

  it("skips an alignment whose non-local placement cannot be evaluated safely", () => {
    const entities = roadModel();
    entities[1].line.ObjectPlacement = r(200);
    entities[200] = { type: "IfcLinearPlacement", line: {} };
    const report = readAlignments(fakeModel(entities));
    expect(report.alignments).toEqual([]);
    expect(report.empty).toBe(1);
  });
});

describe("stations", () => {
  it("formats a chainage the way a drawing writes it", () => {
    expect(chainage(1240)).toBe("1+240.00");
    expect(chainage(0)).toBe("0+000.00");
    expect(chainage(85.5)).toBe("0+085.50");
  });

  it("clamps a position outside the alignment to its ends", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    expect(positionAt(alignment, -50)?.station).toBe(0);
    expect(positionAt(alignment, 1e6)?.station).toBeCloseTo(alignment.length, 2);
  });

  it("finds the nearest sample to a station", () => {
    const alignment = readAlignments(fakeModel(roadModel())).alignments[0];
    const near = sampleAt(alignment, 60);
    expect(near).not.toBeNull();
    expect(Math.abs((near?.station ?? 0) - 60)).toBeLessThan(60);
  });
});

describe("the schema matrix", () => {
  it("matches supported declarations without falling back by prefix", () => {
    expect(schemaRow("IFC4X3_ADD2")?.schema).toBe("IFC4X3");
    expect(schemaRow("IFC4.3 ADD2")?.schema).toBe("IFC4X3");
    expect(schemaRow("IFC4X3_RC4")?.schema).toBe("IFC4X3");
    expect(schemaRow("IFC4")?.schema).toBe("IFC4");
    expect(schemaRow("IFC2X3")?.schema).toBe("IFC2X3");
    expect(schemaRow("IFC9")).toBeNull();
    expect(schemaRow("IFC4X9")).toBeNull();
    expect(schemaRow("IFC4X30")).toBeNull();
    expect(schemaRow("IFC4X3_FUTURE")).toBeNull();
  });

  it("says plainly that a building schema carries no alignments", () => {
    expect(schemaRow("IFC4")?.linear).toBe("none");
    expect(schemaRow("IFC4X3")?.linear).toBe("partial");
    expect(SCHEMA_MATRIX.every((row) => row.note.length > 0)).toBe(true);
  });
});
