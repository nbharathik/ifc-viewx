import { describe, expect, it, vi } from "vitest";
import { ExtensionContributionRegistry, ExtensionScope } from "../src/extensions/contributions.js";
import { CommandRegistry } from "../src/ui/commands.js";

describe("extension contribution lifetime", () => {
  it("removes manifest entries, runtime resources and jobs as one owner scope", () => {
    const registry = new ExtensionContributionRegistry();
    const scope = new ExtensionScope("sample", registry);
    scope.registerManifest({
      commands: [{ id: "sample.run", title: "Run" }],
      overlays: [{ id: "sample.overlay", title: "Overlay" }],
      analyses: [{ id: "sample.analysis", title: "Analysis", capability: "counts" }],
      resultViews: [{ id: "sample.results", title: "Results" }],
    });
    const commandCleanup = vi.fn();
    const overlayCleanup = vi.fn();
    const jobAbort = vi.fn();
    scope.bind("commands", "sample.run", commandCleanup);
    scope.bind("overlays", "sample.overlay", overlayCleanup);
    scope.signal.addEventListener("abort", jobAbort);

    expect(registry.count("sample")).toBe(4);
    expect(registry.list("resultViews")[0].contribution.id).toBe("sample.results");
    scope.dispose();

    expect(scope.signal.aborted).toBe(true);
    expect(jobAbort).toHaveBeenCalledOnce();
    expect(commandCleanup).toHaveBeenCalledOnce();
    expect(overlayCleanup).toHaveBeenCalledOnce();
    expect(registry.count("sample")).toBe(0);
    scope.dispose();
    expect(commandCleanup).toHaveBeenCalledOnce();
  });

  it("supports early runtime cleanup without dropping the declaration", () => {
    const registry = new ExtensionContributionRegistry();
    const scope = new ExtensionScope("sample", registry);
    scope.registerManifest({ overlays: [{ id: "sample.overlay", title: "Overlay" }] });
    const cleanup = vi.fn();
    const removeRuntime = scope.bind("overlays", "sample.overlay", cleanup);
    removeRuntime();
    removeRuntime();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.count("sample")).toBe(1);
    scope.dispose();
    expect(cleanup).toHaveBeenCalledOnce();
    expect(registry.count("sample")).toBe(0);
  });

  it("rejects duplicate declarations", () => {
    const registry = new ExtensionContributionRegistry();
    const scope = new ExtensionScope("sample", registry);
    scope.register("panels", { id: "sample.panel", title: "Panel" });
    expect(() => scope.register("panels", { id: "sample.panel", title: "Again" })).toThrow(/already registered/);
  });
});

describe("extension commands", () => {
  it("removes the command and keyboard binding on unload", () => {
    const registry = new CommandRegistry();
    const run = vi.fn();
    const remove = registry.register({
      id: "sample.run",
      label: "Run",
      section: "Extensions",
      shortcut: "Ctrl+Shift+K",
      run,
    });
    expect(registry.run("sample.run")).toBe(true);
    expect(run).toHaveBeenCalledOnce();
    remove();
    expect(registry.get("sample.run")).toBeUndefined();
    expect(registry.run("sample.run")).toBe(false);
  });
});
