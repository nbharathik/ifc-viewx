// @vitest-environment node

import { JSDOM } from "jsdom";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";
import { InstalledExtensionManager } from "../src/extensions/installed/manager.js";
import { prepareExtensionPackage } from "../src/extensions/installed/package.js";
import { MemoryExtensionStore } from "../src/extensions/installed/store.js";
import type { ExtensionManifest, ExtensionPermission } from "../src/sdk/contributions.js";

beforeAll(() => vi.stubGlobal("DOMParser", new JSDOM("").window.DOMParser));

function manifest(
  version = "1.0.0",
  permissions: ExtensionPermission[] = ["model.structure.read"],
): ExtensionManifest {
  return {
    manifestVersion: 2,
    id: "org.example.sandbox",
    name: "Sandbox Example",
    version,
    sdk: ">=2.0.0 <3",
    description: "A package fixture.",
    publisher: { name: "Example" },
    runtime: { kind: "sandboxed", entry: "panel.html" },
    activationEvents: ["onPanel:main"],
    permissions,
    contributes: { panels: [{ id: "main", title: "Example" }] },
    catalog: {
      tagline: "Sandbox fixture",
      about: "Exercises installed extension packages.",
      icon: "shield",
      category: "Tests",
      keywords: "sandbox",
      does: ["Runs in an isolated frame"],
    },
  };
}

function archive(value: ExtensionManifest, html = "<!doctype html><html><head></head><body><script>IFCViewX.ready()</script></body></html>"): Uint8Array {
  const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
  return zipSync({
    "extension.json": encode(JSON.stringify(value)),
    "panel.html": encode(html),
  });
}

describe("installed extension package", () => {
  it("validates, hashes and unpacks a self-contained sandbox package", async () => {
    const prepared = await prepareExtensionPackage(archive(manifest()));
    expect(prepared.manifest.runtime.kind).toBe("sandboxed");
    expect(prepared.hash).toMatch(/^[a-f0-9]{64}$/);
    expect(prepared.files.has("panel.html")).toBe(true);
  });

  it("rejects unsafe paths before unpacking", async () => {
    const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
    const bytes = zipSync({
      "extension.json": encode(JSON.stringify(manifest())),
      "panel.html": encode("<html></html>"),
      "../escape.txt": encode("hostile"),
    });
    await expect(prepareExtensionPackage(bytes)).rejects.toMatchObject({ code: "path" });
  });

  it("rejects a forged central-directory entry count before unpacking", async () => {
    const bytes = archive(manifest());
    bytes[bytes.length - 14] = 1;
    bytes[bytes.length - 13] = 0;
    bytes[bytes.length - 12] = 1;
    bytes[bytes.length - 11] = 0;
    await expect(prepareExtensionPackage(bytes)).rejects.toMatchObject({ code: "zip" });
  });

  it("rejects network assets and installed-only forbidden permissions", async () => {
    await expect(prepareExtensionPackage(archive(
      manifest(),
      "<html><head><script src='https://example.com/code.js'></script></head></html>",
    ))).rejects.toMatchObject({ code: "external-asset" });
    const raw = manifest("1.0.0", ["geometry.mesh.read"]);
    await expect(prepareExtensionPackage(archive(raw))).rejects.toThrow(/cannot read raw geometry/);
  });

  it("rejects packages that omit the panel activation contract", async () => {
    const value = manifest();
    value.activationEvents = ["onModel"];
    await expect(prepareExtensionPackage(archive(value))).rejects.toMatchObject({ code: "activation" });
  });
});

describe("installed extension manager", () => {
  it("installs atomically, retains one rollback and restores it", async () => {
    const store = new MemoryExtensionStore();
    const manager = new InstalledExtensionManager(store);
    const first = await manager.prepare(archive(manifest("1.0.0")));
    await manager.install(first);
    const update = await manager.prepare(archive(manifest("1.1.0", ["model.structure.read", "view.control"])));
    expect(update.kind).toBe("update");
    expect(update.addedPermissions).toEqual(["view.control"]);
    await manager.install(update);
    expect(manager.get("org.example.sandbox")?.versions).toHaveLength(2);
    expect(manager.current("org.example.sandbox")?.version).toBe("1.1.0");
    await manager.rollback("org.example.sandbox");
    expect(manager.current("org.example.sandbox")?.version).toBe("1.0.0");
  });

  it("does not read or execute package bytes while disabled", async () => {
    const store = new MemoryExtensionStore();
    const read = vi.spyOn(store, "readPackage");
    const manager = new InstalledExtensionManager(store);
    await manager.install(await manager.prepare(archive(manifest())));
    await manager.setEnabled("org.example.sandbox", false);
    await expect(manager.loadModule("org.example.sandbox")).rejects.toThrow(/disabled/);
    expect(read).not.toHaveBeenCalled();
  });

  it("keeps the live state unchanged when persistence fails", async () => {
    const store = new MemoryExtensionStore();
    const manager = new InstalledExtensionManager(store);
    await manager.install(await manager.prepare(archive(manifest())));
    vi.spyOn(store, "writeState").mockRejectedValueOnce(new Error("disk full"));
    await expect(manager.setEnabled("org.example.sandbox", false)).rejects.toThrow(/disk full/);
    expect(manager.get("org.example.sandbox")?.enabled).toBe(true);
  });

  it("keeps persisted records inert when their id becomes bundled", async () => {
    const store = new MemoryExtensionStore();
    const first = new InstalledExtensionManager(store);
    await first.install(await first.prepare(archive(manifest())));
    const manager = new InstalledExtensionManager(store);
    manager.reserve(["org.example.sandbox"]);
    await manager.initialize();
    expect(manager.get("org.example.sandbox")).toBeNull();
    expect(manager.audit.list("org.example.sandbox").at(-1)?.outcome).toBe("failed");
  });

  it("removes package state on uninstall and blocks bundled id collisions", async () => {
    const manager = new InstalledExtensionManager(new MemoryExtensionStore());
    manager.reserve(["org.example.sandbox"]);
    await expect(manager.prepare(archive(manifest()))).rejects.toThrow(/conflicts/);
    manager.reserve([]);
    await manager.install(await manager.prepare(archive(manifest())));
    await manager.uninstall("org.example.sandbox");
    expect(manager.get("org.example.sandbox")).toBeNull();
  });
});
