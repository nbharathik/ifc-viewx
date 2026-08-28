import { describe, expect, it } from "vitest";
import { extractTaskGraph, type TaskGraphLines } from "../src/ifc/taskGraph.js";

const ref = (value: number) => ({ type: 5, value });
const val = (value: unknown) => ({ value });

describe("IFC task graph extraction", () => {
  it("reads schedules, nested tasks, task time, products and sequences", () => {
    const extra = new Map<number, Record<string, unknown>>([
      [50, {
        expressID: 50,
        ScheduleStart: val("2026-01-05T08:00:00"),
        ScheduleFinish: val("2026-01-09T17:00:00"),
        ScheduleDuration: val("P5D"),
        ActualStart: val("2026-01-06T08:00:00"),
        Completion: val(35),
      }],
      [60, { expressID: 60, LagValue: val("P1D") }],
    ]);
    const source: TaskGraphLines = {
      schedules: [{
        expressID: 1,
        GlobalId: val("schedule-guid"),
        Name: val("Main works"),
        StartTime: val("2026-01-01"),
        FinishTime: val("2026-02-01"),
        PredefinedType: val("PLANNED"),
      }],
      tasks: [
        { expressID: 10, GlobalId: val("task-root"), Identification: val("A100"), Name: val("Structure") },
        { expressID: 11, GlobalId: val("task-child"), Identification: val("A110"), Name: val("Columns"), TaskTime: ref(50) },
      ],
      controls: [{ expressID: 20, RelatingControl: ref(1), RelatedObjects: [ref(10)] }],
      nests: [{ expressID: 21, RelatingObject: ref(10), RelatedObjects: [ref(11)] }],
      aggregates: [],
      processAssignments: [{ expressID: 22, RelatingProcess: ref(11), RelatedObjects: [ref(100), ref(101)] }],
      sequences: [{ expressID: 23, RelatingProcess: ref(10), RelatedProcess: ref(11), SequenceType: val("FINISH_START"), TimeLag: ref(60) }],
      line: (id) => extra.get(id) ?? null,
    };

    const graph = extractTaskGraph(source);

    expect(graph.schedules).toHaveLength(1);
    expect(graph.schedules[0]).toMatchObject({ name: "Main works", taskIds: [10, 11] });
    expect(graph.tasks).toHaveLength(2);
    expect(graph.tasks[0]).toMatchObject({ expressID: 10, childTaskIds: [11], successorIds: [11], scheduleIds: [1] });
    expect(graph.tasks[1]).toMatchObject({
      expressID: 11,
      parentTaskId: 10,
      productIds: [100, 101],
      predecessorIds: [10],
      scheduleIds: [1],
    });
    expect(graph.tasks[1].taskTime).toMatchObject({
      scheduleStart: "2026-01-05T08:00:00",
      scheduleFinish: "2026-01-09T17:00:00",
      scheduleDuration: "P5D",
      actualStart: "2026-01-06T08:00:00",
      completion: 35,
    });
    expect(graph.sequences[0]).toMatchObject({
      predecessorId: 10,
      successorId: 11,
      sequenceType: "FINISH_START",
      timeLag: "P1D",
    });
  });

  it("keeps an unassigned IFC task available", () => {
    const graph = extractTaskGraph({
      schedules: [],
      tasks: [{ expressID: 7, Name: val("Commissioning"), IsMilestone: val(true) }],
      controls: [],
      nests: [],
      aggregates: [],
      processAssignments: [],
      sequences: [],
      line: () => null,
    });

    expect(graph.tasks[0]).toMatchObject({ name: "Commissioning", isMilestone: true, scheduleIds: [], productIds: [] });
  });

  it("keeps omitted and blank numeric values nullable", () => {
    const graph = extractTaskGraph({
      schedules: [],
      tasks: [
        { expressID: 7, Priority: null },
        { expressID: 8, Priority: val("  "), TaskTime: ref(50) },
      ],
      controls: [],
      nests: [],
      aggregates: [],
      processAssignments: [],
      sequences: [],
      line: (id) => id === 50 ? { expressID: 50, Completion: val("") } : null,
    });

    expect(graph.tasks.map((task) => task.priority)).toEqual([null, null]);
    expect(graph.tasks[1].taskTime?.completion).toBeNull();
  });
});
