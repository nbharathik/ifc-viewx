import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SNAPSHOT = resolve(ROOT, "tests/contracts/public-contracts.json");

const slash = (value) => value.replaceAll("\\", "/");
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const sorted = (values) => [...new Set(values)].sort(compareText);

async function filesUnder(directory, match) {
  const batches = await Promise.all((await readdir(directory, { withFileTypes: true })).map(async (entry) => {
    const path = resolve(directory, entry.name);
    const generatedApp = slash(path).endsWith("/local-bridge/src/ifcviewx/app");
    if (entry.isDirectory() && entry.name !== "__pycache__" && !generatedApp) return filesUnder(path, match);
    return entry.isFile() && match(path) ? [path] : [];
  }));
  return batches.flat().sort(compareText);
}

async function publicSdkExports(typeScriptPaths) {
  const modules = new Set(typeScriptPaths);
  const visited = new Set();
  const found = new Set();

  const bindingNames = (name) => {
    if (ts.isIdentifier(name)) found.add(name.text);
    else for (const element of name.elements) if (ts.isBindingElement(element)) bindingNames(element.name);
  };

  const resolveExport = (importer, specifier) => {
    if (!specifier.startsWith(".")) return null;
    const absolute = resolve(dirname(importer), specifier);
    return [
      absolute,
      absolute.replace(/\.(?:js|mjs|cjs)$/, ".ts"),
      `${absolute}.ts`,
      resolve(absolute, "index.ts"),
    ].find((path) => modules.has(path)) ?? null;
  };

  const visit = async (path) => {
    if (visited.has(path)) return;
    visited.add(path);
    const source = ts.createSourceFile(path, await readFile(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of source.statements) {
      if (ts.isExportDeclaration(statement)) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
          for (const element of statement.exportClause.elements) found.add(element.name.text);
        } else if (statement.exportClause && ts.isNamespaceExport(statement.exportClause)) {
          found.add(statement.exportClause.name.text);
        } else if (statement.moduleSpecifier && ts.isStringLiteralLike(statement.moduleSpecifier)) {
          const target = resolveExport(path, statement.moduleSpecifier.text);
          if (target) await visit(target);
        }
        continue;
      }
      const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
      if (!modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
          modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword)) continue;
      if (ts.isVariableStatement(statement)) {
        for (const declaration of statement.declarationList.declarations) bindingNames(declaration.name);
      } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) ||
          ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement) ||
          ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) {
        found.add(statement.name.text);
      }
    }
  };

  await visit(resolve(ROOT, "src/sdk/index.ts"));
  return [...found].sort(compareText);
}

function visitTypeScript(source, fileName, visit) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const walk = (node) => {
    visit(node, file);
    ts.forEachChild(node, walk);
  };
  walk(file);
}

