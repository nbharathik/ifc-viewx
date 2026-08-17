// IDS validation, driven through the real XML parser and the real runner.
//
// The case that matters most is the one that used to be silently wrong: a
// specification whose applicability the validator cannot evaluate. Returning
// "true" there made the spec apply to every element in the model, so its
// requirements were checked against the wrong set and the result still read
// like a clean pass.
import { describe, expect, it } from "vitest";
import { idsReport, loadIds } from "../src/ui/ids.js";
import type { ItemProperties, SpatialNode, Viewer } from "../src/viewer-core/viewer.js";

const ids = (body: string): string =>
  `<?xml version="1.0"?><ids xmlns="http://standards.buildingsmart.org/IDS">
     <info><title>Test</title></info>
     <specifications>${body}</specifications>
   </ids>`;

const entity = (name: string): string =>
  `<entity><name><simpleValue>${name}</simpleValue></name></entity>`;

const spec = (applicability: string, requirements: string, name = "Spec"): string =>
  `<specification name="${name}">
     <applicability minOccurs="1" maxOccurs="unbounded">${applicability}</applicability>
     <requirements>${requirements}</requirements>
   </specification>`;

const props = (
  expressID: number,
  type: string,
  attrs: Record<string, string | number> = {},
  psets: Record<string, Record<string, string | number>> = {},
  related: Partial<ItemProperties> = {},
): ItemProperties =>
  ({
    expressID,
    type,
    attributes: Object.entries(attrs).map(([name, value]) => ({ name, value })),
    psets: Object.entries(psets).map(([name, values]) => ({
      name,
      kind: "pset",
      properties: Object.entries(values).map(([n, v]) => ({ name: n, value: v })),
    })),
    classifications: [],
    materials: [],
    partOf: [],
    ...related,
  }) as unknown as ItemProperties;

const TREE: SpatialNode = {
  expressID: 1,
  type: "IfcProject",
  name: "P",
  children: [
    {
      expressID: 2,
      type: "IfcBuildingStorey",
      name: "Level 1",
      children: [
        { expressID: 10, type: "IfcWall", name: "Wall in storey", children: [] },
      ],
    },
    // Deliberately outside any storey: this is what a partOf check catches.
    { expressID: 11, type: "IfcWall", name: "Orphan wall", children: [] },
  ],
} as SpatialNode;

const ELEMENTS: ItemProperties[] = [
  props(10, "IfcWall", { Name: "Wall in storey" }, { Pset_WallCommon: { IsExternal: "true", FireRating: "60" } }, {
    classifications: [{ system: "Uniclass", value: "EF_25", name: "Walls", uri: "https://identifier.buildingsmart.org/uri/test/uniclass/1.0/class/EF_25" }],
    materials: [{ name: "Concrete", category: "structural", code: "concrete", uri: "https://identifier.buildingsmart.org/uri/test/materials/1.0/class/concrete" }],
    partOf: [{ relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE", expressID: 2, type: "IfcBuildingStorey", name: "Level 1" }],
  }),
  props(11, "IfcWall", { Name: "Orphan wall" }, { Pset_WallCommon: { IsExternal: "true" } }, {
    classifications: [{ system: "Uniclass", value: "EF_25", name: "Walls", uri: null }],
    materials: [{ name: "Steel", category: "structural", code: null, uri: null }],
  }),
  props(20, "IfcDoor", { Name: "Door" }, {}, {
    partOf: [
      { relation: "IFCRELFILLSELEMENT", expressID: 21, type: "IfcOpeningElement", name: "Door opening" },
      { relation: "IFCRELVOIDSELEMENT", expressID: 10, type: "IfcWall", name: "Wall in storey" },
    ],
  }),
];

function viewer(): Viewer {
  const byId = new Map(ELEMENTS.map((p) => [p.expressID, p]));
  return {
    getElementTypes: () => new Map(ELEMENTS.map((p) => [p.expressID, p.type])),
    getProperties: async (id: number) => byId.get(id) ?? null,
    getSpatialTree: () => TREE,
  } as unknown as Viewer;
}

type SpecReport = {
  name: string;
  status: string;
  applicable: number;
  passed: number;
  failed: number;
  blockedBy: string[];
};

const run = async (xml: string): Promise<{ specs: SpecReport[]; notRun: number }> => {
  loadIds(xml, "test.ids");
  const report = await idsReport(viewer());
  return {
    specs: report.specifications as SpecReport[],
    notRun: report.notRunSpecifications as number,
  };
};

describe("supported facets", () => {
  it("passes a property requirement every applicable element meets", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>IsExternal</simpleValue></baseName></property>`,
    )));
    expect(specs[0]).toMatchObject({ status: "pass", applicable: 2, passed: 2, failed: 0 });
  });

  it("fails the element that is missing the property", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>FireRating</simpleValue></baseName></property>`,
    )));
    expect(specs[0]).toMatchObject({ status: "fail", applicable: 2, passed: 1, failed: 1 });
  });

  it("scopes applicability by class", async () => {
    const { specs } = await run(ids(spec(entity("IfcDoor"), `<attribute><name><simpleValue>Name</simpleValue></name></attribute>`)));
    expect(specs[0].applicable).toBe(1);
  });
});

