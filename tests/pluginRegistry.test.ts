import { describe, expect, it } from "vitest";
import { satisfiesVersionRange } from "../src/bridge/serviceClient.js";
import { CATALOG, findPlugin } from "../src/plugins/registry.js";

describe("extension registry", () => {
  it("discovers every bundled tool through the current extension manifest", () => {
    const ids = [
      "clash", "compare", "explorer", "finder", "ids-studio", "model-health", "python",
      "schedule-4d", "section-workspace", "smart-measure", "spaces", "storeys", "takeoff",
    ];
    expect(CATALOG.filter((plugin) => plugin.extension).map((plugin) => plugin.id).sort()).toEqual(ids);
    for (const id of ids) {
      expect(findPlugin(id)?.extension).toMatchObject({ manifestVersion: 2, id });
    }
  });

  it("keeps bundled core companions compatible with this Local Studio release line", () => {
    const companions = CATALOG
      .flatMap((plugin) => plugin.extension?.localCompanion ?? [])
      .filter((companion) => companion.id === "org.ifcviewx.core");
    expect(companions.length).toBeGreaterThan(0);
    for (const companion of companions) {
      expect(satisfiesVersionRange(__APP_VERSION__, companion.version), companion.version).toBe(true);
    }
  });
});
