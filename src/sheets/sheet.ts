// The issued drawing set, inside the viewer.
//
// A sheet is a raster page plus two pieces of arithmetic: a scale, so a
// distance measured on it is a real distance, and a placement, so a point on
// it is a point in the model. Everything else, the overlay, the pick-through
// and the markup, follows from those two.
//
// Sheets are stored in IndexedDB rather than localStorage: a page raster is
// megabytes and the quota for a string store is not.

import type { PDFDocumentProxy } from "pdfjs-dist";

export interface SheetPoint {
  x: number;
  y: number;
}

/** Two picked points and the real distance between them. */
export interface SheetCalibration {
  a: SheetPoint;
  b: SheetPoint;
  /** Real-world distance between a and b, in metres. */
  distance: number;
}

/**
 * Sheet pixels to model plan metres, as a complex multiply. Two matched point
 * pairs give rotation, uniform scale and translation exactly; `flip` negates
 * the sheet's vertical axis first, for a plan issued mirrored.
 */
export interface SheetPlacement {
  sheetA: SheetPoint;
  sheetB: SheetPoint;
  /** Scene plan coordinates: X and Z, which is what a Y-axis cut produces. */
  worldA: [number, number];
  worldB: [number, number];
  flip: boolean;
}

export interface SheetMarkup {
  id: string;
  kind: "line" | "rect" | "arrow" | "text" | "cloud";
  points: SheetPoint[];
  text?: string;
  color?: string;
  createdAt: string;
}

export interface SheetRecord {
  id: string;
  name: string;
  /** Which file it came from, for a re-import that should replace it. */
  source: string;
  /** Viewer model revision this drawing is calibrated and placed against. */
  modelKey?: string;
  page: number;
  pageCount: number;
  width: number;
  height: number;
  /** Storey name this sheet draws, so the overlay knows where to cut. */
  storey: string;
  /** Cut height in scene metres, when the storey name is not enough. */
  cutHeight: number | null;
  calibration: SheetCalibration | null;
  placement: SheetPlacement | null;
  markups: SheetMarkup[];
  addedAt: number;
}

export interface StoredSheet extends SheetRecord {
  /** The rendered page. Kept out of the record type so metadata stays small. */
  image: Blob;
}

const distance = (a: SheetPoint, b: SheetPoint): number => Math.hypot(b.x - a.x, b.y - a.y);

/** Metres per sheet pixel, or null before the sheet has been calibrated. */
export function metresPerPixel(sheet: SheetRecord): number | null {
  const calibration = sheet.calibration;
  if (!calibration) return null;
  const pixels = distance(calibration.a, calibration.b);
  if (pixels < 1e-6 || !Number.isFinite(calibration.distance) || calibration.distance <= 0) return null;
  return calibration.distance / pixels;
}

/** The drawing's scale as a ratio, for the sheet header. */
export function scaleLabel(sheet: SheetRecord, dotsPerInch = 96): string {
  const perPixel = metresPerPixel(sheet);
  if (perPixel === null) return "not calibrated";
  const metresPerPaperMetre = perPixel * (dotsPerInch / 0.0254);
  const denominator = Math.round(metresPerPaperMetre);
  return denominator > 0 ? `1:${denominator}` : "1:1";
}

interface Complex {
  re: number;
  im: number;
}

/** The similarity that carries sheet pixels onto the model plan. */
export function placementTransform(placement: SheetPlacement): Complex | null {
  const sheetVector: Complex = {
    re: placement.sheetB.x - placement.sheetA.x,
    im: (placement.sheetB.y - placement.sheetA.y) * (placement.flip ? -1 : 1),
  };
  const worldVector: Complex = {
    re: placement.worldB[0] - placement.worldA[0],
    im: placement.worldB[1] - placement.worldA[1],
  };
  const magnitude = sheetVector.re * sheetVector.re + sheetVector.im * sheetVector.im;
  if (magnitude < 1e-9) return null;
  // world / sheet, as complex division: rotation and uniform scale in one.
  return {
    re: (worldVector.re * sheetVector.re + worldVector.im * sheetVector.im) / magnitude,
    im: (worldVector.im * sheetVector.re - worldVector.re * sheetVector.im) / magnitude,
  };
}

