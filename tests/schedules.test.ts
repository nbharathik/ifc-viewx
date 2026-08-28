import { describe, expect, it, vi } from "vitest";
import type { ScheduleReport } from "../src/ifc/ifcEngine.js";
import { SchedulePanel, type ScheduleActions } from "../src/ui/schedules.js";

function report(name: string, expressID: number): ScheduleReport {
  return {
    type: "IfcWall",
    total: 1,
    returned: 1,
    truncated: false,
    columns: ["expressID", "Name"],
    availableProperties: [],
    rows: [{ expressID, Name: name }],
  };
}

function multiReport(): ScheduleReport {
  return {
    ...report("Wall 1", 41),
    total: 3,
    returned: 3,
    rows: [
      { expressID: 41, Name: "Wall 1" },
      { expressID: 42, Name: "Wall 2" },
      { expressID: 43, Name: "Wall 3" },
    ],
  };
}

function actions(run: ScheduleActions["run"], select = vi.fn()): ScheduleActions {
  return {
    types: () => ["IfcWall"],
    run,
    select,
    stageEdits: async () => undefined,
  };
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("SchedulePanel", () => {
  it("ignores a schedule that finishes after the model changes", async () => {
    const pending: Array<(value: ScheduleReport) => void> = [];
    const mount = document.createElement("div");
    const panel = new SchedulePanel(mount, actions(() => new Promise((resolve) => pending.push(resolve))));
    const run = [...mount.querySelectorAll("button")].find((button) => button.textContent === "Run");
    expect(run).toBeTruthy();

    run?.click();
    panel.refreshTypes();
    run?.click();
    pending[0](report("Old model", 1));
    await settle();
    expect(mount.textContent).not.toContain("Old model");

    pending[1](report("Current model", 2));
    await settle();
    expect(mount.textContent).toContain("Current model");
  });

  it("selects a result row from the keyboard", async () => {
    const selected = vi.fn();
    const mount = document.createElement("div");
    new SchedulePanel(mount, actions(async () => report("Wall", 42), selected));
    const run = [...mount.querySelectorAll("button")].find((button) => button.textContent === "Run");
    run?.click();
    await settle();

    const row = mount.querySelector<HTMLElement>("tbody tr");
    expect(row?.getAttribute("aria-label")).toBe("Select element 42");
    row?.dispatchEvent(new KeyboardEvent("keydown", { key: " ", bubbles: true }));
    expect(selected).toHaveBeenCalledWith(42);
  });

  it("uses one roving tab stop across large result tables", async () => {
    const selected = vi.fn();
    const mount = document.createElement("div");
    document.body.appendChild(mount);
    new SchedulePanel(mount, actions(async () => multiReport(), selected));
    [...mount.querySelectorAll("button")].find((button) => button.textContent === "Run")?.click();
    await settle();

    const rows = [...mount.querySelectorAll<HTMLElement>("tbody tr")];
    expect(rows.map((row) => row.tabIndex)).toEqual([0, -1, -1]);
    rows[0].focus();
    rows[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(document.activeElement).toBe(rows[1]);
    expect(rows.map((row) => row.tabIndex)).toEqual([-1, 0, -1]);
    rows[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(selected).toHaveBeenCalledWith(42);
  });
});
