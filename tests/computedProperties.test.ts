import { describe, expect, it } from "vitest";

import {
  checkFormula,
  COMPUTED_TEMPLATES,
  computedKey,
  ComputedSet,
  ComputedStore,
  evaluateProperty,
  formulaRefs,
  geometryMeasure,
  parseComputedFile,
  serializeComputed,
  type ComputedProperty,
} from "../src/data/computed.js";
import type { ElementRow } from "../src/sdk/data.js";

const row = (
  props: Record<string, unknown> = {},
  extra: Partial<ElementRow> = {},
): ElementRow =>
  ({
    id: 10,
    type: "IfcWall",
    name: "Core wall",
    storey: "Level 1",
    globalId: "0aBcD",
    attrs: { Name: "Core wall", Tag: "W-01" },
    props,
    ...extra,
  }) as ElementRow;

const geometry = { geometry: () => ({ min: [0, 0, 0] as [number, number, number], max: [4, 3, 2] as [number, number, number] }) };

const run = (definition: Omit<ComputedProperty, "id">, source: ElementRow, context = geometry): unknown =>
  evaluateProperty({ id: "x", ...definition }, source, {}, context);

describe("formulas", () => {
  it("reads a fully qualified property, a bare name and a model fact", () => {
    const source = row({ "Pset_WallCommon.FireRating": "FD30", "Qto_Wall.NetVolume": 4 });
    expect(run({ name: "a", kind: "formula", expression: "[Pset_WallCommon.FireRating]" }, source)).toBe("FD30");
    expect(run({ name: "a", kind: "formula", expression: "[FireRating]" }, source)).toBe("FD30");
    expect(run({ name: "a", kind: "formula", expression: "[Storey]" }, source)).toBe("Level 1");
    expect(run({ name: "a", kind: "formula", expression: "[Tag]" }, source)).toBe("W-01");
  });

  it("does arithmetic, text joins and comparisons", () => {
    const source = row({ "Qto.NetArea": 12.5, "Qto.Openings": 2.5 });
    expect(run({ name: "a", kind: "formula", expression: "[NetArea] - [Openings]" }, source)).toBe(10);
    expect(run({ name: "a", kind: "formula", expression: "'Area: ' & ROUND([NetArea], 1)" }, source)).toBe("Area: 12.5");
    expect(run({ name: "a", kind: "formula", expression: "[NetArea] > 10" }, source)).toBe(true);
  });

  it("keeps operator precedence, including exponentiation over multiplication", () => {
    const source = row();
    expect(run({ name: "a", kind: "formula", expression: "2 + 3 * 4" }, source)).toBe(14);
    expect(run({ name: "a", kind: "formula", expression: "(2 + 3) * 4" }, source)).toBe(20);
    expect(run({ name: "a", kind: "formula", expression: "2 * 3 ^ 2" }, source)).toBe(18);
    expect(run({ name: "a", kind: "formula", expression: "2 ^ 3 ^ 2" }, source)).toBe(512);
  });

  it("returns null rather than infinity when dividing by zero", () => {
    expect(run({ name: "a", kind: "formula", expression: "1 / 0" }, row())).toBeNull();
  });

  it("bounds pathological rounding precision to a finite result", () => {
    expect(run({ name: "a", kind: "formula", expression: "ROUND(1.25, 999999)" }, row())).toBe(1.25);
  });

  it("compares text case insensitively, because model data is not consistent", () => {
    const source = row({ "Pset.Status": "New" });
    expect(run({ name: "a", kind: "formula", expression: "[Status] = 'new'" }, source)).toBe(true);
  });

  it("reads a number out of a string a tool wrote with a unit", () => {
    const source = row({ "Pset.Thickness": "200 mm" });
    expect(run({ name: "a", kind: "formula", expression: "[Thickness] * 2" }, source)).toBe(400);
  });

  it("supports the functions the templates need", () => {
    const source = row({ "Pset.Code": "Ss_25_10_30", "Qto.NetVolume": 4.1234 });
    expect(run({ name: "a", kind: "formula", expression: "UPPER(LEFT([Code], 2))" }, source)).toBe("SS");
    expect(run({ name: "a", kind: "formula", expression: "SPLIT([Code], '_', 2)" }, source)).toBe("25");
    expect(run({ name: "a", kind: "formula", expression: "ROUND([NetVolume], 2)" }, source)).toBe(4.12);
    expect(run({ name: "a", kind: "formula", expression: "IF(ISBLANK([Missing]), 'none', 'set')" }, source)).toBe("none");
    expect(run({ name: "a", kind: "formula", expression: "COALESCE([Missing], [Code])" }, source)).toBe("Ss_25_10_30");
    expect(run({ name: "a", kind: "formula", expression: "CONTAINS([Code], 'ss')" }, source)).toBe(true);
  });

  it("reads geometry through the context rather than guessing", () => {
    expect(run({ name: "a", kind: "formula", expression: "[Geometry.boxVolume]" }, row())).toBe(24);
    expect(evaluateProperty({ id: "x", name: "a", kind: "formula", expression: "[Geometry.boxVolume]" }, row(), {}, null))
      .toBeNull();
  });

  it("reports a parse error at definition time and evaluates to null at run time", () => {
    expect(checkFormula("1 + ")).toBeTruthy();
    expect(checkFormula("COALESCE([A], [B])")).toBeNull();
    expect(run({ name: "a", kind: "formula", expression: "1 +" }, row())).toBeNull();
    expect(run({ name: "a", kind: "formula", expression: "NOPE(1)" }, row())).toBeNull();
    expect(checkFormula("1.2.3")).toBeTruthy();
  });

  it("lists the properties a formula reads, for dependency ordering", () => {
    expect(formulaRefs("COALESCE([A.B], [C]) & [D]").sort()).toEqual(["A.B", "C", "D"]);
  });
});

