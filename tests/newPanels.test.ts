// Every panel added in this pass, mounted for real.
//
// The failure these catch is the one a unit test on the logic never does: a
// panel that throws while it builds, because of a control that does not exist
// or a value read before its model is there. Each panel is mounted twice, once
// with a model and once without, because "no model yet" is the state every
// user sees first.
import { describe, expect, it, vi } from "vitest";

import { mount as mountPointCloud } from "../src/plugins/point-cloud/panel.js";
import { mount as mountPresentation } from "../src/plugins/presentation/panel.js";
import { mount as mountReportBuilder } from "../src/plugins/report-builder/panel.js";
import { mount as mountRuleStudio } from "../src/plugins/rule-studio/panel.js";
import { mount as mountSheets } from "../src/plugins/sheets/panel.js";
import { mount as mountSunStudy } from "../src/plugins/sun-study/panel.js";
import { DrivePanel } from "../src/ui/drivePanel.js";
import { ResultsDock, clearDocket, docketSets, publishDocket } from "../src/ui/resultsDock.js";
import { ViewsPane } from "../src/ui/viewsPane.js";
import { ComputedStore } from "../src/data/computed.js";
import { ViewStore } from "../src/views/definition.js";
import type { ExtensionContext } from "../src/sdk/index.js";
import type { Viewer } from "../src/viewer-core/viewer.js";
import type { PropertyIndex } from "../src/sdk/data.js";

function context(loaded: boolean): ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    manifest: { id: "test", name: "Test" },
    signal: new AbortController().signal,
    session: { model: () => ({ key: loaded ? "m1" : "", name: "Arch.ifc", loaded }) },
    model: {
      elements: () => (loaded ? [{ id: 100, type: "IfcWall", name: "Wall", storey: "Level 1" }] : []),
      classes: () => (loaded ? [["IfcWall", 1] as [string, number]] : []),
      properties: vi.fn(async () => null),
      tree: () => (loaded ? { expressID: 1, type: "IfcProject", name: "P", children: [] } : null),
      subtree: () => [],
      bounds: () => (loaded ? { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 3, z: 0.2 } } : null),
      index: () => ({
        ready: () => false,
        all: () => [],
        propertyKeys: () => [],
        build: vi.fn(async () => []),
        invalidate: vi.fn(),
      }) as unknown as PropertyIndex,
      modelOf: () => 0,
      expressOf: (id: number) => id,
      scheduleGraph: vi.fn(),
    },
    geometry: {
      clash: vi.fn(async () => ({ hits: [] })),
      distance: vi.fn(),
      laser: vi.fn(),
      sectionContours: vi.fn(async () => ({ polylines: [] })),
      signatures: vi.fn(async () => ({ signatures: [] })),
      volumes: vi.fn(async () => ({ volumes: [] })),
      sun: vi.fn(async () => ({ exposure: new Float32Array(), directions: 0 })),
      deviation: vi.fn(async () => ({ distances: new Float32Array(), measured: 0, points: 0 })),
    },
    view: {
      select: vi.fn(),
      selection: () => [],
      lastPick: () => null,
      isVisible: () => true,
      isolate: vi.fn(),
      hide: vi.fn(),
      showAll: vi.fn(),
      frame: vi.fn(),
      frameAt: vi.fn(),
      camera: () => ({ position: [1, 1, 1] as [number, number, number], target: [0, 0, 0] as [number, number, number] }),
      setCamera: vi.fn(),
      sections: () => [],
      setSections: vi.fn(),
      setSectionBox: vi.fn(),
      boxAround: () => null,
      modelBox: () => (loaded ? { min: [0, 0, 0] as [number, number, number], max: [10, 3, 10] as [number, number, number] } : null),
      georeferencedToScene: () => null,
      models: () => [],
      colorBy: vi.fn(),
      setSun: vi.fn(),
      setPointCloud: vi.fn(),
      setPointCloudSize: vi.fn(),
      setPointCloudVisible: vi.fn(),
      capture: vi.fn(),
      recordStart: () => false,
      recordStop: vi.fn(async () => null),
      measurements: () => [],
    },
    events: { on: () => () => undefined },
    storage: {
      read: <T,>(key: string, fallback: T): T => (store.has(key) ? (store.get(key) as T) : fallback),
      write: (key: string, value: unknown) => void store.set(key, value),
    },
    feedback: { log: vi.fn(), toast: vi.fn(), publishFindings: vi.fn(), publishResults: vi.fn() },
    commands: { run: vi.fn(), register: vi.fn() },
    capabilities: { list: () => [], execute: vi.fn() },
    contributions: { register: vi.fn() },
    overlays: { line: vi.fn(), remove: vi.fn(), clear: vi.fn() },
    files: { open: vi.fn(), export: vi.fn() },
    issues: { create: vi.fn() },
    results: { create: vi.fn(), get: vi.fn(), page: vi.fn(), dispose: vi.fn() },
    local: { status: vi.fn(), capabilities: () => [], invoke: vi.fn() },
    python: { runsNatively: () => false, query: vi.fn(), propose: vi.fn() },
    close: vi.fn(),
  } as unknown as ExtensionContext;
}

