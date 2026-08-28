import { readFile, readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { moduleSpecifiers } from "./plugin-imports.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE = resolve(ROOT, "src");
const BASELINE = resolve(ROOT, "docs/refactor/architecture-baseline.json");
const slash = (value) => value.replaceAll("\\", "/");
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;

async function typeScriptFiles(directory, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) await typeScriptFiles(path, found);
    else if (entry.isFile() && entry.name.endsWith(".ts")) found.push(path);
  }
  return found;
}

function pluginFolder(path) {
  const match = /^src\/plugins\/([^/]+)\//.exec(path);
  return match && match[1] !== "runtime" ? match[1] : null;
}

function resolveModule(importer, specifier, modules) {
  if (specifier === "@ifcviewx/sdk") return "src/sdk/index.ts";
  if (!specifier.startsWith(".")) return null;
  const absolute = resolve(ROOT, dirname(importer), specifier);
  const candidates = [
    absolute,
    absolute.replace(/\.(?:js|mjs|cjs)$/, ".ts"),
    `${absolute}.ts`,
    resolve(absolute, "index.ts"),
  ].map((path) => slash(relative(ROOT, path)));
  return candidates.find((path) => modules.has(path)) ?? null;
}

export function stronglyConnected(graph) {
  let nextIndex = 0;
  const indexes = new Map();
  const low = new Map();
  const stack = [];
  const active = new Set();
  const components = [];

  const visit = (node) => {
    indexes.set(node, nextIndex);
    low.set(node, nextIndex++);
    stack.push(node);
    active.add(node);
    for (const target of graph.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (active.has(target)) {
        low.set(node, Math.min(low.get(node), indexes.get(target)));
      }
    }
    if (low.get(node) !== indexes.get(node)) return;
    const component = [];
    let member;
    do {
      member = stack.pop();
      active.delete(member);
      component.push(member);
    } while (member !== node);
    if (component.length > 1 || (graph.get(node) ?? []).includes(node)) components.push(component.sort());
  };

  for (const node of [...graph.keys()].sort(compareText)) if (!indexes.has(node)) visit(node);
  return components.sort((a, b) => compareText(a[0], b[0]));
}

function boundaryProblem(importer, specifier, target) {
  const importerPlugin = pluginFolder(importer);
  const targetPlugin = target && pluginFolder(target);
  if (specifier === "@ifcviewx/sdk" && !importerPlugin) return "only bundled plugins may consume the public SDK alias";
  if (target === "src/main.ts" && importer !== target) return "the application entry point must not be imported";
  if (targetPlugin && targetPlugin !== importerPlugin) return `imports the bundled plugin ${targetPlugin}`;
  if (importer.startsWith("src/sdk/") && target &&
      (target.startsWith("src/plugins/") || target.startsWith("src/extensions/installed/"))) {
    return "the public SDK must not depend on plugin or installed-extension runtimes";
  }
  if (/(?:\.worker|\/worker\.entry)\.ts$/.test(importer) && target &&
      /^(?:src\/(?:ui|plugins|extensions)\/|src\/main\.ts$)/.test(target)) {
    return "worker code must not depend on DOM application layers";
  }
  return null;
}

export async function architectureReport() {
  const paths = (await typeScriptFiles(SOURCE)).sort(compareText);
  const modules = new Set(paths.map((path) => slash(relative(ROOT, path))));
  const graph = new Map([...modules].map((path) => [path, []]));
  const violations = [];

  for (const path of paths) {
    const importer = slash(relative(ROOT, path));
    const source = await readFile(path, "utf8");
    for (const specifier of moduleSpecifiers(source, path)) {
      const target = resolveModule(importer, specifier, modules);
      if (target) graph.get(importer).push(target);
      const problem = boundaryProblem(importer, specifier, target);
      if (problem) violations.push({ importer, specifier, target, problem });
    }
    graph.set(importer, [...new Set(graph.get(importer))].sort());
  }

  return {
    modules: modules.size,
    edges: [...graph.values()].reduce((total, entries) => total + entries.length, 0),
    cycles: stronglyConnected(graph),
    violations: violations.sort((a, b) => compareText(`${a.importer}:${a.specifier}`, `${b.importer}:${b.specifier}`)),
  };
}

export function unapprovedCycles(report, baseline) {
  const known = new Set((baseline.allowedCycles ?? []).map((cycle) => [...cycle].sort().join("\0")));
  return report.cycles.filter((cycle) => !known.has(cycle.join("\0")));
}

async function main() {
  const report = await architectureReport();
  const baseline = JSON.parse(await readFile(BASELINE, "utf8"));
  const unexpectedCycles = unapprovedCycles(report, baseline);
  for (const cycle of unexpectedCycles) console.error(`cycle: ${cycle.join(" -> ")}`);
  for (const violation of report.violations) {
    console.error(`${violation.importer}: ${violation.problem} (${violation.specifier})`);
  }
  if (unexpectedCycles.length || report.violations.length) {
    process.exitCode = 1;
    return;
  }
  const documented = report.cycles.length - unexpectedCycles.length;
  console.log(`${report.modules} modules and ${report.edges} internal imports, with ${documented} documented cycle(s) and no new boundary violations.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
