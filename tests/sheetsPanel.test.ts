import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => ({
  all: vi.fn(),
  put: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  get: vi.fn(),
  clear: vi.fn(),
}));

vi.mock("@ifcviewx/sdk", async (importOriginal) => ({
  ...await importOriginal<typeof import("../src/sdk/index.js")>(),
  sheetStore: store,
}));

import { mount } from "../src/plugins/sheets/panel.js";
import type { ExtensionContext, SectionContourResult, StoredSheet } from "../src/sdk/index.js";

const drawing = (): StoredSheet => ({
  id: "s1",
  name: "A-101",
  source: "A-101.pdf",
  modelKey: "m1",
  page: 1,
  pageCount: 1,
  width: 100,
  height: 100,
  storey: "",
  cutHeight: 1,
  calibration: null,
  placement: {
    sheetA: { x: 0, y: 0 },
    sheetB: { x: 10, y: 0 },
    worldA: [0, 0],
    worldB: [10, 0],
    flip: false,
  },
  markups: [{
    id: "m1",
    kind: "line",
    points: [{ x: 1, y: 1 }, { x: 5, y: 5 }],
    createdAt: "2026-08-21T00:00:00.000Z",
  }],
  addedAt: 1,
  image: new Blob(["page"], { type: "image/png" }),
});

function context(sectionContours: ExtensionContext["geometry"]["sectionContours"]): ExtensionContext {
  const controller = new AbortController();
  return {
    manifest: { id: "sheets", name: "Sheets" },
    signal: controller.signal,
    session: { model: () => ({ key: "m1", name: "model.ifc", loaded: true }) },
    model: {
      elements: () => [],
      bounds: () => null,
    },
    geometry: { sectionContours },
    view: {
      lastPick: () => null,
      selection: () => [],
    },
    events: { on: () => () => undefined },
    storage: { read: <T,>(_key: string, fallback: T): T => fallback, write: vi.fn() },
    feedback: { log: vi.fn(), toast: vi.fn() },
    issues: { create: vi.fn() },
  } as unknown as ExtensionContext;
}

const contours = (end: number): SectionContourResult => ({
  axis: "y",
  offset: 1,
  polylines: [{ elementId: 1, elementType: "IfcWall", closed: false, points: [[0, 0], [end, 0]], length: end }],
  bounds: { min: [0, 0], max: [end, 0] },
  segmentCount: 1,
  closedCount: 0,
  openCount: 1,
  testedElements: 1,
  missing: 0,
  truncated: false,
  elapsedMs: 1,
  fidelity: "mesh",
  engine: "browser-section",
  geometryRevision: 1,
});

describe("Sheets overlay lifecycle", () => {
  afterEach(() => vi.unstubAllGlobals());

  beforeEach(() => {
    store.all.mockReset().mockResolvedValue([drawing()]);
    store.put.mockClear();
    store.remove.mockClear();
    vi.stubGlobal("URL", {
      ...URL,
      createObjectURL: vi.fn(() => "blob:sheet"),
      revokeObjectURL: vi.fn(),
    });
  });

  it("keeps contours when annotation state is repainted", async () => {
    const sectionContours = vi.fn(async () => contours(10));
    const host = document.createElement("div");
    const instance = mount(host, context(sectionContours));
    await vi.waitFor(() => expect(host.querySelectorAll(".sheet-overlay polyline")).toHaveLength(1));

    const tool = [...host.querySelectorAll("select")].find((entry) => entry.value === "pan");
    expect(tool).toBeDefined();
    tool!.value = "measure";
    tool!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(host.querySelectorAll(".sheet-overlay polyline")).toHaveLength(1);
    expect(host.querySelectorAll(".sheet-annotations .sheet-markup-line")).toHaveLength(1);
    instance.dispose?.();
  });

  it("scopes a legacy drawing to the open model without trusting its old placement", async () => {
    const legacy = drawing();
    delete legacy.modelKey;
    store.all.mockResolvedValue([legacy]);
    const host = document.createElement("div");
    const instance = mount(host, context(vi.fn(async () => contours(10))));

    await vi.waitFor(() => expect(store.put).toHaveBeenCalledOnce());
    expect(legacy.modelKey).toBe("m1");
    expect(legacy.placement).toBeNull();
    expect(host.textContent).toContain("not placed");
    instance.dispose?.();
  });

  it("ignores an obsolete contour result and never duplicates the overlay", async () => {
    const resolves: Array<(result: SectionContourResult) => void> = [];
    const sectionContours = vi.fn(() => new Promise<SectionContourResult>((resolve) => resolves.push(resolve)));
    const host = document.createElement("div");
    const instance = mount(host, context(sectionContours));
    await vi.waitFor(() => expect(sectionContours).toHaveBeenCalledOnce());

    const toggle = [...host.querySelectorAll("button")].find((entry) => entry.textContent === "Overlay on");
    expect(toggle).toBeDefined();
    toggle!.click();
    toggle!.click();
    await vi.waitFor(() => expect(sectionContours).toHaveBeenCalledTimes(2));

    resolves[1](contours(20));
    await vi.waitFor(() => expect(host.querySelector(".sheet-overlay polyline")?.getAttribute("points")).toBe("0.0,0.0 20.0,0.0"));
    resolves[0](contours(5));
    await Promise.resolve();

    expect(host.querySelectorAll(".sheet-overlay polyline")).toHaveLength(1);
    expect(host.querySelector(".sheet-overlay polyline")?.getAttribute("points")).toBe("0.0,0.0 20.0,0.0");
    instance.dispose?.();
  });
});
