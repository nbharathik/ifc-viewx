import type { PluginManifest } from "./types.js";

/**
 * Declares a plugin. It only returns what it is given: the point is that the
 * manifest is checked against the type as you write it, rather than when the
 * catalog fails to render it.
 */
export const definePlugin = (manifest: PluginManifest): PluginManifest => manifest;
