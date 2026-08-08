// Validate, package, and optionally serve a sandboxed IFCViewX extension.
//
//   npm run extension:package -- ./my-extension
//   npm run extension:dev -- ./my-extension --port 4178
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, stat, watch, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { zipSync } from "fflate";

const LIMITS = {
  compressedBytes: 5 * 1024 * 1024,
  uncompressedBytes: 12 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  files: 128,
};
const KNOWN_PERMISSIONS = new Set([
  "model.summary.read", "model.structure.read", "model.properties.read", "model.index.build",
  "geometry.query", "geometry.mesh.read", "view.read", "view.control", "view.overlay",
  "edit.propose", "file.open", "file.export", "storage.extension", "assistant.contribute",
  "local.invoke", "viewport.capture",
]);
const CONTRIBUTIONS = new Set([
  "panels", "commands", "toolbarItems", "contextActions", "analyses", "assistantTools",
  "resultViews", "overlays", "importers", "exporters", "settings",
]);
const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const ACTIVATION = /^(?:onPanel|onCommand|onAssistantTool|onFile|onLocalCapability):[A-Za-z0-9._-]+$|^onModel$/;
const args = process.argv.slice(2);
const watchMode = args.includes("--watch");
const portAt = args.indexOf("--port");
const port = portAt >= 0 ? Number(args[portAt + 1]) : 4178;
const outputAt = args.indexOf("--output");
const valueIndexes = new Set([portAt + 1, outputAt + 1].filter((index) => index > 0));
const folderArg = args.find((arg, index) => !arg.startsWith("--") && !valueIndexes.has(index));

if (!folderArg || (outputAt >= 0 && !args[outputAt + 1]) || !Number.isInteger(port) || port < 1 || port > 65535) {
  console.error("Usage: node scripts/extension-package.mjs <folder> [--output file] [--watch] [--port 4178]");
  process.exit(1);
}

const root = resolve(folderArg);
let current = null;
let timer = null;
const clients = new Set();

function safePath(path) {
  return path && !/[\u0000-\u001f\u007f]/.test(path) && !path.includes("\\") && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) &&
    path.split("/").every((part) => part && part !== "." && part !== ".." &&
      !["__proto__", "prototype", "constructor"].includes(part.toLowerCase()));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const text = (value) => typeof value === "string" && value.trim();

function sdkCompatible(range) {
  const current = [2, 0, 0];
  const parse = (value) => {
    const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
  };
  const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  if (!text(range) || range.includes("||")) return false;
  for (const token of range.trim().split(/\s+/)) {
    if (token === "*" || token.toLowerCase() === "x") continue;
    const wildcard = /^(\d+)\.(?:x|\*)$/i.exec(token);
    if (wildcard) {
      if (current[0] !== Number(wildcard[1])) return false;
      continue;
    }
    const ranged = /^(\^|~)(\d+(?:\.\d+){0,2})$/.exec(token);
    if (ranged) {
      const base = parse(ranged[2]);
      if (!base) return false;
      const upper = ranged[1] === "^" ? [base[0] + 1, 0, 0] : [base[0], base[1] + 1, 0];
      if (compare(current, base) < 0 || compare(current, upper) >= 0) return false;
      continue;
    }
    const compared = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!compared) return false;
    const target = parse(compared[2]);
    if (!target) return false;
    const relation = compare(current, target);
    const operator = compared[1];
    if (!operator && compared[2].split(".").length === 1 ? current[0] !== target[0]
      : !operator ? relation !== 0
      : operator === ">=" ? relation < 0
      : operator === "<=" ? relation > 0
      : operator === ">" ? relation <= 0
      : operator === "<" ? relation >= 0
      : relation !== 0) return false;
  }
  return true;
}

