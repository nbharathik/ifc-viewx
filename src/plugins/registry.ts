// Extension folders are discovered from extension.json at build time. Their
// panels stay behind dynamic imports and load only when opened.
import { SHORTCUTS } from "./shortcuts.js";
import type { ExtensionModule } from "../extensions/api.js";
import type { ExtensionManifest } from "../sdk/contributions.js";
import { validateManifest } from "../extensions/manifest.js";
import type { ServiceClient } from "../bridge/serviceClient.js";
import type { InstalledExtensionView } from "../extensions/installed/types.js";
import { isReleasePluginVisible } from "../app/release.js";

const extensionManifests = import.meta.glob<ExtensionManifest>("./*/extension.json", {
  eager: true,
  import: "default",
});
const panels = import.meta.glob<ExtensionModule>("./*/panel.ts");

export type CatalogTier = "web" | "local" | "core";

export interface CatalogPlugin {
  id: string;
  name: string;
  tagline: string;
  about: string;
  icon: string;
  category: string;
  tier: CatalogTier;
  keywords: string;
  does: string[];
  author?: string;
  url?: string;
  capability?: string;
  command?: string;
  soon?: boolean;
  extension?: ExtensionManifest;
  load?: () => Promise<ExtensionModule>;
  installation?: InstalledExtensionView;
}

const folderOf = (path: string): string => path.slice(2, path.indexOf("/", 2));

function fromExtension(
  folder: string,
  raw: unknown,
  panel: (() => Promise<ExtensionModule>) | undefined,
): CatalogPlugin | null {
  const validation = validateManifest(raw);
  if (!validation.manifest) {
    console.error(
      `Extension ${folder} has an invalid extension.json:\n${validation.issues.map((issue) => `  ${issue.path}: ${issue.message}`).join("\n")}`,
    );
    return null;
  }
  const manifest = validation.manifest;
  if (manifest.id !== folder) {
    console.error(`Extension ${folder} declares id "${manifest.id}"; the id must match the folder name.`);
    return null;
  }
  if (manifest.runtime.entry !== "panel.ts") {
    console.error(`Extension ${folder} runtime.entry must be "panel.ts" in the bundled host.`);
    return null;
  }
  if (!panel) {
    console.error(`Extension ${folder} has no panel.ts; it will not open.`);
    return null;
  }
  return {
    id: manifest.id,
    name: manifest.name,
    tagline: manifest.catalog.tagline,
    about: manifest.catalog.about,
    icon: manifest.catalog.icon,
    category: manifest.catalog.category,
    tier: "web",
    keywords: manifest.catalog.keywords,
    does: manifest.catalog.does,
    author: manifest.publisher?.name,
    url: manifest.publisher?.url,
    load: panel,
    extension: manifest,
  };
}

function collect(): CatalogPlugin[] {
  const found: CatalogPlugin[] = [];
  for (const [path, raw] of Object.entries(extensionManifests)) {
    const folder = folderOf(path);
    const extension = fromExtension(folder, raw, panels[`./${folder}/panel.ts`]);
    if (extension && isReleasePluginVisible(extension.id)) found.push(extension);
  }
  return [...found, ...SHORTCUTS].sort((a, b) => a.name.localeCompare(b.name));
}

export const CATALOG: CatalogPlugin[] = collect();

export function setInstalledExtensions(
  records: InstalledExtensionView[],
  load: (id: string) => Promise<ExtensionModule>,
): void {
  const bundled = CATALOG.filter((plugin) => !plugin.installation);
  const bundledIds = new Set(bundled.map((plugin) => plugin.id));
  const installed = records
    .filter((record) => isReleasePluginVisible(record.id) && !bundledIds.has(record.id))
    .map((record): CatalogPlugin => {
      const version = record.versions.find((entry) => entry.hash === record.activeHash);
      if (!version) throw new Error(`${record.id} has no active installed version`);
      const manifest = version.manifest;
      return {
        id: manifest.id,
        name: manifest.name,
        tagline: manifest.catalog.tagline,
        about: manifest.catalog.about,
        icon: manifest.catalog.icon,
        category: manifest.catalog.category,
        tier: "web",
        keywords: manifest.catalog.keywords,
        does: manifest.catalog.does,
        author: manifest.publisher?.name,
        url: manifest.publisher?.url,
        load: () => load(record.id),
        extension: manifest,
        installation: record,
      };
    });
  CATALOG.splice(0, CATALOG.length, ...bundled, ...installed);
  CATALOG.sort((a, b) => a.name.localeCompare(b.name));
}

export function findPlugin(id: string): CatalogPlugin | undefined {
  return CATALOG.find((plugin) => plugin.id === id);
}

export const isBuiltIn = (plugin: CatalogPlugin): boolean => plugin.tier === "core";

export const isLive = (plugin: CatalogPlugin, service: ServiceClient): boolean =>
  (!plugin.installation || (plugin.installation.enabled && !plugin.installation.sessionDisabled)) &&
  (!plugin.extension?.localCompanion?.required ||
    service.matchCompanion(
      plugin.extension.localCompanion.id,
      plugin.extension.localCompanion.version,
    ).status === "available") &&
  (plugin.tier !== "local" ||
    (service.mode() === "local" && (!plugin.capability || service.can(plugin.capability))));
