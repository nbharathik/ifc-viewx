import { beforeEach, describe, expect, it } from "vitest";
import { readViewpoints, saveViewpoint, viewpointKey } from "../src/ui/dock.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

describe("saved viewpoints", () => {
  beforeEach(() => localStorage.clear());

  it("stores persistent measurement witness geometry with the camera and cuts", () => {
    const measurements = [{
      a: [1, 2, 3] as [number, number, number],
      b: [4, 2, 3] as [number, number, number],
      ends: ["surface", "surface"] as const,
    }];
    const viewer = {
      getStats: () => ({ totalEntities: 20, triangleCount: 50 }),
      getCamera: () => ({ position: [8, 8, 8], target: [1, 2, 3] }),
      getSection: () => null,
      getSections: () => [{ axis: "y", offset: 2, flip: false }],
      getSectionBox: () => null,
      getMeasurementStates: () => measurements,
      getElementOffsets: () => [[42, [0, 3, 0]]],
      getAnnotationStates: () => [],
    } as unknown as Viewer;

    expect(saveViewpoint(viewer, "Laser check")).toBe("Laser check");
    const key = viewpointKey(viewer)!;
    expect(readViewpoints(key)[0]).toMatchObject({
      name: "Laser check",
      measurements,
    });
  });
});
