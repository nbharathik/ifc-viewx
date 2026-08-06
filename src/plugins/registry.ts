// Every folder here that carries a manifest.ts is a plugin.
//
// There is no list to add yourself to and no core file to edit: dropping the
// folder in is the registration. The manifests are collected at build time and
// are small, so the catalog is complete from the first frame; the panels stay
// behind a dynamic import and only download when someone opens one.
import { SHORTCUTS } from "./shortcuts.js";
import type { PluginManifest, PluginModule } from "../sdk/types.js";
import type { ServiceClient } from "../bridge/serviceClient.js";

const manifests = import.meta.glob<{ default: PluginManifest }>("./*/manifest.ts", { eager: true });
const panels = import.meta.glob<PluginModule>("./*/panel.ts");

/** "./clash/manifest.ts" -> "clash" */
const folderOf = (path: string): string => path.slice(2, path.indexOf("/", 2));

function collect(): PluginManifest[] {
  const found: PluginManifest[] = [];
  for (const [path, module] of Object.entries(manifests)) {
    const folder = folderOf(path);
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
    found.push({ ...manifest, load: manifest.load ?? panel });
  }
  return [...found, ...SHORTCUTS].sort((a, b) => a.name.localeCompare(b.name));
}

/** Alphabetical inside each tier, which is the order the catalog shows them in. */
export const CATALOG: PluginManifest[] = collect();

export function findPlugin(id: string): PluginManifest | undefined {
  return CATALOG.find((plugin) => plugin.id === id);
}

/** A tool the app already carries; the catalog points at it rather than mounting it. */
export const isBuiltIn = (plugin: PluginManifest): boolean => plugin.tier === "core";

/** Local plugins only work in Local Studio, and only if it offers the capability. */
export const isLive = (plugin: PluginManifest, service: ServiceClient): boolean =>
  plugin.tier !== "local" ||
  (service.mode() === "local" && (!plugin.capability || service.can(plugin.capability)));