describe("the other kinds", () => {
  it("takes the first non-empty source for a fallback chain", () => {
    const source = row({ "Pset_WallCommon.FireRating": "", "Other.FireRating": "FD60" });
    expect(run({ name: "a", kind: "coalesce", sources: ["Pset_WallCommon.FireRating", "Other.FireRating"] }, source))
      .toBe("FD60");
  });

  it("falls back when nothing in the chain has a value", () => {
    expect(run({ name: "a", kind: "coalesce", sources: ["Nope"], fallback: "Unknown" }, row())).toBe("Unknown");
  });

  it("joins values and treats a quoted entry as a literal", () => {
    const source = row({ "Pset.Code": "Ss_25", "Pset.TypeName": "Blockwork" });
    expect(run({ name: "a", kind: "concat", sources: ["Code", "'x'", "TypeName"], separator: "-" }, source))
      .toBe("Ss_25-x-Blockwork");
  });

  it("skips a missing part instead of leaving a dangling separator", () => {
    const source = row({ "Pset.Code": "Ss_25" });
    expect(run({ name: "a", kind: "concat", sources: ["Code", "Missing"], separator: "-" }, source)).toBe("Ss_25");
  });

  it("maps values case insensitively and falls back when nothing matches", () => {
    const definition = { name: "a", kind: "map" as const, source: "FireRating", table: [["fd30", "30 minutes"] as [string, string]], fallback: "Not rated" };
    expect(run(definition, row({ "Pset.FireRating": "FD30" }))).toBe("30 minutes");
    expect(run(definition, row({ "Pset.FireRating": "FD90" }))).toBe("Not rated");
  });

  it("converts units and leaves a missing source unconverted", () => {
    expect(run({ name: "a", kind: "convert", source: "Volume", factor: 0.001 }, row({ "Qto.Volume": 2500 }))).toBe(2.5);
    expect(run({ name: "a", kind: "convert", source: "Volume", factor: 0.001 }, row())).toBeNull();
  });

  it("measures geometry the model never quantified", () => {
    expect(run({ name: "a", kind: "geometry", measure: "footprint" }, row())).toBe(8);
    expect(run({ name: "a", kind: "geometry", measure: "height" }, row())).toBe(3);
  });

  it("finds a classification reference wherever it was written", () => {
    const source = row({ "Pset_Uniclass.ClassificationCode": "Ss_25_10", "Pset_Other.Name": "x" });
    expect(run({ name: "a", kind: "classification" }, source)).toBe("Ss_25_10");
    expect(run({ name: "a", kind: "classification", system: "omniclass", fallback: "-" }, source)).toBe("-");
  });
});

describe("geometry measures", () => {
  it("orders width, depth and height off the real box", () => {
    const box = { min: [0, 0, 0] as [number, number, number], max: [1, 5, 3] as [number, number, number] };
    expect(geometryMeasure(box, "height")).toBe(5);
    expect(geometryMeasure(box, "width")).toBe(3);
    expect(geometryMeasure(box, "depth")).toBe(1);
    expect(geometryMeasure(box, "footprint")).toBe(3);
    expect(geometryMeasure(box, "boxVolume")).toBe(15);
  });
});

describe("shipped templates", () => {
  it("contains no formula that the formula language rejects", () => {
    for (const template of COMPUTED_TEMPLATES) {
      if (template.definition.kind === "formula") {
        expect(checkFormula(template.definition.expression ?? ""), template.label).toBeNull();
      }
    }
  });

  it("classifies an MEP class with the built-in discipline template", () => {
    const definition = COMPUTED_TEMPLATES.find((template) => template.label === "Discipline")!.definition;
    expect(run(definition, row({}, { type: "IfcDuctSegment" }))).toBe("MEP");
  });
});

