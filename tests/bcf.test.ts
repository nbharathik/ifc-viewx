import { describe, expect, it, vi } from "vitest";
import { BcfPanel } from "../src/ui/bcf.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

describe("BCF capture", () => {
  it("keeps multiple selected components, their GlobalIds and a section box", async () => {
    const viewer = {
      onModelLoaded: vi.fn(),
      getStats: () => ({ totalEntities: 20, triangleCount: 40 }),
      getVisibilityCounts: () => ({ hidden: 0 }),
      getElementTypes: () => new Map([[11, "IfcWall"], [22, "IfcPipeSegment"]]),
      isElementVisible: () => true,
      getCamera: () => ({ position: [4, 5, 6], target: [1, 2, 3] }),
      getSections: () => [],
      getSectionBox: () => ({ min: [0, 1, 2], max: [3, 4, 5] }),
      getSelectedIds: () => [11, 22],
      getProperties: async (id: number) => ({
        expressID: id,
        type: id === 11 ? "IfcWall" : "IfcPipeSegment",
        attributes: [{ name: "GlobalId", value: id === 11 ? "wall-guid" : "pipe-guid" }],
        propertySets: [],
      }),
      captureImage: async () => null,
    } as unknown as Viewer;
    const panel = new BcfPanel(document.createElement("div"), {
      viewer,
      modelName: () => "coordination.ifc",
      log: vi.fn(),
    });

    const id = panel.capture("Wall and pipe", "64 mm penetration", {
      elementIds: [11, 22],
      priority: "Critical",
    });
    await vi.waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]") as Array<{
        viewpoint?: { selections?: Array<{ guid: string | null }> };
      }>;
      expect(saved[0]?.viewpoint?.selections?.[1]?.guid).toBe("pipe-guid");
    });
    const topics = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]") as Array<Record<string, unknown>>;
    expect(id).toBeTruthy();
    expect(topics[0]).toMatchObject({ title: "Wall and pipe", priority: "Critical" });
    expect(topics[0].viewpoint).toMatchObject({
      sectionBox: { min: [0, 1, 2], max: [3, 4, 5] },
      selections: [{ id: 11, guid: "wall-guid" }, { id: 22, guid: "pipe-guid" }],
    });
  });
});