const PANELS: Array<[string, (host: HTMLElement, ctx: ExtensionContext) => unknown]> = [
  ["Rule Studio", mountRuleStudio],
  ["Report Builder", mountReportBuilder],
  ["Sheets", mountSheets],
  ["Sun and Shadow", mountSunStudy],
  ["Point Cloud", mountPointCloud],
  ["Presentation", mountPresentation],
];

describe("every new plugin panel builds", () => {
  for (const [name, mount] of PANELS) {
    it(`${name} mounts with a model and renders something`, () => {
      const host = document.createElement("div");
      const instance = mount(host, context(true)) as { dispose?(): void } | void;
      expect(host.childElementCount).toBeGreaterThan(0);
      expect(host.querySelector(".plug-head")).not.toBeNull();
      instance?.dispose?.();
    });

    it(`${name} mounts before a model is open`, () => {
      const host = document.createElement("div");
      const instance = mount(host, context(false)) as { dispose?(): void } | void;
      expect(host.textContent?.length ?? 0).toBeGreaterThan(0);
      instance?.dispose?.();
    });
  }
});

describe("Rule Studio", () => {
  it("lists every shipped rule as a card the user can turn off", () => {
    const host = document.createElement("div");
    const instance = mountRuleStudio(host, context(true)) as { dispose?(): void };
    expect(host.querySelectorAll(".rule-card").length).toBe(12);
    // The enable toggle lives on the summary; a boolean rule parameter is a
    // checkbox too, so the assertion has to be about the summary alone.
    expect(host.querySelectorAll(".rule-card > summary > input[type=checkbox]").length).toBe(12);
    instance?.dispose?.();
  });
});

describe("Report Builder", () => {
  it("opens with a usable default template rather than an empty form", () => {
    const host = document.createElement("div");
    mountReportBuilder(host, context(true));
    expect(host.querySelectorAll(".report-column").length).toBeGreaterThan(0);
    expect(host.textContent).toContain("Scope");
  });
});

// -- core panels ------------------------------------------------------------

function fakeViewer(): Viewer {
  return {
    getStats: () => ({ totalEntities: 10, triangleCount: 20 }),
    getCamera: () => ({ position: [1, 1, 1], target: [0, 0, 0] }),
    setCamera: vi.fn(),
    getModelOrigin: () => [0, 0, 0],
    getRules: () => [],
    getElementTypes: () => new Map(),
    getSpatialTree: () => null,
    getModels: () => [],
    getHiddenIds: () => [],
    getElementOffsets: () => [],
    getAnnotationStates: () => [],
    getMeasurementStates: () => [],
    getSections: () => [],
    getSectionBox: () => null,
    getProjection: () => "perspective",
    isGhostHidden: () => false,
    isCategoryVisible: () => false,
    isElementXray: () => false,
    getElementBounds: () => null,
    captureImage: vi.fn(async () => null),
    showAll: vi.fn(),
    isolate: vi.fn(),
    selectMany: vi.fn(),
    fitToPoint: vi.fn(),
    fitToElement: vi.fn(),
  } as unknown as Viewer;
}

