import { beforeEach, describe, expect, it, vi } from "vitest";

import { CommandRegistry } from "../src/ui/commands.js";
import { Ribbon, type RibbonTab } from "../src/ui/ribbon.js";

describe("Ribbon layout", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
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
});
