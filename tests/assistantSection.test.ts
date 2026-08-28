import { describe, expect, it, vi } from "vitest";

const sectionContours = vi.hoisted(() => vi.fn(async () => ({
  axis: "y" as const,
  offset: 3.2,
  polylines: [
    { elementId: 10, elementType: "IfcWall", closed: true, points: [[0, 0], [1, 0]], length: 4 },
    { elementId: 11, elementType: "IfcDoor", closed: false, points: [[1, 0], [2, 0]], length: 0.9 },
  ],
  bounds: { min: [0, 0], max: [2, 1] },
  segmentCount: 9,
  closedCount: 1,
  openCount: 1,
  testedElements: 3,
  missing: 0,
  truncated: false,
  elapsedMs: 2,
  fidelity: "mesh" as const,
  engine: "browser-section" as const,
  geometryRevision: 4,
})));

vi.mock("../src/geometry/section.js", () => ({ extractSectionContours: sectionContours }));

import { AssistantCapabilityAdapter } from "../src/assistant/capabilityAdapter.js";
import { createViewerCapabilityRegistry } from "../src/capabilities/viewer.js";
import { runViewerAction } from "../src/llm/actions.js";
import type { SectionState, SpatialNode, Viewer } from "../src/viewer-core/viewer.js";

const tree: SpatialNode = {
  expressID: 1,
  type: "IfcProject",
  name: "Sample",
  children: [{
    expressID: 2,
    type: "IfcBuildingStorey",
    name: "Level 1",
    children: [
      { expressID: 10, type: "IfcWall", name: "North wall", children: [] },
      { expressID: 11, type: "IfcDoor", name: "Lobby door", children: [] },
    ],
  }],
} as SpatialNode;

function viewerStub(): { viewer: Viewer; sections: () => SectionState[] } {
  let state: SectionState[] = [];
  const viewer = {
    getSpatialTree: () => tree,
    getSections: () => state,
    setSections: (sections: SectionState[]) => { state = sections; },
    getModelBox: () => ({ min: [0, 0, 0], max: [10, 6, 8] }),
  } as unknown as Viewer;
  return { viewer, sections: () => state };
}

describe("assistant section analysis", () => {
  it("synchronizes the cut and returns compact element-owned rows", async () => {
    const state = viewerStub();
    const report = JSON.parse(await runViewerAction(
      state.viewer,
      JSON.stringify({ action: "sectionContours", axis: "y", offset: 3.2, maxSegments: 25_000 }),
    ));

    expect(state.sections()).toEqual([{ axis: "y", offset: 3.2, flip: false }]);
    expect(sectionContours).toHaveBeenCalledWith(state.viewer, "y", 3.2, expect.objectContaining({ maxSegments: 25_000 }));
    expect(report).toMatchObject({ pathCount: 2, intersectedElements: 2, fidelity: "mesh" });
    expect(report.rows).toEqual([
      expect.objectContaining({ id: 10, name: "North wall", closed: 1, open: 0, lengthM: 4 }),
      expect.objectContaining({ id: 11, name: "Lobby door", closed: 0, open: 1, lengthM: 0.9 }),
    ]);
    expect(JSON.stringify(report)).not.toContain("points");
  });

  it("creates paged results and linked evidence for the assistant", async () => {
    const state = viewerStub();
    const adapter = new AssistantCapabilityAdapter(
      createViewerCapabilityRegistry(),
      { viewer: state.viewer },
      undefined,
      () => true,
    );
    adapter.tools("query");
    const execution = await adapter.execute(
      "sectionContours",
      { axis: "y", offset: 3.2 },
      "query",
      new AbortController().signal,
    );

    expect(execution.result).toMatchObject({ capabilityId: "sectionContours", count: 2 });
    expect(execution.evidence.map((entry) => entry.label)).toEqual([
      "Section North wall #10",
      "Section Lobby door #11",
    ]);
    expect(execution.evidence[0].resultId).toBe(execution.result?.id);
  });
});
