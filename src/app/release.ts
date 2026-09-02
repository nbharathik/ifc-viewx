// v0.1.4 release inventory. Bundled plugins only enter the catalog after
// their manifest, import boundary, panel mount and focused workflow tests pass.
// Unknown ids are installed extensions and remain governed by their own
// package validation and enabled state.
export const BUNDLED_PLUGIN_IDS = new Set([
  "clash",
  "compare",
  "explorer",
  "finder",
  "ids-studio",
  "model-health",
  "point-cloud",
  "presentation",
  "python",
  "report-builder",
  "rule-studio",
  "schedule-4d",
  "section-workspace",
  "sheets",
  "smart-measure",
  "spaces",
  "storeys",
  "takeoff",
]);

export const VERIFIED_BUNDLED_PLUGIN_IDS = new Set(BUNDLED_PLUGIN_IDS);

const ADVANCED_COMMAND_IDS = new Set([
  "analysis.clash",
  "analysis.compare",
  "analysis.geo",
  "analysis.health",
  "analysis.ids-studio",
  "analysis.point-cloud",
  "analysis.presentation",
  "analysis.report-builder",
  "analysis.rules",
  "analysis.schedule-4d",
  "analysis.section-workspace",
  "analysis.smart-measure",
  "panel.geo",
  "panel.schedule-4d",
  "sheets.open",
]);

// Geo Context is a core panel rather than a plugin and stays outside this
// plugin audit. Every command below is an entry point for a verified plugin.
const VERIFIED_ADVANCED_COMMAND_IDS = new Set([
  "analysis.clash",
  "analysis.compare",
  "analysis.health",
  "analysis.ids-studio",
  "analysis.point-cloud",
  "analysis.presentation",
  "analysis.report-builder",
  "analysis.rules",
  "analysis.schedule-4d",
  "analysis.section-workspace",
  "analysis.smart-measure",
  "panel.schedule-4d",
  "sheets.open",
]);

const ADVANCED_ASSISTANT_CAPABILITIES = new Set([
  "clash",
  "definition.ruleset",
  "distance",
  "laser",
  "sectionContours",
]);

const VERIFIED_ASSISTANT_CAPABILITIES = new Set(ADVANCED_ASSISTANT_CAPABILITIES);

export const releaseUi = {
  advancedWorkflows: true,
  geoContext: false,
};

export const isReleasePluginVisible = (id: string): boolean =>
  !BUNDLED_PLUGIN_IDS.has(id) || VERIFIED_BUNDLED_PLUGIN_IDS.has(id);

export const isReleaseCommandVisible = (id: string): boolean =>
  !ADVANCED_COMMAND_IDS.has(id) || VERIFIED_ADVANCED_COMMAND_IDS.has(id);

export const isReleaseAssistantCapabilityVisible = (id: string): boolean =>
  !ADVANCED_ASSISTANT_CAPABILITIES.has(id) || VERIFIED_ASSISTANT_CAPABILITIES.has(id);
