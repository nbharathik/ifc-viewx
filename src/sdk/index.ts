// The whole plugin surface, in one import.
//
//   import { definePlugin, page, bar, grid } from "@ifcviewx/sdk";
//
// A plugin that imports only from here keeps working across app releases.
// Anything reached around it is internal and may move without notice.
export { definePlugin } from "./define.js";
export * from "./v2/index.js";
export * from "./ui.js";
export * from "./data.js";
export * from "./parse.js";

// Model analysis the app also uses, published here so a plugin runs the same
// code rather than a second copy of it. Clash detection is triangle-level and
// runs in a worker; a panel only has to hand it two sets of element ids.
export {
  cancelClash,
  clashClassPair,
  clashFingerprint,
  clashReport,
  detectClashes,
  groupClashes,
  idsOfTypes,
  resolvedClashes,
  reviewClashes,
  worstDepth,
  CLASH_LIMIT,
  DEFAULT_TOLERANCE_MM,
  MEP,
  OPENINGS,
  STRUCTURE,
} from "../ifc/clash.js";
export type {
  ClashKind,
  ClashOptions,
  ClashPair,
  ClashCurrentState,
  ClashDecision,
  ClashElementIdentity,
  ClashGroupMode,
  ClashIgnoreRule,
  ClashReviewGroup,
  ClashReviewRow,
  ClashReviewState,
  SweepProgress,
  SweepResult,
} from "../ifc/clash.js";
export { measureDistance } from "../geometry/distance.js";
export type { DistanceOptions, DistanceResult } from "../geometry/distance.js";
export { measureLaser } from "../geometry/laser.js";
export type { LaserOptions, LaserResult, LaserAxis, LaserAxisResult, LaserHit } from "../geometry/laser.js";
export { extractSectionContours } from "../geometry/section.js";
export type {
  SectionAxis, SectionContourOptions, SectionContourResult, SectionPolyline,
} from "../geometry/section.js";
export { geometrySignatures } from "../geometry/signatures.js";
export type { GeometrySignature, GeometrySignatureOptions, GeometrySignatureResult } from "../geometry/signatures.js";
export { compareSnapshots } from "../compare/modelCompare.js";
export type {
  CompareEntry, CompareKind, CompareResult, CompareSnapshot, GeometryDelta, PropertyChange,
} from "../compare/modelCompare.js";

// The ranked search the assistant uses, so a panel searches the same way.
export { buildIndex, tokenize } from "../llm/retrieval.js";

// Element identity across federated models. A plugin that groups by discipline
// unpacks ids with these rather than assuming one file.
export { byModel, expressOf, modelOf, packId } from "../viewer-core/ids.js";
export type { Bm25Index, SearchHit, TextSource } from "../llm/retrieval.js";

// What `ctx.publishFindings` takes, so a panel's results land in the report.
export type { ReportFinding } from "../ui/report.js";

export type {
  ModelElement,
  ModelInfo,
  PluginContext,
  PluginCapabilities,
  PluginCapabilitySummary,
  PluginEvent,
  PluginInstance,
  PluginManifest,
  PluginModule,
  PluginMount,
  PluginPython,
  PluginTier,
} from "./types.js";

// Viewer types a panel needs to talk about what it found. The viewer itself is
// on the context as an escape hatch; these describe what comes back from it.
export type {
  CameraPose,
  IfcProperty,
  IfcPropertySet,
  ItemProperties,
  Measurement,
  FederatedModel,
  ModelBounds,
  ModelStats,
  SectionBox,
  SectionState,
  SpatialNode,
  Vec3,
  Viewer,
  ViewPreset,
  VisibilityRule,
} from "../viewer-core/viewer.js";
export { formatLength } from "../viewer-core/viewer.js";
export type { ServiceClient } from "../bridge/serviceClient.js";