export function sheetToWorld(sheet: SheetRecord, point: SheetPoint): [number, number] | null {
  const placement = sheet.placement;
  if (!placement) return null;
  const k = placementTransform(placement);
  if (!k) return null;
  const dx = point.x - placement.sheetA.x;
  const dy = (point.y - placement.sheetA.y) * (placement.flip ? -1 : 1);
  return [
    placement.worldA[0] + k.re * dx - k.im * dy,
    placement.worldA[1] + k.im * dx + k.re * dy,
  ];
}

export function worldToSheet(sheet: SheetRecord, world: [number, number]): SheetPoint | null {
  const placement = sheet.placement;
  if (!placement) return null;
  const k = placementTransform(placement);
  if (!k) return null;
  const magnitude = k.re * k.re + k.im * k.im;
  if (magnitude < 1e-12) return null;
  const dx = world[0] - placement.worldA[0];
  const dy = world[1] - placement.worldA[1];
  const x = (dx * k.re + dy * k.im) / magnitude;
  const y = (dy * k.re - dx * k.im) / magnitude;
  return {
    x: placement.sheetA.x + x,
    y: placement.sheetA.y + y * (placement.flip ? -1 : 1),
  };
}

/** The scale the placement implies, which should agree with the calibration. */
export function placementScale(placement: SheetPlacement): number | null {
  const k = placementTransform(placement);
  return k ? Math.hypot(k.re, k.im) : null;
}

/**
 * How far the placement and the calibration disagree, as a percentage. A
 * sheet aligned on two points a metre apart will disagree slightly; one that
 * disagrees by tens of percent was aligned on the wrong pair.
 */
export function placementDrift(sheet: SheetRecord): number | null {
  const perPixel = metresPerPixel(sheet);
  const placed = sheet.placement ? placementScale(sheet.placement) : null;
  if (perPixel === null || placed === null || perPixel <= 0) return null;
  return Math.abs(placed - perPixel) / perPixel;
}

/**
 * A placement with no picked pair: the calibrated sheet centred on the model's
 * plan extent, north up. Rough, immediate, and enough to see whether the
 * drawing and the model are the same building before anybody picks anything.
 */
export function autoPlacement(
  sheet: SheetRecord,
  modelPlan: { min: [number, number]; max: [number, number] },
): SheetPlacement | null {
  const perPixel = metresPerPixel(sheet);
  if (perPixel === null) return null;
  const sheetCentre = { x: sheet.width / 2, y: sheet.height / 2 };
  const worldCentre: [number, number] = [
    (modelPlan.min[0] + modelPlan.max[0]) / 2,
    (modelPlan.min[1] + modelPlan.max[1]) / 2,
  ];
  return {
    sheetA: sheetCentre,
    sheetB: { x: sheetCentre.x + 100, y: sheetCentre.y },
    worldA: worldCentre,
    worldB: [worldCentre[0] + 100 * perPixel, worldCentre[1]],
    flip: false,
  };
}

/** Distance between two sheet points, in metres. Null before calibration. */
export function measureOnSheet(sheet: SheetRecord, a: SheetPoint, b: SheetPoint): number | null {
  const perPixel = metresPerPixel(sheet);
  return perPixel === null ? null : distance(a, b) * perPixel;
}

// -- storage ----------------------------------------------------------------

const DB_NAME = "ifcviewx.sheets";
const DB_VERSION = 1;
const STORE = "sheets";

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("This browser has no IndexedDB, so sheets cannot be kept"));
      return;
    }
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: "id" });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("The sheet store could not be opened"));
  });
}

function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDatabase().then(
    (database) =>
      new Promise<T>((resolve, reject) => {
        let transaction: IDBTransaction;
        let request: IDBRequest<T>;
        let result: T;
        let requestError: DOMException | null = null;
        try {
          transaction = database.transaction(STORE, mode);
          request = work(transaction.objectStore(STORE));
        } catch (error) {
          database.close();
          reject(error);
          return;
        }
        request.onsuccess = () => {
          result = request.result;
        };
        request.onerror = () => {
          requestError = request.error;
          // Do not prevent the default: IndexedDB must abort the transaction.
        };
        transaction.oncomplete = () => {
          database.close();
          resolve(result);
        };
        transaction.onabort = () => {
          database.close();
          reject(requestError ?? transaction.error ?? new Error("The sheet store transaction was aborted"));
        };
      }),
  );
}

