import { describe, expect, it } from "vitest";

import { definitionCapabilities, readSelector, type StagedRuleset, type StagedView } from "../src/capabilities/definitions.js";
import { disciplineOf, graphCapabilities } from "../src/capabilities/graph.js";
import { clearDocket, publishDocket } from "../src/ui/resultsDock.js";
import type { ViewerCapabilityContext } from "../src/capabilities/viewer.js";
import type { ModelBounds, SpatialNode, Viewer } from "../src/viewer-core/viewer.js";

const capability = (id: string) => {
  const found = [...definitionCapabilities(), ...graphCapabilities()].find((entry) => entry.id === id);
  if (!found) throw new Error(`no capability ${id}`);
  return found;
};

const run = (id: string, input: Record<string, unknown>, context?: Partial<ViewerCapabilityContext>): unknown =>
  capability(id).execute(input, (context ?? {}) as ViewerCapabilityContext, new AbortController().signal, () => undefined);

describe("reading a selector the model wrote", () => {
  it("accepts every kind the schema documents", () => {
    expect(readSelector({ kind: "all" })).toEqual({ kind: "all" });
    expect(readSelector({ kind: "class", values: ["IfcDoor"] })).toEqual({ kind: "class", values: ["IfcDoor"] });
    expect(readSelector({ kind: "property", name: "FireRating", op: "missing" }))
      .toEqual({ kind: "property", set: "", name: "FireRating", op: "missing", value: "" });
    expect(readSelector({ kind: "not", of: { kind: "all" } })).toEqual({ kind: "not", of: { kind: "all" } });
  });

  it("refuses a kind, a comparison or a shape it does not know", () => {
    expect(() => readSelector({ kind: "sql" })).toThrow(/Unknown selector kind/);
    expect(() => readSelector({ kind: "name", op: "regex", value: "x" })).toThrow(/Unknown comparison/);
    expect(() => readSelector({ kind: "class", values: [] })).toThrow(/at least one value/);
    expect(() => readSelector("everything")).toThrow(/must be an object/);
  });

  it("refuses a selector nested deeper than it needs to be", () => {
    let selector: unknown = { kind: "all" };
    for (let depth = 0; depth < 6; depth++) selector = { kind: "not", of: selector };
    expect(() => readSelector(selector)).toThrow(/four deep/);
  });
});

describe("authoring a view", () => {
  it("turns a request into a definition and explains every rule in words", () => {
    const staged = run("definition.view", {
      name: "Fire doors without a rating",
      filters: [
        { label: "Fire doors", mode: "keep", selector: { kind: "class", values: ["IfcDoor"] } },
        { label: "No rating", mode: "keep", selector: { kind: "property", name: "FireRating", op: "missing" } },
      ],
      color: "storey",
    }) as StagedView;
    expect(staged.staged).toBe("view");
    expect(staged.view.name).toBe("Fire doors without a rating");
    expect(staged.view.color).toEqual({ kind: "storey" });
    expect(staged.explains).toEqual(["Shows Door", "Shows FireRating is missing"]);
    expect(staged.portable).toBe(true);
  });

  it("never applies anything: the staged view carries no camera or section", () => {
    const staged = run("definition.view", { name: "Plain" }) as StagedView;
    expect(staged.view.camera).toBeNull();
    expect(staged.view.sections).toEqual([]);
    expect(capability("definition.view").effect).toBe("propose");
  });

  it("reads a bare property key as a colour rule", () => {
    const staged = run("definition.view", { name: "By rating", color: "Pset_DoorCommon.FireRating" }) as StagedView;
    expect(staged.view.color).toEqual({ kind: "property", key: "Pset_DoorCommon.FireRating" });
  });

  it("says when a rule names specific elements and so will not follow a revision", () => {
    const staged = run("definition.view", {
      name: "Picked",
      filters: [{ label: "Picked", selector: { kind: "ids", ids: [1, 2] } }],
    }) as StagedView;
    expect(staged.portable).toBe(false);
  });
});

describe("authoring a computed property", () => {
  it("stages a fallback chain", () => {
    const staged = run("definition.property", {
      name: "Fire rating",
      kind: "coalesce",
      sources: ["Pset_DoorCommon.FireRating", "FireRating"],
    }) as { staged: string; property: { name: string; sources: string[] } };
    expect(staged.staged).toBe("property");
    expect(staged.property.sources).toEqual(["Pset_DoorCommon.FireRating", "FireRating"]);
  });

  it("refuses a formula that does not parse, before anybody saves it", () => {
    expect(() => run("definition.property", { name: "Bad", kind: "formula", expression: "1 +" })).toThrow();
    expect(() => run("definition.property", { name: "Nope", kind: "sql" })).toThrow(/Unknown computed property kind/);
  });
});

describe("authoring a ruleset", () => {
  it("stages named rules with their severity and scope", () => {
    const staged = run("definition.ruleset", {
      name: "Handover gate",
      rules: [
        { ruleId: "duplicate-globalid", severity: "error" },
        { ruleId: "unclassified", severity: "warning", scope: { kind: "class", values: ["IfcWall"] } },
      ],
    }) as StagedRuleset;
    expect(staged.ruleset.rules).toHaveLength(2);
    expect(staged.ruleset.rules[1].scope).toEqual({ kind: "class", values: ["IfcWall"] });
    expect(staged.ruleset.rules[1].severity).toBe("warning");
  });

  it("refuses an empty ruleset and a rule with no id", () => {
    expect(() => run("definition.ruleset", { name: "Empty", rules: [] })).toThrow(/at least one rule/);
    expect(() => run("definition.ruleset", { name: "Bad", rules: [{}] })).toThrow(/ruleId/);
  });
});

