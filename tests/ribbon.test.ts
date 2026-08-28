import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../src/ui/commands.js";
import { Ribbon, type RibbonTab } from "../src/ui/ribbon.js";

describe("Ribbon layout", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("expands in place when a tab is selected while collapsed", () => {
    const tabs = document.createElement("nav");
    const body = document.createElement("div");
    document.body.append(tabs, body);
    const registry = new CommandRegistry();
    registry.add([
      { id: "one", label: "One", section: "Test", run: vi.fn() },
      { id: "two", label: "Two", section: "Test", run: vi.fn() },
    ]);
    const layout: RibbonTab[] = [
      { id: "first", label: "First", groups: [{ label: "A", items: [{ kind: "cmd", id: "one" }] }] },
      { id: "second", label: "Second", groups: [{ label: "B", items: [{ kind: "cmd", id: "two" }] }] },
    ];
    const ribbon = new Ribbon(tabs, body, registry, layout);

    ribbon.setCollapsed(true);
    expect(body.classList.contains("collapsed")).toBe(true);

    tabs.querySelectorAll<HTMLButtonElement>(".rib-tab")[1].click();

    expect(ribbon.getTab()).toBe("second");
    expect(body.classList.contains("collapsed")).toBe(false);
    expect(body.classList.contains("flyout")).toBe(false);
  });

  it("uses roving focus and arrow keys to select tabs", () => {
    const tabs = document.createElement("nav");
    const body = document.createElement("div");
    document.body.append(tabs, body);
    const registry = new CommandRegistry();
    registry.add([
      { id: "one", label: "One", section: "Test", run: vi.fn() },
      { id: "two", label: "Two", section: "Test", run: vi.fn() },
    ]);
    const ribbon = new Ribbon(tabs, body, registry, [
      { id: "first", label: "First", groups: [{ label: "A", items: [{ kind: "cmd", id: "one" }] }] },
      { id: "second", label: "Second", groups: [{ label: "B", items: [{ kind: "cmd", id: "two" }] }] },
    ]);
    const buttons = tabs.querySelectorAll<HTMLButtonElement>(".rib-tab");

    expect(buttons[0].tabIndex).toBe(0);
    expect(buttons[1].tabIndex).toBe(-1);
    buttons[0].focus();
    buttons[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));

    expect(ribbon.getTab()).toBe("second");
    expect(document.activeElement).toBe(buttons[1]);
    expect(buttons[0].getAttribute("aria-selected")).toBe("false");
    expect(buttons[1].getAttribute("aria-selected")).toBe("true");
  });

  it("keeps working when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const tabs = document.createElement("nav");
    const body = document.createElement("div");
    const registry = new CommandRegistry();
    registry.add([{ id: "one", label: "One", section: "Test", run: vi.fn() }]);

    expect(() => {
      const ribbon = new Ribbon(tabs, body, registry, [
        { id: "first", label: "First", groups: [{ label: "A", items: [{ kind: "cmd", id: "one" }] }] },
      ]);
      ribbon.setCollapsed(true);
      ribbon.select("first", true);
    }).not.toThrow();
  });
});
