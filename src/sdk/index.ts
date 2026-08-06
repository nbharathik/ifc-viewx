// The whole plugin surface, in one import.
//
//   import { definePlugin, page, bar, grid } from "@ifcviewx/sdk";
//
// A plugin that imports only from here keeps working across app releases.
// Anything reached around it is internal and may move without notice.
export { definePlugin } from "./define.js";
export * from "./ui.js";
export * from "./data.js";
export * from "./parse.js";

// Model analysis the app also uses, published here so a plugin runs the same
// code rather than a second copy of it.
export {
  boxesFor,
  clashReport,
  deepestHit,
  sweepBoxes,
  CLASH_LIMIT,
  MEP,
  OPENINGS,
  STRUCTURE,
} from "../ifc/clash.js";
export type { BoxSource, ClashBox, ClashHit, ClashSweep } from "../ifc/clash.js";
export type {
  ModelElement,
  ModelInfo,
  PluginContext,
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
  ModelBounds,
  ModelStats,
  SectionState,
  SpatialNode,
  Vec3,
  Viewer,
  ViewPreset,
  VisibilityRule,
} from "../viewer-core/viewer.js";
export type { ServiceClient } from "../bridge/serviceClient.js";
