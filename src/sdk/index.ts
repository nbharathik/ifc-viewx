// The whole extension surface, in one import.
//
//   import { defineExtension, page, bar, grid } from "@ifcviewx/sdk";
//
// An extension that imports only from here keeps working across app releases.
// Anything reached around it is internal and may move without notice.
export { defineExtension } from "./define.js";
export * from "./contributions.js";
export * from "./types.js";
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
export { isAxisSection } from "../viewer-core/viewer.js";
// Mesh export. The three example exporters load on the first call, so a panel
// that offers glTF/STL/OBJ costs nothing until someone uses it.
export { exportMesh, saveMesh } from "../export/mesh.js";
export type { MeshExportOptions, MeshExportResult, MeshFormat } from "../export/mesh.js";
export { measureVolumes } from "../geometry/volumes.js";
export { measureSun } from "../geometry/sun.js";
export { measureDeviation } from "../geometry/deviation.js";
export type { DeviationOptions } from "../geometry/deviation.js";
export type { DeviationResult } from "../geometry/types.js";
export { centreOn, isLas, isText, readPointCloud, toScene, DEFAULT_POINT_LIMIT } from "../pointcloud/las.js";
export type { CloudPlacement, PointCloud } from "../pointcloud/las.js";
export type { SunOptions } from "../geometry/sun.js";
export type { SunResult, SunSample } from "../geometry/types.js";
export { dayArc, daylightHours, siteLocalInstant, sunDirection, sunPosition } from "../geo/solar.js";
export type { SunPosition } from "../geo/solar.js";
export type { VolumeOptions, VolumesResult, ElementVolume } from "../geometry/volumes.js";
export { classifyByPlane } from "../geometry/plane.js";
export type { PlaneClassifyOptions } from "../geometry/plane.js";
export type { PlaneClassifyResult } from "../geometry/types.js";
export type { Bm25Index, SearchHit, TextSource } from "../llm/retrieval.js";

// Rules beyond IDS: the geometric, topological and relational checks IDS
// cannot express. Importing the library registers the twelve shipped rules.
export {
  boxesOverlap,
  centreOf,
  defaultRuleset,
  findRule,
  parseRuleset,
  registerRule,
  resolveRule,
  ruleDefinitions,
  runRuleset,
  serializeRuleset,
  sizeOf,
  RULESET_FORMAT,
} from "../rules/engine.js";
export type {
  Box,
  ClashHit,
  ParamValue,
  ResolvedRule,
  RuleDefinition,
  RuleFinding,
  RuleInstance,
  RuleModel,
  RuleParam,
  RuleReport,
  RuleRunContext,
  RuleSeverity,
  Ruleset,
  StoreyInfo,
} from "../rules/engine.js";
export { RULE_COUNT } from "../rules/library.js";
export { contextRuleModel, storeyBands } from "../rules/contextModel.js";

// The drawing set. Rasterizing a PDF page and keeping the pages live in core,
// because pdf.js and IndexedDB are not things a plugin may reach for itself.
export {
  autoPlacement,
  isPdf,
  measureOnSheet,
  metresPerPixel,
  newSheet,
  placementDrift,
  placementScale,
  placementTransform,
  readImagePage,
  renderPdfPage,
  renderPdfPages,
  scaleLabel,
  sheetStore,
  sheetToWorld,
  worldToSheet,
  PAGE_RASTER_WIDTH,
} from "../sheets/sheet.js";
export type {
  RenderedPage,
  RenderPdfPagesOptions,
  RenderPdfPagesResult,
  SheetCalibration,
  SheetMarkup,
  SheetPlacement,
  SheetPoint,
  SheetRecord,
  StoredSheet,
} from "../sheets/sheet.js";

// Saved views: the definitions layer a plugin can read, apply and author.
export {
  applySavedView,
  applyView,
  captureView,
  describeSelector,
  isPortable,
  matchText,
  MAX_SELECTOR_STRING_LENGTH,
  MAX_VIEW_FILE_BYTES,
  MAX_VIEW_FILE_VIEWS,
  needsIndex,
  normalizeSelector,
  parseViewFile,
  readRowProperty,
  resolveSelector,
  selectorPortable,
  serializeViews,
  viewNeedsIndex,
  ViewStore,
} from "../views/definition.js";
export type {
  ApplyReport,
  SavedViewApplyOptions,
  Selector,
  TextOp,
  ViewDefinition,
  ViewFilter,
} from "../views/definition.js";

// Computed properties, so a panel reads derived values the same way the app does.
export {
  checkFormula,
  computedKey,
  ComputedSet,
  ComputedStore,
  evaluateProperty,
  geometryMeasure,
  parseComputedFile,
  serializeComputed,
  COMPUTED_SET,
} from "../data/computed.js";
export type { ComputedKind, ComputedProperty, ComputeContext } from "../data/computed.js";

// What `ctx.publishFindings` takes, so a panel's results land in the report.
export type { ReportFinding } from "../results/findings.js";

// Viewer data types used by the scoped SDK services.
export type {
  CameraPose,
  CoordinateOperationInfo,
  GeoreferencedPoint,
  IfcGeoReference,
  IfcProperty,
  IfcPropertySet,
  IfcClassification,
  IfcMaterial,
  IfcRelationTarget,
  IfcScheduleTime,
  IfcTaskGraph,
  IfcTaskRecord,
  IfcTaskSequenceRecord,
  IfcWorkScheduleRecord,
  ItemProperties,
  Measurement,
  FederatedModel,
  ModelBounds,
  ModelStats,
  ModelTransform,
  AxisSectionState,
  PlaneSectionState,
  ProjectedCrsInfo,
  SectionBox,
  SectionState,
  SpatialNode,
  TrueNorthInfo,
  Vec3,
  Viewer,
  ViewPreset,
  VisibilityRule,
} from "../viewer-core/viewer.js";
export { formatLength } from "../viewer-core/viewer.js";

// IDS Studio uses these through the same bounded SDK surface as every bundled
// extension. The inspector and assistant call the same validator functions.
export {
  BUILTIN_IDS_TEMPLATES,
  cloneFacet,
  newFacet,
  newIdsDocument,
  parseIdsDocument,
  serializeIdsDocument,
} from "../ids/document.js";
export type {
  IdsCardinality,
  IdsDraft,
  IdsFacetDraft,
  IdsFacetKind,
  IdsRequirementTemplate,
  IdsSpecificationDraft,
  IdsValueRule,
} from "../ids/document.js";
export { searchBsdd } from "../ids/bsdd.js";
export type { BsddHit, BsddKind } from "../ids/bsdd.js";
export { lastIdsReport, loadIds, runIds } from "../ui/ids.js";
export type { IdsReport, SpecResult } from "../ui/ids.js";