function textOf(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function templateOf(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (!ts.isTemplateExpression(node)) return null;
  return `${node.head.text}${node.templateSpans.map((span) => `\${}${span.literal.text}`).join("")}`;
}

function literalIds(node, found) {
  if (ts.isPropertyAssignment(node) && ts.isIdentifier(node.name) && node.name.text === "id") {
    const id = textOf(node.initializer);
    if (id) found.push(id);
  }
  ts.forEachChild(node, (child) => literalIds(child, found));
}

function objectStringProperty(node, name) {
  const property = node.properties.find((item) =>
    ts.isPropertyAssignment(item) && ts.isIdentifier(item.name) && item.name.text === name);
  return property && ts.isPropertyAssignment(property) ? textOf(property.initializer) : null;
}

async function sourceContracts(paths) {
  const storageKeys = [];
  const capabilityIds = [];
  const registeredIds = [];
  const browserBridgeMethods = [];
  const dynamicImports = [];
  const globEntries = [];
  const workerEntries = [];
  const serviceWorkerEntries = [];

  const sources = await Promise.all(paths.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  for (const { path, source } of sources) {
    const file = slash(relative(ROOT, path));
    const needsAst = source.includes("ifcviewx") || file.startsWith("src/capabilities/") ||
      file === "src/llm/tools.ts" || file === "src/main.ts" || source.includes("bridge.register") ||
      /\bimport\s*\(/.test(source) || source.includes("import.meta.glob") ||
      source.includes("new Worker") || source.includes("serviceWorker");
    if (!needsAst) continue;
    visitTypeScript(source, path, (node, ast) => {
      if (ts.isStringLiteralLike(node) && /^ifcviewx(?:[.:_-]|$)/i.test(node.text)) storageKeys.push(node.text);
      if (ts.isTemplateExpression(node)) {
        const pattern = templateOf(node);
        if (pattern && /^ifcviewx(?:[.:_-]|$)/i.test(pattern)) storageKeys.push(pattern);
      }

      if (file.startsWith("src/capabilities/") && ts.isPropertyAssignment(node) &&
          ts.isIdentifier(node.name) && node.name.text === "id") {
        const id = textOf(node.initializer);
        if (id) capabilityIds.push(id);
      }
      if (file === "src/llm/tools.ts" && ts.isObjectLiteralExpression(node)) {
        const tier = objectStringProperty(node, "tier");
        const name = objectStringProperty(node, "name");
        if (name && (tier === "viewer" || tier === "edit")) capabilityIds.push(name);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          (node.expression.name.text === "register" || node.expression.name.text === "add")) {
        const owner = ts.isIdentifier(node.expression.expression) ? node.expression.expression.text : null;
        const first = node.arguments[0];
        if (owner === "bridge" && node.expression.name.text === "register" && first) {
          const name = textOf(first);
          if (name) browserBridgeMethods.push(name);
        }
        if (owner === "registry" && first) literalIds(first, registeredIds);
      }

      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const target = node.arguments[0] && textOf(node.arguments[0]);
        dynamicImports.push({ file, target: target ?? "<computed>" });
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          ts.isMetaProperty(node.expression.expression) &&
          node.expression.expression.keywordToken === ts.SyntaxKind.ImportKeyword &&
          node.expression.expression.name.text === "meta" && node.expression.name.text === "glob") {
        const pattern = node.arguments[0] && textOf(node.arguments[0]);
        if (pattern) globEntries.push({ file, pattern });
      }

      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Worker") {
        const argument = node.arguments?.[0];
        let target = argument && textOf(argument);
        if (!target && argument && ts.isNewExpression(argument) && ts.isIdentifier(argument.expression) &&
            argument.expression.text === "URL") target = argument.arguments?.[0] && textOf(argument.arguments[0]);
        workerEntries.push({ file, target: target ?? "<dynamic>" });
      }

      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) &&
          node.expression.name.text === "register" &&
          node.expression.expression.getText(ast).replace(/\s/g, "") === "navigator.serviceWorker") {
        serviceWorkerEntries.push({ file, target: templateOf(node.arguments[0]) ?? "<dynamic>" });
      }
    });
  }

  const orderedRecords = (records) => [...new Map(records
    .map((entry) => [`${entry.file}\0${entry.target ?? entry.pattern}`, entry]))
    .values()].sort((a, b) => compareText(JSON.stringify(a), JSON.stringify(b)));

  return {
    storageKeys: sorted(storageKeys),
    capabilityIds: sorted(capabilityIds),
    registeredIds: sorted(registeredIds),
    browserBridgeMethods: sorted(browserBridgeMethods),
    dynamicImports: orderedRecords(dynamicImports),
    globEntries: orderedRecords(globEntries),
    workerEntries: orderedRecords(workerEntries),
    serviceWorkerEntries: orderedRecords(serviceWorkerEntries),
  };
}

