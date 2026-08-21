import { describe, expect, it } from "vitest";

import {
  buildReportTable,
  matchesSelector,
  parseTemplates,
  readValue,
  REPORT_PRESETS,
  serializeTemplates,
  type ReportTemplate,
} from "../src/plugins/report-builder/template.js";
import type { ElementRow } from "../src/sdk/data.js";

const row = (
  id: number,
  type: string,
  storey: string,
  props: Record<string, unknown> = {},
  name = `E${id}`,
): ElementRow =>
  ({ id, type, name, storey, globalId: `G${id}`, attrs: { Name: name }, props }) as ElementRow;

const template = (patch: Partial<ReportTemplate> = {}): ReportTemplate => ({
  id: "t1",
  name: "Test",
  description: "",
  scope: { kind: "everything" },
  columns: [
    { key: "Type", header: "Class", aggregate: "count" },
    { key: "NetVolume", header: "Volume", aggregate: "sum", decimals: 2 },
  ],
  groupBy: "",
  sortBy: "",
  sortDescending: false,
  dropEmptyRows: false,
  ...patch,
});

const ROWS = [
  row(1, "IfcWall", "Level 1", { "Qto_WallBaseQuantities.NetVolume": 2.5 }),
  row(2, "IfcWall", "Level 2", { "Qto_WallBaseQuantities.NetVolume": 1.25 }),
  row(3, "IfcDoor", "Level 1", { "Pset_DoorCommon.FireRating": "FD30" }),
];

describe("reading a column", () => {
  it("resolves model facts, exact keys and bare property names alike", () => {
    expect(readValue(ROWS[0], "Type")).toBe("Wall");
    expect(readValue(ROWS[0], "Storey")).toBe("Level 1");
    expect(readValue(ROWS[0], "Qto_WallBaseQuantities.NetVolume")).toBe(2.5);
    expect(readValue(ROWS[0], "NetVolume")).toBe(2.5);
    expect(readValue(ROWS[2], "FireRating")).toBe("FD30");
    expect(readValue(ROWS[2], "NetVolume")).toBeNull();
  });

  it("keeps a numeric property numeric so a total can be taken", () => {
    expect(typeof readValue(ROWS[0], "NetVolume")).toBe("number");
  });
});

describe("building the table", () => {
  it("totals a column by its aggregate and counts rows", () => {
    const report = buildReportTable({ template: template(), rows: ROWS, scopeIds: null });
    expect(report.headers).toEqual(["Class", "Volume"]);
    expect(report.rows).toHaveLength(3);
    expect(report.totals).toEqual([3, 3.75]);
  });

  it("groups and totals each group separately", () => {
    const report = buildReportTable({ template: template({ groupBy: "Type" }), rows: ROWS, scopeIds: null });
    expect(report.groups.map((group) => group.key)).toEqual(["Door", "Wall"]);
    expect(report.groups[1].totals).toEqual([2, 3.75]);
    expect(report.groups[1].ids).toEqual([1, 2]);
  });

  it("honours the template scope without touching the viewer", () => {
    const scoped = template({ scope: { kind: "query", selector: { kind: "class", values: ["IfcDoor"] } } });
    const report = buildReportTable({ template: scoped, rows: ROWS, scopeIds: null });
    expect(report.rows).toHaveLength(1);
    expect(report.rows[0].id).toBe(3);
  });

  it("lets the caller override the scope with explicit ids, for selection and visibility", () => {
    const report = buildReportTable({ template: template(), rows: ROWS, scopeIds: new Set([2]) });
    expect(report.rows.map((entry) => entry.id)).toEqual([2]);
  });

  it("drops rows with nothing in any column only when asked", () => {
    const rows = [...ROWS, row(4, "", "", {}, "")];
    const kept = buildReportTable({ template: template({ columns: [{ key: "NetVolume", header: "V", aggregate: "sum" }] }), rows, scopeIds: null });
    expect(kept.rows).toHaveLength(4);
    const dropped = buildReportTable({
      template: template({ dropEmptyRows: true, columns: [{ key: "NetVolume", header: "V", aggregate: "sum" }] }),
      rows,
      scopeIds: null,
    });
    expect(dropped.rows).toHaveLength(2);
    expect(dropped.dropped).toBe(2);
  });

  it("sorts numerically when the column is numeric", () => {
    const report = buildReportTable({ template: template({ sortBy: "NetVolume" }), rows: ROWS, scopeIds: null });
    expect(report.rows.map((entry) => entry.cells[1])).toEqual([null, 1.25, 2.5]);
  });

  it("rounds to the column's decimals rather than the raw float", () => {
    const rows = [row(1, "IfcWall", "L1", { "Qto.NetVolume": 2.5678 })];
    const report = buildReportTable({ template: template(), rows, scopeIds: null });
    expect(report.rows[0].cells[1]).toBe(2.57);
  });

  it("falls back to a class count when a template has no columns", () => {
    const report = buildReportTable({ template: template({ columns: [] }), rows: ROWS, scopeIds: null });
    expect(report.headers).toEqual(["Class"]);
    expect(report.totals).toEqual([3]);
  });
});

describe("selectors over index rows", () => {
  it("answers class, storey, property and the combinators", () => {
    expect(matchesSelector(ROWS[0], { kind: "class", values: ["Wall"] })).toBe(true);
    expect(matchesSelector(ROWS[0], { kind: "storey", values: ["level 1"] })).toBe(true);
    expect(matchesSelector(ROWS[2], { kind: "property", set: "", name: "FireRating", op: "is", value: "fd30" })).toBe(true);
    expect(matchesSelector(ROWS[0], { kind: "not", of: { kind: "class", values: ["IfcWall"] } })).toBe(false);
    expect(matchesSelector(ROWS[0], {
      kind: "any",
      of: [{ kind: "class", values: ["IfcDoor"] }, { kind: "storey", values: ["Level 1"] }],
    })).toBe(true);
  });
});

describe("template files", () => {
  it("round-trips through the file format", () => {
    const parsed = parseTemplates(serializeTemplates([template({ name: "Door schedule", groupBy: "Type" })]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].groupBy).toBe("Type");
    expect(parsed[0].columns[1].aggregate).toBe("sum");
  });

  it("rejects a file with no named template", () => {
    expect(parseTemplates(JSON.stringify({ templates: [{}] }))).toEqual([]);
  });

  it("normalizes imported aggregates and decimals and rejects malformed selectors", () => {
    const parsed = parseTemplates(JSON.stringify({
      format: "ifcviewx.report",
      version: 1,
      templates: [{
        name: "Unsafe",
        scope: { kind: "query", selector: { kind: "any" } },
        columns: [{ key: "Area", aggregate: "execute", decimals: 500 }],
      }],
    }));
    expect(parsed).toEqual([]);

    const [safe] = parseTemplates(JSON.stringify([{
      name: "Normalized",
      columns: [{ key: "Area", aggregate: "execute", decimals: 500 }],
    }]));
    expect(safe.columns[0]).toEqual({ key: "Area", header: "Area", aggregate: "none" });
  });

  it("rejects a template file version this build does not understand", () => {
    expect(parseTemplates(JSON.stringify({ format: "ifcviewx.report", version: 2, templates: [template()] }))).toEqual([]);
  });

  it("ships presets that all build against a model", () => {
    for (const preset of REPORT_PRESETS) {
      const report = buildReportTable({ template: { ...preset.template, id: "x" }, rows: ROWS, scopeIds: null });
      expect(report.headers.length).toBeGreaterThan(0);
    }
  });
});
