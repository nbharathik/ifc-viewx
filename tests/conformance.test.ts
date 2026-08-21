import { describe, expect, it } from "vitest";

import { checkConformance, FAMILY_LABEL } from "../src/ifc/conformance.js";
import type { IfcModel } from "../src/ifc/model.js";

/** web-ifc's scalar and entity-reference wrapper. */
const v = (value: unknown) => ({ value });

interface Entity {
  type: string;
  line?: Record<string, unknown>;
  guid?: string | null;
  container?: number | null;
  aggregate?: number | null;
}

/** A model made of literals: the checks read an entity model, not a file. */
function fakeModel(entities: Record<number, Entity>, schema = "IFC4"): IfcModel {
  const ids = Object.keys(entities).map(Number);
  const inherits: Record<string, string[]> = {
    IfcRoot: ["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey", "IfcWall", "IfcDoor", "IfcPropertySet", "IfcWallType", "IfcRelDefinesByType"],
    IfcElement: ["IfcWall", "IfcDoor"],
    IfcTypeObject: ["IfcWallType"],
  };
  const isType = (id: number, name: string): boolean => {
    const type = entities[id]?.type ?? "";
    if (type === name) return true;
    return (inherits[name] ?? []).includes(type);
  };
  return {
    schema,
    byType: (name: string) => ids.filter((id) => isType(id, name)),
    typeName: (id: number) => entities[id]?.type ?? "",
    line: (id: number) => entities[id]?.line ?? null,
    guidOf: (id: number) => (entities[id]?.guid === undefined ? `guid${id}`.padEnd(22, "0") : entities[id].guid),
    containerOf: (id: number) => entities[id]?.container ?? null,
    aggregateOf: (id: number) => entities[id]?.aggregate ?? null,
  } as unknown as IfcModel;
}

/** A file that should pass everything the browser half can decide. */
const clean = (): Record<number, Entity> => ({
  1: { type: "IfcProject", line: { UnitsInContext: v(9), RepresentationContexts: [v(8)] } },
  2: { type: "IfcSite", line: {} },
  3: { type: "IfcBuilding", line: {} },
  4: { type: "IfcBuildingStorey", line: { Elevation: v(0) } },
  5: { type: "IfcWall", line: { Name: v("Core wall"), ObjectPlacement: v(20), OwnerHistory: v(21) }, container: 4 },
  6: { type: "IfcPropertySet", line: { HasProperties: [v(30)] } },
  // web-ifc exposes the forward relationship, not the inverse `Types` field.
  7: { type: "IfcWallType", line: {} },
  8: { type: "IfcRelDefinesByType", line: { RelatingType: v(7), RelatedObjects: [v(5)] } },
});

const outcome = (report: ReturnType<typeof checkConformance>, id: string) =>
  report.checks.find((check) => check.id === id)?.outcome;

