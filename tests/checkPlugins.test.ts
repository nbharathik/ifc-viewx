// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  hasNonLiteralDynamicImport,
  importedPluginId,
  moduleSpecifiers,
  pluginImportProblem,
} from "../scripts/plugin-imports.mjs";

const ROOT = "src/plugins/example";
const PANEL = "src/plugins/example/panel.ts";

describe("plugin import boundary check", () => {
  it("finds static, side-effect, re-export and dynamic module references", () => {
    const source = [
      '/// <reference path="./ambient.d.ts" />',
      'import type { ExtensionContext } from "@ifcviewx/sdk";',
      'import "./setup.js";',
      'export { helper } from "./helper.js";',
      'const lazy = import("./lazy.js");',
      'const data = import("./data.json", { with: { type: "json" } });',
      'type Result = import("./types.js").Result;',
    ].join("\n");
    expect(moduleSpecifiers(source)).toEqual([
      "./ambient.d.ts", "@ifcviewx/sdk", "./setup.js", "./helper.js", "./lazy.js", "./data.json", "./types.js",
    ]);
  });

  it("allows only the public SDK and paths contained by the plugin folder", () => {
    expect(pluginImportProblem(ROOT, PANEL, "@ifcviewx/sdk")).toBeNull();
    expect(pluginImportProblem(ROOT, PANEL, "./helper.js")).toBeNull();
    for (const specifier of ["three", "/src/ui/kit.js", "../registry.js", "./../registry.js"]) {
      expect(pluginImportProblem(ROOT, PANEL, specifier), specifier).toMatch(/plugins may only import/);
    }
  });

  it("rejects computed dynamic imports that cannot be bounded statically", () => {
    expect(hasNonLiteralDynamicImport("const panel = import(`./${name}.js`)")).toBe(true);
    expect(hasNonLiteralDynamicImport('const panel = import("./panel.js")')).toBe(false);
    expect(hasNonLiteralDynamicImport('const data = import("./data.json", { with: { type: "json" } })')).toBe(false);
  });

  it("normalizes core imports before identifying plugin folders", () => {
    expect(importedPluginId("../plugins/clash/panel.js")).toBe("clash");
    expect(importedPluginId("../plugins//clash/runtime.js")).toBe("clash");
    expect(importedPluginId("../plugins/runtime/context.js")).toBe("runtime");
    expect(importedPluginId("../plugins/registry.js")).toBeNull();
    expect(importedPluginId("third-party/plugins/clash")).toBeNull();
    expect(importedPluginId("../geometry/distance.js")).toBeNull();
  });
});