export const sheetStore = {
  all: (): Promise<StoredSheet[]> =>
    run<StoredSheet[]>("readonly", (store) => store.getAll() as IDBRequest<StoredSheet[]>)
      .then((sheets) => sheets.sort((a, b) => a.addedAt - b.addedAt)),
  get: (id: string): Promise<StoredSheet | undefined> =>
    run<StoredSheet | undefined>("readonly", (store) => store.get(id) as IDBRequest<StoredSheet | undefined>),
  put: (sheet: StoredSheet): Promise<unknown> =>
    run("readwrite", (store) => store.put(sheet) as IDBRequest<unknown>),
  remove: (id: string): Promise<unknown> =>
    run("readwrite", (store) => store.delete(id) as IDBRequest<unknown>),
  clear: (): Promise<unknown> => run("readwrite", (store) => store.clear() as IDBRequest<unknown>),
};

// -- import -----------------------------------------------------------------

export interface RenderedPage {
  blob: Blob;
  width: number;
  height: number;
  page: number;
  pageCount: number;
}

/** Pixels across the widest side of a rasterized page. */
export const PAGE_RASTER_WIDTH = 2400;

const MAX_PDF_BYTES = 256 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_IMAGE_DIMENSION = 50_000;
const MAX_SOURCE_IMAGE_PIXELS = 100_000_000;
const MAX_RASTER_DIMENSION = 10_000;
const MAX_RASTER_PIXELS = 100_000_000;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const headerDecoder = new TextDecoder("utf-8", { fatal: false });

export interface RenderPdfPagesOptions {
  maxPages?: number;
  maxWidth?: number;
  signal?: AbortSignal;
  onProgress?: (page: number, pageCount: number) => void;
}

export interface RenderPdfPagesResult {
  pageCount: number;
  rendered: number;
}

const cancelled = (): DOMException => new DOMException("Sheet import cancelled", "AbortError");

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function encodePng(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
  assertActive(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value: Blob | Error): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      if (value instanceof Error) reject(value);
      else resolve(value);
    };
    const onAbort = (): void => finish(cancelled());
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      canvas.toBlob((blob) => {
        if (signal?.aborted) return finish(cancelled());
        finish(blob ?? new Error("The page could not be rasterized"));
      }, "image/png");
    } catch (error) {
      finish(error instanceof Error ? error : new Error(String(error)));
    }
  });
}

function supportedRasterHeader(bytes: Uint8Array): boolean {
  if (PNG_MAGIC.every((value, index) => bytes[index] === value)) return true;
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return true;
  return bytes.length >= 12
    && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF"
    && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}

function looksLikeSvg(bytes: Uint8Array): boolean {
  return /<svg(?:\s|>)/i.test(headerDecoder.decode(bytes));
}

async function withPdfDocument<T>(
  data: ArrayBuffer,
  signal: AbortSignal | undefined,
  work: (document_: PDFDocumentProxy) => Promise<T>,
): Promise<T> {
  assertActive(signal);
  if (data.byteLength === 0 || data.byteLength > MAX_PDF_BYTES) {
    throw new Error("That PDF is empty or too large to import safely in this tab");
  }
  const pdfjs = await import("pdfjs-dist");
  assertActive(signal);
  // The worker ships beside the library; Vite resolves it as an asset URL so
  // no copy of it has to be served by hand.
  pdfjs.GlobalWorkerOptions.workerSrc = new URL("pdfjs-dist/build/pdf.worker.mjs", import.meta.url).href;
  const loading = pdfjs.getDocument({ data: new Uint8Array(data) });
  let destruction: Promise<void> | null = null;
  let completed = false;
  const destroy = (): Promise<void> => {
    // pdf.js v6 owns teardown on the loading task; this also destroys the
    // resolved document proxy and its worker.
    if (!destruction) destruction = loading.destroy();
    return destruction;
  };
  const onAbort = (): void => void destroy().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const document_ = await loading.promise;
    assertActive(signal);
    const result = await work(document_);
    completed = true;
    return result;
  } catch (error) {
    if (signal?.aborted) throw cancelled();
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    try {
      await destroy();
    } catch (error) {
      // Cleanup must not hide the parse/raster error that led here.
      if (completed && !signal?.aborted) throw error;
    }
  }
}

