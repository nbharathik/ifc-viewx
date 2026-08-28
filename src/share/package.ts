// The share package: one file that still opens in five years.
//
// Handover is the case nobody plans for. A model, the views a coordinator
// authored, the properties those views read, the issues raised against them
// and the drawings they were checked on are five separate things in five
// separate systems, and four of them are gone by the time anyone looks.
//
// This is all five, zipped, with a manifest that says what it is. Nothing in
// it needs this application to be readable: the model is the model, and
// everything else is JSON and PNG.
import { unzipSync, zipSync } from "fflate";
import {
  COMPUTED_FILE_FORMAT,
  parseComputedFile,
  serializeComputed,
  type ComputedProperty,
} from "../data/computed.js";
import type { StoredSheet } from "../sheets/sheet.js";
import {
  parseViewFile,
  serializeViews,
  VIEW_FILE_FORMAT,
  VIEW_FILE_VERSION,
  type ViewDefinition,
} from "../views/definition.js";

export const PACKAGE_FORMAT = "ifcviewx.package";
export const PACKAGE_VERSION = 1;
export const PACKAGE_EXTENSION = ".ifcpkg";

export interface PackageManifest {
  format: typeof PACKAGE_FORMAT;
  version: number;
  createdAt: string;
  app: string;
  project: string;
  model: { name: string; bytes: number } | null;
  counts: { views: number; properties: number; sheets: number; state: number };
  note: string;
}

/**
 * Session state worth carrying, by key prefix. An allowlist rather than a
 * denylist: a package is a file somebody sends to somebody else, and a key
 * added next year must not leak into it because nobody remembered to exclude
 * it. Provider keys live under a different prefix entirely and are not here.
 */
export const STATE_PREFIXES = [
  "ifcviewx.views.",
  "ifcviewx.computed.",
  "ifcviewx.vp.",
  "ifcviewx.measure.",
  "ifcviewx.notes.",
  "ifcviewx.sets.",
  "ifcviewx.bcf.",
];

/** Reviewed plugin artifacts that are project data rather than arbitrary extension storage. */
export const STATE_PLUGIN_KEYS = new Set([
  "ifcviewx.plug.rule-studio.ruleset",
  "ifcviewx.plug.report-builder.templates",
  "ifcviewx.plug.report-builder.activeId",
  "ifcviewx.plug.presentation.deck",
  "ifcviewx.plug.ids-studio.compliance-baseline",
  "ifcviewx.plug.ids-studio.requirement-templates",
  "ifcviewx.plug.clash.definitions",
  "ifcviewx.plug.clash.activeDefinition",
  "ifcviewx.plug.clash.decisions",
  "ifcviewx.plug.clash.ignoreRules",
]);

export const carriesState = (key: string): boolean =>
  STATE_PREFIXES.some((prefix) => key.startsWith(prefix)) ||
  STATE_PLUGIN_KEYS.has(key) ||
  key.startsWith("ifcviewx.plug.clash.history.") ||
  key.startsWith("ifcviewx.plug.schedule-4d.workspace.");

export interface PackageInput {
  project: string;
  app: string;
  model: { name: string; bytes: Uint8Array } | null;
  views: ViewDefinition[];
  properties: ComputedProperty[];
  sheets: StoredSheet[];
  /** Raw localStorage entries that passed the allowlist. */
  state: Record<string, string>;
  /** A PNG of the view the package was made from. */
  preview: Uint8Array | null;
  note?: string;
}

export interface PackageContents {
  manifest: PackageManifest;
  model: { name: string; bytes: Uint8Array } | null;
  views: ViewDefinition[];
  properties: ComputedProperty[];
  sheets: Array<{ record: Omit<StoredSheet, "image">; image: Uint8Array }>;
  state: Record<string, string>;
  preview: Uint8Array | null;
}

const encoder = new TextEncoder();
const archiveDecoder = new TextDecoder("utf-8", { fatal: true });

