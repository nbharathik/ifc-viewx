// Writes docs/plugins/catalog.md from the manifests themselves.
//
// A hand written list of plugins is wrong the day after someone adds one, so
// the gallery is generated. Run by `npm run docs` and `npm run docs:build`.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";

const PLUGINS = join("src", "plugins");
const OUT = join("docs", "plugins", "catalog.md");
const STUB = "const definePlugin = (m) => m;";

/** Strips the types and swaps the SDK import for a definePlugin that is identity. */
async function evaluate(source) {
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  const js = code.replace(/import\s*\{[^}]*\}\s*from\s*["']@ifcviewx\/sdk["'];?/g, STUB);
  return import(`data:text/javascript,${encodeURIComponent(js)}`);
}

const found = [];
for (const entry of await readdir(PLUGINS, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "runtime") continue;
  const source = await readFile(join(PLUGINS, entry.name, "manifest.ts"), "utf8").catch(() => null);
  if (source) found.push((await evaluate(source)).default);
}
found.push(...(await evaluate(await readFile(join(PLUGINS, "shortcuts.ts"), "utf8"))).SHORTCUTS);
found.sort((a, b) => a.name.localeCompare(b.name));

const TIERS = [
  ["web", "In the browser", "These run in the tab. Nothing to install, nothing uploaded."],
  ["local", "Local Studio", "These need the local service, which is one `pip install` away."],
  ["core", "Built into the app", "These have their own panel on the rail rather than being opened from the catalog."],
];

const section = ([tier, title, blurb]) => {
  const list = found.filter((plugin) => plugin.tier === tier);
  if (!list.length) return "";
  const entries = list.map((plugin) => {
    const credit = plugin.author ? `\nBy ${plugin.url ? `[${plugin.author}](${plugin.url})` : plugin.author}.\n` : "";
    return [
      `### ${plugin.name}${plugin.soon ? " *(planned)*" : ""}`,
      "",
      `*${plugin.tagline}*`,
      "",
      plugin.about,
      "",
      ...plugin.does.map((line) => `- ${line}`),
      credit,
      `<small>Category: ${plugin.category}${plugin.capability ? ` &middot; Needs: \`${plugin.capability}\`` : ""}</small>`,
      "",
    ].join("\n");
  });
  return [`## ${title}`, "", blurb, "", ...entries].join("\n");
};

const page = [
  "# Plugin catalog",
  "",
  "Everything in the viewer's plugin browser, generated from the manifests.",
  "Yours belongs here too: see [writing a plugin](index.md).",
  "",
  ...TIERS.map(section).filter(Boolean),
].join("\n");

await writeFile(OUT, `${page}\n`);
console.log(`Wrote ${OUT} with ${found.length} plugin(s).`);