async function rasterizePdfPage(
  document_: PDFDocumentProxy,
  pageNumber: number,
  maxWidth: number,
  signal?: AbortSignal,
): Promise<RenderedPage> {
  assertActive(signal);
  const pageCount = document_.numPages;
  if (!Number.isSafeInteger(pageCount) || pageCount <= 0) throw new Error("That PDF carries no readable pages");
  const requestedPage = Number.isFinite(pageNumber) ? Math.trunc(pageNumber) : 1;
  const selectedPage = Math.min(Math.max(1, requestedPage), pageCount);
  const page = await document_.getPage(selectedPage);
  let canvas: HTMLCanvasElement | null = null;
  try {
    assertActive(signal);
    const base = page.getViewport({ scale: 1 });
    if (!Number.isFinite(base.width) || !Number.isFinite(base.height) || base.width <= 0 || base.height <= 0) {
      throw new Error("That PDF page has invalid dimensions");
    }
    const targetWidth = Number.isFinite(maxWidth) && maxWidth > 0
      ? Math.min(MAX_RASTER_DIMENSION, maxWidth)
      : PAGE_RASTER_WIDTH;
    // No minimum scale: it would defeat the output bound for a huge PDF page.
    const scale = Math.min(4, targetWidth / Math.max(base.width, base.height));
    const viewport = page.getViewport({ scale });
    if (!Number.isFinite(viewport.width) || !Number.isFinite(viewport.height) ||
      viewport.width <= 0 || viewport.height <= 0) throw new Error("That PDF page has invalid dimensions");
    const width = Math.max(1, Math.round(viewport.width));
    const height = Math.max(1, Math.round(viewport.height));
    if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION || width * height > MAX_RASTER_PIXELS) {
      throw new Error("That PDF page is too large to rasterize safely");
    }
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser would not give a 2D canvas for the page");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    const rendering = page.render({ canvas, canvasContext: context, viewport });
    const onAbort = (): void => {
      try { rendering.cancel(); } catch { /* The document teardown also cancels it. */ }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await rendering.promise;
      assertActive(signal);
      const blob = await encodePng(canvas, signal);
      return { blob, width, height, page: selectedPage, pageCount };
    } catch (error) {
      if (signal?.aborted) throw cancelled();
      throw error;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  } finally {
    try { page.cleanup(); } catch { /* Cleanup must not mask the raster error. */ }
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
  }
}

/**
 * Rasterize a PDF page. pdf.js is loaded on the first PDF and never before:
 * a session that only ever opens PNGs pays nothing for it.
 */
export async function renderPdfPage(data: ArrayBuffer, pageNumber = 1, maxWidth = PAGE_RASTER_WIDTH): Promise<RenderedPage> {
  return withPdfDocument(data, undefined, (document_) => rasterizePdfPage(document_, pageNumber, maxWidth));
}

/**
 * Rasterize a run of PDF pages while keeping one pdf.js document alive. The
 * visitor can persist each page immediately, so a forty-page drawing set does
 * not have to retain forty full-size canvases and blobs in memory.
 */
export async function renderPdfPages(
  data: ArrayBuffer,
  visit: (page: RenderedPage) => void | Promise<void>,
  options: RenderPdfPagesOptions = {},
): Promise<RenderPdfPagesResult> {
  return withPdfDocument(data, options.signal, async (document_) => {
    if (!Number.isSafeInteger(document_.numPages) || document_.numPages <= 0) {
      throw new Error("That PDF carries no readable pages");
    }
    const requested = options.maxPages === undefined
      ? document_.numPages
      : Number.isFinite(options.maxPages) ? Math.max(0, Math.floor(options.maxPages)) : document_.numPages;
    const limit = Math.min(document_.numPages, requested);
    for (let pageNumber = 1; pageNumber <= limit; pageNumber++) {
      assertActive(options.signal);
      options.onProgress?.(pageNumber, document_.numPages);
      const rendered = await rasterizePdfPage(
        document_,
        pageNumber,
        options.maxWidth ?? PAGE_RASTER_WIDTH,
        options.signal,
      );
      await visit(rendered);
      assertActive(options.signal);
    }
    return { pageCount: document_.numPages, rendered: limit };
  });
}

