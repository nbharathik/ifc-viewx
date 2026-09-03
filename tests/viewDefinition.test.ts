import { describe, expect, it, vi } from "vitest";

import {
  applySavedView,
  applyView,
  captureView,
  describeSelector,
  isPortable,
  matchText,
  MAX_SELECTOR_STRING_LENGTH,
  MAX_VIEW_FILE_BYTES,
  MAX_VIEW_FILE_VIEWS,
  needsIndex,
  normalizeSelector,
  normalizeView,
  parseViewFile,
  resolveSelector,
  serializeViews,
  ViewStore,
  type Selector,
  type ViewDefinition,
} from "../src/views/definition.js";
import type { ElementRow } from "../src/sdk/data.js";
import type { SpatialNode, Viewer, VisibilityRule } from "../src/viewer-core/viewer.js";

const node = (expressID: number, type: string, name: string | null, children: SpatialNode[] = []): SpatialNode =>
  ({ expressID, type, name, children });

/** Two storeys, two classes, so class, storey and name rules all have work. */
const tree = (): SpatialNode =>
  node(1, "IfcProject", "P", [
    node(2, "IfcBuildingStorey", "Level 1", [
      node(10, "IfcWall", "Core wall"),
      node(11, "IfcWall", "Party wall"),
      node(12, "IfcDoor", "FD30 door"),
    ]),
    node(3, "IfcBuildingStorey", "Level 2", [node(20, "IfcWall", "Core wall"), node(21, "IfcSlab", "Deck")]),
  ]);

const TYPES = new Map<number, string>([
  [10, "IfcWall"],
  [11, "IfcWall"],
  [12, "IfcDoor"],
  [20, "IfcWall"],
  [21, "IfcSlab"],
]);

interface FakeState {
  rules: VisibilityRule[];
  hidden: number[];
  xray: number[];
  sections: unknown[];
  camera: { position: [number, number, number]; target: [number, number, number] } | null;
  box: unknown;
  ghostHidden: boolean;
  offsets: unknown[];
  annotations: unknown[];
  measurements: unknown[];
  projection: string;
  categories: { spaces: boolean; openings: boolean };
  shown: number;
}

function fakeViewer(state: FakeState): Viewer {
  return {
    getSpatialTree: () => tree(),
    getElementTypes: () => TYPES,
    getModels: () => [{ index: 0, name: "arch.ifc" }],
    getRules: () => state.rules.map((rule) => ({ ...rule })),
    addRule: (rule: Omit<VisibilityRule, "id">) => {
      const added = { ...rule, id: `v${state.rules.length + 1}`, ids: [...rule.ids] };
      state.rules.push(added);
      return added;
    },
    showAll: () => {
      state.rules = [];
      state.hidden = [];
      state.shown++;
    },
    setHidden: (ids: number[], hidden: boolean) => {
      if (hidden) state.hidden = [...ids];
    },
    getHiddenIds: () => state.hidden,
    setXray: (ids: Iterable<number>) => (state.xray = [...ids]),
    clearXray: () => (state.xray = []),
    isElementXray: (id: number) => state.xray.includes(id),
    clearElementOffsets: () => (state.offsets = []),
    setElementOffsetEntries: (entries: unknown[]) => (state.offsets = entries),
    getElementOffsets: () => [],
    hasElementOffsets: () => false,
    setGhostHidden: (on: boolean) => (state.ghostHidden = on),
    isGhostHidden: () => state.ghostHidden,
    setSections: (states: unknown[]) => (state.sections = states),
    getSections: () => state.sections,
    setSectionBox: (value: unknown) => (state.box = value),
    getSectionBox: () => state.box,
    setAnnotationStates: (states: unknown[]) => (state.annotations = states),
    getAnnotationStates: () => state.annotations,
    setMeasurementStates: (states: unknown[]) => (state.measurements = states),
    getMeasurementStates: () => state.measurements,
    setProjection: (projection: string) => (state.projection = projection),
    getProjection: () => state.projection,
    setCamera: (pose: FakeState["camera"]) => (state.camera = pose),
    getCamera: () => ({ position: [1, 2, 3], target: [0, 0, 0] }),
    isCategoryVisible: (category: string) => category === "IfcSpace" ? state.categories.spaces : state.categories.openings,
    setCategoryVisible: async (category: string, visible: boolean) => {
      if (category === "IfcSpace") state.categories.spaces = visible;
      else state.categories.openings = visible;
    },
  } as unknown as Viewer;
}