const PACKAGE_LIMITS = {
  compressed: 512 * 1024 * 1024,
  uncompressed: 768 * 1024 * 1024,
  metadata: 8 * 1024 * 1024,
  sheetImage: 48 * 1024 * 1024,
  preview: 24 * 1024 * 1024,
  files: 1_024,
  compressionRatio: 200,
} as const;

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const MAX_SHEET_DIMENSION = 50_000;
const MAX_SHEET_PIXELS = 100_000_000;
const MAX_SHEET_COORDINATE = 1_000_000;
const MAX_WORLD_COORDINATE = 1_000_000_000;
const MAX_SHEET_PAGES = 100_000;

interface ArchiveEntry {
  path: string;
  compressed: number;
  size: number;
}

const text = (value: unknown): Uint8Array => encoder.encode(JSON.stringify(value, null, 2));

const isPng = (bytes: Uint8Array): boolean =>
  bytes.length >= PNG_MAGIC.length && PNG_MAGIC.every((value, index) => bytes[index] === value);

export async function buildPackage(input: PackageInput): Promise<Uint8Array> {
  const files: Record<string, Uint8Array> = {};
  // Callers normally pre-filter localStorage, but the package boundary owns
  // this privacy guarantee and must not depend on every caller remembering it.
  const state = sanitizeState(input.state, false);
  const app = packageText(input.app, "app", 500);
  const project = packageText(input.project, "project", 4_096);
  const note = packageText(input.note ??
    "Open this with IFCViewX, or unzip it: the model, the view definitions, the drawings and the issues are all readable on their own.",
  "note", 16_384);
  const viewsSource = serializeViews(input.views);
  const views = parseViewFile(viewsSource);
  if (views.length !== input.views.length) throw new Error("The package contains an invalid view definition.");
  assertUniqueIds(views, "view");
  const propertiesSource = serializeComputed(input.properties);
  const properties = parseComputedFile(propertiesSource);
  if (properties.length !== input.properties.length) {
    throw new Error("The package contains an invalid computed-property definition.");
  }
  assertUniqueIds(properties, "computed-property");
  if (input.sheets.length > 500) throw new Error("A share package may contain at most 500 sheets.");
  let model: PackageInput["model"] = null;
  if (input.model) {
    if (!(input.model.bytes instanceof Uint8Array) || input.model.bytes.byteLength > PACKAGE_LIMITS.uncompressed) {
      throw new Error("The package model is invalid or too large.");
    }
    const name = packageText(input.model.name, "model name", 4_096);
    if (!/\.(?:ifc|ifcx)$/i.test(name)) throw new Error("The package model must be an IFC or IFCX file.");
    model = { name, bytes: input.model.bytes };
  }
  const manifest: PackageManifest = {
    format: PACKAGE_FORMAT,
    version: PACKAGE_VERSION,
    createdAt: new Date().toISOString(),
    app,
    project,
    model: model ? { name: model.name, bytes: model.bytes.length } : null,
    counts: {
      views: views.length,
      properties: properties.length,
      sheets: input.sheets.length,
      state: Object.keys(state).length,
    },
    note,
  };
  files["manifest.json"] = text(manifest);
  files["views.json"] = encoder.encode(viewsSource);
  files["properties.json"] = encoder.encode(propertiesSource);
  files["state.json"] = text(state);
  if (model) files[`model/${safeName(model.name)}`] = model.bytes;
  if (input.preview) {
    if (input.preview.byteLength > PACKAGE_LIMITS.preview || !isPng(input.preview)) {
      throw new Error("The package preview is not a bounded PNG image.");
    }
    files["preview.png"] = input.preview;
  }
  const sheetIds = new Set<string>();
  for (const sheet of input.sheets) {
    const { image, ...record } = sheet;
    const normalized = normalizeSheetRecord(record);
    if (!normalized || sheetIds.has(normalized.id)) throw new Error(`The package sheet record is invalid: ${sheet.id}`);
    sheetIds.add(normalized.id);
    if (!(image instanceof Blob) || image.size > PACKAGE_LIMITS.sheetImage) {
      throw new Error(`The package sheet image is invalid or too large: ${sheet.id}`);
    }
    const imageBytes = new Uint8Array(await image.arrayBuffer());
    if (!isPng(imageBytes)) throw new Error(`The package sheet is not a PNG image: ${sheet.id}`);
    files[`sheets/${normalized.id}.json`] = text(normalized);
    files[`sheets/${normalized.id}.png`] = imageBytes;
  }
  files["README.txt"] = encoder.encode(README);
  // The model is already compressed in .ifcx and barely compresses in .ifc;
  // level 6 on the rest keeps the package small without a long wait.
  const archive = zipSync(files, { level: 6 });
  // Use the same central-directory preflight as the reader, so this function
  // can never emit a package this build would refuse to open.
  inspectArchive(archive);
  return archive;
}

