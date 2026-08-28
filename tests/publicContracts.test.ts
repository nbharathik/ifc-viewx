// @vitest-environment node
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { collectPublicContracts, contractJson } from "../scripts/public-contracts.mjs";

const contracts = collectPublicContracts();

describe("public contract freeze", () => {
  it("matches the reviewed public contract snapshot", async () => {
    const snapshot = await readFile(new URL("../docs/refactor/public-contracts.json", import.meta.url), "utf8");
    expect(contractJson(await contracts)).toBe(snapshot);
  });

  it("covers static and dynamically discovered entry points", async () => {
    const value = await contracts;
    expect(value.sdk.exports).toContain("defineExtension");
    expect(value.bundledPlugins).toHaveLength(18);
    expect(value.capabilities).toEqual(expect.arrayContaining([
      "find",
      "setProperty",
      "result.select",
      "result.isolate",
    ]));
    expect(value.capabilities).not.toEqual(expect.arrayContaining(["python query", "python edit", "tool"]));
    expect(value.dynamicEntries.importMetaGlobs).toEqual(expect.arrayContaining([
      { file: "src/plugins/registry.ts", pattern: "./*/extension.json" },
      { file: "src/plugins/registry.ts", pattern: "./*/panel.ts" },
    ]));
    expect(value.localStudio.routes).toEqual(expect.arrayContaining([
      { method: "GET", path: "/health" },
      { method: "WEBSOCKET", path: "/ws" },
    ]));
    expect(value.localStudio.cliEntries).toEqual({
      ifcviewx: "ifcviewx.cli:main",
      "ifcx-convert": "ifcviewx.convert:main",
    });
    expect(value.localStudio.mcpTools.length).toBeGreaterThan(20);
  });

  it("has a reviewed SDK declaration snapshot", async () => {
    const snapshot = JSON.parse(await readFile(
      new URL("../docs/refactor/sdk-type-contracts.json", import.meta.url),
      "utf8",
    )) as { digest: string; files: Array<{ path: string; sha256: string }> };
    expect(snapshot.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.files).toEqual(expect.arrayContaining([
      expect.objectContaining({
        path: "src/sdk/index.d.ts",
        sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    ]));
  });
});