const memoryStorage = (): Storage => {
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

describe("the Views pane", () => {
  it("builds both halves of the definitions layer and offers to save the current view", () => {
    const host = document.createElement("div");
    const index = { ready: () => false, all: () => [], propertyKeys: () => [], setComputed: vi.fn() } as unknown as PropertyIndex;
    new ViewsPane(
      host,
      fakeViewer(),
      index,
      { colorRule: () => null, setColorRule: vi.fn(), selectors: () => new Map(), log: vi.fn() },
      new ViewStore(memoryStorage()),
      new ComputedStore(memoryStorage()),
    );
    expect(host.textContent).toContain("Save this view");
    expect(host.textContent).toContain("No saved views yet");
    const tabs = [...host.querySelectorAll("button")].filter((node) => node.textContent === "Properties");
    expect(tabs).toHaveLength(1);
    tabs[0].click();
    expect(host.textContent).toContain("No computed properties");
  });
});

describe("the results dock", () => {
  it("stays hidden with nothing on it and opens on the set it is given", () => {
    clearDocket();
    const host = document.createElement("div");
    const dock = new ResultsDock(host, {
      isolate: vi.fn(), select: vi.fn(), frameAt: vi.fn(), frame: vi.fn(),
      showAll: vi.fn(), raiseIssue: vi.fn(), log: vi.fn(),
    });
    expect(dock.isOpen()).toBe(false);
    expect(dock.count()).toBe(0);

    publishDocket({
      id: "rules",
      producer: "Rule Studio",
      title: "Model receipt",
      summary: "2 findings",
      rows: [
        { id: "a", severity: "error", title: "Duplicate GlobalId", group: "Identity", ids: [1] },
        { id: "b", severity: "warning", title: "No classification", group: "Data", ids: [2] },
      ],
    });
    dock.show("rules");
    expect(dock.isOpen()).toBe(true);
    expect(dock.count()).toBe(2);
    expect(host.textContent).toContain("Duplicate GlobalId");
    expect(host.querySelectorAll(".dock-row")).toHaveLength(2);
    // Grouping is shared by every producer, so the group headers are there
    // whatever wrote the rows.
    expect(host.querySelectorAll(".dock-group").length).toBe(2);
    clearDocket();
  });

  it("rejects malformed or unbounded plugin result payloads", () => {
    clearDocket();
    expect(() => publishDocket({
      id: "bad",
      producer: "Plugin",
      title: "Bad",
      summary: "",
      rows: [{ id: "row", severity: "error", title: "Bad", ids: [Number.NaN] }],
    })).toThrow(/element ids/i);
    expect(() => publishDocket({
      id: "huge",
      producer: "Plugin",
      title: "Huge",
      summary: "",
      rows: Array.from({ length: 50_001 }, (_, index) => ({
        id: String(index), severity: "info" as const, title: "row", ids: [],
      })),
    })).toThrow(/at most 50[.,]000/i);
    expect(docketSets()).toHaveLength(0);
  });
});

describe("drive mode", () => {
  it("stays closed and says so when the model carries no alignment", () => {
    const host = document.createElement("div");
    const log = vi.fn();
    const panel = new DrivePanel(host, fakeViewer(), { log });
    expect(panel.isOpen()).toBe(false);
    panel.present([], "IFC4");
    expect(panel.isOpen()).toBe(false);
    expect(log).toHaveBeenCalled();
  });

  it("opens on an alignment and reads its chainage", () => {
    const host = document.createElement("div");
    const panel = new DrivePanel(host, fakeViewer(), { log: vi.fn() });
    panel.present([{
      expressID: 1,
      name: "A1",
      points: [
        { point: [0, 0, 0], station: 0, direction: 0 },
        { point: [100, 2, 0], station: 100, direction: 0 },
      ],
      length: 100,
      horizontalSegments: 1,
      verticalSegments: 1,
      approximated: [],
      hasVertical: true,
    }], "IFC4X3");
    expect(panel.isOpen()).toBe(true);
    expect(host.textContent).toContain("0+000.00");
    panel.hide();
    expect(panel.isOpen()).toBe(false);
  });

  it("puts metre/Y-up samples through the primary model placement and scene origin", () => {
    const host = document.createElement("div");
    const setCamera = vi.fn();
    const viewer = {
      ...fakeViewer(),
      setCamera,
      getModelOrigin: () => [5, 1, -2],
      getModels: () => [{
        index: 0,
        transform: {
          translation: [7, 11, 13],
          rotationZ: Math.PI / 2,
          scale: 2,
          source: "manual",
        },
      }],
    } as unknown as Viewer;
    const panel = new DrivePanel(host, viewer, { log: vi.fn() });
    panel.present([{
      expressID: 1,
      name: "Placed road",
      points: [
        { point: [10, 3, -20], station: 0, direction: 0 },
        { point: [20, 5, -20], station: 12, direction: 0 },
      ],
      length: 12,
      horizontalSegments: 1,
      verticalSegments: 1,
      approximated: [],
      hasVertical: true,
    }], "IFC4X3");

    const pose = setCamera.mock.lastCall?.[0];
    expect(pose?.position[0]).toBeCloseTo(-38, 9);
    expect(pose?.position[1]).toBeCloseTo(17.5, 9);
    expect(pose?.position[2]).toBeCloseTo(-5, 9);
    expect(pose?.target[0]).toBeCloseTo(-38, 9);
    expect(pose?.target[1]).toBeCloseTo(21.5, 9);
    expect(pose?.target[2]).toBeCloseTo(-25, 9);
    expect(host.textContent).toContain("3.00 m");
    expect(host.textContent).toContain("90.0°");
    expect(host.textContent).toContain("20.00%");
  });
});
