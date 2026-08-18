import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attachPopover, closeLayer, CommandPalette, toast } from "../src/ui/kit.js";

describe("UI kit accessibility", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    vi.useFakeTimers();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    closeLayer();
    vi.runAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("announces routine and error toasts with the right urgency", () => {
    toast("Saved", "success");
    toast("Could not save", "error");

    const host = document.querySelector("#toasts");
    const messages = host?.querySelectorAll<HTMLElement>(".toast");
    expect(host?.getAttribute("role")).toBe("region");
    expect(host?.getAttribute("aria-label")).toBe("Notifications");
    expect(messages?.[0].getAttribute("role")).toBe("status");
    expect(messages?.[1].getAttribute("role")).toBe("alert");
    expect(messages?.[1].getAttribute("aria-atomic")).toBe("true");
  });

  it("labels popovers from their trigger", () => {
    const host = document.createElement("span");
    const button = document.createElement("button");
    button.setAttribute("aria-label", "Visibility options");
    host.appendChild(button);
    document.body.appendChild(host);
    attachPopover(button, (popover) => {
      popover.textContent = "Options";
    });

    button.click();

    expect(host.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Visibility options");
  });

  it("exposes the command palette as a labelled combobox and listbox", () => {
    const palette = new CommandPalette(() => [
      { id: "first", label: "First command", section: "Test", run: vi.fn() },
      { id: "second", label: "Second command", section: "Test", run: vi.fn() },
    ]);
    palette.open();
    const panel = document.querySelector<HTMLElement>("#palette");
    const input = panel?.querySelector<HTMLInputElement>("input");
    const options = panel?.querySelectorAll<HTMLElement>("[role=option]");

    expect(panel?.getAttribute("aria-label")).toBe("Command palette");
    expect(input?.getAttribute("role")).toBe("combobox");
    expect(input?.getAttribute("aria-controls")).toBe("palette-list");
    expect(options).toHaveLength(2);
    expect(input?.getAttribute("aria-activedescendant")).toBe(options?.[0].id);

    input?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input?.getAttribute("aria-activedescendant")).toBe(options?.[1].id);
    expect(panel?.querySelectorAll<HTMLElement>("[role=option]")[1].getAttribute("aria-selected")).toBe("true");
    palette.close();
  });
});
