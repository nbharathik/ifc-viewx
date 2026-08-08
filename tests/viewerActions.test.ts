import { describe, expect, it } from "vitest";
import { runViewerAction } from "../src/llm/actions.js";
import { createViewerCapabilityRegistry } from "../src/capabilities/viewer.js";
import { VIEWER_POLICY } from "../src/capabilities/policy.js";
import type { SectionBox, SectionState, SpatialNode, Viewer } from "../src/viewer-core/viewer.js";

/**
 * The runner only ever touches a handful of viewer methods, so the stub
 * records calls rather than pretending to render. Every assertion below is
 * about what the assistant asked the viewer to do.
 */
interface Recorder {
  calls: string[];
  hidden: Map<number, boolean>;
  colors: { assignment: Map<number, number>; colors: Array<[number, number, number]> } | null;
  sections: SectionState[];
  box: SectionBox | null;
  selected: number[];
  categories: Record<string, boolean>;
  view: string | null;
}

const TREE: SpatialNode = {
  expressID: 1,
  type: "IfcProject",
  name: "Sample",
  children: [
    {
      expressID: 2,
      type: "IfcBuildingStorey",
      name: "Level 1",
      children: [
        { expressID: 10, type: "IfcWall", name: "Exterior Wall North", children: [] },
        { expressID: 11, type: "IfcDoor", name: "Fire Rated Door 60", children: [] },
      ],
    },
    {
      expressID: 3,
      type: "IfcBuildingStorey",
      name: "Level 2",
      children: [
        { expressID: 20, type: "IfcWindow", name: "Fixed Window", children: [] },
      ],
    },
  ],
} as SpatialNode;

let rec: Recorder;

function stub(): Viewer {
  rec = {
    calls: [],
    hidden: new Map(),
    colors: null,
    sections: [],
    box: null,
    selected: [11],
    categories: { IfcSpace: false, IfcOpeningElement: false },
    view: null,
  };
  const viewer = {
    getSpatialTree: () => TREE,
    getStats: () => ({ totalEntities: 30, triangleCount: 100 }),
    getElementTypes: () => new Map([[10, "IfcWall"], [11, "IfcDoor"], [20, "IfcWindow"]]),
    getSelectedIds: () => rec.selected,
    select: (id: number) => void rec.calls.push(`select:${id}`),
    selectMany: (ids: number[]) => {
      rec.selected = [...ids];
      rec.calls.push(`selectMany:${ids.join(",")}`);
    },
    fitToElement: (id: number) => void rec.calls.push(`fit:${id}`),
    fitToModel: () => void rec.calls.push("fitModel"),
    isolate: (ids: number[]) => void rec.calls.push(`isolate:${ids.join(",")}`),
    setHidden: (ids: number[], on: boolean) => {
      for (const id of ids) rec.hidden.set(id, on);
      rec.calls.push(`setHidden:${on}:${ids.join(",")}`);
    },
    showAll: () => void rec.calls.push("showAll"),
    getHiddenCount: () => [...rec.hidden.values()].filter(Boolean).length,
    getVisibilityCounts: () => ({ total: 3, visible: 3, hidden: 0 }),
    getRules: () => [{ id: "r1", label: "Doors", mode: "keep" as const, ids: [11] }],
    getSections: () => rec.sections,
    setSections: (states: SectionState[]) => {
      rec.sections = states;
      rec.box = null;
    },
    clearSection: () => {
      rec.sections = [];
      rec.box = null;
    },
    getSectionBox: () => rec.box,
    setSectionBox: (box: SectionBox | null) => {
      rec.box = box;
      if (box) rec.sections = [];
    },
    getModelBox: (): SectionBox => ({ min: [0, 0, 0], max: [10, 6, 8] }),
    boxAround: (ids: number[]): SectionBox | null =>
      ids.length ? { min: [1, 1, 1], max: [2, 2, 2] } : null,
    setColorOverride: (assignment: Map<number, number>, colors: Array<[number, number, number]>) => {
      rec.colors = { assignment, colors };
    },
    clearColorOverride: () => {
      rec.colors = null;
    },
    setCategoryVisible: async (category: string, on: boolean) => {
      rec.categories[category] = on;
    },
    isCategoryVisible: (category: string) => rec.categories[category] ?? false,
    getCamera: () => ({ position: [1.234567, 2, 3], target: [0, 0, 0] }),
    setCamera: (pose: unknown) => void rec.calls.push(`setCamera:${JSON.stringify(pose)}`),
    viewFrom: (view: string) => {
      rec.view = view;
    },
    getProperties: async () => null,
  };
  return viewer as unknown as Viewer;
}

