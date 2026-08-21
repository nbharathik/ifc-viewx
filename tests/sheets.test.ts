import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const pdf = vi.hoisted(() => ({ getDocument: vi.fn() }));

vi.mock("pdfjs-dist", () => ({
  GlobalWorkerOptions: { workerSrc: "" },
  getDocument: pdf.getDocument,
}));

import {
  autoPlacement,
  isPdf,
  measureOnSheet,
  metresPerPixel,
  newSheet,
  placementDrift,
  placementScale,
  readImagePage,
  renderPdfPages,
  scaleLabel,
  sheetStore,
  sheetToWorld,
  worldToSheet,
  type SheetRecord,
  type StoredSheet,
} from "../src/sheets/sheet.js";

interface FakeRequest<T> {
  result: T;
  error: DOMException | null;
  onsuccess: (() => void) | null;
  onerror: (() => void) | null;
}

interface FakeTransaction {
  error: DOMException | null;
  oncomplete: (() => void) | null;
  onabort: (() => void) | null;
  objectStore: () => IDBObjectStore;
}

function fakeIndexedDb<T>(result: T): {
  open: FakeRequest<IDBDatabase> & { onupgradeneeded: (() => void) | null };
  request: FakeRequest<T>;
  transaction: FakeTransaction;
  store: { put: ReturnType<typeof vi.fn>; getAll: ReturnType<typeof vi.fn> };
  close: ReturnType<typeof vi.fn>;
} {
  const request: FakeRequest<T> = { result, error: null, onsuccess: null, onerror: null };
  const store = {
    put: vi.fn(() => request as unknown as IDBRequest<T>),
    getAll: vi.fn(() => request as unknown as IDBRequest<T>),
  };
  const transaction: FakeTransaction = {
    error: null,
    oncomplete: null,
    onabort: null,
    objectStore: () => store as unknown as IDBObjectStore,
  };
  const close = vi.fn();
  const database = {
    transaction: () => transaction as unknown as IDBTransaction,
    close,
  } as unknown as IDBDatabase;
  const open = {
    result: database,
    error: null,
    onsuccess: null,
    onerror: null,
    onupgradeneeded: null,
  };
  vi.stubGlobal("indexedDB", { open: vi.fn(() => open as unknown as IDBOpenDBRequest) });
  return { open, request, transaction, store, close };
}

const sheet = (patch: Partial<SheetRecord> = {}): SheetRecord => ({
  id: "s1",
  name: "A-101",
  source: "A-101.pdf",
  page: 1,
  pageCount: 1,
  width: 2400,
  height: 1600,
  storey: "Level 1",
  cutHeight: null,
  calibration: null,
  placement: null,
  markups: [],
  addedAt: 0,
  ...patch,
});

/** 100 px stands for 5 m, so one pixel is 50 mm. */
const calibrated = (): SheetRecord =>
  sheet({ calibration: { a: { x: 100, y: 100 }, b: { x: 200, y: 100 }, distance: 5 } });

describe("calibration", () => {
  it("turns two points and a distance into metres per pixel", () => {
    expect(metresPerPixel(calibrated())).toBeCloseTo(0.05, 9);
  });

  it("refuses a degenerate or negative calibration rather than dividing by zero", () => {
    expect(metresPerPixel(sheet({ calibration: { a: { x: 5, y: 5 }, b: { x: 5, y: 5 }, distance: 3 } }))).toBeNull();
    expect(metresPerPixel(sheet({ calibration: { a: { x: 0, y: 0 }, b: { x: 10, y: 0 }, distance: 0 } }))).toBeNull();
    expect(metresPerPixel(sheet())).toBeNull();
  });

  it("measures a distance on the sheet in real units", () => {
    expect(measureOnSheet(calibrated(), { x: 0, y: 0 }, { x: 0, y: 40 })).toBeCloseTo(2, 9);
    expect(measureOnSheet(sheet(), { x: 0, y: 0 }, { x: 0, y: 40 })).toBeNull();
  });

  it("says the drawing scale as a ratio", () => {
    expect(scaleLabel(calibrated())).toBe("1:189");
    expect(scaleLabel(sheet())).toBe("not calibrated");
  });
});

