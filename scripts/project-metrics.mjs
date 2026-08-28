import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, extname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const slash = (value) => value.replaceAll("\\", "/");
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function filesUnder(directory, accept = () => true) {
  const found = [];
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const generatedApp = slash(path).endsWith("/local-bridge/src/ifcviewx/app");
    if (entry.isDirectory() && entry.name !== "__pycache__" && !generatedApp) {
      found.push(...await filesUnder(path, accept));
    }
    else if (entry.isFile() && accept(path)) found.push(path);
  }
  return found.sort(compareText);
}

function lineCount(text) {
  if (!text) return 0;
  const lines = text.split(/\r\n?|\n/);
  return lines.length - (lines.at(-1) === "" ? 1 : 0);
}

function areaOf(path) {
  const parts = slash(relative(ROOT, path)).split("/");
  if (parts[0] === "src") return `src/${parts[1] ?? "root"}`;
  if (parts[0] === "tests") return "tests";
  if (parts[0] === "scripts") return "scripts";
  if (parts[0] === "local-bridge") return parts[1] === "src" ? "local-bridge/src" : parts[1] === "tests" ? "local-bridge/tests" : "local-bridge";
  if (parts[0] === "docs") return "docs";
  return parts[0];
}

async function sourceMetrics() {
  const roots = ["src", "tests", "scripts", "local-bridge/src", "local-bridge/tests", "docs"];
  const accepted = new Set([".ts", ".mjs", ".py", ".css", ".html", ".md", ".yml", ".yaml", ".json"]);
  const paths = (await Promise.all(roots.map((path) => filesUnder(resolve(ROOT, path), (file) => accepted.has(extname(file)))))).flat().sort();
  const areas = new Map();
  const hash = createHash("sha256");
  for (const path of paths) {
    const relativePath = slash(relative(ROOT, path));
    const bytes = await readFile(path);
    const text = bytes.toString("utf8");
    const area = areaOf(path);
    const current = areas.get(area) ?? { files: 0, bytes: 0, lines: 0, nonblankLines: 0 };
    current.files++;
    current.bytes += bytes.byteLength;
    current.lines += lineCount(text);
    current.nonblankLines += text.split(/\r\n?|\n/).filter((line) => line.trim()).length;
    areas.set(area, current);
    hash.update(relativePath);
    hash.update("\0");
    hash.update(bytes);
  }
  return {
    digest: hash.digest("hex"),
    totals: [...areas.values()].reduce((total, area) => ({
      files: total.files + area.files,
      bytes: total.bytes + area.bytes,
      lines: total.lines + area.lines,
      nonblankLines: total.nonblankLines + area.nonblankLines,
    }), { files: 0, bytes: 0, lines: 0, nonblankLines: 0 }),
    areas: Object.fromEntries([...areas].sort(([a], [b]) => compareText(a, b))),
  };
}

function compressible(path) {
  return new Set([".css", ".html", ".js", ".json", ".mjs", ".svg", ".txt", ".xml"]).has(extname(path));
}

async function buildMetrics() {
  const directory = resolve(ROOT, "dist");
  const paths = await filesUnder(directory);
  if (!paths.length) return null;
  const entries = [];
  for (const path of paths) {
    const content = await readFile(path);
    const relativePath = slash(relative(directory, path));
    const compressed = compressible(path) ? gzipSync(content, { level: 9 }).byteLength : content.byteLength;
    entries.push({ path: relativePath, bytes: content.byteLength, gzipBytes: compressed });
  }
  const summarize = (selected) => {
    selected.sort((a, b) => b.bytes - a.bytes || compareText(a.path, b.path));
    return {
      files: selected.length,
      bytes: selected.reduce((total, entry) => total + entry.bytes, 0),
      gzipBytes: selected.reduce((total, entry) => total + entry.gzipBytes, 0),
      largest: selected.slice(0, 20),
    };
  };
  const app = entries.filter((entry) => !entry.path.startsWith("docs/"));
  const docs = entries.filter((entry) => entry.path.startsWith("docs/"));
  return { app: summarize(app), docs: docs.length ? summarize(docs) : null };
}

export async function collectProjectMetrics(options = {}) {
  const includeBuild = options.includeBuild !== false;
  return {
    schemaVersion: 1,
    source: await sourceMetrics(),
    build: includeBuild ? await buildMetrics() : null,
  };
}

async function main() {
  const result = `${JSON.stringify(await collectProjectMetrics(), null, 2)}\n`;
  const outputAt = process.argv.indexOf("--output");
  if (outputAt >= 0) {
    const target = process.argv[outputAt + 1];
    if (!target) throw new Error("--output requires a path");
    await writeFile(resolve(process.cwd(), target), result, "utf8");
    console.log(`Wrote ${slash(target)}.`);
  } else {
    process.stdout.write(result);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