function validateSchema(schema, path) {
  assert(object(schema), `${path} must be a JSON schema object`);
  const allowedTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    assert(types.length > 0 && types.every((type) => allowedTypes.has(type)), `${path}.type is invalid`);
  }
  if (schema.required !== undefined) {
    assert(Array.isArray(schema.required) && schema.required.every(text), `${path}.required must contain property names`);
  }
  if (schema.enum !== undefined) assert(Array.isArray(schema.enum) && schema.enum.length > 0, `${path}.enum must not be empty`);
  if (schema.$ref !== undefined) assert(text(schema.$ref) && (schema.$ref === "#" || schema.$ref.startsWith("#/")), `${path}.$ref must be package-local`);
  if (schema.properties !== undefined) {
    assert(object(schema.properties), `${path}.properties must be an object`);
    for (const [name, child] of Object.entries(schema.properties)) validateSchema(child, `${path}.properties.${name}`);
  }
  if (schema.items !== undefined) validateSchema(schema.items, `${path}.items`);
  if (object(schema.additionalProperties)) validateSchema(schema.additionalProperties, `${path}.additionalProperties`);
  else if (schema.additionalProperties !== undefined) assert(typeof schema.additionalProperties === "boolean", `${path}.additionalProperties must be a boolean or schema`);
}

function contributionIds(contributes, kind) {
  return new Set((contributes[kind] ?? []).map((entry) => entry.id));
}