/** Rasterize an image to the same bounded PNG representation as a PDF page. */
export async function readImagePage(
  file: Blob,
  signal?: AbortSignal,
  maxWidth = PAGE_RASTER_WIDTH,
): Promise<RenderedPage> {
  assertActive(signal);
  if (file.size === 0 || file.size > MAX_IMAGE_BYTES) {
    throw new Error("That image is empty or too large to import safely in this tab");
  }
  const mime = file.type.split(";", 1)[0].trim().toLowerCase();
  if (mime === "image/svg+xml") {
    throw new Error("SVG sheets are not imported because they can reference remote content");
  }
  const header = new Uint8Array(await file.slice(0, 1_024).arrayBuffer());
  assertActive(signal);
  if (!supportedRasterHeader(header)) {
    if (looksLikeSvg(header)) {
      throw new Error("SVG sheets are not imported because they can reference remote content");
    }
    throw new Error("That sheet is not a supported PNG, JPEG, or WebP image");
  }
  const url = URL.createObjectURL(file);
  let loaded: HTMLImageElement | null = null;
  let canvas: HTMLCanvasElement | null = null;
  try {
    loaded = await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image();
      const cleanup = (): void => signal?.removeEventListener("abort", onAbort);
      const onAbort = (): void => {
        cleanup();
        image.removeAttribute("src");
        reject(new DOMException("Image import cancelled", "AbortError"));
      };
      image.onload = () => {
        cleanup();
        resolve(image);
      };
      image.onerror = () => {
        cleanup();
        reject(new Error("That image could not be read"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      image.src = url;
    });
    assertActive(signal);
    const sourceWidth = loaded.naturalWidth;
    const sourceHeight = loaded.naturalHeight;
    if (!Number.isSafeInteger(sourceWidth) || !Number.isSafeInteger(sourceHeight) || sourceWidth <= 0 || sourceHeight <= 0 ||
      sourceWidth > MAX_SOURCE_IMAGE_DIMENSION || sourceHeight > MAX_SOURCE_IMAGE_DIMENSION ||
      sourceWidth * sourceHeight > MAX_SOURCE_IMAGE_PIXELS) {
      throw new Error("That image has invalid or impractically large dimensions");
    }
    const targetWidth = Number.isFinite(maxWidth) && maxWidth > 0
      ? Math.min(MAX_RASTER_DIMENSION, maxWidth)
      : PAGE_RASTER_WIDTH;
    const scale = Math.min(1, targetWidth / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    if (width > MAX_RASTER_DIMENSION || height > MAX_RASTER_DIMENSION || width * height > MAX_RASTER_PIXELS) {
      throw new Error("That image is too large to rasterize safely");
    }
    canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("This browser would not give a 2D canvas for the image");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(loaded, 0, 0, width, height);
    const blob = await encodePng(canvas, signal);
    return { blob, width, height, page: 1, pageCount: 1 };
  } finally {
    loaded?.removeAttribute("src");
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    URL.revokeObjectURL(url);
  }
}

export const isPdf = (name: string, type: string): boolean =>
  type.split(";", 1)[0].trim().toLowerCase() === "application/pdf" || name.toLowerCase().endsWith(".pdf");

export function newSheet(name: string, source: string, rendered: RenderedPage, modelKey = ""): StoredSheet {
  return {
    id: `sheet-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
    name,
    source,
    modelKey,
    page: rendered.page,
    pageCount: rendered.pageCount,
    width: rendered.width,
    height: rendered.height,
    storey: "",
    cutHeight: null,
    calibration: null,
    placement: null,
    markups: [],
    addedAt: Date.now(),
    image: rendered.blob,
  };
}
