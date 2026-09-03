import { describe, expect, it } from "vitest";
import { satisfiesVersionRange } from "../src/bridge/serviceClient.js";
import { CATALOG, findPlugin } from "../src/plugins/registry.js";
import {
  BUNDLED_PLUGIN_IDS,
  VERIFIED_BUNDLED_PLUGIN_IDS,
  isReleaseAssistantCapabilityVisible,
  isReleaseCommandVisible,
  isReleasePluginVisible,
  releaseUi,
} from "../src/app/release.js";
import compareManifest from "../src/plugins/compare/extension.json";
import smartMeasureManifest from "../src/plugins/smart-measure/extension.json";

describe("extension registry", () => {
  it("publishes the complete verified v0.1.4 plugin inventory", () => {
    const ids = [
      "clash", "compare", "explorer", "finder", "ids-studio", "model-health", "point-cloud",
      "presentation", "python", "report-builder", "rule-studio", "schedule-4d",
      "section-workspace", "sheets", "smart-measure", "spaces", "storeys", "takeoff",
    ];
    expect(CATALOG.filter((plugin) => plugin.extension).map((plugin) => plugin.id).sort()).toEqual(ids);
    expect([...BUNDLED_PLUGIN_IDS].sort()).toEqual(ids);
    expect([...VERIFIED_BUNDLED_PLUGIN_IDS].sort()).toEqual(ids);
    for (const id of ids) {
      expect(isReleasePluginVisible(id), id).toBe(true);
      expect(findPlugin(id)?.extension).toMatchObject({ manifestVersion: 2, id });
    }
    expect(releaseUi.advancedWorkflows).toBe(true);
    expect(releaseUi.geoContext).toBe(false);
    for (const id of [
      "analysis.clash", "analysis.compare", "analysis.health",
      "analysis.ids-studio", "analysis.point-cloud", "analysis.presentation",
      "analysis.report-builder", "analysis.rules", "analysis.schedule-4d",
      "analysis.section-workspace", "analysis.smart-measure",
      "panel.schedule-4d", "sheets.open",
    ]) expect(isReleaseCommandVisible(id), id).toBe(true);
    for (const id of ["analysis.geo", "panel.geo"]) {
      expect(isReleaseCommandVisible(id), id).toBe(false);
    }
    for (const id of ["clash", "definition.ruleset", "distance", "laser", "sectionContours"]) {
      expect(isReleaseAssistantCapabilityVisible(id), id).toBe(true);
    }
  });

  it("keeps bundled core companions compatible with this Local Studio release line", () => {
    const companions = [compareManifest, smartMeasureManifest]
      .flatMap((manifest) => manifest.localCompanion ?? [])
      .filter((companion) => companion.id === "org.ifcviewx.core");
    expect(companions.length).toBeGreaterThan(0);
    for (const companion of companions) {
      expect(satisfiesVersionRange(__APP_VERSION__, companion.version), companion.version).toBe(true);
    }
  });
});