const emptyState = (): FakeState => ({
  rules: [],
  hidden: [],
  xray: [],
  sections: [],
  camera: null,
  box: null,
  ghostHidden: false,
  offsets: [],
  annotations: [],
  measurements: [],
  projection: "perspective",
  categories: { spaces: false, openings: false },
  shown: 0,
});

const row = (id: number, props: Record<string, unknown>, attrs: Record<string, unknown> = {}): ElementRow =>
  ({ id, type: TYPES.get(id) ?? "IfcWall", name: "", storey: "", globalId: "", attrs, props }) as ElementRow;

describe("selector resolution", () => {
  const context = () => ({ viewer: fakeViewer(emptyState()), rows: [] as ElementRow[] });

  it("selects by class, with or without the Ifc prefix", () => {
    expect(resolveSelector({ kind: "class", values: ["IfcWall"] }, context()).sort()).toEqual([10, 11, 20]);
    expect(resolveSelector({ kind: "class", values: ["Wall"] }, context()).sort()).toEqual([10, 11, 20]);
  });

  it("selects every element under a named storey", () => {
    expect(resolveSelector({ kind: "storey", values: ["Level 2"] }, context()).sort()).toEqual([20, 21]);
  });

  it("selects by name, case insensitively", () => {
    expect(resolveSelector({ kind: "name", op: "contains", value: "core" }, context()).sort()).toEqual([10, 20]);
  });

  it("reads properties out of any set when the set is blank", () => {
    const rows = [row(10, { "Pset_WallCommon.FireRating": "FD30" }), row(11, { "Other.FireRating": "FD60" })];
    const found = resolveSelector(
      { kind: "property", set: "", name: "FireRating", op: "is", value: "FD30" },
      { viewer: fakeViewer(emptyState()), rows },
    );
    expect(found).toEqual([10]);
  });

  it("finds elements missing a property, which is not the same as a bare presence test", () => {
    const rows = [row(10, { "Pset_WallCommon.FireRating": "FD30" }), row(11, {})];
    const missing = resolveSelector(
      { kind: "property", set: "", name: "FireRating", op: "missing", value: "" },
      { viewer: fakeViewer(emptyState()), rows },
    );
    expect(missing).toEqual([11]);
  });

  it("combines selectors with any, every and not", () => {
    const both: Selector = {
      kind: "every",
      of: [{ kind: "class", values: ["IfcWall"] }, { kind: "storey", values: ["Level 1"] }],
    };
    expect(resolveSelector(both, context()).sort()).toEqual([10, 11]);
    const either: Selector = {
      kind: "any",
      of: [{ kind: "class", values: ["IfcDoor"] }, { kind: "class", values: ["IfcSlab"] }],
    };
    expect(resolveSelector(either, context()).sort()).toEqual([12, 21]);
    expect(resolveSelector({ kind: "not", of: { kind: "class", values: ["IfcWall"] } }, context()).sort()).toEqual([12, 21]);
  });

  it("drops ids that are not in this model", () => {
    expect(resolveSelector({ kind: "ids", ids: [10, 999] }, context())).toEqual([10]);
  });
});

describe("text matching", () => {
  it("treats an empty value as absent for exists and missing", () => {
    expect(matchText(["", ""], "exists", "")).toBe(false);
    expect(matchText(["", ""], "missing", "")).toBe(true);
    expect(matchText(["FD30"], "exists", "")).toBe(true);
  });

  it("negates only the hit, so 'is not' also matches elements with no value", () => {
    expect(matchText([], "not", "FD30")).toBe(true);
    expect(matchText(["FD30"], "not", "FD30")).toBe(false);
  });
});

