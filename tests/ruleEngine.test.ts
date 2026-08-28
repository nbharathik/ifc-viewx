import { describe, expect, it } from "vitest";

import {
  defaultRuleset,
  findRule,
  parseRuleset,
  resolveRule,
  ruleDefinitions,
  runRuleset,
  serializeRuleset,
  type Box,
  type RuleModel,
  type Ruleset,
} from "../src/rules/engine.js";
import "../src/rules/library.js";
import { storeyBands } from "../src/rules/contextModel.js";
import type { ElementRow } from "../src/sdk/data.js";

interface Fixture {
  id: number;
  type: string;
  name?: string;
  storey?: string;
  globalId?: string;
  props?: Record<string, unknown>;
  box?: Box | null;
  volume?: { volume: number; closed: boolean };
  signature?: { hash: string; translation: [number, number, number] };
}

const box = (
  min: [number, number, number],
  size: [number, number, number],
): Box => ({ min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] });

function model(fixtures: Fixture[], clashes: Array<[number, number]> = []): RuleModel {
  const rows: ElementRow[] = fixtures.map((fixture) => ({
    id: fixture.id,
    type: fixture.type,
    name: fixture.name ?? "",
    storey: fixture.storey ?? "Level 1",
    globalId: fixture.globalId ?? `G${fixture.id}`,
    attrs: { Name: fixture.name ?? "" },
    props: (fixture.props ?? {}) as ElementRow["props"],
  }));
  const byId = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
  const boxes = fixtures.map((fixture) => fixture.box).filter((value): value is Box => !!value);
  return {
    elements: () => rows,
    select: (scope) => {
      if (scope.kind === "class") {
        const wanted = new Set(scope.values.map((value) => value.toLowerCase()));
        return rows.filter((row) => wanted.has(row.type.toLowerCase())).map((row) => row.id);
      }
      return rows.map((row) => row.id);
    },
    bounds: (id) => byId.get(id)?.box ?? null,
    modelBox: () =>
      boxes.length === 0
        ? null
        : {
            min: [
              Math.min(...boxes.map((entry) => entry.min[0])),
              Math.min(...boxes.map((entry) => entry.min[1])),
              Math.min(...boxes.map((entry) => entry.min[2])),
            ],
            max: [
              Math.max(...boxes.map((entry) => entry.max[0])),
              Math.max(...boxes.map((entry) => entry.max[1])),
              Math.max(...boxes.map((entry) => entry.max[2])),
            ],
          },
    storeys: async () => storeyBands(rows, (id) => byId.get(id)?.box ?? null),
    clash: async () => clashes.map(([a, b]) => ({ a, b, distance: 0.05, point: [0, 0, 0] as [number, number, number] })),
    volumes: async (ids) => {
      const out = new Map<number, { volume: number; closed: boolean }>();
      for (const id of ids) {
        const volume = byId.get(id)?.volume;
        if (volume) out.set(id, volume);
      }
      return out;
    },
    signatures: async (ids) => {
      const out = new Map<number, { hash: string; translation: [number, number, number] }>();
      for (const id of ids) {
        const signature = byId.get(id)?.signature;
        if (signature) out.set(id, signature);
      }
      return out;
    },
  };
}

const onlyRule = (ruleId: string, params: Record<string, unknown> = {}): Ruleset => ({
  format: "ifcviewx.rules",
  version: 1,
  name: "One rule",
  description: "",
  rules: [{ id: "r1", ruleId, enabled: true, scope: null, params: params as never }],
});

const run = (ruleId: string, fixtures: Fixture[], params: Record<string, unknown> = {}, clashes: Array<[number, number]> = []) =>
  runRuleset(onlyRule(ruleId, params), { model: model(fixtures, clashes) });