function validateManifest(manifest) {
  assert(object(manifest), "extension.json must be an object");
  assert(manifest.manifestVersion === 2, "manifestVersion must equal 2");
  assert(ID.test(manifest.id ?? "") && manifest.id.includes("."), "id must use reverse-domain notation");
  assert(text(manifest.name), "name is required");
  assert(VERSION.test(manifest.version ?? ""), "version must be semantic, such as 1.0.0");
  assert(sdkCompatible(manifest.sdk), "sdk must be a supported range that includes host SDK 2.0.0");
  assert(text(manifest.description), "description is required");
  assert(manifest.runtime?.kind === "sandboxed", "runtime.kind must be sandboxed");
  assert(typeof manifest.runtime?.entry === "string" && safePath(manifest.runtime.entry) && manifest.runtime.entry.toLowerCase().endsWith(".html"), "runtime.entry must be a safe HTML path");
  assert(object(manifest.publisher) && text(manifest.publisher.name), "publisher.name is required");
  if (manifest.publisher.url !== undefined) {
    let url;
    try {
      url = new URL(manifest.publisher.url);
    } catch {
      throw new Error("publisher.url must be an HTTP or HTTPS URL");
    }
    assert(url.protocol === "http:" || url.protocol === "https:", "publisher.url must use HTTP or HTTPS");
  }
  assert(Array.isArray(manifest.activationEvents) && manifest.activationEvents.length, "activationEvents must not be empty");
  assert(manifest.activationEvents.every((event) => typeof event === "string" && ACTIVATION.test(event)), "activationEvents contains an unsupported event");
  assert(Array.isArray(manifest.permissions), "permissions must be an array");
  assert(new Set(manifest.permissions).size === manifest.permissions.length, "permissions must not contain duplicates");
  for (const permission of manifest.permissions) assert(KNOWN_PERMISSIONS.has(permission), `unknown permission ${permission}`);
  assert(!manifest.permissions.includes("geometry.mesh.read"), "installed extensions cannot request geometry.mesh.read");
  assert(object(manifest.contributes), "contributes must be an object");
  for (const [kind, entries] of Object.entries(manifest.contributes)) {
    assert(CONTRIBUTIONS.has(kind), `unknown contribution point ${kind}`);
    assert(Array.isArray(entries), `contributes.${kind} must be an array`);
    const seen = new Set();
    entries.forEach((entry, index) => {
      const path = `contributes.${kind}[${index}]`;
      assert(object(entry), `${path} must be an object`);
      assert(ID.test(entry.id ?? ""), `${path}.id has an invalid format`);
      assert(!seen.has(entry.id), `${path}.id duplicates ${entry.id}`);
      seen.add(entry.id);
      if (kind !== "assistantTools" && kind !== "toolbarItems") assert(text(entry.title), `${path}.title is required`);
      if (kind === "commands") assert(entry.id.includes("."), `${path}.id must be namespaced`);
      if (kind === "assistantTools" || kind === "analyses") assert(text(entry.capability), `${path}.capability is required`);
      if (kind === "toolbarItems" || kind === "contextActions") assert(text(entry.command), `${path}.command is required`);
      if (kind === "importers") assert(Array.isArray(entry.accepts) && entry.accepts.every(text), `${path}.accepts must contain file types`);
      if (kind === "exporters") assert(Array.isArray(entry.mimeTypes) && entry.mimeTypes.every(text), `${path}.mimeTypes must contain MIME types`);
      if (kind === "settings") validateSchema(entry.schema, `${path}.schema`);
      if (kind === "resultViews" && entry.schema !== undefined) validateSchema(entry.schema, `${path}.schema`);
    });
  }
  const panels = manifest.contributes.panels;
  assert(Array.isArray(panels) && panels.length === 1, "the first package format requires exactly one panel contribution");
  assert(manifest.activationEvents.includes(`onPanel:${panels[0].id}`), `activationEvents must include onPanel:${panels[0].id}`);
  const commands = contributionIds(manifest.contributes, "commands");
  const results = contributionIds(manifest.contributes, "resultViews");
  const tools = contributionIds(manifest.contributes, "assistantTools");
  for (const entry of [...(manifest.contributes.toolbarItems ?? []), ...(manifest.contributes.contextActions ?? [])]) {
    assert(commands.has(entry.command), `${entry.id} references undeclared command ${entry.command}`);
  }
  for (const entry of manifest.contributes.analyses ?? []) {
    if (entry.resultView !== undefined) assert(results.has(entry.resultView), `${entry.id} references undeclared result view ${entry.resultView}`);
  }
  for (const event of manifest.activationEvents) {
    const [kind, id] = event.split(":", 2);
    if (kind === "onPanel") assert(contributionIds(manifest.contributes, "panels").has(id), `${event} references an undeclared panel`);
    if (kind === "onCommand") assert(commands.has(id), `${event} references an undeclared command`);
    if (kind === "onAssistantTool") assert(tools.has(id), `${event} references an undeclared assistant tool`);
  }
  const requiredPermissions = {
    assistantTools: "assistant.contribute", overlays: "view.overlay", importers: "file.open",
    exporters: "file.export", settings: "storage.extension",
  };
  for (const [kind, permission] of Object.entries(requiredPermissions)) {
    if ((manifest.contributes[kind] ?? []).length) assert(manifest.permissions.includes(permission), `${kind} contributions require ${permission}`);
  }
  assert(object(manifest.catalog), "catalog metadata is required");
  for (const key of ["tagline", "about", "icon", "category", "keywords"]) assert(text(manifest.catalog[key]), `catalog.${key} is required`);
  assert(Array.isArray(manifest.catalog.does) && manifest.catalog.does.every(text), "catalog.does must contain descriptions");
  if (manifest.localCompanion !== undefined) {
    assert(object(manifest.localCompanion) && ID.test(manifest.localCompanion.id ?? "") && text(manifest.localCompanion.version), "localCompanion id and version are required");
    assert(manifest.localCompanion.required === undefined || typeof manifest.localCompanion.required === "boolean", "localCompanion.required must be boolean");
  }
  if (manifest.permissions.includes("local.invoke")) assert(manifest.localCompanion, "local.invoke requires localCompanion metadata");
  if (manifest.integrity !== undefined) {
    assert(object(manifest.integrity), "integrity must be an object");
    if (manifest.integrity.sha256 !== undefined) assert(/^[a-f0-9]{64}$/i.test(manifest.integrity.sha256), "integrity.sha256 must be hexadecimal SHA-256");
    if (manifest.integrity.signature !== undefined) assert(text(manifest.integrity.signature), "integrity.signature must be a non-empty string");
  }
  return manifest;
}

