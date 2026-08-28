import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
  dispose: vi.fn(),
  mount: vi.fn(),
  release: vi.fn(),
}));

vi.mock("../src/plugins/registry.js", () => {
  const extension = {
    manifestVersion: 2,
    id: "org.example.persistence",
    name: "Persistence fixture",
    version: "1.0.0",
    sdk: ">=2.0.0 <3",
    description: "Exercises plugin session persistence.",
    runtime: { kind: "bundled", entry: "panel.ts" },
    activationEvents: ["onPanel:main"],
    permissions: [],
    contributes: { panels: [{ id: "main", title: "Fixture" }] },
    catalog: {
      tagline: "Persistence fixture",
      about: "Used only by the plugin host persistence test.",
      icon: "blocks",
      category: "Tests",
      keywords: "test persistence",
      does: ["Mounts a fixture panel"],
    },
  };
  const plugin = {
    id: extension.id,
    name: extension.name,
    tagline: extension.catalog.tagline,
    about: extension.catalog.about,
    icon: extension.catalog.icon,
    category: extension.catalog.category,
    tier: "web",
    keywords: extension.catalog.keywords,
    does: extension.catalog.does,
    extension,
    load: async () => ({
      mount: (...args: unknown[]) => {
        runtime.mount(...args);
        return { dispose: runtime.dispose };
      },
    }),
  };
  return {
    CATALOG: [plugin],
    findPlugin: (id: string) => id === plugin.id ? plugin : undefined,
    isBuiltIn: () => false,
    isLive: () => true,
  };
});

vi.mock("../src/plugins/runtime/context.js", () => ({
  createHostContext: () => ({ ctx: {}, release: runtime.release }),
}));

vi.mock("../src/extensions/context.js", () => ({
  createExtensionContext: () => ({}),
}));

import { PluginHost } from "../src/plugins/runtime/host.js";
import type { ExtensionCapabilities } from "../src/sdk/types.js";
import type { ServiceClient } from "../src/bridge/serviceClient.js";
import type { Viewer } from "../src/viewer-core/viewer.js";
import type { HostActions } from "../src/plugins/runtime/host.js";

beforeEach(() => {
  document.body.replaceChildren();
  localStorage.clear();
  runtime.dispose.mockClear();
  runtime.mount.mockClear();
  runtime.release.mockClear();
});

afterEach(() => vi.restoreAllMocks());

describe("plugin host persistence", () => {
  it("finishes opening and closing when localStorage is unavailable", async () => {
    const setPanelVisible = vi.fn();
    const changed = vi.fn();
    const actions = {
      showPanel: vi.fn(),
      setPanelVisible,
      log: vi.fn(),
      runCommand: vi.fn(),
      registerCommand: vi.fn(() => () => undefined),
      createIssue: vi.fn(),
      setActiveResult: vi.fn(),
      modelKey: () => "",
      modelName: () => "",
      python: { runsNatively: () => false, query: vi.fn(), propose: vi.fn() },
      setColorRule: vi.fn(async () => undefined),
      changed,
    } as unknown as HostActions;
    const service = {} as ServiceClient;
    const capabilities = { list: () => [], execute: vi.fn() } as unknown as ExtensionCapabilities;
    const host = new PluginHost(
      document.body.appendChild(document.createElement("div")),
      {} as Viewer,
      service,
      capabilities,
      actions,
      vi.fn(),
    );
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(host.open("org.example.persistence")).resolves.toBeUndefined();
    expect(host.isOpen("org.example.persistence")).toBe(true);
    expect(runtime.mount).toHaveBeenCalledOnce();
    expect(setPanelVisible).toHaveBeenLastCalledWith(true);

    expect(() => host.close("org.example.persistence")).not.toThrow();
    expect(host.isOpen("org.example.persistence")).toBe(false);
    expect(runtime.dispose).toHaveBeenCalledOnce();
    expect(setPanelVisible).toHaveBeenLastCalledWith(false);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
