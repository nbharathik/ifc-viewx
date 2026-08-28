const ADVANCED_WORKFLOWS_VISIBLE = false;

export const ADVANCED_PLUGIN_IDS = new Set([
  "clash",
  "compare",
  "finder",
  "ids-studio",
  "model-health",
  "point-cloud",
  "presentation",
  "report-builder",
  "rule-studio",
  "schedule-4d",
  "section-workspace",
  "sheets",
  "smart-measure",
]);

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

const ADVANCED_ASSISTANT_CAPABILITIES = new Set([
  "clash",
  "definition.ruleset",
  "distance",
  "laser",
  "sectionContours",
]);

export const releaseUi = {
  advancedWorkflows: ADVANCED_WORKFLOWS_VISIBLE,
  geoContext: ADVANCED_WORKFLOWS_VISIBLE,
};

export const isReleasePluginVisible = (id: string): boolean =>
  ADVANCED_WORKFLOWS_VISIBLE || !ADVANCED_PLUGIN_IDS.has(id);

export const isReleaseCommandVisible = (id: string): boolean =>
  ADVANCED_WORKFLOWS_VISIBLE || !ADVANCED_COMMAND_IDS.has(id);

export const isReleaseAssistantCapabilityVisible = (id: string): boolean =>
  ADVANCED_WORKFLOWS_VISIBLE || !ADVANCED_ASSISTANT_CAPABILITIES.has(id);
