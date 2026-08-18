import { afterEach, describe, expect, it, vi } from "vitest";
import { strFromU8, unzipSync } from "fflate";
import { saveXlsx, toXlsx } from "../src/sdk/data.js";

const HEADERS = ["Class", "Name", "Volume m3"];
const ROWS: Array<Array<string | number | null>> = [
  ["IfcWall", "=SUM(A1:A2)", 12.5],
  ["IfcSlab", "Slab 01", 3],
  ["IfcBeam", null, 0],
];

function parseXml(source: string): XMLDocument {
  const document = new DOMParser().parseFromString(source, "application/xml");
  const error = document.getElementsByTagName("parsererror")[0];
  if (error) throw new Error(error.textContent ?? "invalid XML");
  return document;
}

function read(bytes: ArrayBuffer) {
  const files = unzipSync(new Uint8Array(bytes));
  const part = (path: string): XMLDocument => {
    const data = files[path];
    if (!data) throw new Error(`workbook has no ${path}`);
    return parseXml(strFromU8(data));
  };
  return {
    files,
    workbook: part("xl/workbook.xml"),
    sheet: part("xl/worksheets/sheet1.xml"),
    styles: part("xl/styles.xml"),
    contentTypes: part("[Content_Types].xml"),
    relationships: part("xl/_rels/workbook.xml.rels"),
  };
}

function cell(sheet: XMLDocument, reference: string): Element {
  const found = [...sheet.getElementsByTagName("c")].find((entry) => entry.getAttribute("r") === reference);
  if (!found) throw new Error(`no cell ${reference}`);
  return found;
}

function value(entry: Element): string {
  return entry.getElementsByTagName("v")[0]?.textContent ?? entry.getElementsByTagName("t")[0]?.textContent ?? "";
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveXlsx", () => {
  it("writes a non-empty workbook with the requested sheet and header", async () => {
    const bytes = await toXlsx(HEADERS, ROWS, { sheet: "Takeoff" });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const book = read(bytes);
    expect(Object.keys(book.files).sort()).toEqual([
      "[Content_Types].xml", "_rels/.rels", "xl/_rels/workbook.xml.rels",
      "xl/styles.xml", "xl/workbook.xml", "xl/worksheets/sheet1.xml",
    ]);
    expect(book.workbook.getElementsByTagName("sheet")[0].getAttribute("name")).toBe("Takeoff");
    expect(["A1", "B1", "C1"].map((reference) => value(cell(book.sheet, reference)))).toEqual(HEADERS);
    expect(book.sheet.getElementsByTagName("row")[0].getAttribute("s")).toBe("1");
    expect(book.sheet.getElementsByTagName("row")[0].getAttribute("customFormat")).toBe("1");
    expect(cell(book.sheet, "A1").getAttribute("s")).toBe("1");
    expect(book.styles.getElementsByTagName("font")[1].getElementsByTagName("b")).toHaveLength(1);
    expect(book.styles.getElementsByTagName("patternFill")[2].getAttribute("patternType")).toBe("solid");
    const pane = book.sheet.getElementsByTagName("pane")[0];
    expect(pane.getAttribute("state")).toBe("frozen");
    expect(pane.getAttribute("ySplit")).toBe("1");
    expect(Number(book.sheet.getElementsByTagName("col")[1].getAttribute("width"))).toBeGreaterThan(0);
    expect(book.sheet.getElementsByTagName("row")).toHaveLength(ROWS.length + 1);
    expect(book.sheet.getElementsByTagName("autoFilter")[0].getAttribute("ref")).toBe("A1:C1");
    expect(book.contentTypes.getElementsByTagName("Override")).toHaveLength(3);
    expect(book.relationships.getElementsByTagName("Relationship")).toHaveLength(2);
  });

  it("clamps auto column widths", async () => {
    const wide = [["IfcWall", "N".repeat(400), 1]];
    const { sheet } = read(await toXlsx(HEADERS, wide, { maxWidth: 30 }));
    expect(Number(sheet.getElementsByTagName("col")[1].getAttribute("width"))).toBe(30);
  });

  it("keeps numbers numeric so Excel can sum them", async () => {
    const { sheet } = read(await toXlsx(HEADERS, ROWS));
    expect(cell(sheet, "C2").hasAttribute("t")).toBe(false);
    expect(value(cell(sheet, "C2"))).toBe("12.5");
    expect(value(cell(sheet, "C4"))).toBe("0");
  });

  it("treats a leading = as text rather than a formula", async () => {
    const { sheet } = read(await toXlsx(HEADERS, ROWS));
    const entry = cell(sheet, "B2");
    expect(entry.getAttribute("t")).toBe("inlineStr");
    expect(value(entry)).toBe("=SUM(A1:A2)");
    expect(entry.getElementsByTagName("f")).toHaveLength(0);
  });

  it("sanitizes a sheet name Excel would reject", async () => {
    const bytes = await toXlsx(HEADERS, ROWS, { sheet: "Rooms: level [1]/2" });
    expect(read(bytes).workbook.getElementsByTagName("sheet")[0].getAttribute("name")).toBe("Rooms  level  1  2");
  });

  it("limits sheet names by Excel's UTF-16 unit count without splitting emoji", async () => {
    const requested = "😀".repeat(16);
    const bytes = await toXlsx(HEADERS, ROWS, { sheet: requested });
    const name = read(bytes).workbook.getElementsByTagName("sheet")[0].getAttribute("name")!;
    expect(name).toBe("😀".repeat(15));
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toContain("�");
  });

  it("writes booleans and XML-sensitive text without changing their values", async () => {
    const { sheet } = read(await toXlsx(
      ["Flag & note"],
      [[true], ["<wall> & slab"], [false], [Number.NaN], [Number.POSITIVE_INFINITY]],
    ));
    expect(cell(sheet, "A2").getAttribute("t")).toBe("b");
    expect(value(cell(sheet, "A2"))).toBe("1");
    expect(value(cell(sheet, "A3"))).toBe("<wall> & slab");
    expect(value(cell(sheet, "A4"))).toBe("0");
    expect([...sheet.getElementsByTagName("c")].some((entry) => entry.getAttribute("r") === "A5")).toBe(false);
    expect([...sheet.getElementsByTagName("c")].some((entry) => entry.getAttribute("r") === "A6")).toBe(false);
  });

  it("uses Excel column references beyond Z and rejects an oversized sheet", async () => {
    const headers = Array.from({ length: 27 }, (_, at) => `Column ${at + 1}`);
    const { sheet } = read(await toXlsx(headers, [headers]));
    expect(value(cell(sheet, "AA1"))).toBe("Column 27");
    expect(sheet.getElementsByTagName("autoFilter")[0].getAttribute("ref")).toBe("A1:AA1");
    await expect(toXlsx(Array.from({ length: 16_385 }, () => "x"), [])).rejects.toThrow(/16,384 columns/);
  });

  it("downloads with the spreadsheet mime type", async () => {
    const blobs: Blob[] = [];
    const urls = URL as unknown as Record<string, unknown>;
    urls.createObjectURL = (blob: Blob): string => (blobs.push(blob), "blob:xlsx");
    urls.revokeObjectURL = (): void => undefined;
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    await saveXlsx("takeoff.xlsx", HEADERS, ROWS);
    expect(click).toHaveBeenCalledOnce();
    expect(names).toEqual(["takeoff.xlsx"]);
    expect(blobs[0].type).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    expect(blobs[0].size).toBeGreaterThan(1000);
  });
});
