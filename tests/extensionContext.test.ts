import { describe, expect, it, vi } from "vitest";
import { ExtensionContributionRegistry, ExtensionScope } from "../src/extensions/contributions.js";
import { createExtensionContextV2 } from "../src/extensions/context.js";
import { ExtensionResultStore } from "../src/extensions/results.js";
import type { ExtensionManifestV2 } from "../src/sdk/v2/contributions.js";
import type { PluginContext } from "../src/sdk/types.js";

const summary = (id: string, effect: "read" | "view" | "propose") => ({
  id,
  title: id,
  description: id,
  effect,
  cost: "instant" as const,
  parallelSafe: true,
});

function manifest(permissions: ExtensionManifestV2["permissions"]): ExtensionManifestV2 {
  return {
    manifestVersion: 2,
    id: "sample",
    name: "Sample",
    version: "1.0.0",
    sdk: ">=2.0.0 <3",
    description: "Sample",
    runtime: { kind: "bundled", entry: "panel.ts" },
    activationEvents: ["onPanel:sample"],
    permissions,
    contributes: {
      panels: [{ id: "sample", title: "Sample" }],
      commands: [{ id: "sample.run", title: "Run sample" }],
      overlays: [{ id: "sample.overlay", title: "Overlay" }],
      resultViews: [{ id: "sample.results", title: "Results" }],
    },
    catalog: {
      tagline: "Sample",
      about: "Sample extension",
      icon: "blocks",
      category: "Tests",
      keywords: "sample",
      does: ["Tests context"],
    },
  };
}

function legacy() {
  const off = vi.fn();
  const clash = vi.fn((_a: number[], _b: number[], options?: { signal?: AbortSignal }) =>
    new Promise<never>((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
    }));
  const execute = vi.fn(async <T,>(_id: string): Promise<T> => "ok" as T);
  const laser = vi.fn(async () => ({ axes: [], fidelity: "mesh" }));
  const value = {
    capabilities: {
      list: () => [summary("counts", "read"), summary("clash", "read"), summary("select", "view"), summary("danger", "propose")],
      execute,
    },
    model: vi.fn(() => ({ key: "model", name: "Model", loaded: true })),
    elements: vi.fn(() => [{ id: 1, type: "IfcWall", name: "Wall", storey: "Level 1" }]),
    classes: vi.fn(() => [["IfcWall", 1]]),
    bounds: vi.fn(() => null),
    clash,
    laser,
    lastPick: vi.fn(() => ({ expressID: 1, point: [1, 2, 3] })),
    isVisible: vi.fn(() => true),
    camera: vi.fn(() => ({ position: [2, 2, 2], target: [0, 0, 0] })),
    setCamera: vi.fn(),
    measurements: vi.fn(() => []),
    addMeasurement: vi.fn(() => ({ id: 7 })),
    removeMeasurement: vi.fn(),
    on: vi.fn(() => off),
    hide: vi.fn(),
    run: vi.fn(),
    read: vi.fn((_key: string, fallback: unknown) => fallback),
    write: vi.fn(),
  } as unknown as PluginContext;
  return { value, off, clash, laser, execute };
}