// -- the graph --------------------------------------------------------------

const node = (expressID: number, type: string, name: string | null, children: SpatialNode[] = []): SpatialNode =>
  ({ expressID, type, name, children });

const bounds = (min: [number, number, number], max: [number, number, number]): ModelBounds =>
  ({ min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] } }) as ModelBounds;

function fakeViewer(): Viewer {
  const boxes = new Map<number, ModelBounds>([
    [10, bounds([0, 0, 0], [10, 0.3, 0.3])],
    [20, bounds([0, 0, 0], [4, 3, 4])],
    [21, bounds([6, 0, 0], [10, 3, 4])],
    [22, bounds([20, 0, 0], [24, 3, 4])],
  ]);
  return {
    getSpatialTree: () =>
      node(1, "IfcProject", "P", [
        node(2, "IfcBuildingStorey", "Level 1", [
          node(10, "IfcDuctSegment", "Supply duct"),
          node(20, "IfcSpace", "Office"),
          node(21, "IfcSpace", "Corridor"),
          node(22, "IfcSpace", "Plant"),
        ]),
      ]),
    getElementBounds: (id: number) => boxes.get(id) ?? null,
    getElementTypes: () => new Map([[10, "IfcDuctSegment"], [20, "IfcSpace"], [21, "IfcSpace"], [22, "IfcSpace"]]),
    getSelectedIds: () => [],
  } as unknown as Viewer;
}

describe("the relationship graph", () => {
  it("answers which spaces an element passes through", () => {
    const answer = run("graph.spaces", { expressId: 10 }, { viewer: fakeViewer() }) as {
      elements: Array<{ spaces: Array<{ name: string }> }>;
    };
    expect(answer.elements[0].spaces.map((space) => space.name)).toEqual(["Office", "Corridor"]);
  });

  it("reports the spatial path and the storey population", () => {
    const answer = run("graph.neighbours", { expressId: 10 }, { viewer: fakeViewer() }) as {
      path: Array<{ type: string }>;
      storeyPopulation: Array<{ type: string; count: number }>;
    };
    expect(answer.path.map((step) => step.type)).toEqual(["IfcProject", "IfcBuildingStorey", "IfcDuctSegment"]);
    expect(answer.storeyPopulation[0]).toEqual({ type: "IfcSpace", count: 3 });
  });

  it("only pays for the geometry pass when asked", () => {
    const plain = run("graph.neighbours", { expressId: 10 }, { viewer: fakeViewer() }) as Record<string, unknown>;
    expect(plain.touching).toBeUndefined();
    const full = run("graph.neighbours", { expressId: 10, touching: true }, { viewer: fakeViewer() }) as {
      touching: Array<{ id: number }>;
    };
    expect(full.touching.map((entry) => entry.id)).toEqual([20, 21]);
  });

  it("says plainly when an element is not in the spatial structure", () => {
    expect(() => run("graph.neighbours", { expressId: 999 }, { viewer: fakeViewer() })).toThrow(/not in the spatial structure/);
  });
});

describe("docket triage", () => {
  it("says there is nothing to triage rather than inventing groups", () => {
    clearDocket();
    const answer = run("docket.triage", {}, { viewer: fakeViewer() }) as { groups: unknown[]; note: string };
    expect(answer.groups).toEqual([]);
    expect(answer.note).toContain("Nothing is on the docket");
  });

  it("groups by producer and rule, ranks errors first and proposes a discipline", () => {
    clearDocket();
    publishDocket({
      id: "rules",
      producer: "Rule Studio",
      title: "Model receipt",
      summary: "",
      rows: [
        { id: "1", severity: "warning", title: "Duct overlaps duct", group: "Self-intersection", ids: [10] },
        { id: "2", severity: "error", title: "Space does not close", group: "Unbounded space", ids: [20] },
        { id: "3", severity: "error", title: "Space does not close", group: "Unbounded space", ids: [21] },
      ],
    });
    const answer = run("docket.triage", {}, { viewer: fakeViewer() }) as {
      groups: Array<{ group: string; errors: number; elements: number; discipline: string; draftComment: string }>;
    };
    expect(answer.groups[0].group).toBe("Unbounded space");
    expect(answer.groups[0].errors).toBe(2);
    expect(answer.groups[0].elements).toBe(2);
    expect(answer.groups[1].discipline).toBe("MEP");
    expect(answer.groups[0].draftComment).toContain("Model receipt");
    clearDocket();
  });

  it("proposes a discipline from the classes involved, and says Unknown when it cannot", () => {
    expect(disciplineOf(["IfcDuctSegment", "IfcPipeFitting"])).toBe("MEP");
    expect(disciplineOf(["IfcBeam", "IfcColumn"])).toBe("Structure");
    expect(disciplineOf(["IfcWall", "IfcDoor"])).toBe("Architecture");
    expect(disciplineOf([])).toBe("Unknown");
  });
});