describe("the set", () => {
  it("keys values so every property picker finds them", () => {
    const set = new ComputedSet([{ id: "1", name: "Fire rating", kind: "coalesce", sources: ["FireRating"] }]);
    const values = set.evaluate(row({ "Pset.FireRating": "FD30" }), null);
    expect(values[computedKey("Fire rating")]).toBe("FD30");
    expect(set.keys()).toEqual(["Computed.Fire rating"]);
  });

  it("lets one computed property read another, whatever order they were written in", () => {
    const set = new ComputedSet([
      { id: "2", name: "Label", kind: "formula", expression: "'FR ' & [Computed.Rating]" },
      { id: "1", name: "Rating", kind: "coalesce", sources: ["FireRating"] },
    ]);
    const values = set.evaluate(row({ "Pset.FireRating": "FD30" }), null);
    expect(values["Computed.Label"]).toBe("FR FD30");
  });

  it("does not loop on a cycle", () => {
    const set = new ComputedSet([
      { id: "1", name: "A", kind: "formula", expression: "[Computed.B]" },
      { id: "2", name: "B", kind: "formula", expression: "[Computed.A]" },
    ]);
    expect(() => set.evaluate(row(), null)).not.toThrow();
  });

  it("replaces the previous pass rather than stacking values on the row", () => {
    const target = row({ "Pset.FireRating": "FD30" });
    new ComputedSet([{ id: "1", name: "R", kind: "coalesce", sources: ["FireRating"] }]).applyTo(target, null);
    expect(target.props["Computed.R"]).toBe("FD30");
    new ComputedSet([{ id: "2", name: "S", kind: "coalesce", sources: ["FireRating"] }]).applyTo(target, null);
    expect(target.props["Computed.R"]).toBeUndefined();
    expect(target.props["Computed.S"]).toBe("FD30");
  });

  it("ignores an unnamed definition", () => {
    expect(new ComputedSet([{ id: "1", name: "  ", kind: "formula", expression: "1" }]).isEmpty()).toBe(true);
  });
});

describe("storage", () => {
  const memory = (): Storage => {
    const map = new Map<string, string>();
    return {
      getItem: (key: string) => map.get(key) ?? null,
      setItem: (key: string, value: string) => void map.set(key, value),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: () => null,
      length: 0,
    } as unknown as Storage;
  };

  it("round-trips through the file format", () => {
    const definitions: ComputedProperty[] = [{ id: "1", name: "Fire rating", kind: "coalesce", sources: ["FireRating"] }];
    expect(parseComputedFile(serializeComputed(definitions))).toEqual(definitions);
  });

  it("rejects unsupported envelopes and drops malformed definitions", () => {
    expect(() => parseComputedFile(JSON.stringify({ format: "ifcviewx.computed", version: 2, properties: [] })))
      .toThrow(/version/i);
    expect(parseComputedFile(JSON.stringify({
      format: "ifcviewx.computed",
      version: 1,
      properties: [
        { id: "bad-kind", name: "Bad", kind: "execute" },
        { id: "bad-number", name: "Scale", kind: "convert", source: "Length", factor: "lots" },
        { id: "bad-formula", name: "Formula", kind: "formula", expression: "1 +" },
        { id: "safe", name: "Box", kind: "geometry", measure: "not-a-measure" },
      ],
    }))).toEqual([{ id: "safe", name: "Box", kind: "geometry", measure: "boxVolume" }]);
  });

  it("keeps definitions across a reload and replaces by name on merge", () => {
    const storage = memory();
    const store = new ComputedStore(storage);
    store.save({ id: "1", name: "Fire rating", kind: "coalesce", sources: ["A"] });
    expect(new ComputedStore(storage).list()).toHaveLength(1);
    store.merge([{ id: "9", name: "Fire rating", kind: "coalesce", sources: ["B"] }]);
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].sources).toEqual(["B"]);
  });

  it("validates direct saves and prevents duplicate computed keys", () => {
    const store = new ComputedStore(memory());
    expect(store.save({ id: "bad", name: "Broken", kind: "formula", expression: "1 +" })).toBe(false);
    expect(store.save({ id: "1", name: "Rating", kind: "coalesce", sources: ["A"] })).toBe(true);
    expect(store.save({ id: "2", name: "rating", kind: "coalesce", sources: ["B"] })).toBe(true);
    expect(store.list()).toEqual([{ id: "2", name: "rating", kind: "coalesce", sources: ["B"] }]);
  });

  it("bounds direct file input before parsing JSON", () => {
    expect(() => parseComputedFile(" ".repeat(2_000_001))).toThrow(/too large/i);
  });
});