describe("placement", () => {
  /** The sheet is rotated a quarter turn and sits at twice the scale. */
  const placed = (): SheetRecord =>
    sheet({
      calibration: { a: { x: 0, y: 0 }, b: { x: 100, y: 0 }, distance: 100 },
      placement: {
        sheetA: { x: 0, y: 0 },
        sheetB: { x: 100, y: 0 },
        worldA: [10, 20],
        worldB: [10, 120],
        flip: false,
      },
    });

  it("carries a sheet point onto the model plan", () => {
    expect(sheetToWorld(placed(), { x: 0, y: 0 })).toEqual([10, 20]);
    expect(sheetToWorld(placed(), { x: 100, y: 0 })).toEqual([10, 120]);
  });

  it("round-trips a point back to the sheet", () => {
    const record = placed();
    const world = sheetToWorld(record, { x: 37, y: 91 });
    expect(world).not.toBeNull();
    const back = worldToSheet(record, world as [number, number]);
    expect(back?.x).toBeCloseTo(37, 6);
    expect(back?.y).toBeCloseTo(91, 6);
  });

  it("reports the scale the placement implies", () => {
    expect(placementScale(placed().placement!)).toBeCloseTo(1, 9);
  });

  it("mirrors when the drawing was issued flipped", () => {
    const record = placed();
    record.placement!.flip = true;
    const normal = sheetToWorld(placed(), { x: 0, y: 50 });
    const mirrored = sheetToWorld(record, { x: 0, y: 50 });
    expect(mirrored).not.toEqual(normal);
    const back = worldToSheet(record, mirrored as [number, number]);
    expect(back?.x).toBeCloseTo(0, 6);
    expect(back?.y).toBeCloseTo(50, 6);
  });

  it("refuses a placement whose two points are the same", () => {
    const record = sheet({
      placement: { sheetA: { x: 5, y: 5 }, sheetB: { x: 5, y: 5 }, worldA: [0, 0], worldB: [1, 1], flip: false },
    });
    expect(sheetToWorld(record, { x: 9, y: 9 })).toBeNull();
  });

  it("returns nothing before the sheet is placed", () => {
    expect(sheetToWorld(calibrated(), { x: 1, y: 1 })).toBeNull();
    expect(worldToSheet(calibrated(), [1, 1])).toBeNull();
  });

  it("reports the drift when the placement and the calibration disagree", () => {
    const record = placed();
    // Calibration says one metre per pixel; placement pairs say two.
    record.placement!.worldB = [10, 220];
    expect(placementDrift(record)).toBeCloseTo(1, 6);
    const agreeing = placed();
    expect(placementDrift(agreeing)).toBeCloseTo(0, 9);
  });
});

describe("auto placement", () => {
  it("centres a calibrated sheet on the model's plan extent", () => {
    const record = calibrated();
    const placement = autoPlacement(record, { min: [0, 0], max: [40, 20] });
    expect(placement).not.toBeNull();
    record.placement = placement;
    expect(sheetToWorld(record, { x: record.width / 2, y: record.height / 2 })).toEqual([20, 10]);
    // The auto placement keeps the calibrated scale, so it cannot drift.
    expect(placementDrift(record)).toBeCloseTo(0, 9);
  });

  it("will not place a sheet that has no scale yet", () => {
    expect(autoPlacement(sheet(), { min: [0, 0], max: [1, 1] })).toBeNull();
  });
});

describe("format sniffing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("recognizes a PDF by type or by name", () => {
    expect(isPdf("plan.pdf", "")).toBe(true);
    expect(isPdf("plan", "application/pdf")).toBe(true);
    expect(isPdf("plan.png", "image/png")).toBe(false);
  });

  it("normalizes imported images to a bounded PNG page", async () => {
    const drawImage = vi.fn();
    const context = { fillStyle: "", fillRect: vi.fn(), drawImage };
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => context,
      toBlob: (callback: BlobCallback) => callback(new Blob(["png"], { type: "image/png" })),
    };
    const create = document.createElement.bind(document);
    vi.spyOn(document, "createElement").mockImplementation((tagName: string) =>
      tagName === "canvas" ? canvas as unknown as HTMLCanvasElement : create(tagName));
    class FakeImage {
      naturalWidth = 4_800;
      naturalHeight = 2_400;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      removeAttribute = vi.fn();
      set src(_value: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal("Image", FakeImage);
    vi.stubGlobal("URL", { createObjectURL: () => "blob:sheet", revokeObjectURL: vi.fn() });

    const page = await readImagePage(new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }));

    expect(page).toMatchObject({ width: 2_400, height: 1_200, page: 1, pageCount: 1 });
    expect(page.blob.type).toBe("image/png");
    expect(drawImage).toHaveBeenCalledOnce();
  });

  it("refuses SVG content before creating a browser image resource", async () => {
    const createObjectURL = vi.fn(() => "blob:sheet");
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const disguised = new Blob(["<svg xmlns='http://www.w3.org/2000/svg'></svg>"], { type: "image/png" });

    await expect(readImagePage(disguised)).rejects.toThrow(/SVG sheets are not imported/);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});

