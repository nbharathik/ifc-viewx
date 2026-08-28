import { strToU8, zipSync } from "fflate";

import type { Value, XlsxOptions } from "./types.js";

/** Rows sampled for widths; a takeoff of 100k rows should not be scanned twice. */
const WIDTH_SAMPLE = 500;
const DECLARATION = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const PACKAGE_RELATIONSHIPS = "http://schemas.openxmlformats.org/package/2006/relationships";
const OFFICE_RELATIONSHIPS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const SPREADSHEET = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";

/** Build one self-contained Office Open XML workbook without a heavyweight model. */
export function buildXlsx(
  headers: string[],
  rows: Array<Array<Value | undefined>>,
  options: XlsxOptions,
): ArrayBuffer {
  if (headers.length > 16_384) throw new RangeError("XLSX supports at most 16,384 columns");
  if (headers.length && rows.length > 1_048_575) throw new RangeError("XLSX supports at most 1,048,575 data rows");
  const requestedMax = options.maxWidth ?? 56;
  const max = Number.isFinite(requestedMax) ? Math.max(10, requestedMax) : 56;
  const sample = rows.slice(0, WIDTH_SAMPLE);
  const widths = headers.map((header, at) => {
    let width = String(header).length;
    for (const row of sample) width = Math.max(width, String(row[at] ?? "").length);
    return Math.min(max, width + 2);
  });
  const files: Record<string, Uint8Array> = {};
  for (const [path, xml] of Object.entries(parts(sheetName(options.sheet), headers, rows, widths))) {
    files[path] = strToU8(xml);
  }
  // ZIP stores local DOS timestamps; local midnight avoids becoming 1979 in
  // western time zones, which fflate correctly rejects as out of range.
  const zipped = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
  return zipped.slice().buffer;
}

function parts(
  name: string,
  headers: string[],
  rows: Array<Array<Value | undefined>>,
  widths: number[],
): Record<string, string> {
  const endColumn = headers.length ? columnName(headers.length - 1) : "A";
  const filter = headers.length ? `<autoFilter ref="A1:${endColumn}1"/>` : "";
  const columnXml = widths.length
    ? `<cols>${widths.map((width, at) => `<col min="${at + 1}" max="${at + 1}" width="${width}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const rowXml: string[] = [];
  if (headers.length) {
    rowXml.push(row(1, headers, true));
    rows.forEach((values, at) => rowXml.push(row(at + 2, headers.map((_, column) => cellValue(values[column])))));
  }
  const dimension = headers.length ? `A1:${endColumn}${rows.length + 1}` : "A1";

  return {
    "[Content_Types].xml": `${DECLARATION}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`,
    "_rels/.rels": `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    "xl/workbook.xml": `${DECLARATION}<workbook xmlns="${SPREADSHEET}" xmlns:r="${OFFICE_RELATIONSHIPS}"><bookViews><workbookView activeTab="0"/></bookViews><sheets><sheet name="${xml(name)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `${DECLARATION}<Relationships xmlns="${PACKAGE_RELATIONSHIPS}"><Relationship Id="rId1" Type="${OFFICE_RELATIONSHIPS}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${OFFICE_RELATIONSHIPS}/styles" Target="styles.xml"/></Relationships>`,
    "xl/styles.xml": `${DECLARATION}<styleSheet xmlns="${SPREADSHEET}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEDF1F6"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FFC7D0DA"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleLight16"/></styleSheet>`,
    "xl/worksheets/sheet1.xml": `${DECLARATION}<worksheet xmlns="${SPREADSHEET}"><dimension ref="${dimension}"/><sheetViews><sheetView tabSelected="1" workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/>${columnXml}<sheetData>${rowXml.join("")}</sheetData>${filter}</worksheet>`,
  };
}

function row(at: number, values: Array<Value | undefined>, header = false): string {
  const cells = values.map((value, column) => xlsxCell(`${columnName(column)}${at}`, value, header)).join("");
  return `<row r="${at}"${header ? ' s="1" customFormat="1"' : ""}>${cells}</row>`;
}

function xlsxCell(reference: string, value: Value | undefined, header: boolean): string {
  if (value === null || value === undefined) return "";
  const style = header ? ' s="1"' : "";
  if (typeof value === "number") return `<c r="${reference}"${style}><v>${value}</v></c>`;
  if (typeof value === "boolean") return `<c r="${reference}"${style} t="b"><v>${value ? 1 : 0}</v></c>`;
  return `<c r="${reference}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(value)}</t></is></c>`;
}

/** Never emit formulas: leading operators in model data are literal text. */
function cellValue(value: Value | undefined): Value {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  return value;
}

function columnName(column: number): string {
  let value = column + 1;
  let name = "";
  while (value > 0) {
    value -= 1;
    name = String.fromCharCode(65 + value % 26) + name;
    value = Math.floor(value / 26);
  }
  return name;
}

function xml(value: string): string {
  return value
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "\uFFFD")
    .replace(/_x([0-9a-f]{4})_/gi, "_x005F_x$1_")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, (character) => `_x${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}_`)
    .replace(/\r/g, "_x000D_")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function sheetName(value = "Sheet1"): string {
  const safe = value.replace(/[[\]:*?/\\\u0000-\u001F]/g, " ").trim() || "Sheet1";
  // Excel counts UTF-16 code units, not Unicode code points. Slice to its
  // 31-unit limit, then avoid leaving half of a surrogate pair at the end.
  let limited = safe.slice(0, 31);
  if (/[\uD800-\uDBFF]$/.test(limited)) limited = limited.slice(0, -1);
  const trimmed = limited.replace(/^'+|'+$/g, "").trim();
  if (!trimmed) return "Sheet1";
  return /^history$/i.test(trimmed) ? "History_" : trimmed;
}