/** A throwaway viewer per call, for the cases that only read one report. */
const run = (action: object): Promise<string> => runViewerAction(stub(), JSON.stringify(action));
/** Same viewer across two calls, for the cases that check accumulated state. */
const runOn = (viewer: Viewer, action: object): Promise<string> =>
  runViewerAction(viewer, JSON.stringify(action));

describe("search", () => {
  it("ranks a name match first", async () => {
    const report = JSON.parse(await run({ action: "search", query: "fire rated" }));
    expect(report.elements[0].id).toBe(11);
    expect(report.indexed).toBe(3);
  });

  it("finds by class word without the Ifc prefix", async () => {
    const report = JSON.parse(await run({ action: "search", query: "window" }));
    expect(report.elements[0].id).toBe(20);
  });

  it("refuses an empty query rather than returning the whole model", async () => {
    await expect(run({ action: "search", query: "  " })).rejects.toThrow(/needs a query/);
  });

  it("caps the limit so a report cannot swamp the context", async () => {
    const report = JSON.parse(await run({ action: "search", query: "wall door window", limit: 9999 }));
    expect(report.elements.length).toBeLessThanOrEqual(40);
  });
});

describe("select", () => {
  it("still takes a single id and frames it", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "select", id: 10 });
    expect(rec.calls).toContain("select:10");
    expect(rec.calls).toContain("fit:10");
  });

  it("takes a set of ids, which find already returns", async () => {
    const viewer = stub();
    const report = await runOn(viewer, { action: "select", ids: [10, 11, 20] });
    expect(rec.calls).toContain("selectMany:10,11,20");
    expect(report).toMatch(/3 element/);
  });

  it("refuses with neither", async () => {
    await expect(run({ action: "select" })).rejects.toThrow(/needs an id/);
  });
});

describe("selection and visibility reports", () => {
  it("reports what is selected with class and name", async () => {
    const report = JSON.parse(await run({ action: "selection" }));
    expect(report.count).toBe(1);
    expect(report.elements[0]).toMatchObject({ id: 11, type: "IfcDoor", name: "Fire Rated Door 60" });
  });

  it("reports rules, sections and the lazy categories", async () => {
    const report = JSON.parse(await run({ action: "visibility" }));
    expect(report.rules).toEqual([{ label: "Doors", mode: "keep", elements: 1 }]);
    expect(report.spacesLoaded).toBe(false);
    expect(report.sectionBox).toBeNull();
  });
});

describe("unhide", () => {
  it("unhides just those ids instead of showing everything", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "unhide", ids: [10, 11] });
    expect(rec.calls).toContain("setHidden:false:10,11");
    expect(rec.calls).not.toContain("showAll");
  });

  it("refuses without ids", async () => {
    await expect(run({ action: "unhide", ids: [] })).rejects.toThrow(/needs ids/);
  });
});

describe("categories", () => {
  it("switches spaces on, which they are not by default", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "categories", IfcSpace: true });
    expect(rec.categories.IfcSpace).toBe(true);
  });

  it("refuses when neither category is a boolean", async () => {
    await expect(run({ action: "categories", IfcSpace: "yes" })).rejects.toThrow(/booleans/);
  });
});

