import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginHost, type HostActions } from "../src/plugins/runtime/host.js";
import { CATALOG, type CatalogPlugin } from "../src/plugins/registry.js";
import type { ExtensionCapabilities, ExtensionModule } from "../src/sdk/types.js";
import type { ServiceClient } from "../src/bridge/serviceClient.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const originalCatalog = [...CATALOG];

function plugin(id: string, name: string): CatalogPlugin {
  const extension = {
    manifestVersion: 2 as const,
    id,
    name,
    version: "1.0.0",
    sdk: ">=2.0.0 <3",
    description: `${name} test panel`,
    runtime: { kind: "bundled" as const, entry: "panel.ts" },
    activationEvents: ["onPanel:main"],
    permissions: [],
    contributes: { panels: [{ id: "main", title: name }] },
    catalog: {
      tagline: `${name} tagline`,
      about: `${name} about`,
      icon: "blocks",
      category: "Tests",
      keywords: "test",
      does: ["Tests the workspace"],
    },
  };
  const module: ExtensionModule = {
    mount(host) {
      host.appendChild(Object.assign(document.createElement("button"), { textContent: `${name} action` }));
    },
  };
  return {
    id,
    name,
    tagline: extension.catalog.tagline,
    about: extension.catalog.about,
    icon: extension.catalog.icon,
    category: extension.catalog.category,
    tier: "web",
    keywords: extension.catalog.keywords,
    does: extension.catalog.does,
    extension,
    load: async () => module,
  };
}

function actions(): HostActions {
  return {
    showPanel: vi.fn(),
    setPanelVisible: vi.fn(),
    log: vi.fn(),
    runCommand: vi.fn(),
    registerCommand: vi.fn(() => vi.fn()),
    createIssue: vi.fn(async (input) => ({
      id: "issue-1",
      title: input.title,
      status: "Open" as const,
      snapshot: "pending" as const,
    })),
    setActiveResult: vi.fn(),
    modelKey: () => "model",
    modelName: () => "Model",
    python: {
      runsNatively: () => false,
      query: vi.fn(async () => ""),
      propose: vi.fn(async () => ""),
    },
    setColorRule: vi.fn(async () => undefined),
    changed: vi.fn(),
  } as HostActions;
}

afterEach(() => {
  CATALOG.splice(0, CATALOG.length, ...originalCatalog);
  document.body.replaceChildren();
  document.body.className = "";
  localStorage.clear();
});