describe("sheet storage transactions", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("does not report a write as durable until its transaction completes", async () => {
    const db = fakeIndexedDb<IDBValidKey>("s1");
    const stored = newSheet("A-101", "A-101.png", {
      blob: new Blob(["page"]), width: 100, height: 100, page: 1, pageCount: 1,
    }, "model-1");
    let settled = false;
    const write = sheetStore.put(stored).then(() => { settled = true; });

    db.open.onsuccess?.();
    await vi.waitFor(() => expect(db.store.put).toHaveBeenCalledOnce());
    db.request.onsuccess?.();
    await Promise.resolve();

    expect(settled).toBe(false);
    expect(db.close).not.toHaveBeenCalled();
    db.transaction.oncomplete?.();
    await write;
    expect(settled).toBe(true);
    expect(db.close).toHaveBeenCalledOnce();
  });

  it("surfaces an all() transaction failure instead of returning an empty drawing set", async () => {
    const db = fakeIndexedDb<StoredSheet[]>([]);
    const failure = new DOMException("quota database unavailable", "UnknownError");
    const read = sheetStore.all();

    db.open.onsuccess?.();
    await vi.waitFor(() => expect(db.store.getAll).toHaveBeenCalledOnce());
    db.request.error = failure;
    db.request.onerror?.();
    db.transaction.onabort?.();

    await expect(read).rejects.toBe(failure);
    expect(db.close).toHaveBeenCalledOnce();
  });
});

describe("multi-page PDF rendering", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    pdf.getDocument.mockReset();
  });

  it("opens one PDF document for all pages and tears its worker down", async () => {
    const cleanup = vi.fn();
    const render = vi.fn(() => ({ promise: Promise.resolve(), cancel: vi.fn() }));
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 100 * scale, height: 200 * scale }),
      render,
      cleanup,
    };
    const document_ = {
      numPages: 3,
      getPage: vi.fn(async (_pageNumber: number) => page),
    };
    const destroy = vi.fn(async () => undefined);
    pdf.getDocument.mockReturnValue({ promise: Promise.resolve(document_), destroy });
    const context = { fillStyle: "", fillRect: vi.fn() } as unknown as CanvasRenderingContext2D;
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => callback(new Blob(["png"])));
    const visited: number[] = [];

    const result = await renderPdfPages(
      new ArrayBuffer(8),
      (rendered) => void visited.push(rendered.page),
      { maxPages: 3 },
    );

    expect(pdf.getDocument).toHaveBeenCalledOnce();
    expect(document_.getPage.mock.calls.map(([pageNumber]) => pageNumber)).toEqual([1, 2, 3]);
    expect(visited).toEqual([1, 2, 3]);
    expect(result).toEqual({ pageCount: 3, rendered: 3 });
    expect(cleanup).toHaveBeenCalledTimes(3);
    expect(destroy).toHaveBeenCalledOnce();
  });

  it("cleans up a page when cancellation lands while getPage is pending", async () => {
    const cleanup = vi.fn();
    let resolvePage!: (page: { cleanup: () => void }) => void;
    const document_ = {
      numPages: 1,
      getPage: vi.fn(() => new Promise<{ cleanup: () => void }>((resolve) => { resolvePage = resolve; })),
    };
    const destroy = vi.fn(async () => undefined);
    pdf.getDocument.mockReturnValue({ promise: Promise.resolve(document_), destroy });
    const controller = new AbortController();
    const rendering = renderPdfPages(new ArrayBuffer(8), vi.fn(), { signal: controller.signal });
    await vi.waitFor(() => expect(document_.getPage).toHaveBeenCalledOnce());

    controller.abort();
    resolvePage({ cleanup });

    await expect(rendering).rejects.toMatchObject({ name: "AbortError" });
    expect(cleanup).toHaveBeenCalledOnce();
    expect(destroy).toHaveBeenCalledOnce();
  });
});
