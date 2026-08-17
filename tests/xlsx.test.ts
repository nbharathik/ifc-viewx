import { afterEach, describe, expect, it, vi } from "vitest";
import { saveXlsx, toXlsx } from "../src/sdk/data.js";

const HEADERS = ["Class", "Name", "Volume m3"];
const ROWS: Array<Array<string | number | null>> = [
  ["IfcWall", "=SUM(A1:A2)", 12.5],
  ["IfcSlab", "Slab 01", 3],
  ["IfcBeam", null, 0],
];

async function read(bytes: ArrayBuffer, sheet: string) {
  const { Workbook } = await import("exceljs");
  const book = new Workbook();
  await book.xlsx.load(bytes);
  const worksheet = book.getWorksheet(sheet);
  if (!worksheet) throw new Error(`no worksheet named ${sheet}`);
  return worksheet;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("saveXlsx", () => {
  it("writes a non-empty workbook with the requested sheet and header", async () => {
    const bytes = await toXlsx(HEADERS, ROWS, { sheet: "Takeoff" });
    expect(bytes.byteLength).toBeGreaterThan(1000);
    const sheet = await read(bytes, "Takeoff");
    expect(sheet.getRow(1).values).toEqual([undefined, ...HEADERS]);
    expect(sheet.getRow(1).font?.bold).toBe(true);
    expect(sheet.getRow(1).fill?.type).toBe("pattern");
    expect(sheet.views[0]).toMatchObject({ state: "frozen", ySplit: 1 });
    expect(sheet.getColumn(2).width).toBeGreaterThan(0);
    expect(sheet.rowCount).toBe(ROWS.length + 1);
  });

  it("clamps auto column widths", async () => {
    const wide = [["IfcWall", "N".repeat(400), 1]];
    const sheet = await read(await toXlsx(HEADERS, wide, { maxWidth: 30 }), "Sheet1");
    expect(sheet.getColumn(2).width).toBe(30);
  });

  it("keeps numbers numeric so Excel can sum them", async () => {
    const sheet = await read(await toXlsx(HEADERS, ROWS), "Sheet1");
    expect(typeof sheet.getCell("C2").value).toBe("number");
    expect(sheet.getCell("C2").value).toBe(12.5);
    expect(sheet.getCell("C4").value).toBe(0);
  });

  it("treats a leading = as text rather than a formula", async () => {
    const sheet = await read(await toXlsx(HEADERS, ROWS), "Sheet1");
    const cell = sheet.getCell("B2");
    expect(cell.value).toBe("=SUM(A1:A2)");
    expect(cell.formula).toBeUndefined();
    expect(typeof cell.value).toBe("string");
  });

  it("sanitizes a sheet name Excel would reject", async () => {
    const bytes = await toXlsx(HEADERS, ROWS, { sheet: "Rooms: level [1]/2" });
    await expect(read(bytes, "Rooms  level  1  2")).resolves.toBeTruthy();
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
