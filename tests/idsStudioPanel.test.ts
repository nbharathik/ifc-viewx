import { describe, expect, it, vi } from "vitest";
import { mount } from "../src/plugins/ids-studio/panel.js";
import type { ExtensionContext } from "../src/sdk/index.js";

function context(): ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    session: { model: () => ({ key: "model-key", name: "Architecture.ifc", loaded: true }) },
    model: {
      elements: () => [{ id: 100, type: "IfcWall", name: "Wall", storey: "Level 1" }],
      properties: vi.fn(async () => null),
      tree: () => null,
    },
    view: { select: vi.fn(), frame: vi.fn() },
    storage: {
      read: <T,>(key: string, fallback: T): T => (store.has(key) ? store.get(key) as T : fallback),
      write: (key: string, value: unknown) => void store.set(key, value),
    },
    feedback: { log: vi.fn(), toast: vi.fn(), publishFindings: vi.fn() },
    results: { create: vi.fn(() => ({ id: "result-1" })), dispose: vi.fn() },
    files: { open: vi.fn(), export: vi.fn() },
    issues: { create: vi.fn() },
  } as unknown as ExtensionContext;
}

const byText = (host: HTMLElement, text: string): HTMLButtonElement =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;

const openEdit = (host: HTMLElement): void => byText(host, "Edit").click();

const picker = (host: HTMLElement): HTMLSelectElement => host.querySelector<HTMLSelectElement>(".ids-spec-picker")!;

describe("IDS Requirements Studio panel", () => {
  it("opens on Check, which is the one thing the panel is usually for", () => {
    const host = document.createElement("div");
    const instance = mount(host, context());

    expect(byText(host, "Check the open model")).toBeTruthy();
    expect(host.querySelector(".ids-spec-picker")).toBeNull();
    expect(host.textContent).toContain("Nothing in the model is changed");

    instance?.dispose?.();
  });

  it("edits a specification in one column with the facet editor inline", () => {
    const host = document.createElement("div");
    const instance = mount(host, context());
    openEdit(host);

    expect(picker(host).options).toHaveLength(1);
    expect(host.textContent).toContain("Applies to");
    expect(host.textContent).toContain("Must provide");
    // The editor belongs to the list holding the selection, so criteria sit
    // next to the facet they describe at any panel width.
    const editor = host.querySelector(".ids-inspector");
    expect(editor).not.toBeNull();
    expect(editor?.closest(".ids-block")?.textContent).toContain("Must provide");

    instance?.dispose?.();
  });

  it("moves the inline editor when an applicability facet is selected", () => {
    const host = document.createElement("div");
    const instance = mount(host, context());
    openEdit(host);

    const blocks = [...host.querySelectorAll<HTMLElement>(".ids-block")];
    const applies = blocks.find((block) => block.textContent?.startsWith("Applies to"))!;
    applies.querySelector<HTMLButtonElement>(".ids-facet-card")!.click();

    expect(host.querySelectorAll(".ids-inspector")).toHaveLength(1);
    expect(host.querySelector(".ids-inspector")?.closest(".ids-block")?.textContent).toContain("Applies to");

    instance?.dispose?.();
  });

  it("duplicates and adds specifications through the picker bar", () => {
    const host = document.createElement("div");
    const instance = mount(host, context());
    openEdit(host);

    host.querySelector<HTMLButtonElement>('[title^="Duplicate"]')!.click();
    expect(picker(host).options).toHaveLength(2);
    expect(picker(host).selectedOptions[0].textContent).toContain("copy");

    host.querySelector<HTMLButtonElement>('[title^="Add a specification"]')!.click();
    host.querySelector<HTMLButtonElement>('[title^="Add a specification"]')!.click();
    expect(picker(host).options).toHaveLength(4);

    instance?.dispose?.();
  });

  it("refuses to remove the only specification", () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);
    openEdit(host);

    host.querySelector<HTMLButtonElement>('[title^="Remove this specification"]')!.click();

    expect(picker(host).options).toHaveLength(1);
    expect(ctx.feedback.toast).toHaveBeenCalledWith("An IDS file needs at least one specification", "error");

    instance?.dispose?.();
  });

  it("does not mark the document dirty when browsing specifications", () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);
    openEdit(host);

    host.querySelector<HTMLButtonElement>('[title^="Duplicate"]')!.click();
    byText(host, "Export .ids").click();
    expect(ctx.files.export).toHaveBeenCalledOnce();
    expect(host.querySelector(".ids-studio")?.classList.contains("is-edited")).toBe(false);

    const select = picker(host);
    select.value = select.options[0].value;
    select.dispatchEvent(new Event("change"));

    expect(host.querySelector(".ids-studio")?.classList.contains("is-edited")).toBe(false);
    instance?.dispose?.();
  });
});
