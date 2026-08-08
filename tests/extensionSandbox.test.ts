import { describe, expect, it, vi } from "vitest";
import { ExtensionContributionRegistry, ExtensionScope } from "../src/extensions/contributions.js";
import { createExtensionContextV2 } from "../src/extensions/context.js";
import { ExtensionAuditLog } from "../src/extensions/installed/audit.js";
import {
  SANDBOX_MESSAGE_BYTES,
  SandboxRuntime,
  sandboxDocument,
} from "../src/extensions/installed/sandbox.js";
import type { ExtensionManifestV2 } from "../src/sdk/v2/contributions.js";
import type { PluginContext } from "../src/sdk/types.js";

function manifest(): ExtensionManifestV2 {
  return {
    manifestVersion: 2,
    id: "org.example.hostile",
    name: "Hostile Fixture",
    version: "1.0.0",
    sdk: ">=2.0.0 <3",
    description: "Tests the sandbox boundary.",
    publisher: { name: "Tests" },
    runtime: { kind: "sandboxed", entry: "panel.html" },
    activationEvents: ["onPanel:main"],
    permissions: ["view.read"],
    contributes: { panels: [{ id: "main", title: "Hostile" }] },
    catalog: {
      tagline: "Hostile fixture",
      about: "Attempts forbidden calls.",
      icon: "shield",
      category: "Tests",
      keywords: "hostile",
      does: ["Tests isolation"],
    },
  };
}

function context() {
  const isolate = vi.fn();
  const off = vi.fn();
  const legacy = {
    capabilities: { list: () => [], execute: vi.fn() },
    on: vi.fn(() => off),
    selection: vi.fn(() => []),
    sections: vi.fn(() => []),
    isolate,
  } as unknown as PluginContext;
  const definition = manifest();
  const scope = new ExtensionScope(definition.id, new ExtensionContributionRegistry());
  scope.registerManifest(definition.contributes);
  return { definition, scope, isolate, value: createExtensionContextV2(definition, legacy, scope) };
}

describe("installed extension sandbox", () => {
  it("injects a no-network CSP and keeps the iframe origin isolated", () => {
    const documentText = sandboxDocument("<html><head></head><body><script>window.test = true</script></body></html>", "nonce-1");
    expect(documentText).toContain("connect-src 'none'");
    expect(documentText).toContain("sandbox allow-scripts");
    expect(documentText).toContain("nonce-1");
    expect(documentText).not.toContain("allow-same-origin");
    expect(documentText).toContain("geometry.laser");
    expect(documentText).toContain("view.addMeasurement");
  });

  it("cannot isolate through direct RPC without view.control", async () => {
    const state = context();
    const host = document.createElement("div");
    const runtime = new SandboxRuntime(host, "<html><head></head><body></body></html>", state.definition, state.value, {
      audit: new ExtensionAuditLog(),
      onCrash: vi.fn(),
    });
    expect(() => runtime.dispatch("view.isolate", { ids: [1] }, new AbortController().signal)).toThrow(/view\.control/);
    expect(() => runtime.dispatch("service.token", {}, new AbortController().signal)).toThrow(/Unknown extension method/);
    expect(() => runtime.dispatch("local.status", {}, new AbortController().signal)).toThrow(/local\.invoke/);
    expect(() => runtime.dispatch("model.mesh", { id: 1 }, new AbortController().signal)).toThrow(/Unknown extension method/);
    await expect(runtime.dispatch("geometry.laser", { origin: [0, 0, 0] }, new AbortController().signal)).rejects.toThrow(/geometry\.query/);
    expect(state.isolate).not.toHaveBeenCalled();
    const frame = host.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin");
    expect(frame.getAttribute("csp")).toContain("connect-src 'none'");
    expect(frame.hasAttribute("credentialless")).toBe(true);
    expect(frame.getAttribute("allow")).toContain("camera 'none'");
    runtime.dispose();
    state.scope.dispose();
  });

  it("session-disables repeated malformed or oversized messages without touching the viewer", async () => {
    const state = context();
    const crash = vi.fn();
    const runtime = new SandboxRuntime(document.createElement("div"), "<html><head></head><body></body></html>", state.definition, state.value, {
      audit: new ExtensionAuditLog(),
      onCrash: crash,
    });
    const hostile = { protocol: 1, type: "request", id: "bad", method: "view.isolate", params: { padding: "x".repeat(SANDBOX_MESSAGE_BYTES) } };
    await runtime.receiveMessage(hostile);
    await runtime.receiveMessage(hostile);
    expect(crash).not.toHaveBeenCalled();
    await runtime.receiveMessage(hostile);
    expect(crash).toHaveBeenCalledOnce();
    expect(state.isolate).not.toHaveBeenCalled();
    state.scope.dispose();
  });

  it("rejects duplicate and replayed request ids", async () => {
    const state = context();
    const crash = vi.fn();
    const runtime = new SandboxRuntime(document.createElement("div"), "<html><head></head><body></body></html>", state.definition, state.value, {
      audit: new ExtensionAuditLog(),
      onCrash: crash,
    });
    const request = { protocol: 1, type: "request", id: "replayed", method: "view.selection", params: {} };
    await runtime.receiveMessage(request);
    await runtime.receiveMessage(request);
    await runtime.receiveMessage(request);
    expect(crash).not.toHaveBeenCalled();
    await runtime.receiveMessage(request);
    expect(crash).toHaveBeenCalledOnce();
    state.scope.dispose();
  });
});