describe("capture and apply", () => {
  it("stores the rule query rather than the ids it happened to match", () => {
    const state = emptyState();
    const viewer = fakeViewer(state);
    viewer.addRule({ label: "Walls", mode: "keep", ids: [10, 11, 20], selector: { kind: "class", values: ["IfcWall"] } });
    const view = captureView(viewer, { kind: "class" }, { name: "Walls only" });
    expect(view.filters).toHaveLength(1);
    expect(view.filters[0].selector).toEqual({ kind: "class", values: ["IfcWall"] });
    expect(isPortable(view)).toBe(true);
  });

  it("keeps a hand-made selection as ids and reports it as not portable", () => {
    const state = emptyState();
    const viewer = fakeViewer(state);
    viewer.addRule({ label: "Picked", mode: "keep", ids: [10, 12] });
    const view = captureView(viewer, null, { name: "Picked" });
    expect(view.filters[0].selector).toEqual({ kind: "ids", ids: [10, 12] });
    expect(isPortable(view)).toBe(false);
  });

  it("re-resolves rules against the model it is applied to", () => {
    const view = captureView(fakeViewer(emptyState()), null, { name: "Doors" });
    view.filters = [{ label: "Doors", mode: "keep", selector: { kind: "class", values: ["IfcDoor"] } }];
    const state = emptyState();
    const viewer = fakeViewer(state);
    const report = applyView(view, { viewer, rows: [] });
    expect(report.empty).toEqual([]);
    expect(state.rules).toHaveLength(1);
    expect(state.rules[0].ids).toEqual([12]);
    expect(state.camera).toEqual({ position: [1, 2, 3], target: [0, 0, 0] });
  });

  it("names the rules that matched nothing instead of applying an empty keep", () => {
    const view = captureView(fakeViewer(emptyState()), null, { name: "Nothing" });
    view.filters = [{ label: "Ducts", mode: "keep", selector: { kind: "class", values: ["IfcDuctSegment"] } }];
    const state = emptyState();
    const report = applyView(view, { viewer: fakeViewer(state), rows: [] });
    expect(report.empty).toEqual(["Ducts"]);
    expect(state.rules).toHaveLength(0);
  });

  it("builds property rows before applying and preserves the union of keep filters", async () => {
    const view = captureView(fakeViewer(emptyState()), null, { name: "Fire doors and walls" });
    view.filters = [
      {
        label: "FD30 walls",
        mode: "keep",
        selector: { kind: "property", set: "Pset_WallCommon", name: "FireRating", op: "is", value: "FD30" },
      },
      { label: "Doors", mode: "keep", selector: { kind: "class", values: ["IfcDoor"] } },
    ];
    const rows = [row(10, { "Pset_WallCommon.FireRating": "FD30" })];
    let ready = false;
    const build = vi.fn(async () => {
      ready = true;
      return rows;
    });
    const state = emptyState();

    await applySavedView(view, {
      viewer: fakeViewer(state),
      index: { ready: () => ready, all: () => ready ? rows : [], build },
      setColorRule: vi.fn(),
    });

    expect(build).toHaveBeenCalledOnce();
    expect(state.rules.map((rule) => [rule.label, rule.ids])).toEqual([
      ["FD30 walls", [10]],
      ["Doors", [12]],
    ]);
  });

  it("applies the complete saved-view state through the shared path", async () => {
    const view = captureView(fakeViewer(emptyState()), { kind: "class" }, { name: "Complete" });
    view.hidden = { kind: "ids", ids: [11] };
    view.xray = { kind: "ids", ids: [12] };
    view.ghostHidden = true;
    view.sections = [{ axis: "x", offset: 2, flip: false }];
    view.box = { min: [0, 0, 0], max: [5, 5, 5] };
    view.offsets = [[10, [1, 2, 3]]];
    view.annotations = [{ text: "Check", at: [1, 1, 1], elementId: 10 }];
    view.measurements = [{ a: [0, 0, 0], b: [1, 0, 0], ends: ["surface", "surface"] }];
    view.projection = "orthographic";
    view.categories = { spaces: true, openings: true };
    const state = emptyState();
    const setColorRule = vi.fn(async () => undefined);

    await applySavedView(view, {
      viewer: fakeViewer(state),
      index: { ready: () => true, all: () => [], build: vi.fn() },
      setColorRule,
    });

    expect(state.hidden).toEqual([11]);
    expect(state.xray).toEqual([12]);
    expect(state.ghostHidden).toBe(true);
    expect(state.sections).toEqual(view.sections);
    expect(state.box).toEqual(view.box);
    expect(state.offsets).toEqual(view.offsets);
    expect(state.annotations).toEqual(view.annotations);
    expect(state.measurements).toEqual(view.measurements);
    expect(state.projection).toBe("orthographic");
    expect(state.categories).toEqual({ spaces: true, openings: true });
    expect(setColorRule).toHaveBeenCalledWith({ kind: "class" });
  });
});

