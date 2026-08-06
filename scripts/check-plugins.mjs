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

  if (!files.includes("manifest.ts")) {
    fail(dir, "no manifest.ts, so nothing will discover this folder");
    continue;
  }
  if (!/^[a-z][a-z0-9-]*$/.test(id)) {
    fail(dir, "folder name must be lowercase letters, digits and dashes");
  }

  const manifest = await readFile(join(dir, "manifest.ts"), "utf8");
  const declared = /\bid:\s*["']([^"']+)["']/.exec(manifest)?.[1];
  if (declared !== id) {
    fail(join(dir, "manifest.ts"), `declares id "${declared ?? "?"}" but the folder is "${id}"`);
  }
  if (!manifest.includes("definePlugin(")) {
    fail(join(dir, "manifest.ts"), "should export default definePlugin({...})");
  }
  if (!/tier:\s*["']local["']/.test(manifest) && !files.includes("panel.ts")) {
    fail(dir, "no panel.ts, so opening it would do nothing");
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
    if (!/\.(ts|md|mjs|css|yml)$/.test(path)) continue;
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