describe("SDK v2 extension context", () => {
  it("exposes no raw host escape hatch and enforces domain permissions", async () => {
    const old = legacy();
    const scope = new ExtensionScope("sample", new ExtensionContributionRegistry());
    const definition = manifest(["model.structure.read"]);
    scope.registerManifest(definition.contributes);
    const ctx = createExtensionContextV2(definition, old.value, scope);

    expect("viewer" in ctx).toBe(false);
    expect("service" in ctx).toBe(false);
    expect("python" in ctx).toBe(false);
    expect(ctx.model.elements()).toHaveLength(1);
    expect(() => ctx.view.hide([1])).toThrow(/requires permission view\.control/);
    expect(ctx.capabilities.list().map((entry) => entry.id)).toEqual(["counts"]);
    await expect(ctx.capabilities.execute("clash")).rejects.toThrow(/not allowed/);
    await expect(ctx.capabilities.execute("counts")).resolves.toBe("ok");
  });

  it("removes events, commands, overlays and pending geometry on close", async () => {
    const old = legacy();
    const registry = new ExtensionContributionRegistry();
    const scope = new ExtensionScope("sample", registry);
    const definition = manifest([
      "model.structure.read", "geometry.query", "view.control", "view.overlay",
    ]);
    scope.registerManifest(definition.contributes);
    const removeCommand = vi.fn();
    const registerCommand = vi.fn(() => removeCommand);
    const addOverlayLine = vi.fn(() => 42);
    const removeOverlayLine = vi.fn();
    const results = new ExtensionResultStore();
    const ctx = createExtensionContextV2(definition, old.value, scope, {
      registerCommand,
      results,
      addOverlayLine,
      removeOverlayLine,
    });
    const overlayCleanup = vi.fn();

    ctx.events.on("model", vi.fn());
    ctx.commands.register("sample.run", vi.fn());
    ctx.contributions.register("overlays", definition.contributes.overlays![0], overlayCleanup);
    ctx.overlays.line("sample.overlay", [0, 0, 0], [1, 0, 0]);
    const handle = ctx.results.create("sample.results", [{ id: 1 }, { id: 2 }]);
    expect(ctx.results.page<{ id: number }>(handle.id, 0, 1).items).toEqual([{ id: 1 }]);
    const pending = ctx.geometry.clash([1], [2]);
    scope.dispose();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(old.off).toHaveBeenCalledOnce();
    expect(registerCommand).toHaveBeenCalledOnce();
    expect(removeCommand).toHaveBeenCalledOnce();
    expect(overlayCleanup).toHaveBeenCalledOnce();
    expect(addOverlayLine).toHaveBeenCalledOnce();
    expect(removeOverlayLine).toHaveBeenCalledWith(42);
    expect(ctx.results.get(handle.id)).toBeNull();
    expect(registry.count("sample")).toBe(0);
  });

  it("mediates laser, surface pick, camera, visibility and persistent measurements", async () => {
    const old = legacy();
    const scope = new ExtensionScope("sample", new ExtensionContributionRegistry());
    const definition = manifest(["geometry.query", "view.read", "view.control"]);
    scope.registerManifest(definition.contributes);
    const ctx = createExtensionContextV2(definition, old.value, scope);

    await ctx.geometry.laser([1, 2, 3], { source: 1, maxDistance: 12 });
    expect(old.laser).toHaveBeenCalledWith([1, 2, 3], expect.objectContaining({
      source: 1,
      maxDistance: 12,
      signal: expect.any(AbortSignal),
    }));
    expect(ctx.view.lastPick()).toEqual({ expressID: 1, point: [1, 2, 3] });
    expect(ctx.view.isVisible(1)).toBe(true);
    expect(ctx.view.camera()).toEqual({ position: [2, 2, 2], target: [0, 0, 0] });
    ctx.view.setCamera({ position: [4, 4, 4], target: [1, 2, 3] });
    expect(ctx.view.addMeasurement([0, 0, 0], [1, 0, 0])).toMatchObject({ id: 7 });
    ctx.view.removeMeasurement(7);
    scope.dispose();
  });

  it("rejects undeclared commands and runtime contributions", () => {
    const old = legacy();
    const scope = new ExtensionScope("sample", new ExtensionContributionRegistry());
    const definition = manifest(["view.overlay"]);
    scope.registerManifest(definition.contributes);
    const ctx = createExtensionContextV2(definition, old.value, scope, { registerCommand: vi.fn() });
    expect(() => ctx.commands.run("other.run")).toThrow(/did not declare command/);
    expect(() => ctx.contributions.register("overlays", { id: "other.overlay", title: "Other" })).toThrow(/did not declare/);
  });

  it("namespaces and caps extension storage", () => {
    const old = legacy();
    const scope = new ExtensionScope("sample", new ExtensionContributionRegistry());
    const definition = manifest(["storage.extension"]);
    scope.registerManifest(definition.contributes);
    const ctx = createExtensionContextV2(definition, old.value, scope);
    ctx.storage.write("choice", { unit: "mm" });
    expect(ctx.storage.read("choice", null)).toEqual({ unit: "mm" });
    expect(localStorage.getItem("ifcviewx.plug.sample.choice")).toBe('{"unit":"mm"}');
    expect(() => ctx.storage.write("large", "x".repeat(65 * 1024))).toThrow(/64 KB/);
    localStorage.removeItem("ifcviewx.plug.sample.choice");
    scope.dispose();
  });

  it("binds local invocation to the declared companion", async () => {
    const old = legacy();
    const definition = manifest(["local.invoke"]);
    definition.localCompanion = { id: "org.example.native", version: "^1.2", required: true };
    const invokeLocal = vi.fn(async () => ({ rows: 3 }));
    (old.value as unknown as { service: PluginContext["service"] }).service = {
      matchCompanion: vi.fn(() => ({
        status: "available",
        provider: {
          id: "org.example.native",
          version: "1.4.0",
          capabilities: [{ id: "geometry.exact", available: true }],
        },
      })),
      invokeLocal,
    } as unknown as PluginContext["service"];
    const scope = new ExtensionScope("sample", new ExtensionContributionRegistry());
    scope.registerManifest(definition.contributes);
    const ctx = createExtensionContextV2(definition, old.value, scope);

    expect(ctx.local.status()).toMatchObject({ state: "available", installedVersion: "1.4.0" });
    expect(ctx.local.capabilities()).toEqual(["geometry.exact"]);
    await expect(ctx.local.invoke("geometry.exact", { tolerance: 2 })).resolves.toEqual({ rows: 3 });
    expect(invokeLocal).toHaveBeenCalledWith(
      "org.example.native",
      "^1.2",
      "geometry.exact",
      { tolerance: 2 },
      expect.any(AbortSignal),
    );
    scope.dispose();
  });
});