describe("conformance", () => {
  it("passes a well-formed file and never claims to have uploaded anything", () => {
    const report = checkConformance(fakeModel(clean()));
    expect(report.failed).toBe(0);
    expect(report.offline).toBe(true);
    expect(outcome(report, "SCH001")).toBe("pass");
    expect(outcome(report, "AGR002")).toBe("pass");
  });

  it("rejects a schema it does not implement", () => {
    expect(outcome(checkConformance(fakeModel(clean(), "IFC1X9")), "SCH001")).toBe("fail");
    const future = checkConformance(fakeModel(clean(), "IFC4X9"));
    expect(outcome(future, "SCH001")).toBe("fail");
    expect(future.checks.find((check) => check.id === "SCH001")?.count).toBe(1);
    expect(outcome(checkConformance(fakeModel(clean(), "IFC4X3_ADD2")), "SCH001")).toBe("pass");
    expect(outcome(checkConformance(fakeModel(clean(), "IFC4X3_RC4")), "SCH001")).toBe("pass");
  });

  it("catches a missing, malformed or duplicated GlobalId", () => {
    const entities = clean();
    entities[5].guid = null;
    entities[6].guid = "not a guid";
    entities[7].guid = "guid4".padEnd(22, "0");
    entities[4].guid = "guid4".padEnd(22, "0");
    const report = checkConformance(fakeModel(entities));
    expect(outcome(report, "SCH002")).toBe("fail");
    expect(outcome(report, "SCH003")).toBe("fail");
    expect(outcome(report, "SCH004")).toBe("fail");
  });

  it("counts more than one project as a fault", () => {
    const entities = clean();
    entities[10] = { type: "IfcProject", line: { UnitsInContext: 9, RepresentationContexts: [8] } };
    expect(outcome(checkConformance(fakeModel(entities)), "SCH005")).toBe("fail");
  });

  it("does not judge units when there is no project to judge", () => {
    const entities = clean();
    delete entities[1];
    expect(outcome(checkConformance(fakeModel(entities)), "SCH006")).toBe("not_applicable");
  });

  it("treats null-wrapped references and empty reference lists as missing", () => {
    const entities = clean();
    entities[1].line = { UnitsInContext: v(null), RepresentationContexts: [v(null)] };
    entities[5].line = { Name: v("Core wall"), ObjectPlacement: v(null), OwnerHistory: v(null) };
    entities[6].line = { HasProperties: [v(null)] };
    const report = checkConformance(fakeModel(entities));
    expect(outcome(report, "SCH006")).toBe("fail");
    expect(outcome(report, "SCH007")).toBe("fail");
    expect(outcome(report, "AGR001")).toBe("fail");
    expect(outcome(report, "AGR003")).toBe("fail");
    expect(outcome(report, "PRP001")).toBe("fail");
  });

  it("catches an element with no placement, no container or no owner history", () => {
    const entities = clean();
    entities[5].line = { Name: "Core wall" };
    entities[5].container = null;
    const report = checkConformance(fakeModel(entities));
    expect(outcome(report, "AGR001")).toBe("fail");
    expect(outcome(report, "AGR002")).toBe("fail");
    expect(outcome(report, "AGR003")).toBe("fail");
    expect(report.checks.find((check) => check.id === "AGR001")?.sample[0].expressID).toBe(5);
  });

  it("catches a storey with no elevation", () => {
    const entities = clean();
    entities[4].line = {};
    expect(outcome(checkConformance(fakeModel(entities)), "AGR005")).toBe("fail");
  });

  it("unwraps web-ifc values when checking elevations and names", () => {
    const entities = clean();
    entities[4].line = { Elevation: v(null) };
    entities[5].line = { Name: v("  "), ObjectPlacement: 20, OwnerHistory: 21 };
    const report = checkConformance(fakeModel(entities));
    expect(outcome(report, "AGR005")).toBe("fail");
    expect(outcome(report, "PRP002")).toBe("fail");
  });

  it("catches an empty property set, an unnamed element and an unused type", () => {
    const entities = clean();
    entities[6].line = { HasProperties: [] };
    entities[5].line = { Name: v("  "), ObjectPlacement: 20, OwnerHistory: 21 };
    // A fabricated inverse must not hide the missing forward relationship.
    entities[7].line = { Types: [v(5)] };
    entities[8].line = { RelatingType: v(7), RelatedObjects: [] };
    const report = checkConformance(fakeModel(entities));
    expect(outcome(report, "PRP001")).toBe("fail");
    expect(outcome(report, "PRP002")).toBe("fail");
    expect(outcome(report, "PRP003")).toBe("fail");
  });

  it("names the normative rules it cannot run rather than skipping them silently", () => {
    const report = checkConformance(fakeModel(clean()));
    const gherkin = report.checks.filter((check) => check.family === "gherkin");
    expect(gherkin.length).toBeGreaterThan(0);
    expect(gherkin.every((check) => check.outcome === "not_run")).toBe(true);
    expect(report.notRun).toBe(gherkin.length);
    expect(gherkin[0].detail).toContain("Local Studio");
  });

  it("labels every family it reports", () => {
    const report = checkConformance(fakeModel(clean()));
    for (const check of report.checks) expect(FAMILY_LABEL[check.family]).toBeTruthy();
  });

  it("caps the sample it carries, so a broken file does not produce a megabyte of report", () => {
    const entities: Record<number, Entity> = clean();
    for (let id = 100; id < 200; id++) entities[id] = { type: "IfcWall", line: { Name: "x" }, container: 4 };
    const report = checkConformance(fakeModel(entities));
    const placement = report.checks.find((check) => check.id === "AGR001");
    expect(placement?.count).toBe(100);
    expect(placement?.sample.length).toBe(20);
  });
});
