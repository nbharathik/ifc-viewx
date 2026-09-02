// Writes docs/plugins/catalog.md from the manifests themselves.
//
// A hand written list of plugins is wrong the day after someone adds one, so
// the gallery is generated. Run by `npm run docs` and `npm run docs:build`.
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { transform } from "esbuild";

const PLUGINS = join("src", "plugins");
const OUT = join("docs", "plugins", "catalog.md");
const { version: releaseVersion } = JSON.parse(await readFile("package.json", "utf8"));
async function evaluate(source) {
  const { code } = await transform(source, { loader: "ts", format: "esm" });
  return import(`data:text/javascript,${encodeURIComponent(code)}`);
}

const release = await evaluate(await readFile(join("src", "app", "release.ts"), "utf8"));

const found = [];
for (const entry of await readdir(PLUGINS, { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === "runtime") continue;
  const manifestText = await readFile(join(PLUGINS, entry.name, "extension.json"), "utf8").catch(() => null);
  if (!manifestText) continue;
  const manifest = JSON.parse(manifestText);
  if (!release.isReleasePluginVisible(manifest.id)) continue;
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
found.push(...(await evaluate(await readFile(join(PLUGINS, "shortcuts.ts"), "utf8"))).SHORTCUTS
  .filter((plugin) => release.isReleasePluginVisible(plugin.id)));
found.sort((a, b) => a.name.localeCompare(b.name));

const TIERS = [
  ["web", "Viewer plugins", "Available from **Plugins** in the viewer."],
  ["core", "Built-in tools", "Available directly from the viewer."],
  ["local", "Local Studio", "Available after installing Local Studio."],
];

const section = ([tier, title, blurb]) => {
  const list = found.filter((plugin) => plugin.tier === tier);
  if (!list.length) return "";
  return [
    `## ${title}`,
    "",
    blurb,
    "",
    ...list.flatMap((plugin) => [`**${plugin.name}.** ${plugin.tagline}.`, ""]),
  ].join("\n");
};

const page = [
  `# Available tools in ${releaseVersion}`,
  "",
  `This page lists the tools available in the ${releaseVersion} release. Each one runs in the browser or through Local Studio.`,
  "",
  ...TIERS.map(section).filter(Boolean),
].join("\n");

await writeFile(OUT, `${page.trimEnd()}\n`);
console.log(`Wrote ${OUT} with ${found.length} plugin(s).`);
