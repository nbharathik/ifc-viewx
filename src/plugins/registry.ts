// Every folder here that carries a manifest.ts is a plugin.
//
// There is no list to add yourself to and no core file to edit: dropping the
// folder in is the registration. The manifests are collected at build time and
// are small, so the catalog is complete from the first frame; the panels stay
// behind a dynamic import and only download when someone opens one.
import { SHORTCUTS } from "./shortcuts.js";
import type { PluginManifest, PluginModule } from "../sdk/types.js";
import type { ExtensionManifestV2 } from "../sdk/v2/contributions.js";
import type { ExtensionModuleV2 } from "../sdk/v2/types.js";
import { validateManifestV2 } from "../extensions/manifest.js";
import type { ServiceClient } from "../bridge/serviceClient.js";
import type { InstalledExtensionView } from "../extensions/installed/types.js";

const manifests = import.meta.glob<{ default: PluginManifest }>("./*/manifest.ts", { eager: true });
const extensionManifests = import.meta.glob<ExtensionManifestV2>("./*/extension.json", {
  eager: true,
  import: "default",
});
const panels = import.meta.glob<PluginModule | ExtensionModuleV2>("./*/panel.ts");

export interface CatalogPlugin extends Omit<PluginManifest, "load"> {
  manifestVersion: 1 | 2;
  extension?: ExtensionManifestV2;
  load?: () => Promise<PluginModule | ExtensionModuleV2>;
  installation?: InstalledExtensionView;
}

/** "./clash/manifest.ts" -> "clash" */
const folderOf = (path: string): string => path.slice(2, path.indexOf("/", 2));

function fromExtension(
  folder: string,
  raw: unknown,
  panel: (() => Promise<PluginModule | ExtensionModuleV2>) | undefined,
): CatalogPlugin | null {
  const validation = validateManifestV2(raw);
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
    console.error(`Extension ${folder} runtime.entry must be "panel.ts" in the bundled Phase 3 host.`);
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
    manifestVersion: 2,
    extension: manifest,
  };
}

function collect(): CatalogPlugin[] {
  const found: CatalogPlugin[] = [];
  const migrated = new Set<string>();
  for (const [path, raw] of Object.entries(extensionManifests)) {
    const folder = folderOf(path);
    migrated.add(folder);
    const extension = fromExtension(folder, raw, panels[`./${folder}/panel.ts`]);
    if (extension) found.push(extension);
  }
  for (const [path, module] of Object.entries(manifests)) {
    const folder = folderOf(path);
    if (migrated.has(folder)) {
      console.warn(`Plugin ${folder} has both extension.json and manifest.ts; extension.json wins.`);
      continue;
    }
    const manifest = module.default;
    if (!manifest?.id) {
      console.warn(`Plugin ${folder} has no default export from definePlugin; skipped.`);
      continue;
    }
    if (manifest.id !== folder) {
      console.warn(`Plugin ${folder} declares id "${manifest.id}"; the id must match the folder name.`);
    }
    const panel = panels[`./${folder}/panel.ts`];
    if (!panel && !manifest.load) {
      console.warn(`Plugin ${folder} has no panel.ts and no load(); it will not open.`);
    }
    found.push({ ...manifest, load: manifest.load ?? panel, manifestVersion: 1 });
  }
  return [
    ...found,
    ...SHORTCUTS.map((plugin) => ({ ...plugin, manifestVersion: 1 as const })),
  ].sort((a, b) => a.name.localeCompare(b.name));
}

/** Alphabetical inside each tier, which is the order the catalog shows them in. */
export const CATALOG: CatalogPlugin[] = collect();

export function setInstalledExtensions(
  records: InstalledExtensionView[],
  load: (id: string) => Promise<ExtensionModuleV2>,
): void {
  const bundled = CATALOG.filter((plugin) => !plugin.installation);
  const bundledIds = new Set(bundled.map((plugin) => plugin.id));
  const installed = records
    .filter((record) => !bundledIds.has(record.id))
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
        manifestVersion: 2,
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

/** A tool the app already carries; the catalog points at it rather than mounting it. */
export const isBuiltIn = (plugin: CatalogPlugin): boolean => plugin.tier === "core";

/** Local plugins only work in Local Studio, and only if it offers the capability. */
export const isLive = (plugin: CatalogPlugin, service: ServiceClient): boolean =>
  (!plugin.installation || (plugin.installation.enabled && !plugin.installation.sessionDisabled)) &&
  (!plugin.extension?.localCompanion?.required ||
    service.matchCompanion(
      plugin.extension.localCompanion.id,
      plugin.extension.localCompanion.version,
    ).status === "available") &&
  (plugin.tier !== "local" ||
    (service.mode() === "local" && (!plugin.capability || service.can(plugin.capability))));
