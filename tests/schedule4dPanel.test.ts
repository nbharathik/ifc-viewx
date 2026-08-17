import { describe, expect, it, vi } from "vitest";
import { mount, timelineTicks } from "../src/plugins/schedule-4d/panel.js";
import type { ExtensionContext, IfcTaskGraph } from "../src/sdk/index.js";

const DAY = 86_400_000;

const graph: IfcTaskGraph = {
  schedules: [{
    expressID: 1,
    globalId: "schedule-guid",
    name: "Main programme",
    description: "",
    identification: "WS-1",
    status: "",
    predefinedType: "PLANNED",
    creationDate: null,
    startTime: "2026-01-01",
    finishTime: "2026-02-01",
    taskIds: [10],
    modelIndex: 0,
    modelName: "Architecture.ifc",
  }],
  tasks: [{
    expressID: 10,
    globalId: "task-guid",
    name: "Install facade",
    description: "",
    identification: "A100",
    status: "",
    predefinedType: "CONSTRUCTION",
    workMethod: "",
    priority: null,
    isMilestone: false,
    taskTime: {
      scheduleStart: "2026-01-10",
      scheduleFinish: "2026-01-20",
      scheduleDuration: "P10D",
      actualStart: null,
      actualFinish: null,
      actualDuration: null,
      remainingTime: null,
      completion: 25,
      statusTime: null,
    },
    scheduleIds: [1],
    parentTaskId: null,
    childTaskIds: [],
    productIds: [100, 101],
    predecessorIds: [],
    successorIds: [],
    modelIndex: 0,
    modelName: "Architecture.ifc",
  }],
  sequences: [],
};

function context(): ExtensionContext {
  const result = { id: "result-1" };
  return {
    session: { model: () => ({ key: "model-key", name: "Architecture.ifc", loaded: true }) },
    model: {
      scheduleGraph: vi.fn(async () => graph),
      elements: () => [
        { id: 100, type: "IfcCurtainWall", name: "North facade", storey: "Level 1" },
        { id: 101, type: "IfcCurtainWall", name: "South facade", storey: "Level 1" },
      ],
      classes: () => [["IfcCurtainWall", 2]],
      index: () => ({ build: vi.fn(async () => []) }),
    },
    view: {
      colorBy: vi.fn(),
      models: () => [{ index: 0, name: "Architecture.ifc", visible: true, offset: [0, 0, 0], elements: 2, triangles: 24 }],
      setModelVisible: vi.fn(),
      rules: () => [],
      selection: () => [],
      select: vi.fn(),
      isolate: vi.fn(),
      showAll: vi.fn(),
    },
    storage: { read: <T,>(_key: string, fallback: T): T => fallback, write: vi.fn() },
    feedback: { log: vi.fn(), toast: vi.fn(), publishFindings: vi.fn() },
    results: { create: vi.fn(() => result), dispose: vi.fn() },
    events: { on: vi.fn(() => () => undefined) },
    files: { open: vi.fn(), export: vi.fn() },
    issues: { create: vi.fn() },
  } as unknown as ExtensionContext;
}

describe("4D schedule panel", () => {
  it("mounts the task graph, draws a Gantt row and opens mapping controls", async () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);

    await vi.waitFor(() => expect(host.querySelectorAll(".s4d-task-row")).toHaveLength(1));
    expect(host.textContent).toContain("Install facade");
    expect(host.textContent).toContain("1 / 1");

    (host.querySelector(".s4d-task-row") as HTMLButtonElement).click();
    expect(host.textContent).toContain("Current selection");
    expect(host.textContent).toContain("Native IfcRelAssignsToProcess");

    instance?.dispose?.();
    expect(ctx.view.colorBy).toHaveBeenCalled();
  });

  it("draws a date axis whose ticks sit on the same scale as the bars", async () => {
    const host = document.createElement("div");
    const instance = mount(host, context());

    await vi.waitFor(() => expect(host.querySelectorAll(".s4d-task-row")).toHaveLength(1));
    const ticks = [...host.querySelectorAll<HTMLElement>(".s4d-axis-track > span")];
    expect(ticks.length).toBeGreaterThan(1);
    // Tick k must land at exactly k steps, which is what lets one repeating
    // gradient draw the gridlines behind the bars with no phase correction.
    const step = Number.parseFloat(ticks[1].style.left);
    ticks.forEach((tick, index) => expect(Number.parseFloat(tick.style.left)).toBeCloseTo(step * index, 6));
    const board = host.querySelector<HTMLElement>(".s4d-board");
    expect(board?.style.getPropertyValue("--s4d-tick")).toBe(`${step}%`);
    expect(host.querySelector(".s4d-axis-cursor")?.textContent).toBeTruthy();

    instance?.dispose?.();
  });

  it("scrubbing the timeline keeps the open task card and its typed filters", async () => {
    const host = document.createElement("div");
    const instance = mount(host, context());

    await vi.waitFor(() => expect(host.querySelectorAll(".s4d-task-row")).toHaveLength(1));
    (host.querySelector(".s4d-task-row") as HTMLButtonElement).click();
    const card = host.querySelector(".s4d-task-card");
    const nameFilter = host.querySelector<HTMLInputElement>('input[aria-label="Element name filter"]');
    expect(card).not.toBeNull();
    nameFilter!.value = "facade";

    const slider = host.querySelector<HTMLInputElement>(".s4d-slider")!;
    slider.value = String(Math.round(Number(slider.max) / 2));
    slider.dispatchEvent(new Event("input"));

    expect(host.querySelector(".s4d-task-card")).toBe(card);
    expect(host.querySelector<HTMLInputElement>('input[aria-label="Element name filter"]')?.value).toBe("facade");

    instance?.dispose?.();
  });

  it("a discipline that names no loaded model leaves every model visible", async () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);

    await vi.waitFor(() => expect(host.querySelectorAll(".s4d-task-row")).toHaveLength(1));
    const select = host.querySelector<HTMLSelectElement>('select[class="plug-select"], .plug-field select')!;
    select.append(Object.assign(document.createElement("option"), { value: "Piping (CSV)", text: "Piping (CSV)" }));
    select.value = "Piping (CSV)";
    select.dispatchEvent(new Event("change"));

    expect(ctx.view.setModelVisible).toHaveBeenCalledWith(0, true);
    expect(ctx.view.setModelVisible).not.toHaveBeenCalledWith(0, false);

    instance?.dispose?.();
  });
});

describe("timelineTicks", () => {
  it("keeps every tick a whole step from the range start", () => {
    const start = Date.UTC(2026, 0, 1);
    const { ticks, stepPercent } = timelineTicks(start, start + 30 * DAY, 6);
    expect(ticks[0].at).toBe(start);
    for (const [index, tick] of ticks.entries()) {
      expect(tick.percent).toBeCloseTo(stepPercent * index, 6);
    }
    expect(ticks[ticks.length - 1].at).toBeLessThanOrEqual(start + 30 * DAY);
  });

  it("widens the step rather than crowding the axis on a multi-year programme", () => {
    const start = Date.UTC(2020, 0, 1);
    const short = timelineTicks(start, start + 20 * DAY, 8);
    const long = timelineTicks(start, start + 1500 * DAY, 8);
    expect(short.ticks.length).toBeLessThanOrEqual(9);
    expect(long.ticks.length).toBeLessThanOrEqual(9);
    expect(long.stepPercent).toBeGreaterThan(0);
  });
});