describe("the shipped library", () => {
  it("registers twelve rules, each with a distinct id", () => {
    const definitions = ruleDefinitions();
    expect(definitions.length).toBe(12);
    expect(new Set(definitions.map((definition) => definition.id)).size).toBe(12);
  });

  it("builds a default ruleset with every rule enabled", () => {
    const ruleset = defaultRuleset();
    expect(ruleset.rules).toHaveLength(12);
    expect(ruleset.rules.every((rule) => rule.enabled)).toBe(true);
  });
});

describe("identity and geometry rules", () => {
  it("catches two elements sharing a GlobalId", async () => {
    const report = await run("duplicate-globalid", [
      { id: 1, type: "IfcWall", globalId: "SAME" },
      { id: 2, type: "IfcWall", globalId: "SAME" },
      { id: 3, type: "IfcWall", globalId: "OTHER" },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids.sort()).toEqual([1, 2]);
    expect(report.counts.error).toBe(1);
  });

  it("catches identical geometry in the same place, and lets a moved copy through", async () => {
    const report = await run("coincident-elements", [
      { id: 1, type: "IfcWall", box: box([0, 0, 0], [1, 1, 1]), signature: { hash: "a", translation: [0, 0, 0] } },
      { id: 2, type: "IfcWall", box: box([0, 0, 0], [1, 1, 1]), signature: { hash: "a", translation: [0, 0, 0] } },
      { id: 3, type: "IfcWall", box: box([9, 0, 0], [1, 1, 1]), signature: { hash: "a", translation: [9, 0, 0] } },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids.sort()).toEqual([1, 2]);
  });

  it("reports each self-intersecting pair once, not twice", async () => {
    const report = await run(
      "self-intersection",
      [
        { id: 1, type: "IfcDuctSegment", box: box([0, 0, 0], [1, 1, 1]) },
        { id: 2, type: "IfcDuctSegment", box: box([0, 0, 0], [1, 1, 1]) },
      ],
      {},
      [[1, 2], [2, 1], [1, 1]],
    );
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids.sort()).toEqual([1, 2]);
  });

  it.each([
    "coincident-elements",
    "self-intersection",
    "unbounded-space",
    "quantity-vs-geometry",
  ])("reports the 6,000-element geometry cap for %s", async (ruleId) => {
    const fixtures = Array.from({ length: 6001 }, (_, index): Fixture => ({
      id: index + 1,
      type: ruleId === "unbounded-space" ? "IfcSpace" : "IfcWall",
      ...(ruleId === "unbounded-space" ? { box: box([index, 0, 0], [1, 1, 1]) } : {}),
      ...(ruleId === "quantity-vs-geometry" ? { props: { "Qto.NetVolume": 1 } } : {}),
    }));
    const report = await run(ruleId, fixtures);
    expect(report.findings).toEqual([
      expect.objectContaining({
        severity: "info",
        ids: [],
        title: `Only the first ${(6000).toLocaleString()} of ${(6001).toLocaleString()} elements were read`,
        detail: "Narrow the scope to check the rest.",
      }),
    ]);
  });

  it("flags an element whose centre sits outside its storey band", async () => {
    const fixtures: Fixture[] = [
      { id: 1, type: "IfcSlab", storey: "Level 1", box: box([0, 0, 0], [10, 0.2, 10]) },
      { id: 2, type: "IfcWall", storey: "Level 1", box: box([0, 0, 0], [1, 3, 0.2]) },
      { id: 3, type: "IfcSlab", storey: "Level 2", box: box([0, 3, 0], [10, 0.2, 10]) },
      { id: 4, type: "IfcWall", storey: "Level 2", box: box([0, 3, 0], [1, 3, 0.2]) },
      // Filed on Level 1 but modelled on Level 2.
      { id: 5, type: "IfcDoor", storey: "Level 1", box: box([2, 4, 0], [1, 2, 0.2]) },
    ];
    const report = await run("outside-storey", fixtures);
    expect(report.findings.map((finding) => finding.ids[0])).toEqual([5]);
  });

  it("does not flag anything when the model has one storey and normal elements", async () => {
    const report = await run("outside-storey", [
      { id: 1, type: "IfcSlab", storey: "Level 1", box: box([0, 0, 0], [10, 0.2, 10]) },
      { id: 2, type: "IfcWall", storey: "Level 1", box: box([0, 0, 0], [1, 3, 0.2]) },
    ]);
    expect(report.findings).toEqual([]);
  });
});

describe("space, host and access rules", () => {
  it("reports a space with no geometry and one that does not close", async () => {
    const report = await run("unbounded-space", [
      { id: 1, type: "IfcSpace", name: "Plant", box: null },
      { id: 2, type: "IfcSpace", name: "Office", box: box([0, 0, 0], [4, 3, 4]), volume: { volume: 48, closed: true } },
      { id: 3, type: "IfcSpace", name: "Void", box: box([0, 0, 0], [4, 3, 4]), volume: { volume: 40, closed: false } },
      { id: 4, type: "IfcSpace", name: "Sliver", box: box([0, 0, 0], [1, 1, 1]), volume: { volume: 0.01, closed: true } },
    ]);
    expect(report.findings.map((finding) => finding.ids[0]).sort()).toEqual([1, 3, 4]);
  });

  it("flags a door with an obstruction in its clear zone, and ignores its own wall", async () => {
    const report = await run("door-clearance", [
      { id: 1, type: "IfcDoor", name: "D1", box: box([0, 0, 0], [1, 2, 0.1]) },
      { id: 2, type: "IfcWall", name: "Host", box: box([-1, 0, 0], [4, 3, 0.1]) },
      { id: 3, type: "IfcFurniture", name: "Desk", box: box([0, 0, 0.4], [1, 0.8, 0.6]) },
      { id: 4, type: "IfcDoor", name: "D2", box: box([20, 0, 0], [1, 2, 0.1]) },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids[0]).toBe(1);
  });

  it("flags a door that touches no host", async () => {
    const report = await run("missing-host", [
      { id: 1, type: "IfcDoor", name: "Orphan door", box: box([10, 0, 10], [1, 2, 0.1]) },
      { id: 2, type: "IfcDoor", name: "Hosted door", box: box([0, 0, 0], [1, 2, 0.1]) },
      { id: 3, type: "IfcWall", name: "Wall", box: box([-1, 0, 0], [4, 3, 0.1]) },
    ]);
    expect(report.findings.map((finding) => finding.ids[0])).toEqual([1]);
  });
});

describe("data rules", () => {
  it("groups unclassified elements by class rather than listing thousands", async () => {
    const report = await run("unclassified", [
      { id: 1, type: "IfcWall", props: { "Pset.Classification": "Ss_25" } },
      { id: 2, type: "IfcWall" },
      { id: 3, type: "IfcWall" },
      { id: 4, type: "IfcDoor" },
    ]);
    expect(report.findings).toHaveLength(2);
    expect(report.findings.flatMap((finding) => finding.ids).sort()).toEqual([2, 3, 4]);
  });

  it("reports elements outside the spatial structure", async () => {
    const report = await run("orphaned", [
      { id: 1, type: "IfcWall", storey: "Level 1" },
      { id: 2, type: "IfcWall", storey: "" },
      { id: 3, type: "IfcWall", storey: "   " },
    ]);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids.sort()).toEqual([2, 3]);
  });

  it("applies a naming convention and reports the regular expression that failed", async () => {
    const report = await run("naming-convention", [
      { id: 1, type: "IfcWall", name: "WA-101" },
      { id: 2, type: "IfcWall", name: "wall 3" },
      { id: 3, type: "IfcWall", name: "" },
    ], { pattern: "^[A-Z]{2,}[-_]" });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0].ids.sort()).toEqual([2, 3]);
  });

  it("reports a bad regular expression against the rule instead of losing the batch", async () => {
    const ruleset = defaultRuleset();
    ruleset.rules = ruleset.rules.filter((rule) => rule.ruleId === "naming-convention");
    ruleset.rules[0].params = { pattern: "([" };
    const report = await runRuleset(ruleset, { model: model([{ id: 1, type: "IfcWall", name: "x" }]) });
    expect(report.findings).toEqual([]);
    expect(report.ran[0].error).toContain("not a valid regular expression");
  });

  it("catches the millimetre-for-metre placement error", async () => {
    const report = await run("placement-sanity", [
      { id: 1, type: "IfcWall", box: box([0, 0, 0], [1, 3, 0.2]) },
      { id: 2, type: "IfcWall", box: box([0, 0, 0], [1, 3, 0.2]) },
      { id: 3, type: "IfcWall", box: box([50000, 0, 0], [1, 3, 0.2]) },
    ]);
    expect(report.findings.map((finding) => finding.ids[0])).toEqual([3]);
  });

  it("compares an authored quantity with the measured mesh", async () => {
    const report = await run("quantity-vs-geometry", [
      { id: 1, type: "IfcWall", props: { "Qto_WallBaseQuantities.NetVolume": 4 }, box: box([0, 0, 0], [1, 1, 1]), volume: { volume: 4.2, closed: true } },
      { id: 2, type: "IfcWall", props: { "Qto_WallBaseQuantities.NetVolume": 4 }, box: box([0, 0, 0], [1, 1, 1]), volume: { volume: 9, closed: true } },
      { id: 3, type: "IfcWall", props: { "Qto_WallBaseQuantities.NetVolume": 4 }, box: box([0, 0, 0], [1, 1, 1]), volume: { volume: 9, closed: false } },
    ]);
    expect(report.findings.map((finding) => finding.ids[0])).toEqual([2]);
  });
});

