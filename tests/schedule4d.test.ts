import { describe, expect, it } from "vitest";
import {
  addLink,
  buildScheduleTasks,
  emptyWorkspace,
  matchFilter,
  parseScheduleCsv,
  scheduleRange,
  snapshotAt,
} from "../src/plugins/schedule-4d/schedule.js";
import type { IfcTaskGraph } from "../src/viewer-core/engine/types.js";

const graph: IfcTaskGraph = {
  schedules: [{
    expressID: 1,
    globalId: "schedule",
    name: "Shell programme",
    description: "",
    identification: "S1",
    status: "",
    predefinedType: "PLANNED",
    creationDate: null,
    startTime: "2026-01-01",
    finishTime: "2026-01-31",
    taskIds: [10],
    modelIndex: 0,
    modelName: "Architecture.ifc",
  }],
  tasks: [{
    expressID: 10,
    globalId: "task-guid",
    name: "Install walls",
    description: "Level one walls",
    identification: "A-10",
    status: "",
    predefinedType: "CONSTRUCTION",
    workMethod: "",
    priority: 1,
    isMilestone: false,
    taskTime: {
      scheduleStart: "2026-01-05",
      scheduleFinish: "2026-01-15",
      scheduleDuration: "P10D",
      actualStart: null,
      actualFinish: null,
      actualDuration: null,
      remainingTime: null,
      completion: 10,
      statusTime: null,
    },
    scheduleIds: [1],
    parentTaskId: null,
    childTaskIds: [],
    productIds: [100],
    predecessorIds: [],
    successorIds: [],
    modelIndex: 0,
    modelName: "Architecture.ifc",
  }],
  sequences: [],
};

describe("4D schedule workspace", () => {
  it("imports common CSV headings, quoted names, percentages and European dates", () => {
    const tasks = parseScheduleCsv([
      "Task ID,Task Name,Start,Finish,Progress,GlobalIds,Discipline",
      'A-10,"Install walls, level 1",05.01.2026,15.01.2026,35%,gid-1;gid-2,Architecture.ifc',
      "M-20,Commissioning,2026/02/01,2026/02/01,1,,MEP.ifc",
    ].join("\n"));

    expect(tasks[0]).toMatchObject({
      externalId: "A-10",
      name: "Install walls, level 1",
      plannedStart: "2026-01-05",
      plannedFinish: "2026-01-15",
      progress: 35,
      globalIds: ["gid-1", "gid-2"],
    });
    expect(tasks[1]).toMatchObject({ progress: 100, plannedStart: "2026-02-01" });
  });

  it("overlays CSV progress onto a native task and keeps mappings outside IFC", () => {
    const workspace = emptyWorkspace("model-key");
    workspace.imported = [{
      externalId: "A-10",
      name: "Walls from programme",
      plannedStart: "2026-01-06",
      plannedFinish: "2026-01-18",
      actualStart: "2026-01-07",
      actualFinish: null,
      progress: 30,
      globalIds: [],
      discipline: "Architecture.ifc",
    }];
    addLink(workspace, "ifc:10", { kind: "selection", label: "Facade", elementIds: [101, 102, 102] });

    const tasks = buildScheduleTasks(graph, workspace);

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      source: "ifc+csv",
      name: "Walls from programme",
      plannedStart: "2026-01-06",
      progress: 30,
      nativeElementIds: [100],
      elementIds: [100, 101, 102],
    });
    expect(graph.tasks[0].productIds).toEqual([100]);
  });

  it("classifies planned, delayed and completed states against the status date", () => {
    const task = buildScheduleTasks(graph, emptyWorkspace("model"))[0];
    expect(snapshotAt(task, Date.parse("2026-01-01"), Date.parse("2026-01-20")).state).toBe("planned");
    expect(snapshotAt(task, Date.parse("2026-01-12"), Date.parse("2026-01-20")).state).toBe("delayed");
    expect(snapshotAt({ ...task, progress: 100, actualFinish: "2026-01-14" }, Date.parse("2026-01-16"), Date.parse("2026-01-20")).state).toBe("completed");
  });

  it("filters federated elements by model, class, storey and name", () => {
    const secondModelWall = 2 ** 32 + 22;
    const ids = matchFilter([
      { id: 11, type: "IfcWall", name: "Core wall", storey: "Level 1" },
      { id: secondModelWall, type: "IfcWall", name: "Facade wall", storey: "Level 1" },
      { id: 23, type: "IfcSlab", name: "Core slab", storey: "Level 1" },
    ], { modelIndex: 0, type: "IfcWall", storey: "Level 1", nameContains: "core" });

    expect(ids).toEqual([11]);
  });

  it("derives a usable timeline range", () => {
    const tasks = buildScheduleTasks(graph, emptyWorkspace("model"));
    expect(scheduleRange(tasks)).toEqual([Date.parse("2026-01-05T00:00:00Z"), Date.parse("2026-01-15T00:00:00Z")]);
    expect(scheduleRange(tasks, Date.parse("2026-01-20T00:00:00Z"))[1]).toBe(Date.parse("2026-01-20T00:00:00Z"));
  });
});