describe("color", () => {
  it("assigns one palette index per group, starting at 1", async () => {
    const viewer = stub();
    await runOn(viewer, {
      action: "color",
      groups: [
        { label: "a", ids: [10], color: "#ff0000" },
        { label: "b", ids: [11, 20] },
      ],
    });
    expect(rec.colors?.assignment.get(10)).toBe(1);
    expect(rec.colors?.assignment.get(11)).toBe(2);
    expect(rec.colors?.colors[0]).toEqual([255, 0, 0]);
  });

  it("makes up a colour when the model omits one", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "color", groups: [{ ids: [10] }] });
    expect(rec.colors?.colors[0].every((v) => v >= 0 && v <= 255)).toBe(true);
  });

  it("clears when no groups are given", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "color", groups: [{ ids: [10] }] });
    await runOn(viewer, { action: "color" });
    expect(rec.colors).toBeNull();
  });

  it("caps the number of groups", async () => {
    const viewer = stub();
    const groups = Array.from({ length: 30 }, (_, i) => ({ ids: [10 + i] }));
    await runOn(viewer, { action: "color", groups });
    expect(rec.colors!.colors.length).toBeLessThanOrEqual(12);
  });

  it("refuses groups that carry no ids", async () => {
    await expect(run({ action: "color", groups: [{ ids: [] }] })).rejects.toThrow(/at least one group/);
  });
});

describe("section", () => {
  it("cuts on an axis at the given offset", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "section", axis: "y", offset: 3.5 });
    expect(rec.sections).toEqual([{ axis: "y", offset: 3.5, flip: false }]);
  });

  it("defaults to the middle of the model on that axis", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "section", axis: "z" });
    expect(rec.sections[0].offset).toBe(4); // model box z spans 0..8
  });

  it("replaces the plane on the same axis rather than stacking", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "section", axis: "y", offset: 1 });
    await runOn(viewer, { action: "section", axis: "y", offset: 2 });
    expect(rec.sections).toHaveLength(1);
    expect(rec.sections[0].offset).toBe(2);
  });

  it("rejects a bad axis", async () => {
    await expect(run({ action: "section", axis: "w" })).rejects.toThrow(/axis/);
  });

  it("clears every plane", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "section", axis: "y", offset: 1 });
    await runOn(viewer, { action: "section", clear: true });
    expect(rec.sections).toEqual([]);
  });
});

describe("sectionBox", () => {
  it("boxes the given ids", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "sectionBox", ids: [10, 11] });
    expect(rec.box).toEqual({ min: [1, 1, 1], max: [2, 2, 2] });
  });

  it("falls back to the selection when no ids are given", async () => {
    const viewer = stub();
    const report = await runOn(viewer, { action: "sectionBox" });
    expect(rec.box).not.toBeNull();
    expect(report).toMatch(/1 element/);
  });

  it("drops any per-axis section, because the two cannot both be on", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "section", axis: "y", offset: 1 });
    await runOn(viewer, { action: "sectionBox", ids: [10] });
    expect(rec.sections).toEqual([]);
    expect(rec.box).not.toBeNull();
  });

  it("clears the box", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "sectionBox", ids: [10] });
    await runOn(viewer, { action: "sectionBox", clear: true });
    expect(rec.box).toBeNull();
  });
});

describe("camera", () => {
  it("moves to a preset", async () => {
    const viewer = stub();
    await runOn(viewer, { action: "camera", view: "top" });
    expect(rec.view).toBe("top");
  });

  it("reads the pose when no view is given, rounded", async () => {
    const report = JSON.parse(await run({ action: "camera" }));
    expect(report.position[0]).toBe(1.235);
  });

  it("rejects a view it does not have", async () => {
    await expect(run({ action: "camera", view: "northeast" })).rejects.toThrow(/must be one of/);
  });
});

describe("unknown actions", () => {
  it("still names the action it could not run", async () => {
    await expect(run({ action: "teleport" })).rejects.toThrow(/teleport/);
  });
});

describe("capability adapter", () => {
  it("runs the same viewer action through the shared registry", async () => {
    const viewer = stub();
    const registry = createViewerCapabilityRegistry();
    const report = await registry.execute<string>("select", { ids: [10, 11] }, { viewer }, {
      policy: VIEWER_POLICY,
    });
    expect(report).toBe("selected 2 element(s)");
    expect(rec.calls).toContain("selectMany:10,11");
    expect(registry.get("select")?.exposure).toMatchObject({ assistant: true, sdk: true });
  });
});