function validateHtml(html) {
  assert(!/<\s*(?:base|iframe|frame|object|embed|form)\b/i.test(html), "panel HTML contains a forbidden element");
  assert(!/<\s*meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html), "panel HTML cannot refresh or navigate itself");
  assert(!/<\s*script\b[^>]*\bsrc\s*=/i.test(html), "panel scripts must be inline");
  assert(!/<\s*link\b[^>]*\bhref\s*=/i.test(html), "panel styles must be inline");
  for (const match of html.matchAll(/<\s*(?:img|audio|video|source)\b[^>]*\bsrc\s*=\s*(["'])(.*?)\1/gi)) {
    assert(!match[2].trim() || /^(?:data:|blob:)/i.test(match[2].trim()), "panel media must use data or blob URLs");
  }
  assert(!/@import\b|url\s*\(\s*["']?(?:https?:|\/\/)/i.test(html), "panel styles cannot import network resources");
}

async function filesUnder(directory) {
  const out = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`symbolic links are not allowed: ${relative(directory, full)}`);
      if (entry.isDirectory()) await visit(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  await visit(directory);
  return out;
}

async function build() {
  assert((await stat(root)).isDirectory(), `${root} is not a directory`);
  const paths = await filesUnder(root);
  assert(paths.length <= LIMITS.files, `packages may contain at most ${LIMITS.files} files`);
  const files = Object.create(null);
  let total = 0;
  for (const path of paths) {
    const name = relative(root, path).split(sep).join("/");
    assert(safePath(name), `unsafe package path: ${name}`);
    const data = new Uint8Array(await readFile(path));
    assert(data.byteLength <= LIMITS.fileBytes, `${name} exceeds the per-file size limit`);
    total += data.byteLength;
    assert(total <= LIMITS.uncompressedBytes, "the unpacked package is too large");
    files[name] = data;
  }
  assert(files["extension.json"], "extension.json must be at the package root");
  const manifest = validateManifest(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(files["extension.json"])));
  const entry = files[manifest.runtime.entry];
  assert(entry, `missing runtime entry ${manifest.runtime.entry}`);
  assert(entry.byteLength <= LIMITS.entryBytes, "the panel entry exceeds the 1 MB limit");
  validateHtml(new TextDecoder("utf-8", { fatal: true }).decode(entry));
  const bytes = zipSync(files, { level: 6, mtime: new Date(1980, 0, 1) });
  assert(bytes.byteLength <= LIMITS.compressedBytes, "the package exceeds the 5 MB compressed size limit");
  return { bytes, manifest, hash: createHash("sha256").update(bytes).digest("hex") };
}

async function rebuild(write = true) {
  try {
    current = await build();
    const output = outputAt >= 0
      ? resolve(args[outputAt + 1])
      : resolve(dirname(root), `${current.manifest.id}-${current.manifest.version}.ifcviewx-extension`);
    if (write) {
      await mkdir(dirname(output), { recursive: true });
      await writeFile(output, current.bytes);
      console.log(`Built ${output}`);
    }
    console.log(`  ${Math.ceil(current.bytes.byteLength / 1024)} KB  SHA-256 ${current.hash}`);
    for (const response of clients) response.write("event: change\ndata: ready\n\n");
  } catch (error) {
    current = null;
    console.error(error instanceof Error ? error.message : String(error));
    for (const response of clients) response.write(`event: error\ndata: ${JSON.stringify(error instanceof Error ? error.message : String(error))}\n\n`);
    if (!watchMode) process.exitCode = 1;
  }
}

await rebuild(!watchMode);

if (watchMode) {
  const server = createServer((request, response) => {
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.setHeader("Cache-Control", "no-store");
    if (request.url === "/events") {
      response.writeHead(200, { "Content-Type": "text/event-stream", Connection: "keep-alive" });
      response.write("event: connected\ndata: ready\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }
    if (request.url === "/extension.ifcviewx-extension" && current) {
      response.writeHead(200, { "Content-Type": "application/zip", "Content-Length": current.bytes.byteLength });
      response.end(current.bytes);
      return;
    }
    response.writeHead(current ? 404 : 503, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(current ? "Not found" : "Extension build failed");
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`Development bridge: http://127.0.0.1:${port}/`);
    console.log(`Viewer query: ?extensionDev=${encodeURIComponent(`http://127.0.0.1:${port}/`)}`);
  });
  const watcher = watch(root, { recursive: true });
  for await (const _event of watcher) {
    clearTimeout(timer);
    timer = setTimeout(() => void rebuild(false), 120);
  }
}