describe("serialization", () => {
  const sample = (): ViewDefinition => {
    const view = captureView(fakeViewer(emptyState()), { kind: "storey" }, { name: "Level 2 review", folder: "QA" });
    view.filters = [{ label: "Level 2", mode: "keep", selector: { kind: "storey", values: ["Level 2"] } }];
    return view;
  };

  it("round-trips through the file format", () => {
    const parsed = parseViewFile(serializeViews([sample()]));
    expect(parsed).toHaveLength(1);
    expect(parsed[0].name).toBe("Level 2 review");
    expect(parsed[0].filters[0].selector).toEqual({ kind: "storey", values: ["Level 2"] });
    expect(parsed[0].color).toEqual({ kind: "storey" });
  });

  it("accepts a bare array and fills in what an older file did not carry", () => {
    const parsed = parseViewFile(JSON.stringify([{ name: "Old", filters: [] }]));
    expect(parsed[0].folder).toBe("");
    expect(parsed[0].categories).toEqual({ spaces: false, openings: false });
    expect(parsed[0].id).toBeTruthy();
  });

  it("rejects anything without a name rather than storing a blank card", () => {
    expect(normalizeView({ filters: [] })).toBeNull();
    expect(parseViewFile(JSON.stringify({ views: [{}, { name: "Keep" }] }))).toHaveLength(1);
  });

  it("drops malformed recursive selectors instead of crashing when they are applied", () => {
    const [view] = parseViewFile(JSON.stringify({
      format: "ifcviewx.views",
      version: 1,
      views: [{
        name: "Untrusted",
        filters: [
          { label: "broken", mode: "keep", selector: { kind: "any" } },
          { label: "valid", mode: "hide", selector: { kind: "class", values: ["IfcDoor"] } },
        ],
        xray: { kind: "not" },
      }],
    }));
    expect(view.filters.map((filter) => filter.label)).toEqual(["valid"]);
    expect(view.xray).toBeNull();
    expect(() => applyView(view, { viewer: fakeViewer(emptyState()), rows: [] })).not.toThrow();
  });

  it("bounds every retained selector string", () => {
    const oversized = "x".repeat(MAX_SELECTOR_STRING_LENGTH + 1);
    expect(normalizeSelector({ kind: "class", values: [oversized] })).toBeNull();
    expect(normalizeSelector({ kind: "name", op: "contains", value: oversized })).toBeNull();
    expect(normalizeSelector({ kind: "property", set: oversized, name: "Name", op: "is", value: "x" })).toBeNull();
    expect(normalizeSelector({ kind: "property", set: "Pset", name: oversized, op: "is", value: "x" })).toBeNull();
    expect(normalizeSelector({ kind: "property", set: "Pset", name: "Name", op: "is", value: oversized })).toBeNull();
  });

  it("rejects a file format or version this build does not understand", () => {
    expect(parseViewFile(JSON.stringify({ format: "other", version: 1, views: [{ name: "x" }] }))).toEqual([]);
    expect(parseViewFile(JSON.stringify({ format: "ifcviewx.views", version: 99, views: [{ name: "x" }] }))).toEqual([]);
  });

  it("drops remote thumbnail URLs from imported views", () => {
    const [view] = parseViewFile(JSON.stringify([{ name: "Tracked", thumbnail: "https://tracker.invalid/pixel" }]));
    expect(view.thumbnail).toBe("");
  });

  it.each([
    ["colour", { color: { kind: "property", key: "" } }],
    ["camera", { camera: { position: [Number.NaN, 0, 0], target: [0, 0, 0] } }],
    ["degenerate camera", { camera: { position: [1, 1, 1], target: [1, 1, 1] } }],
    ["section box", { box: { min: [5, 0, 0], max: [1, 1, 1] } }],
    ["axis section", { sections: [{ axis: "x", offset: Number.POSITIVE_INFINITY, flip: false }] }],
    ["plane section", { sections: [{ id: "p", name: "P", normal: [0, 0, 0], offset: 1, flip: false }] }],
    ["offset", { offsets: [[10, [0, Number.NaN, 0]]] }],
    ["annotation", { annotations: [{ text: "Unsafe", at: [0, Number.NaN, 0] }] }],
    ["measurement", { measurements: [{ kind: "distance", a: [0, 0, 0], b: [1, 0, 0], ends: ["bogus", "surface"] }] }],
    ["timestamp", { updatedAt: "not-a-date" }],
    ["categories", { categories: { spaces: "yes", openings: false } }],
    ["oversized text", { description: "x".repeat(10_001) }],
    ["too many sections", { sections: Array.from({ length: 9 }, () => ({ axis: "x", offset: 1, flip: false })) }],
  ])("rejects malformed %s state before it can reach Viewer", (_name, payload) => {
    expect(normalizeView({ name: "Untrusted", filters: [], ...payload })).toBeNull();
  });

  it("normalizes safe timestamps and caps the number of imported views", () => {
    const views = Array.from({ length: MAX_VIEW_FILE_VIEWS + 20 }, (_, index) => ({
      name: `View ${index}`,
      updatedAt: "2026-01-01T01:00:00+01:00",
    }));
    const parsed = parseViewFile(JSON.stringify(views));
    expect(parsed).toHaveLength(MAX_VIEW_FILE_VIEWS);
    expect(parsed[0].updatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("bounds file input and validates definitions before serialization", () => {
    expect(() => parseViewFile(" ".repeat(MAX_VIEW_FILE_BYTES + 1))).toThrow(/may not exceed 8 MB/);
    expect(() => serializeViews(Array(MAX_VIEW_FILE_VIEWS + 1).fill(sample()))).toThrow(/at most 512 views/);

    const invalid = sample();
    invalid.camera = { position: [Number.NaN, 0, 0], target: [0, 0, 0] };
    expect(() => serializeViews([invalid])).toThrow(/definition is invalid/);

    const sanitizable = sample();
    sanitizable.thumbnail = "https://tracker.invalid/pixel";
    expect(parseViewFile(serializeViews([sanitizable]))[0].thumbnail).toBe("");
  });
});

describe("the store", () => {
  const memory = (): Storage => {
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

  it("replaces a view saved under the same name and folder", () => {
    const storage = memory();
    const store = new ViewStore(storage);
    const first = captureView(fakeViewer(emptyState()), null, { name: "QA", folder: "Weekly" });
    store.save(first);
    const second = captureView(fakeViewer(emptyState()), null, { name: "QA", folder: "Weekly" });
    store.save(second);
    expect(store.list()).toHaveLength(1);
    // The original id survives, so a link to the view keeps working.
    expect(store.list()[0].id).toBe(first.id);
  });

  it("survives a reload through storage", () => {
    const storage = memory();
    const store = new ViewStore(storage);
    store.save(captureView(fakeViewer(emptyState()), null, { name: "Kept" }));
    expect(new ViewStore(storage).list().map((view) => view.name)).toEqual(["Kept"]);
  });

  it("shares the default library for this session without persisting it", () => {
    localStorage.setItem("ifcviewx.views.v1", "legacy data");
    const store = new ViewStore();
    store.clear();
    expect(store.save(captureView(fakeViewer(emptyState()), null, { name: "Current model" }))).toBe(true);

    expect(new ViewStore().list().map((view) => view.name)).toEqual(["Current model"]);
    expect(localStorage.getItem("ifcviewx.views.v1")).toBeNull();
    store.clear();
  });

  it("groups by folder and reports them sorted", () => {
    const store = new ViewStore(memory());
    store.save(captureView(fakeViewer(emptyState()), null, { name: "A", folder: "Zeta" }));
    store.save(captureView(fakeViewer(emptyState()), null, { name: "B", folder: "Alpha" }));
    expect(store.folders()).toEqual(["Alpha", "Zeta"]);
  });

  it("reports that a save did not persist when storage is unavailable", () => {
    const store = new ViewStore(null);
    expect(store.save(captureView(fakeViewer(emptyState()), null, { name: "Ephemeral" }))).toBe(false);
  });
});

describe("descriptions", () => {
  it("says what a selector picks in one line", () => {
    expect(describeSelector({ kind: "class", values: ["IfcWall", "IfcDoor"] })).toBe("Wall, Door");
    expect(describeSelector({ kind: "property", set: "Pset_WallCommon", name: "FireRating", op: "missing", value: "" }))
      .toBe("Pset_WallCommon.FireRating is missing");
    expect(describeSelector({ kind: "not", of: { kind: "all" } })).toBe("not Everything");
  });

  it("knows which selectors need the property index built first", () => {
    expect(needsIndex({ kind: "class", values: ["IfcWall"] })).toBe(false);
    expect(needsIndex({ kind: "any", of: [{ kind: "all" }, { kind: "property", set: "", name: "X", op: "exists", value: "" }] })).toBe(true);
  });
});
