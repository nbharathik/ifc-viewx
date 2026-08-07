import { describe, expect, it } from "vitest";
import {
  buildTable, coerce, columnsOf, describeDiff, diffTable, parseDelimited, sniffDelimiter, toEditOps,
  type TableRow,
} from "../src/ifc/tabular.js";
import { toCsv } from "../src/sdk/data.js";

const row = (over: Partial<TableRow> = {}): TableRow => ({
  globalId: "2Sample000000000000009",
  model: 0,
  expressID: 47,
  ifcClass: "IfcWall",
  name: "South wall 1",
  storey: "Ground floor",
  props: { "Pset_WallCommon.IsExternal": "true", "Pset_WallCommon.FireRating": "60" },
  ...over,
});

const MODEL: TableRow[] = [
  row(),
  row({ globalId: "2Sample000000000000010", expressID: 60, name: "North wall 1", props: { "Pset_WallCommon.IsExternal": "false", "Pset_WallCommon.FireRating": "30" } }),
];

describe("parseDelimited", () => {
  it("reads a plain sheet", () => {
    expect(parseDelimited("a,b\n1,2")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("keeps commas inside quotes", () => {
    expect(parseDelimited('a,b\n"Level 1, east",2')).toEqual([["a", "b"], ["Level 1, east", "2"]]);
  });

  it("keeps newlines inside quotes", () => {
    expect(parseDelimited('a\n"line one\nline two"')).toEqual([["a"], ["line one\nline two"]]);
  });

  it("unescapes doubled quotes", () => {
    expect(parseDelimited('a\n"say ""hi"""')).toEqual([["a"], ['say "hi"']]);
  });

  it("handles CRLF, which is what Excel writes", () => {
    expect(parseDelimited("a,b\r\n1,2\r\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("strips the BOM, which is also what Excel writes", () => {
    expect(parseDelimited("﻿a,b\n1,2")[0]).toEqual(["a", "b"]);
  });

  it("does not invent a trailing empty row", () => {
    expect(parseDelimited("a\n1\n")).toHaveLength(2);
  });

  it("keeps a genuinely empty trailing field", () => {
    expect(parseDelimited("a,b\n1,")).toEqual([["a", "b"], ["1", ""]]);
  });

  it("reads semicolons when asked", () => {
    expect(parseDelimited("a;b\n1;2", ";")).toEqual([["a", "b"], ["1", "2"]]);
  });
});

describe("sniffDelimiter", () => {
  it("finds commas", () => expect(sniffDelimiter("a,b,c\n1,2,3")).toBe(","));
  it("finds semicolons", () => expect(sniffDelimiter("a;b;c\n1;2;3")).toBe(";"));
  it("finds tabs", () => expect(sniffDelimiter("a\tb\n1\t2")).toBe("\t"));
  it("falls back to a comma on a single column", () => expect(sniffDelimiter("a\n1")).toBe(","));
});

describe("columns and table build", () => {
  it("puts the fixed columns first, then properties sorted", () => {
    expect(columnsOf(MODEL)).toEqual([
      "GlobalId", "Model", "ExpressID", "Class", "Name", "Storey",
      "Pset_WallCommon.FireRating", "Pset_WallCommon.IsExternal",
    ]);
  });

  it("writes a header row and one row per element", () => {
    const table = buildTable(MODEL);
    expect(table).toHaveLength(3);
    expect(table[1][0]).toBe("2Sample000000000000009");
    expect(table[1][4]).toBe("South wall 1");
  });

  it("leaves a missing property blank rather than undefined", () => {
    const sparse = buildTable([row({ props: {} })], columnsOf(MODEL));
    expect(sparse[1][6]).toBe("");
  });
});

describe("round trip", () => {
  it("survives CSV encoding and re-parsing with zero changes", () => {
    const table = buildTable(MODEL);
    const text = toCsv(table[0], table.slice(1));
    const back = parseDelimited(text);
    expect(back).toEqual(table);
    expect(diffTable(MODEL, back).changes).toEqual([]);
  });

  it("survives commas and quotes in a name", () => {
    const tricky = [row({ name: 'Wall "A", east' })];
    const table = buildTable(tricky);
    const back = parseDelimited(toCsv(table[0], table.slice(1)));
    expect(back[1][4]).toBe('Wall "A", east');
    expect(diffTable(tricky, back).changes).toEqual([]);
  });

  it("survives a newline in a name", () => {
    const tricky = [row({ name: "Wall\nsecond line" })];
    const table = buildTable(tricky);
    const back = parseDelimited(toCsv(table[0], table.slice(1)));
    expect(diffTable(tricky, back).changes).toEqual([]);
  });
});

describe("diffTable", () => {
  const edited = (mutate: (t: string[][]) => void): string[][] => {
    const table = buildTable(MODEL);
    mutate(table);
    return table;
  };

  it("reports exactly one change for one edited cell", () => {
    const diff = diffTable(MODEL, edited((t) => { t[1][4] = "South wall renamed"; }));
    expect(diff.changes).toEqual([{
      globalId: "2Sample000000000000009", expressID: 47, model: 0,
      column: "Name", before: "South wall 1", after: "South wall renamed",
    }]);
  });

  it("reports a property change with its full column name", () => {
    const diff = diffTable(MODEL, edited((t) => { t[1][7] = "false"; }));
    expect(diff.changes[0].column).toBe("Pset_WallCommon.IsExternal");
    expect(diff.changes[0].after).toBe("false");
  });

  it("ignores whitespace a spreadsheet may add", () => {
    expect(diffTable(MODEL, edited((t) => { t[1][4] = "  South wall 1  "; })).changes).toEqual([]);
  });

  it("reports a row whose GlobalId is not in the model, and does not guess", () => {
    const diff = diffTable(MODEL, edited((t) => { t[1][0] = "notAGlobalIdAtAll0000"; }));
    expect(diff.unknown).toEqual(["notAGlobalIdAtAll0000"]);
    expect(diff.changes).toEqual([]);
  });

  it("refuses to match anything when GlobalId is missing", () => {
    const table = buildTable(MODEL);
    table[0][0] = "Ignored";
    const diff = diffTable(MODEL, table);
    expect(diff.changes).toEqual([]);
    expect(diff.unknownColumns.length).toBeGreaterThan(0);
  });

  it("refuses to write the read-only columns", () => {
    const diff = diffTable(MODEL, edited((t) => { t[1][3] = "IfcBeam"; }));
    expect(diff.changes).toEqual([]);
    expect(diff.readOnlyEdits).toEqual(["Class"]);
  });

  it("names columns the model does not have", () => {
    const table = buildTable(MODEL);
    table[0].push("Made.Up");
    table[1].push("x");
    expect(diffTable(MODEL, table).unknownColumns).toEqual(["Made.Up"]);
  });

  it("counts rows the sheet left out", () => {
    const table = buildTable(MODEL);
    expect(diffTable(MODEL, [table[0], table[1]]).untouched).toBe(1);
  });

  it("keeps each federated model's own row", () => {
    const federated = [row(), row({ model: 1, globalId: "2Other000000000000009", expressID: 47 })];
    const diff = diffTable(federated, buildTable(federated));
    expect(diff.changes).toEqual([]);
    expect(diff.unknown).toEqual([]);
  });
});

describe("coerce", () => {
  it("reads booleans", () => {
    expect(coerce("true")).toBe(true);
    expect(coerce("FALSE")).toBe(false);
  });

  it("reads numbers", () => {
    expect(coerce("60")).toBe(60);
    expect(coerce("-1.5")).toBe(-1.5);
  });

  it("keeps a leading-zero code as text, which a spreadsheet would mangle", () => {
    expect(coerce("007")).toBe("007");
  });

  it("keeps anything else as text", () => {
    expect(coerce("60 min")).toBe("60 min");
    expect(coerce("1.2.3")).toBe("1.2.3");
  });
});

describe("toEditOps", () => {
  it("makes a setProperty op for a dotted column", () => {
    const table = buildTable(MODEL);
    const fireRating = table[0].indexOf("Pset_WallCommon.FireRating");
    table[1][fireRating] = "90";
    expect(toEditOps(diffTable(MODEL, table))).toEqual([
      { op: "setProperty", ids: [47], set: "Pset_WallCommon", property: "FireRating", value: 90 },
    ]);
  });

  it("makes a setAttribute op for a plain column", () => {
    const table = buildTable(MODEL);
    table[1][4] = "Renamed";
    expect(toEditOps(diffTable(MODEL, table))).toEqual([
      { op: "setAttribute", ids: [47], attribute: "Name", value: "Renamed" },
    ]);
  });

  it("groups elements that got the same new value into one op", () => {
    const table = buildTable(MODEL);
    table[1][6] = "90";
    table[2][6] = "90";
    const ops = toEditOps(diffTable(MODEL, table));
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ op: "setProperty", ids: [47, 60], property: "FireRating", value: 90 });
  });

  it("keeps different values as separate ops", () => {
    const table = buildTable(MODEL);
    table[1][6] = "90";
    table[2][6] = "120";
    expect(toEditOps(diffTable(MODEL, table))).toHaveLength(2);
  });

  it("produces nothing for an unchanged file", () => {
    expect(toEditOps(diffTable(MODEL, buildTable(MODEL)))).toEqual([]);
  });
});

describe("describeDiff", () => {
  it("says nothing changed when nothing did", () => {
    expect(describeDiff(diffTable(MODEL, buildTable(MODEL)))).toMatch(/0 cells changed/);
  });

  it("counts elements as well as cells", () => {
    const table = buildTable(MODEL);
    table[1][4] = "A";
    table[2][4] = "B";
    expect(describeDiff(diffTable(MODEL, table))).toMatch(/2 cells changed; across 2 elements/);
  });

  it("surfaces unmatched rows", () => {
    const table = buildTable(MODEL);
    table[1][0] = "missing00000000000000";
    expect(describeDiff(diffTable(MODEL, table))).toMatch(/1 row\(s\) matched no element/);
  });
});

describe("header aliases", () => {
  // The schedule panel has always written expressID and Type. A re-import
  // must not report the app's own column names as unknown.
  it("accepts the schedule panel's own spellings", () => {
    const table = buildTable(MODEL);
    table[0] = table[0].map((c) => (c === "ExpressID" ? "expressID" : c === "Class" ? "Type" : c));
    const diff = diffTable(MODEL, table);
    expect(diff.unknownColumns).toEqual([]);
    expect(diff.changes).toEqual([]);
  });

  it("accepts GUID as a GlobalId heading", () => {
    const table = buildTable(MODEL);
    table[0][0] = "GUID";
    expect(diffTable(MODEL, table).unknown).toEqual([]);
  });

  it("is case insensitive on the fixed columns", () => {
    const table = buildTable(MODEL);
    table[0] = table[0].map((c) => c.toLowerCase());
    const diff = diffTable(MODEL, table);
    expect(diff.unknownColumns).not.toContain("globalid");
    expect(diff.changes).toEqual([]);
  });

  it("still reports a genuinely unknown column", () => {
    const table = buildTable(MODEL);
    table[0].push("Invented.Column");
    table[1].push("x");
    expect(diffTable(MODEL, table).unknownColumns).toEqual(["Invented.Column"]);
  });
});
