import type { JsonSchema } from "../../capabilities/types.js";

export type ExtensionPermission =
  | "model.summary.read"
  | "model.structure.read"
  | "model.properties.read"
  | "model.index.build"
  | "geometry.query"
  | "geometry.mesh.read"
  | "view.read"
  | "view.control"
  | "view.overlay"
  | "edit.propose"
  | "file.open"
  | "file.export"
  | "storage.extension"
  | "assistant.contribute"
  | "local.invoke"
  | "viewport.capture";

export interface PanelContribution {
  id: string;
  title: string;
  icon?: string;
}

export interface CommandContribution {
  id: string;
  title: string;
  icon?: string;
  shortcut?: string;
}

export interface ToolbarContribution {
  id: string;
  command: string;
  group?: string;
  order?: number;
}

export interface ContextActionContribution {
  id: string;
  title: string;
  command: string;
  when?: "selection" | "result" | "model-node";
}

export interface AnalysisContribution {
  id: string;
  title: string;
  capability: string;
  resultView?: string;
}

export interface AssistantToolContribution {
  id: string;
  capability: string;
}

export interface ResultViewContribution {
  id: string;
  title: string;
  schema?: JsonSchema;
}

export interface OverlayContribution {
  id: string;
  title: string;
  quota?: number;
}

export interface ImporterContribution {
  id: string;
  title: string;
  accepts: string[];
}

export interface ExporterContribution {
  id: string;
  title: string;
  mimeTypes: string[];
}

export interface SettingContribution {
  id: string;
  title: string;
  schema: JsonSchema;
  default?: unknown;
}

export interface ExtensionContributions {
  panels?: PanelContribution[];
  commands?: CommandContribution[];
  toolbarItems?: ToolbarContribution[];
  contextActions?: ContextActionContribution[];
  analyses?: AnalysisContribution[];
  assistantTools?: AssistantToolContribution[];
  resultViews?: ResultViewContribution[];
  overlays?: OverlayContribution[];
  importers?: ImporterContribution[];
  exporters?: ExporterContribution[];
  settings?: SettingContribution[];
}

export type ContributionKind = keyof ExtensionContributions;

export type ContributionFor<Kind extends ContributionKind> =
  NonNullable<ExtensionContributions[Kind]>[number];

export interface ExtensionCatalogMetadata {
  tagline: string;
  about: string;
  icon: string;
  category: string;
  keywords: string;
  does: string[];
}

export interface ExtensionManifestV2 {
  manifestVersion: 2;
  id: string;
  name: string;
  version: string;
  sdk: string;
  description: string;
  publisher?: { name: string; url?: string };
  runtime: {
    kind: "bundled" | "sandboxed";
    entry: string;
  };
  activationEvents: string[];
  permissions: ExtensionPermission[];
  contributes: ExtensionContributions;
  catalog: ExtensionCatalogMetadata;
  localCompanion?: {
    id: string;
    version: string;
    required?: boolean;
  };
  integrity?: {
    sha256?: string;
    signature?: string;
  };
}
