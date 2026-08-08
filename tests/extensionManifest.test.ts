import { describe, expect, it } from "vitest";
import { assertManifestV2, validateManifestV2 } from "../src/extensions/manifest.js";
import type { ExtensionManifestV2 } from "../src/sdk/v2/contributions.js";

function manifest(): ExtensionManifestV2 {
  return {
    manifestVersion: 2,
    id: "sample.extension",
    name: "Sample Extension",
    version: "1.2.0",
    sdk: ">=2.0.0 <3",
    description: "Exercises the extension manifest.",
    runtime: { kind: "bundled", entry: "panel.ts" },
    activationEvents: ["onPanel:sample.panel", "onCommand:sample.run"],
    permissions: ["model.structure.read", "view.control", "view.overlay"],
    contributes: {
      panels: [{ id: "sample.panel", title: "Sample" }],
      commands: [{ id: "sample.run", title: "Run sample" }],
      toolbarItems: [{ id: "sample.toolbar", command: "sample.run" }],
      resultViews: [{ id: "sample.results", title: "Results" }],
      analyses: [{ id: "sample.analysis", title: "Analyze", capability: "counts", resultView: "sample.results" }],
      overlays: [{ id: "sample.overlay", title: "Markers" }],
    },
    catalog: {
      tagline: "A sample extension",
      about: "Used to verify the SDK v2 manifest contract.",
      icon: "blocks",
      category: "Tests",
      keywords: "sample test",
      does: ["Validates manifests"],
    },
  };
}

describe("extension manifest v2", () => {
  it("accepts a compatible, linked, permission-complete manifest", () => {
    const result = validateManifestV2(manifest());
    expect(result.valid).toBe(true);
    expect(result.manifest?.id).toBe("sample.extension");
  });

  it("reports SDK, path, permission and reference errors before activation", () => {
    const value = manifest() as unknown as Record<string, unknown>;
    value.sdk = ">=3.0.0";
    value.runtime = { kind: "bundled", entry: "../panel.ts" };
    value.permissions = ["model.structure.read", "unknown.permission"];
    value.activationEvents = ["onCommand:missing.command"];
    value.contributes = {
      commands: [{ id: "run", title: "Run" }],
      toolbarItems: [{ id: "toolbar", command: "missing.command" }],
      exporters: [{ id: "sample.csv", title: "CSV", mimeTypes: ["text/csv"] }],
    };

    const result = validateManifestV2(value);
    expect(result.valid).toBe(false);
    expect(result.issues.map((issue) => issue.code)).toEqual(expect.arrayContaining([
      "compatibility", "path", "unknown", "namespace", "reference", "permission",
    ]));
    expect(() => assertManifestV2(value)).toThrow(/sample\.extension manifest is invalid/);
    expect(() => assertManifestV2(value)).toThrow(/host SDK 2\.0\.0/);
  });

  it("rejects duplicate contribution ids and unsupported activation events", () => {
    const value = manifest();
    value.contributes.panels = [
      { id: "sample.panel", title: "One" },
      { id: "sample.panel", title: "Two" },
    ];
    value.activationEvents = ["whenever:sample.panel"];
    const result = validateManifestV2(value);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "duplicate" }),
      expect.objectContaining({ code: "format" }),
    ]));
  });

  it("applies the stricter installed extension profile", () => {
    const value = manifest();
    value.id = "sample";
    value.publisher = { name: "Sample", url: "javascript:alert(1)" };
    value.runtime = { kind: "sandboxed", entry: "panel.html" };
    value.activationEvents = ["onStartup"];
    value.permissions.push("geometry.mesh.read");
    const result = validateManifestV2(value, { runtime: "sandboxed" });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.id", code: "format" }),
      expect.objectContaining({ path: "manifest.publisher.url", code: "format" }),
      expect.objectContaining({ path: "manifest.activationEvents", code: "forbidden" }),
      expect.objectContaining({ path: "manifest.permissions", code: "forbidden" }),
    ]));
  });

  it("requires a valid companion range for local invocation", () => {
    const value = manifest();
    value.permissions.push("local.invoke");
    value.localCompanion = { id: "org.example.native", version: "latest", required: true };
    const result = validateManifestV2(value);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "manifest.localCompanion.version", code: "format" }),
    ]));
  });
});