describe("the runner", () => {
  it("skips disabled rules and reports what ran", async () => {
    const ruleset = defaultRuleset();
    for (const rule of ruleset.rules) rule.enabled = rule.ruleId === "orphaned";
    const report = await runRuleset(ruleset, { model: model([{ id: 1, type: "IfcWall", storey: "" }]) });
    expect(report.ran).toHaveLength(1);
    expect(report.ran[0].title).toBe("Element outside the spatial structure");
  });

  it("applies the instance severity over the rule's default", async () => {
    const ruleset = onlyRule("orphaned");
    ruleset.rules[0].severity = "info";
    const report = await runRuleset(ruleset, { model: model([{ id: 1, type: "IfcWall", storey: "" }]) });
    expect(report.findings[0].severity).toBe("info");
    expect(report.counts.info).toBe(1);
  });

  it("narrows a rule to its scope", async () => {
    const ruleset = onlyRule("orphaned");
    ruleset.rules[0].scope = { kind: "class", values: ["IfcDoor"] };
    const report = await runRuleset(ruleset, {
      model: model([
        { id: 1, type: "IfcWall", storey: "" },
        { id: 2, type: "IfcDoor", storey: "" },
      ]),
    });
    expect(report.findings[0].ids).toEqual([2]);
  });

  it("reports progress once per rule and finishes on the total", async () => {
    const seen: string[] = [];
    const ruleset = defaultRuleset();
    ruleset.rules = ruleset.rules.slice(0, 2);
    await runRuleset(ruleset, { model: model([]), progress: (_done, _total, label) => seen.push(label) });
    expect(seen[seen.length - 1]).toBe("Done");
  });

  it("rejects a pre-aborted run without announcing Done", async () => {
    const controller = new AbortController();
    const seen: string[] = [];
    controller.abort();

    await expect(runRuleset(onlyRule("orphaned"), {
      model: model([{ id: 1, type: "IfcWall", storey: "" }]),
      signal: controller.signal,
      progress: (_done, _total, label) => seen.push(label),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).not.toContain("Done");
  });

  it("propagates an AbortError from a rule instead of recording a failed rule", async () => {
    const fixtureModel = model([{ id: 1, type: "IfcWall" }]);
    const cancelled = new Error("Geometry cancelled");
    cancelled.name = "AbortError";
    fixtureModel.signatures = async () => { throw cancelled; };
    const seen: string[] = [];

    await expect(runRuleset(onlyRule("coincident-elements"), {
      model: fixtureModel,
      progress: (_done, _total, label) => seen.push(label),
    })).rejects.toBe(cancelled);
    expect(seen).not.toContain("Done");
  });

  it("rejects rather than returning findings when a signal aborts during a rule", async () => {
    const controller = new AbortController();
    const fixtureModel = model([
      { id: 1, type: "IfcWall" },
      { id: 2, type: "IfcWall" },
    ]);
    fixtureModel.signatures = async () => {
      controller.abort();
      return new Map([
        [1, { hash: "same", translation: [0, 0, 0] }],
        [2, { hash: "same", translation: [0, 0, 0] }],
      ]);
    };
    const seen: string[] = [];

    await expect(runRuleset(onlyRule("coincident-elements"), {
      model: fixtureModel,
      signal: controller.signal,
      progress: (_done, _total, label) => seen.push(label),
    })).rejects.toMatchObject({ name: "AbortError" });
    expect(seen).not.toContain("Done");
  });
});

describe("ruleset files", () => {
  it("round-trips", () => {
    const ruleset = defaultRuleset("Project QA");
    ruleset.rules[0].params = { toleranceMm: 25 };
    const parsed = parseRuleset(serializeRuleset(ruleset));
    expect(parsed.name).toBe("Project QA");
    expect(parsed.rules).toHaveLength(12);
    expect(parsed.rules[0].params).toEqual({ toleranceMm: 25 });
  });

  it("refuses a file that is not a ruleset", () => {
    expect(() => parseRuleset("{}")).toThrow();
    expect(() => parseRuleset("[]")).toThrow();
  });

  it("fills a rule's defaults in when the file only names it", () => {
    const parsed = parseRuleset(JSON.stringify({ name: "Minimal", rules: [{ ruleId: "coincident-elements" }] }));
    const resolved = resolveRule(parsed.rules[0]);
    expect(resolved?.params.toleranceMm).toBe(20);
    expect(resolved?.severity).toBe(findRule("coincident-elements")?.severity);
  });

  it("rejects unsupported envelopes and malformed selectors", () => {
    expect(() => parseRuleset(JSON.stringify({ format: "other", version: 1, rules: [] }))).toThrow(/format or version/i);
    expect(() => parseRuleset(JSON.stringify({
      format: "ifcviewx.rules",
      version: 2,
      rules: [],
    }))).toThrow(/format or version/i);
    expect(() => parseRuleset(JSON.stringify({
      rules: [{ ruleId: "orphaned", scope: { kind: "unknown" } }],
    }))).toThrow(/invalid scope/i);
  });

  it("bounds rule count and sanitizes parameter values", () => {
    expect(() => parseRuleset(JSON.stringify({
      rules: Array.from({ length: 257 }, () => ({ ruleId: "orphaned" })),
    }))).toThrow(/at most 256/i);
    const parsed = parseRuleset(JSON.stringify({
      rules: [{
        ruleId: "coincident-elements",
        params: { toleranceMm: 12, constructor: "no", huge: "x".repeat(2_001), classes: ["IfcWall"] },
      }],
    }));
    expect(parsed.rules[0].params).toEqual({ toleranceMm: 12, classes: ["IfcWall"] });
  });

  it("only resolves parameters declared by the registered rule", () => {
    const parsed = parseRuleset(JSON.stringify({
      rules: [{ ruleId: "coincident-elements", params: { toleranceMm: "not a number", extra: "ignored" } }],
    }));
    expect(resolveRule(parsed.rules[0])?.params).toEqual({ toleranceMm: 20 });
  });
});