async function bundledPlugins() {
  const directory = resolve(ROOT, "src/plugins");
  const plugins = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === "runtime") continue;
    const path = resolve(directory, entry.name, "extension.json");
    let manifest;
    try {
      manifest = JSON.parse(await readFile(path, "utf8"));
    } catch {
      continue;
    }
    plugins.push({
      folder: entry.name,
      manifestVersion: manifest.manifestVersion,
      id: manifest.id,
      version: manifest.version,
      sdk: manifest.sdk,
      runtime: manifest.runtime,
      activationEvents: manifest.activationEvents,
      permissions: manifest.permissions,
      contributes: manifest.contributes,
      localCompanion: manifest.localCompanion ?? null,
    });
  }
  return plugins.sort((a, b) => compareText(a.id, b.id));
}

function pythonRoutes(source) {
  return [...source.matchAll(/@[A-Za-z_]\w*\.(get|post|put|patch|delete|websocket)\(\s*["']([^"']+)["']/g)]
    .map((match) => ({ method: match[1].toUpperCase(), path: match[2] }))
    .sort((a, b) => compareText(`${a.path}:${a.method}`, `${b.path}:${b.method}`));
}

function mcpTools(source) {
  return sorted([...source.matchAll(/@mcp\.tool\(\)\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/g)].map((match) => match[1]));
}

function projectScripts(source) {
  const entries = [];
  let active = false;
  for (const line of source.split(/\r\n?|\n/)) {
    if (/^\[project\.scripts\]\s*$/.test(line)) {
      active = true;
      continue;
    }
    if (active && /^\[/.test(line)) break;
    const match = active && /^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']/.exec(line);
    if (match) entries.push([match[1], match[2]]);
  }
  return Object.fromEntries(entries.sort(([a], [b]) => compareText(a, b)));
}

export async function collectPublicContracts() {
  const typeScriptPaths = await filesUnder(resolve(ROOT, "src"), (path) => path.endsWith(".ts"));
  const pythonPaths = await filesUnder(resolve(ROOT, "local-bridge/src/ifcviewx"), (path) => path.endsWith(".py"));
  const source = await sourceContracts(typeScriptPaths);
  const pythonSources = await Promise.all(pythonPaths.map((path) => readFile(path, "utf8")));
  const pyproject = await readFile(resolve(ROOT, "local-bridge/pyproject.toml"), "utf8");

  return {
    schemaVersion: 1,
    sdk: { entry: "src/sdk/index.ts", exports: await publicSdkExports(typeScriptPaths) },
    bundledPlugins: await bundledPlugins(),
    capabilities: source.capabilityIds,
    registeredIds: source.registeredIds,
    persistenceNamespaces: source.storageKeys,
    browserBridgeMethods: source.browserBridgeMethods,
    localStudio: {
      routes: [...new Map(pythonSources.flatMap(pythonRoutes)
        .map((route) => [`${route.method}\0${route.path}`, route])).values()]
        .sort((a, b) => compareText(`${a.path}:${a.method}`, `${b.path}:${b.method}`)),
      mcpTools: sorted(pythonSources.flatMap(mcpTools)),
      cliEntries: projectScripts(pyproject),
      providerEntryPointGroup: pythonSources
        .map((text) => /ENTRY_POINT_GROUP\s*=\s*["']([^"']+)["']/.exec(text)?.[1])
        .find(Boolean) ?? null,
    },
    dynamicEntries: {
      importMetaGlobs: source.globEntries,
      dynamicImports: source.dynamicImports,
      workers: source.workerEntries,
      serviceWorkers: source.serviceWorkerEntries,
    },
  };
}

export function contractJson(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

async function main() {
  const next = contractJson(await collectPublicContracts());
  if (process.argv.includes("--check")) {
    const current = await readFile(SNAPSHOT, "utf8").catch(() => "");
    if (current !== next) {
      console.error("Public contracts changed. Review the change, then run npm run contracts:update.");
      process.exitCode = 1;
      return;
    }
    console.log("Public contract snapshot is current.");
    return;
  }
  if (process.argv.includes("--write")) {
    await writeFile(SNAPSHOT, next, "utf8");
    console.log(`Wrote ${slash(relative(ROOT, SNAPSHOT))}.`);
    return;
  }
  process.stdout.write(next);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
