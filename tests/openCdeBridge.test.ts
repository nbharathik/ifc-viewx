import { describe, expect, it } from "vitest";
import {
  fromBcfTopic,
  fromBcfViewpoint,
  pendingCount,
  toBcfTopic,
  toBcfViewpoint,
  type ReviewTopic,
} from "../src/opencde/bridge.js";

const topic = (): ReviewTopic => ({
  guid: "topic-1",
  title: "Pipe clashes with wall",
  description: "Move the pipe 100 mm",
  status: "In progress",
  priority: "Urgent",
  author: "coordinator@example.com",
  date: "2026-08-11T12:00:00Z",
  comments: [],
  snapshot: "data:image/jpeg;base64,YWJj",
  viewpoint: {
    camera: { position: [4, 5, 6], target: [1, 2, 3] },
    sections: [],
    sectionBox: { min: [0, 1, 2], max: [3, 4, 5] },
    selections: [{ id: 12, guid: "ifc-guid" }],
    hidden: [21],
  },
});

describe("OpenCDE BCF bridge", () => {
  it("round trips camera, components, clipping box and snapshot", () => {
    const remote = toBcfViewpoint(topic());
    expect(remote).toMatchObject({
      snapshot: { snapshot_type: "jpg", snapshot_data: "YWJj" },
      components: {
        selection: [{ ifc_guid: "ifc-guid", authoring_tool_id: "12" }],
        visibility: { exceptions: [{ authoring_tool_id: "21" }] },
      },
    });
    expect(remote?.clipping_planes).toHaveLength(6);
    expect(fromBcfViewpoint(remote)).toMatchObject({
      sectionBox: { min: [0, 1, 2], max: [3, 4, 5] },
      selections: [{ id: 12, guid: "ifc-guid" }],
      hidden: [21],
    });
  });

  it("round trips an arbitrary section plane without dropping it", () => {
    const local = topic();
    const n: [number, number, number] = [Math.SQRT1_2, 0, Math.SQRT1_2];
    local.viewpoint = {
      camera: { position: [4, 5, 6], target: [1, 2, 3] },
      sections: [{ id: "plane-1", name: "Tilted", normal: n, offset: 2, flip: false }],
      sectionBox: null,
      selections: [],
      hidden: [],
    };
    const remote = toBcfViewpoint(local);
    expect(remote?.clipping_planes).toHaveLength(1);
    const back = fromBcfViewpoint(remote);
    const section = back?.sections[0];
    expect(section).toBeDefined();
    expect(section?.axis).toBeUndefined();
    const plane = section as { normal: [number, number, number]; offset: number; flip: boolean };
    for (let i = 0; i < 3; i++) expect(plane.normal[i]).toBeCloseTo(n[i], 3);
    expect(plane.offset).toBeCloseTo(2, 3);
    expect(plane.flip).toBe(false);
  });

  it("keeps an axis plane as an axis entry through the round trip", () => {
    const local = topic();
    local.viewpoint = {
      camera: { position: [4, 5, 6], target: [1, 2, 3] },
      sections: [{ axis: "y", offset: 3.5, flip: true }],
      sectionBox: null,
      selections: [],
      hidden: [],
    };
    const back = fromBcfViewpoint(toBcfViewpoint(local));
    expect(back?.sections[0]).toMatchObject({ axis: "y", offset: 3.5, flip: true });
  });

  it("rejects malformed remote cameras without poisoning viewer state", () => {
    const nonFinite = toBcfViewpoint(topic())!;
    nonFinite.perspective_camera!.camera_view_point.x = Number.POSITIVE_INFINITY;
    expect(fromBcfViewpoint(nonFinite)).toBeNull();

    const zeroDirection = toBcfViewpoint(topic())!;
    zeroDirection.perspective_camera!.camera_direction = { x: 0, y: 0, z: 0 };
    expect(fromBcfViewpoint(zeroDirection)).toBeNull();
  });

  it("normalizes local values to choices advertised by the project", () => {
    const local = topic();
    const write = toBcfTopic(local, {
      topic_type: ["Coordination"],
      topic_status: ["Open", "Closed"],
      priority: ["Normal", "High"],
    });
    expect(write).toMatchObject({ topic_type: "Coordination", topic_status: "Open", priority: "Normal" });
  });

  it("preserves cached viewpoints while refreshing server topic fields", () => {
    const cached = topic();
    const refreshed = fromBcfTopic({
      topic: { guid: "topic-1", title: "Updated title", topic_status: "Closed" },
      comments: [],
      serverUrl: "https://cde.test",
      projectId: "p1",
      cached,
    });
    expect(refreshed.title).toBe("Updated title");
    expect(refreshed.viewpoint).toEqual(cached.viewpoint);
    expect(refreshed.remote).toMatchObject({ state: "synced", projectId: "p1" });
  });

  it("counts queued topic and comment operations for the active project", () => {
    const local = topic();
    local.remote = {
      serverUrl: "https://cde.test",
      projectId: "p1",
      state: "pending-update",
      pendingComments: ["c1", "c2"],
    };
    expect(pendingCount([local], "https://cde.test", "p1")).toBe(3);
    expect(pendingCount([local], "https://cde.test", "another")).toBe(0);
  });
});