describe("partOf", () => {
  it("passes the wall inside a storey and fails the orphan", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<partOf relation="IFCRELCONTAINEDINSPATIALSTRUCTURE">${entity("IfcBuildingStorey")}</partOf>`,
    )));
    expect(specs[0]).toMatchObject({ status: "fail", applicable: 2, passed: 1, failed: 1 });
  });

  it("matches an ancestor by name as well as by class", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<partOf><entity><name><simpleValue>Level 1</simpleValue></name></entity></partOf>`,
    )));
    expect(specs[0].passed).toBe(1);
  });

  it("evaluates the combined void and fill relationship path", async () => {
    const { specs, notRun } = await run(ids(spec(
      entity("IfcDoor"),
      `<partOf relation="IFCRELVOIDSELEMENT IFCRELFILLSELEMENT">${entity("IfcWall")}</partOf>`,
    )));
    expect(specs[0]).toMatchObject({ status: "pass", applicable: 1, passed: 1 });
    expect(notRun).toBe(0);
  });
});

describe("classification and material", () => {
  const CLASSIFICATION = `<classification><system><simpleValue>Uniclass</simpleValue></system></classification>`;
  const MATERIAL = `<material><value><simpleValue>Concrete</simpleValue></value></material>`;

  it("scopes material applicability to the associated material", async () => {
    const { specs, notRun } = await run(ids(spec(MATERIAL, `<attribute><name><simpleValue>Name</simpleValue></name></attribute>`)));
    expect(specs[0]).toMatchObject({ status: "pass", applicable: 1, passed: 1 });
    expect(notRun).toBe(0);
  });

  it("matches a classification system", async () => {
    const { specs } = await run(ids(spec(CLASSIFICATION, `<attribute><name><simpleValue>Name</simpleValue></name></attribute>`)));
    expect(specs[0]).toMatchObject({ status: "pass", applicable: 2, passed: 2, blockedBy: [] });
  });

  it("matches a classification value as well as its system", async () => {
    const value = `<classification><value><simpleValue>EF_25</simpleValue></value><system><simpleValue>Uniclass</simpleValue></system></classification>`;
    const { specs } = await run(ids(spec(value, `<attribute><name><simpleValue>Name</simpleValue></name></attribute>`)));
    expect(specs[0].applicable).toBe(2);
  });

  it("still runs a spec whose applicability is fine but a requirement is not", async () => {
    const { specs } = await run(ids(spec(entity("IfcWall"), MATERIAL)));
    // Applicability is evaluable, so the element set is known and reported.
    expect(specs[0].status).not.toBe("not_run");
    expect(specs[0].applicable).toBe(2);
    expect(specs[0].blockedBy).toEqual([]);
  });

  it("checks material requirements and suggests a correction", async () => {
    loadIds(ids(spec(entity("IfcWall"), MATERIAL)), "test.ids");
    const report = await idsReport(viewer());
    const first = report.specifications[0];
    expect(first).toMatchObject({ status: "fail", failed: 1, notChecked: [] });
    expect(first.failures[0].suggestion).toMatch(/Assign material/);
  });
});

describe("restrictions", () => {
  it("matches an enumeration", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>IsExternal</simpleValue></baseName>
        <value><restriction><enumeration value="true"/><enumeration value="false"/></restriction></value>
      </property>`,
    )));
    expect(specs[0].passed).toBe(2);
  });

  it("enforces a numeric bound", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>FireRating</simpleValue></baseName>
        <value><restriction><minInclusive value="90"/></restriction></value>
      </property>`,
    )));
    // 60 does not reach 90, and the orphan has no FireRating at all.
    expect(specs[0].failed).toBe(2);
  });

  it("matches a pattern", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<attribute><name><simpleValue>Name</simpleValue></name>
        <value><restriction><pattern value=".*wall.*"/></restriction></value></attribute>`,
    )));
    // Case sensitive by specification: "Wall in storey" has a capital W.
    expect(specs[0].passed).toBe(1);
  });
});

describe("cardinality", () => {
  it("optional never fails", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property cardinality="optional"><propertySet><simpleValue>Nope</simpleValue></propertySet>
        <baseName><simpleValue>Missing</simpleValue></baseName></property>`,
    )));
    expect(specs[0].failed).toBe(0);
  });

  it("prohibited inverts the result", async () => {
    const { specs } = await run(ids(spec(
      entity("IfcWall"),
      `<property cardinality="prohibited"><propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
        <baseName><simpleValue>IsExternal</simpleValue></baseName></property>`,
    )));
    // Both walls have IsExternal, and it is prohibited, so both fail.
    expect(specs[0].failed).toBe(2);
  });
});

describe("applicability occurrences", () => {
  it("fails when fewer elements are applicable than required", async () => {
    const xml = ids(`<specification name="Doors"><applicability minOccurs="2" maxOccurs="unbounded">${entity("IfcDoor")}</applicability></specification>`);
    const { specs } = await run(xml);
    expect(specs[0]).toMatchObject({ status: "fail", applicable: 1, failed: 1 });
  });

  it("passes an optional specification with no applicable elements", async () => {
    const xml = ids(`<specification name="Windows"><applicability minOccurs="0" maxOccurs="unbounded">${entity("IfcWindow")}</applicability></specification>`);
    const { specs, notRun } = await run(xml);
    expect(specs[0]).toMatchObject({ status: "pass", applicable: 0, failed: 0 });
    expect(notRun).toBe(0);
  });
});

describe("document errors", () => {
  it("rejects non-XML", () => {
    expect(() => loadIds("not xml at all", "x.ids")).toThrow(/XML/);
  });

  it("rejects XML that is not an IDS", () => {
    expect(() => loadIds("<?xml version='1.0'?><root/>", "x.ids")).toThrow(/IDS document/);
  });

  it("rejects an IDS with no specifications", () => {
    expect(() => loadIds(ids(""), "x.ids")).toThrow(/no specifications/);
  });
});