describe("expanded plugin workspace accessibility", () => {
  it("preserves catalog focus when availability or installation state repaints it", () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"));
    const container = document.body.appendChild(document.createElement("div"));
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );

    container.querySelector<HTMLButtonElement>(".plug-entry")?.focus();
    host.refresh();
    expect(container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);

    container.querySelector<HTMLButtonElement>(".plug-entry")?.focus();
    host.catalogChanged();
    expect(container.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
  });

  it("moves focus from a catalog launcher to the opened plugin tab", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"));
    const container = document.body.appendChild(document.createElement("div"));
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );

    const launcher = container.querySelector<HTMLButtonElement>(".plug-entry");
    launcher?.focus();
    launcher?.click();
    await vi.waitFor(() => expect(host.isOpen("alpha")).toBe(true));

    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("moves focus out of a panel that programmatic selection hides", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"), plugin("beta", "Beta"));
    const container = document.body.appendChild(document.createElement("div"));
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );
    await host.open("alpha", false);
    await host.open("beta", false);
    host.select("alpha");
    container.querySelector<HTMLButtonElement>('.plug-host:not([hidden]) button')?.focus();

    host.select("beta");

    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.textContent).toContain("Beta");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
  });

  it("implements tabs, arrow navigation, modal focus containment and restoration", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"), plugin("beta", "Beta"));
    const app = document.createElement("div");
    app.id = "app";
    const container = document.createElement("div");
    app.appendChild(container);
    document.body.appendChild(app);
    const capabilities: ExtensionCapabilities = { list: () => [], execute: vi.fn() };
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      capabilities,
      actions(),
      vi.fn(),
    );

    await host.open("alpha", false);
    await host.open("beta", false);

    const tablist = container.querySelector<HTMLElement>('[role="tablist"]');
    let tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tablist?.getAttribute("aria-label")).toBe("Open plugins");
    expect(tabs).toHaveLength(2);
    expect(tablist?.querySelectorAll("button:not([role=tab])")).toHaveLength(0);
    expect(tabs[0].getAttribute("aria-selected")).toBe("false");
    expect(tabs[1].getAttribute("aria-selected")).toBe("true");
    expect(document.getElementById(tabs[0].getAttribute("aria-controls") ?? "")?.getAttribute("role")).toBe("tabpanel");

    tabs[1].focus();
    tabs[1].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    tabs = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs[0].getAttribute("aria-selected")).toBe("true");
    expect(tabs[0].tabIndex).toBe(0);
    expect(tabs[1].tabIndex).toBe(-1);
    expect(document.activeElement).toBe(tabs[0]);

    const expand = container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]');
    expand?.focus();
    expand?.click();
    const dialog = document.querySelector<HTMLDialogElement>("dialog.plug-expanded");
    expect(dialog?.open).toBe(true);
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(app.hasAttribute("inert")).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Return plugin to the inspector");
    expect(dialog?.querySelector(".plug-workspace")).toBeTruthy();

    (document.activeElement as HTMLElement).dispatchEvent(new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    }));
    expect(dialog?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).not.toBe("Return plugin to the inspector");

    dialog?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    expect(dialog?.open).toBe(false);
    expect(dialog?.classList.contains("hidden")).toBe(true);
    expect(app.hasAttribute("inert")).toBe(false);
    expect(container.contains(container.querySelector(".plug-workspace"))).toBe(true);
    expect(document.activeElement?.getAttribute("aria-haspopup")).toBe("dialog");
  });

  it("restores connected focus when the last expanded plugin closes", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"));
    const app = document.createElement("div");
    app.id = "app";
    const container = document.createElement("div");
    app.appendChild(container);
    document.body.appendChild(app);
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );
    await host.open("alpha", false);
    container.querySelector<HTMLButtonElement>('[aria-haspopup="dialog"]')?.click();

    const dialog = document.querySelector<HTMLDialogElement>("dialog.plug-expanded");
    dialog?.querySelector<HTMLButtonElement>('[aria-label="Close Alpha"]')?.click();

    expect(host.isOpen("alpha")).toBe(false);
    expect(dialog?.open).toBe(false);
    expect(app.hasAttribute("inert")).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("moves focus to the catalog when the last docked plugin closes", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"));
    const container = document.body.appendChild(document.createElement("div"));
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );
    await host.open("alpha", false);

    const close = container.querySelector<HTMLButtonElement>('[aria-label="Close Alpha"]');
    close?.focus();
    close?.click();

    expect(host.isOpen("alpha")).toBe(false);
    expect(document.activeElement).not.toBe(document.body);
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
    expect(container.contains(document.activeElement)).toBe(true);
  });

  it("restores focus when a plugin closes itself from its focused panel", async () => {
    CATALOG.splice(0, CATALOG.length, plugin("alpha", "Alpha"), plugin("beta", "Beta"));
    const container = document.body.appendChild(document.createElement("div"));
    const host = new PluginHost(
      container,
      {} as Viewer,
      {} as ServiceClient,
      { list: () => [], execute: vi.fn() } as ExtensionCapabilities,
      actions(),
      vi.fn(),
    );
    await host.open("alpha", false);
    await host.open("beta", false);
    host.select("alpha");

    container.querySelector<HTMLButtonElement>('.plug-host:not([hidden]) button')?.focus();
    // Use the public close path that ExtensionContext.close() calls.
    host.close("alpha");

    expect(host.isOpen("alpha")).toBe(false);
    expect(document.activeElement?.getAttribute("role")).toBe("tab");
    expect(document.activeElement?.getAttribute("aria-selected")).toBe("true");
    expect((document.activeElement as HTMLElement).isConnected).toBe(true);
  });
});
