// Writes docs/plugins/catalog.md from the manifests themselves.
//
// A hand written list of plugins is wrong the day after someone adds one, so
// the gallery is generated. Run by `npm run docs` and `npm run docs:build`.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";

const PLUGINS = join("src", "plugins");
const OUT = join("docs", "plugins", "catalog.md");
async function evaluate(source) {
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const found = [];
for (const entry of await readdir(PLUGINS, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "runtime") continue;
  const manifestText = await readFile(join(PLUGINS, entry.name, "extension.json"), "utf8").catch(() => null);
  if (!manifestText) continue;
  const manifest = JSON.parse(manifestText);
  found.push({
    id: manifest.id,
    name: manifest.name,
    tier: "web",
    tagline: manifest.catalog.tagline,
    about: manifest.catalog.about,
    icon: manifest.catalog.icon,
    category: manifest.catalog.category,
    keywords: manifest.catalog.keywords,
    does: manifest.catalog.does,
    author: manifest.publisher?.name,
    url: manifest.publisher?.url,
  });
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
    const credit = plugin.author
      ? `    By ${plugin.url ? `[${plugin.author}](${plugin.url})` : plugin.author}.`
      : "";
    return [
      `??? info "${plugin.name}${plugin.soon ? " (planned)" : ""}: ${plugin.tagline}"`,
      "",
      `    ${plugin.about}`,
      "",
      "    **Highlights**",
      "",
      ...plugin.does.map((line) => `    - ${line}`),
      "",
      credit,
      `    <small>Category: ${plugin.category}${plugin.capability ? ` &middot; Needs: \`${plugin.capability}\`` : ""}</small>`,
      "",
    ].filter((line, index, lines) => line || lines[index - 1]).join("\n");
  });
  return [
    `## ${title}`,
    "",
    blurb,
    "Select a tool to see its purpose and main features.",
    "",
    ...entries,
  ].join("\n");
};

const page = [
  "# Extension catalog",
  "",
  "Find the tool you need without leaving the viewer. This page is generated",
  "from the extension manifests, so it stays in sync with the app.",
  "See [Build an extension](index.md) to add your own tool.",
  "",
  ...TIERS.map(section).filter(Boolean),
].join("\n");

await writeFile(OUT, `${page}\n`);
console.log(`Wrote ${OUT} with ${found.length} plugin(s).`);
