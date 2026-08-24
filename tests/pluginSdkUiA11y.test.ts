import { describe, expect, it, vi } from "vitest";
import { grid, progress } from "../src/sdk/ui.js";

describe("plugin SDK UI accessibility", () => {
  it("exposes progress values and clamps the visual and semantic percentage", () => {
    const status = progress();

    expect(status.root.getAttribute("role")).toBe("progressbar");
    expect(status.root.getAttribute("aria-valuemin")).toBe("0");
    expect(status.root.getAttribute("aria-valuemax")).toBe("100");

    status.set(3, 4, "Checking doors");
    expect(status.root.classList.contains("hidden")).toBe(false);
    expect(status.root.getAttribute("aria-valuenow")).toBe("75");
    expect(status.root.getAttribute("aria-valuetext")).toBe("Checking doors");
    expect(status.root.querySelector<HTMLElement>(".plug-progress-track i")?.style.width).toBe("75%");

    status.set(9, 4);
    expect(status.root.getAttribute("aria-valuenow")).toBe("100");
    expect(status.root.getAttribute("aria-valuetext")).toBe("9 of 4");
    status.hide();
    expect(status.root.classList.contains("hidden")).toBe(true);
  });

  it("uses native controls for sorting and selecting table rows", () => {
    const sort = vi.fn();
    const pick = vi.fn();
    const pickWindows = vi.fn();
    const root = grid(
      ["Name", "Count"],
      [
        { cells: ["Doors", 12], pick, pickLabel: "Select all doors" },
        { cells: ["Total", 12] },
        { cells: ["Windows", 4], pick: pickWindows },
      ],
      sort,
      { column: 1, direction: "descending" },
    );
    document.body.appendChild(root);
    const headers = [...root.querySelectorAll<HTMLTableCellElement>("th")];
    const sortButtons = [...root.querySelectorAll<HTMLButtonElement>(".grid-sort")];

    expect(headers[0].getAttribute("scope")).toBe("col");
    expect(headers[0].getAttribute("aria-sort")).toBeNull();
    expect(headers[1].getAttribute("aria-sort")).toBe("descending");
    expect(sortButtons.map((button) => button.type)).toEqual(["button", "button"]);

    sortButtons[0].click();
    expect(sort).toHaveBeenCalledWith(0);
    expect(headers[0].getAttribute("aria-sort")).toBe("ascending");
    expect(headers[1].getAttribute("aria-sort")).toBeNull();

    const actions = [...root.querySelectorAll<HTMLButtonElement>(".grid-row-action")];
    expect(actions[0].type).toBe("button");
    expect(actions[0].getAttribute("aria-label")).toBe("Select all doors");
    expect(actions.map((button) => button.tabIndex)).toEqual([0, -1]);
    expect(actions[0].closest("tr")?.getAttribute("role")).toBeNull();
    expect(actions[0].closest("td")?.tagName).toBe("TD");

    // Enter and Space use the browser's native button activation. Arrow keys
    // only move the single tab stop between selectable rows.
    actions[0].click();
    expect(pick).toHaveBeenCalledOnce();
    actions[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(document.activeElement).toBe(actions[1]);
    expect(actions.map((button) => button.tabIndex)).toEqual([-1, 0]);
    actions[1].click();
    expect(pickWindows).toHaveBeenCalledOnce();
    root.remove();
  });
});