export function readPackage(bytes: Uint8Array): PackageContents {
  const listed = inspectArchive(bytes);
  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(bytes);
  } catch (error) {
    throw new Error(`The package could not be unpacked: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files: Record<string, Uint8Array> = {};
  for (const entry of listed) {
    const data = unpacked[entry.path];
    if (!data || data.byteLength !== entry.size) throw new Error(`The package entry is corrupt: ${entry.path}`);
    files[entry.path] = data;
  }
  const manifestRaw = files["manifest.json"];
  if (!manifestRaw) throw new Error("That zip is not an IFCViewX package: it has no manifest.");
  const manifest = readManifest(manifestRaw);
  if (manifest.format !== PACKAGE_FORMAT) throw new Error("That package was written by something else.");
  if (manifest.version !== PACKAGE_VERSION) throw new Error("That package version is not supported by this build.");

  const modelEntries = Object.keys(files).filter((name) => name.startsWith("model/") && !name.endsWith("/"));
  if (modelEntries.length > 1) throw new Error("A share package may carry only one model.");
  const modelEntry = modelEntries[0];
  if (modelEntry && !/\.(?:ifc|ifcx)$/i.test(modelEntry)) throw new Error("The packaged model is not an IFC or IFCX file.");
  if ((modelEntry === undefined) !== (manifest.model === null)) {
    throw new Error("The packaged model does not match its manifest.");
  }
  if (modelEntry && manifest.model && (
    manifest.model.bytes !== files[modelEntry].byteLength ||
    safeName(manifest.model.name) !== modelEntry.slice("model/".length)
  )) {
    throw new Error("The packaged model does not match its manifest.");
  }
  const views = readViews(files["views.json"]);
  const properties = readProperties(files["properties.json"]);
  const state = readState(files["state.json"]);
  const sheets = readSheets(files);
  const preview = files["preview.png"] ?? null;
  if (preview && !isPng(preview)) throw new Error("The packaged preview is not a PNG image.");
  assertCount("view", manifest.counts.views, views.length);
  assertCount("computed property", manifest.counts.properties, properties.length);
  assertCount("sheet", manifest.counts.sheets, sheets.length);
  assertCount("state entry", manifest.counts.state, Object.keys(state).length);

  return {
    manifest,
    model: modelEntry ? { name: modelEntry.slice("model/".length), bytes: files[modelEntry] } : null,
    views,
    properties,
    sheets,
    state,
    preview,
  };
}

function readManifest(data: Uint8Array): PackageManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(archiveDecoder.decode(data));
  } catch {
    throw new Error("The package manifest is not valid JSON.");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("The package manifest is invalid.");
  const value = raw as Partial<PackageManifest>;
  if (value.format !== PACKAGE_FORMAT || typeof value.version !== "number" ||
    typeof value.createdAt !== "string" || typeof value.app !== "string" || typeof value.project !== "string" ||
    typeof value.note !== "string" || !value.counts || typeof value.counts !== "object" || Array.isArray(value.counts)) {
    throw new Error("The package manifest is invalid.");
  }
  const counts = value.counts as Partial<PackageManifest["counts"]>;
  if (![counts.views, counts.properties, counts.sheets, counts.state]
    .every((count) => Number.isSafeInteger(count) && (count as number) >= 0)) {
    throw new Error("The package manifest counts are invalid.");
  }
  if (value.model !== null && (!value.model || typeof value.model.name !== "string" || !value.model.name ||
    !Number.isSafeInteger(value.model.bytes) || value.model.bytes < 0)) throw new Error("The package model manifest is invalid.");
  return value as PackageManifest;
}

type SheetRecord = Omit<StoredSheet, "image">;
type JsonObject = Record<string, unknown>;

const objectValue = (value: unknown): JsonObject | null =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : null;

function readJsonFile(data: Uint8Array, path: string): { source: string; value: unknown } {
  try {
    const source = archiveDecoder.decode(data);
    return { source, value: JSON.parse(source) as unknown };
  } catch {
    throw new Error(`The package file ${path} is not valid UTF-8 JSON.`);
  }
}

function assertUniqueIds(items: Array<{ id: string }>, label: string): void {
  const ids = new Set<string>();
  for (const item of items) {
    if (ids.has(item.id)) throw new Error(`The package contains duplicate ${label} ids.`);
    ids.add(item.id);
  }
}

function readViews(data: Uint8Array | undefined): ViewDefinition[] {
  if (!data) return [];
  const { source, value } = readJsonFile(data, "views.json");
  const envelope = objectValue(value);
  if (envelope && (
    (envelope.format !== undefined && envelope.format !== VIEW_FILE_FORMAT) ||
    (envelope.version !== undefined && envelope.version !== VIEW_FILE_VERSION)
  )) throw new Error("The package file views.json has an unsupported format or version.");
  const list = Array.isArray(value) ? value : envelope && Array.isArray(envelope.views) ? envelope.views : null;
  if (!list) throw new Error("The package file views.json has no view definitions.");
  let views: ViewDefinition[];
  try {
    views = parseViewFile(source);
  } catch {
    throw new Error("The package file views.json is invalid.");
  }
  if (views.length !== list.length) throw new Error("The package file views.json contains invalid view definitions.");
  assertUniqueIds(views, "view");
  return views;
}

function readProperties(data: Uint8Array | undefined): ComputedProperty[] {
  if (!data) return [];
  const { source, value } = readJsonFile(data, "properties.json");
  const envelope = objectValue(value);
  const list = Array.isArray(value)
    ? value
    : envelope && envelope.format === COMPUTED_FILE_FORMAT && envelope.version === 1 && Array.isArray(envelope.properties)
      ? envelope.properties
      : null;
  if (!list) throw new Error("The package file properties.json has an unsupported format or version.");
  let properties: ComputedProperty[];
  try {
    properties = parseComputedFile(source);
  } catch {
    throw new Error("The package file properties.json is invalid.");
  }
  if (properties.length !== list.length) {
    throw new Error("The package file properties.json contains invalid computed-property definitions.");
  }
  assertUniqueIds(properties, "computed-property");
  return properties;
}

function sanitizeState(value: unknown, rejectMalformed: boolean): Record<string, string> {
  const source = objectValue(value);
  if (!source) return {};
  const state: Record<string, string> = {};
  let totalBytes = 2;
  let entries = 0;
  for (const [key, entry] of Object.entries(source)) {
    if (!carriesState(key)) continue;
    const entryBytes = typeof entry === "string" ? encoder.encode(entry).byteLength : 0;
    if (typeof entry !== "string" || key.length > 2_048 || /[\u0000-\u001f\u007f]/.test(key) ||
      entryBytes > PACKAGE_LIMITS.metadata || entries >= 1_024 || totalBytes + entryBytes > PACKAGE_LIMITS.metadata) {
      if (rejectMalformed) throw new Error(`The package state entry is invalid: ${key}`);
      continue;
    }
    state[key] = entry;
    entries++;
    totalBytes += entryBytes + encoder.encode(key).byteLength + 8;
  }
  return state;
}

function packageText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length > maximum || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) {
    throw new Error(`The package ${label} is invalid.`);
  }
  return value;
}

function readState(data: Uint8Array | undefined): Record<string, string> {
  if (!data) return {};
  const { value } = readJsonFile(data, "state.json");
  if (!objectValue(value)) throw new Error("The package file state.json must contain an object.");
  return sanitizeState(value, true);
}

const shortString = (value: unknown, limit: number, nonEmpty = false): string | null =>
  typeof value === "string" && value.length <= limit && (!nonEmpty || value.length > 0) ? value : null;
const finiteNumber = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const boundedNumber = (value: unknown, maximum: number): value is number =>
  finiteNumber(value) && Math.abs(value) <= maximum;

function sheetPoint(value: unknown): { x: number; y: number } | null {
  const point = objectValue(value);
  return point && boundedNumber(point.x, MAX_SHEET_COORDINATE) && boundedNumber(point.y, MAX_SHEET_COORDINATE)
    ? { x: point.x, y: point.y } : null;
}

function worldPoint(value: unknown): [number, number] | null {
  return Array.isArray(value) && value.length === 2 &&
    boundedNumber(value[0], MAX_WORLD_COORDINATE) && boundedNumber(value[1], MAX_WORLD_COORDINATE)
    ? [value[0], value[1]] : null;
}

function normalizeSheetRecord(raw: unknown): SheetRecord | null {
  const value = objectValue(raw);
  if (!value) return null;
  const id = shortString(value.id, 256, true);
  const name = shortString(value.name, 4_096, true);
  const source = shortString(value.source, 4_096);
  const storey = shortString(value.storey, 4_096);
  if (!id || name === null || source === null || storey === null || !safeArchivePath(id) || id.includes("/")) return null;
  if (!Number.isSafeInteger(value.page) || (value.page as number) < 1 || (value.page as number) > MAX_SHEET_PAGES ||
    !Number.isSafeInteger(value.pageCount) || (value.pageCount as number) < (value.page as number) ||
    (value.pageCount as number) > MAX_SHEET_PAGES ||
    !Number.isSafeInteger(value.width) || (value.width as number) <= 0 || (value.width as number) > MAX_SHEET_DIMENSION ||
    !Number.isSafeInteger(value.height) || (value.height as number) <= 0 || (value.height as number) > MAX_SHEET_DIMENSION ||
    (value.width as number) * (value.height as number) > MAX_SHEET_PIXELS ||
    !Number.isSafeInteger(value.addedAt) || (value.addedAt as number) < 0) return null;

  let cutHeight: number | null = null;
  if (value.cutHeight !== undefined && value.cutHeight !== null) {
    if (!boundedNumber(value.cutHeight, MAX_WORLD_COORDINATE)) return null;
    cutHeight = value.cutHeight;
  }

  let calibration: SheetRecord["calibration"] = null;
  if (value.calibration !== undefined && value.calibration !== null) {
    const rawCalibration = objectValue(value.calibration);
    const a = sheetPoint(rawCalibration?.a);
    const b = sheetPoint(rawCalibration?.b);
    if (!rawCalibration || !a || !b || !boundedNumber(rawCalibration.distance, MAX_WORLD_COORDINATE) ||
      rawCalibration.distance <= 0 ||
      Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return null;
    calibration = { a, b, distance: rawCalibration.distance };
  }

  let placement: SheetRecord["placement"] = null;
  if (value.placement !== undefined && value.placement !== null) {
    const rawPlacement = objectValue(value.placement);
    const sheetA = sheetPoint(rawPlacement?.sheetA);
    const sheetB = sheetPoint(rawPlacement?.sheetB);
    const worldA = worldPoint(rawPlacement?.worldA);
    const worldB = worldPoint(rawPlacement?.worldB);
    if (!rawPlacement || !sheetA || !sheetB || !worldA || !worldB || typeof rawPlacement.flip !== "boolean" ||
      Math.hypot(sheetB.x - sheetA.x, sheetB.y - sheetA.y) < 1e-6) return null;
    placement = { sheetA, sheetB, worldA, worldB, flip: rawPlacement.flip };
  }

  const rawMarkups = value.markups === undefined ? [] : value.markups;
  if (!Array.isArray(rawMarkups) || rawMarkups.length > 4_096) return null;
  const markups: SheetRecord["markups"] = [];
  const markupIds = new Set<string>();
  const kinds = new Set(["line", "rect", "arrow", "text", "cloud"]);
  for (const rawMarkup of rawMarkups) {
    const markup = objectValue(rawMarkup);
    const markupId = shortString(markup?.id, 256, true);
    const createdAt = shortString(markup?.createdAt, 256, true);
    if (!markup || !markupId || !createdAt || markupIds.has(markupId) || !kinds.has(String(markup.kind)) ||
      !Array.isArray(markup.points) || markup.points.length > 4_096) return null;
    const points = markup.points.map(sheetPoint);
    const minimum = markup.kind === "text" ? 1 : 2;
    if (points.length < minimum || points.some((point) => point === null)) return null;
    if (markup.text !== undefined && shortString(markup.text, 32_768) === null) return null;
    if (markup.color !== undefined && shortString(markup.color, 256) === null) return null;
    markupIds.add(markupId);
    markups.push({
      id: markupId,
      kind: markup.kind as SheetRecord["markups"][number]["kind"],
      points: points as Array<{ x: number; y: number }>,
      ...(typeof markup.text === "string" ? { text: markup.text } : {}),
      ...(typeof markup.color === "string" ? { color: markup.color } : {}),
      createdAt,
    });
  }

  if (value.modelKey !== undefined && shortString(value.modelKey, 4_096) === null) return null;
  return {
    id,
    name,
    source,
    ...(typeof value.modelKey === "string" ? { modelKey: value.modelKey } : {}),
    page: value.page as number,
    pageCount: value.pageCount as number,
    width: value.width as number,
    height: value.height as number,
    storey,
    cutHeight,
    calibration,
    placement,
    markups,
    addedAt: value.addedAt as number,
  };
}

function readSheets(files: Record<string, Uint8Array>): PackageContents["sheets"] {
  const names = Object.keys(files).filter((name) => name.startsWith("sheets/"));
  for (const name of names) {
    if (!/^sheets\/[^/]+\.(?:json|png)$/.test(name)) throw new Error(`The package sheet entry is invalid: ${name}`);
  }
  const sheets: PackageContents["sheets"] = [];
  const ids = new Set<string>();
  for (const name of names.filter((entry) => entry.endsWith(".json"))) {
    const imageName = name.replace(/\.json$/, ".png");
    const image = files[imageName];
    if (!image) throw new Error(`The package sheet is missing its PNG: ${name}`);
    if (!isPng(image)) throw new Error(`The package sheet image is not a PNG: ${imageName}`);
    const id = name.slice("sheets/".length, -".json".length);
    const record = normalizeSheetRecord(readJsonFile(files[name], name).value);
    if (!record || record.id !== id || ids.has(record.id)) throw new Error(`The package sheet record is invalid: ${name}`);
    ids.add(record.id);
    sheets.push({ record, image });
  }
  for (const name of names.filter((entry) => entry.endsWith(".png"))) {
    if (!files[name.replace(/\.png$/, ".json")]) throw new Error(`The package sheet image has no record: ${name}`);
  }
  return sheets;
}

function assertCount(label: string, expected: number, actual: number): void {
  if (expected !== actual) {
    throw new Error(`The package manifest ${label} count is ${expected}, but the package contains ${actual}.`);
  }
}

function inspectArchive(bytes: Uint8Array): ArchiveEntry[] {
  if (bytes.byteLength === 0 || bytes.byteLength > PACKAGE_LIMITS.compressed) {
    throw new Error("The share package is empty or exceeds the compressed size limit.");
  }
  const uint16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const uint32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  const floor = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (uint32(at) === 0x06054b50) { end = at; break; }
  }
  if (end < 0) throw new Error("That package is not a supported ZIP archive.");
  const entriesOnDisk = uint16(end + 8);
  const entries = uint16(end + 10);
  const centralSize = uint32(end + 12);
  const centralOffset = uint32(end + 16);
  const commentLength = uint16(end + 20);
  if (uint16(end + 4) !== 0 || uint16(end + 6) !== 0 || entriesOnDisk !== entries ||
    entries === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new Error("Multi-disk and ZIP64 share packages are not supported.");
  }
  if (entries > PACKAGE_LIMITS.files) throw new Error("The share package contains too many files.");
  if (end + 22 + commentLength !== bytes.length || centralOffset + centralSize !== end) {
    throw new Error("The share package ZIP directory is malformed.");
  }
  const found: ArchiveEntry[] = [];
  const paths = new Set<string>();
  let total = 0;
  let at = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > end || uint32(at) !== 0x02014b50) throw new Error("The share package ZIP directory is malformed.");
    const flags = uint16(at + 8);
    const method = uint16(at + 10);
    const compressed = uint32(at + 20);
    const size = uint32(at + 24);
    const nameLength = uint16(at + 28);
    const extraLength = uint16(at + 30);
    const entryCommentLength = uint16(at + 32);
    const external = uint32(at + 38);
    const next = at + 46 + nameLength + extraLength + entryCommentLength;
    if (next > end || (flags & 1) || (method !== 0 && method !== 8)) throw new Error("The share package uses an unsupported ZIP entry.");
    const path = archiveDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at = next;
    // unzipSync inflates every entry, directory entries included, so the bomb
    // caps run before the trailing-slash skip or a payload behind "evil/"
    // expands in memory uncounted.
    const limit = path.startsWith("model/") ? PACKAGE_LIMITS.uncompressed
      : path.startsWith("sheets/") && path.endsWith(".png") ? PACKAGE_LIMITS.sheetImage
        : path === "preview.png" ? PACKAGE_LIMITS.preview : PACKAGE_LIMITS.metadata;
    if (size > limit) throw new Error(`The package entry is too large: ${path}`);
    if (size > 16 * 1024 * 1024 && size / Math.max(1, compressed) > PACKAGE_LIMITS.compressionRatio) {
      throw new Error(`The package entry expands implausibly far: ${path}`);
    }
    total += size;
    if (total > PACKAGE_LIMITS.uncompressed) throw new Error("The unpacked share package is too large.");
    const directory = path.endsWith("/");
    const checkedPath = directory ? path.slice(0, -1) : path;
    if (!safeArchivePath(checkedPath) || paths.has(checkedPath.toLowerCase()) || ((external >>> 16) & 0o170000) === 0o120000) {
      throw new Error(`Unsafe or duplicate package path: ${path}`);
    }
    paths.add(checkedPath.toLowerCase());
    if (directory) {
      if (size !== 0) throw new Error(`The package directory entry contains data: ${path}`);
      continue;
    }
    found.push({ path, compressed, size });
  }
  if (at !== centralOffset + centralSize) throw new Error("The share package ZIP entry count is inconsistent.");
  return found;
}

function safeArchivePath(path: string): boolean {
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((part) => part && part !== "." && part !== ".." &&
    !["__proto__", "prototype", "constructor"].includes(part.toLowerCase()));
}

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "model.ifc";

export const isPackageName = (name: string): boolean =>
  name.toLowerCase().endsWith(PACKAGE_EXTENSION) || name.toLowerCase().endsWith(".ifcpkg.zip");

const README = `IFCViewX share package
======================

This is an ordinary zip file. Everything in it is readable without IFCViewX:

  manifest.json     what this package is, and when it was made
  model/            the IFC or .ifcx model exactly as it was opened
  views.json        saved view definitions: rules, colour, cuts and camera
  properties.json   computed property definitions the views read
  sheets/           the drawings, as PNG pages plus their calibration
  state.json        issues, measurements, notes and named sets
  preview.png       the view this package was made from

Opening it in IFCViewX restores all of it at once. Nothing here was uploaded
anywhere to produce it.
`;
