// Checks that every plugin folder is self-contained.
//
// The one rule that makes plugins survivable across releases is that they
// import "@ifcviewx/sdk" and nothing else from the app. Reaching into core
// works right up until core moves, so it is caught here instead.
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const PLUGINS = join("src", "plugins");
const NOT_A_PLUGIN = new Set(["runtime"]);
const IMPORT = /(?:from\s*|import\s*\(\s*)["']([^"']+)["']/g;

const problems = [];
const fail = (file, message) => problems.push(`${file}: ${message}`);

const entries = await readdir(PLUGINS, { withFileTypes: true });
const folders = entries.filter((e) => e.isDirectory() && !NOT_A_PLUGIN.has(e.name)).map((e) => e.name);

for (const id of folders) {
  const dir = join(PLUGINS, id);
  const files = await readdir(dir);
  const hasV1 = files.includes("manifest.ts");
  const hasV2 = files.includes("extension.json");

  if (!hasV1 && !hasV2) {
    fail(dir, "no manifest.ts or extension.json, so nothing will discover this folder");
    continue;
  }
  if (hasV1 && hasV2) fail(dir, "has both manifest.ts and extension.json; keep one manifest version");
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    fail(dir, "folder name must be lowercase letters, digits and dashes");
  }

  if (hasV2) {
    const path = join(dir, "extension.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      fail(path, `is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (manifest) {
      if (manifest.manifestVersion !== 2) fail(path, "manifestVersion must equal 2");
      if (manifest.id !== id) fail(path, `declares id "${manifest.id ?? "?"}" but the folder is "${id}"`);
      if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(manifest.version ?? "")) {
        fail(path, "version must be semantic, such as 1.0.0");
      }
      if (typeof manifest.sdk !== "string" || !/(?:^|[^0-9])2(?:\.|\b)/.test(manifest.sdk)) {
        fail(path, "sdk must include host SDK 2");
      }
      if (manifest.runtime?.kind !== "bundled") fail(path, "runtime.kind must be bundled");
      if (manifest.runtime?.entry !== "panel.ts") fail(path, "runtime.entry must be panel.ts");
      if (!Array.isArray(manifest.activationEvents) || manifest.activationEvents.length === 0) {
        fail(path, "activationEvents must contain at least one event");
      }
      if (!Array.isArray(manifest.permissions)) fail(path, "permissions must be an array");
      if (!manifest.contributes || typeof manifest.contributes !== "object" || Array.isArray(manifest.contributes)) {
        fail(path, "contributes must be an object");
      }
      if (!manifest.catalog || typeof manifest.catalog !== "object" || !manifest.catalog.tagline || !Array.isArray(manifest.catalog.does)) {
        fail(path, "catalog must include tagline and does fields");
      }
      if (!files.includes("panel.ts")) fail(dir, "no panel.ts, so opening it would do nothing");
    }
  } else {
    const path = join(dir, "manifest.ts");
    const manifest = await readFile(path, "utf8");
    const declared = /\bid:\s*["']([^"']+)["']/.exec(manifest)?.[1];
    if (declared !== id) fail(path, `declares id "${declared ?? "?"}" but the folder is "${id}"`);
    if (!manifest.includes("definePlugin(")) fail(path, "should export default definePlugin({...})");
    if (!/tier:\s*["']local["']/.test(manifest) && !files.includes("panel.ts")) {
      fail(dir, "no panel.ts, so opening it would do nothing");
    }
  }

  for (const file of files.filter((f) => f.endsWith(".ts"))) {
    const path = join(dir, file);
    const source = await readFile(path, "utf8");
    for (const [, specifier] of source.matchAll(IMPORT)) {
      const local = specifier.startsWith(".") || specifier.startsWith("/");
      const escapes = specifier.startsWith("..");
      if (specifier === "@ifcviewx/sdk") continue;
      if (local && !escapes) continue;
      fail(path, `imports "${specifier}"; plugins may only import "@ifcviewx/sdk" and their own files`);
    }
    if (hasV2 && file === "panel.ts") {
      if (/\bPluginContext\b/.test(source)) fail(path, "SDK v2 panels must use ExtensionContextV2");
      for (const escape of source.matchAll(/\bctx\.(viewer|service|python)\b/g)) {
        fail(path, `uses ctx.${escape[1]}; SDK v2 panels must use a declared domain service`);
      }
    }
  }
}

// The other direction, which is the one that bites quietly: core reaching into
// a plugin folder means deleting that plugin breaks the app, and every promise
// made about plugins being removable stops being true.
for await (const path of walk("src")) {
  if (!path.endsWith(".ts")) continue;
  if (path.startsWith(join("src", "plugins"))) continue;
  const source = await readFile(path, "utf8");
  for (const [, specifier] of source.matchAll(IMPORT)) {
    const reach = /(?:^|\/)plugins\/([^/]+)\/(?!runtime)/.exec(specifier);
    if (reach && !NOT_A_PLUGIN.has(reach[1])) {
      fail(path, `imports the "${reach[1]}" plugin; core must not depend on a plugin folder`);
    }
  }
}

const EM_DASH = String.fromCharCode(0x2014);
for (const dir of ["src", "docs", "scripts"]) {
  for await (const path of walk(dir)) {
    if (!/\.(ts|md|mjs|css|yml|json)$/.test(path)) continue;
    const source = await readFile(path, "utf8");
    if (source.includes(EM_DASH)) fail(path, "contains an em-dash");
  }
}

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else if ((await stat(path)).isFile()) yield path;
  }
}

if (problems.length) {
  console.error(`${problems.length} problem(s):\n`);
  for (const problem of problems) console.error(`  ${problem}`);
  process.exit(1);
}

console.log(`${folders.length} plugin folder(s), all self-contained.`);
