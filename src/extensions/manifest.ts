import type {
  ContributionKind,
  ExtensionContributions,
  ExtensionManifestV2,
  ExtensionPermission,
} from "../sdk/v2/contributions.js";

export interface ManifestIssue {
  path: string;
  code: string;
  message: string;
}

export interface ManifestValidation {
  valid: boolean;
  issues: ManifestIssue[];
  manifest?: ExtensionManifestV2;
}

export interface ManifestValidationOptions {
  runtime?: "bundled" | "sandboxed";
}

const ID = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256 = /^[a-f0-9]{64}$/i;
const ACTIVATION = /^(?:onPanel|onCommand|onAssistantTool|onFile|onLocalCapability):[A-Za-z0-9._-]+$|^onModel$|^onStartup$/;

export const SDK_V2_VERSION = "2.0.0";

type Version = [number, number, number];

const parseVersion = (value: string): Version | null => {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(value);
  return match ? [Number(match[1]), Number(match[2] ?? 0), Number(match[3] ?? 0)] : null;
};

const compareVersion = (a: Version, b: Version): number =>
  a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

function sdkCompatibility(range: string): "compatible" | "incompatible" | "invalid" {
  const current = parseVersion(SDK_V2_VERSION)!;
  const tokens = range.trim().split(/\s+/);
  if (!range.trim() || range.includes("||")) return "invalid";
  let compatible = true;
  for (const token of tokens) {
    if (token === "*" || token.toLowerCase() === "x") continue;
    const wildcard = /^(\d+)\.(?:x|\*)$/i.exec(token);
    if (wildcard) {
      compatible &&= current[0] === Number(wildcard[1]);
      continue;
    }
    const ranged = /^(\^|~)(\d+(?:\.\d+){0,2})$/.exec(token);
    if (ranged) {
      const base = parseVersion(ranged[2]);
      if (!base) return "invalid";
      const upper: Version = ranged[1] === "^"
        ? [base[0] + 1, 0, 0]
        : [base[0], base[1] + 1, 0];
      compatible &&= compareVersion(current, base) >= 0 && compareVersion(current, upper) < 0;
      continue;
    }
    const compared = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!compared) return "invalid";
    const target = parseVersion(compared[2]);
    if (!target) return "invalid";
    const relation = compareVersion(current, target);
    const operator = compared[1];
    if (!operator && compared[2].split(".").length === 1) compatible &&= current[0] === target[0];
    else if (!operator) compatible &&= relation === 0;
    else if (operator === ">=") compatible &&= relation >= 0;
    else if (operator === "<=") compatible &&= relation <= 0;
    else if (operator === ">") compatible &&= relation > 0;
    else if (operator === "<") compatible &&= relation < 0;
    else compatible &&= relation === 0;
  }
  return compatible ? "compatible" : "incompatible";
}

export const EXTENSION_PERMISSIONS: readonly ExtensionPermission[] = [
  "model.summary.read",
  "model.structure.read",
  "model.properties.read",
  "model.index.build",
  "geometry.query",
  "geometry.mesh.read",
  "view.read",
  "view.control",
  "view.overlay",
  "review.issue.create",
  "edit.propose",
  "file.open",
  "file.export",
  "storage.extension",
  "assistant.contribute",
  "local.invoke",
  "viewport.capture",
];

export const CONTRIBUTION_KINDS: readonly ContributionKind[] = [
  "panels",
  "commands",
  "toolbarItems",
  "contextActions",
  "analyses",
  "assistantTools",
  "resultViews",
  "overlays",
  "importers",
  "exporters",
  "settings",
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function requiredString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  issues: ManifestIssue[],
): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    issues.push({ path: `${path}.${key}`, code: "required", message: "must be a non-empty string" });
    return "";
  }
  return value;
}

function stringArray(value: unknown, path: string, issues: ManifestIssue[]): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || !entry.trim())) {
    issues.push({ path, code: "type", message: "must be an array of non-empty strings" });
    return [];
  }
  return value;
}

function validateJsonSchema(
  value: unknown,
  path: string,
  issues: ManifestIssue[],
  seen = new WeakSet<object>(),
): void {
  if (!isRecord(value)) {
    issues.push({ path, code: "schema", message: "must be a JSON schema object" });
    return;
  }
  if (seen.has(value)) {
    issues.push({ path, code: "schema", message: "must not contain circular references" });
    return;
  }
  seen.add(value);
  const allowedTypes = new Set(["null", "boolean", "object", "array", "number", "integer", "string"]);
  if (value.type !== undefined) {
    const types = Array.isArray(value.type) ? value.type : [value.type];
    if (!types.length || types.some((type) => typeof type !== "string" || !allowedTypes.has(type))) {
      issues.push({ path: `${path}.type`, code: "schema", message: "contains an unsupported JSON schema type" });
    }
  }
  if (value.required !== undefined &&
      (!Array.isArray(value.required) || value.required.some((entry) => typeof entry !== "string" || !entry))) {
    issues.push({ path: `${path}.required`, code: "schema", message: "must contain property names" });
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    issues.push({ path: `${path}.enum`, code: "schema", message: "must be a non-empty array" });
  }
  if (value.$ref !== undefined &&
      (typeof value.$ref !== "string" || (value.$ref !== "#" && !value.$ref.startsWith("#/")))) {
    issues.push({ path: `${path}.$ref`, code: "schema", message: "must be a package-local reference" });
  }
  if (value.properties !== undefined) {
    if (!isRecord(value.properties)) {
      issues.push({ path: `${path}.properties`, code: "schema", message: "must be an object" });
    } else {
      for (const [name, schema] of Object.entries(value.properties)) {
        validateJsonSchema(schema, `${path}.properties.${name}`, issues, seen);
      }
    }
  }
  if (value.items !== undefined) validateJsonSchema(value.items, `${path}.items`, issues, seen);
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    validateJsonSchema(value.additionalProperties, `${path}.additionalProperties`, issues, seen);
  }
  seen.delete(value);
}

function validateContributions(value: unknown, issues: ManifestIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "manifest.contributes", code: "type", message: "must be an object" });
    return;
  }
  for (const [kind, entries] of Object.entries(value)) {
    if (!CONTRIBUTION_KINDS.includes(kind as ContributionKind)) {
      issues.push({ path: `manifest.contributes.${kind}`, code: "unknown", message: "is not a supported contribution point" });
      continue;
    }
    if (!Array.isArray(entries)) {
      issues.push({ path: `manifest.contributes.${kind}`, code: "type", message: "must be an array" });
      continue;
    }
    const ids = new Set<string>();
    entries.forEach((entry, index) => {
      const path = `manifest.contributes.${kind}[${index}]`;
      if (!isRecord(entry)) {
        issues.push({ path, code: "type", message: "must be an object" });
        return;
      }
      const id = requiredString(entry, "id", path, issues);
      if (id && !ID.test(id)) {
        issues.push({ path: `${path}.id`, code: "format", message: "must use lowercase letters, digits, dots, or dashes" });
      }
      if (id && ids.has(id)) {
        issues.push({ path: `${path}.id`, code: "duplicate", message: `duplicates ${id} in ${kind}` });
      }
      ids.add(id);
      if (kind !== "assistantTools" && kind !== "toolbarItems") {
        requiredString(entry, "title", path, issues);
      }
      if (kind === "commands" && id && !id.includes(".")) {
        issues.push({ path: `${path}.id`, code: "namespace", message: "command ids must be namespaced" });
      }
      if (kind === "assistantTools" || kind === "analyses") {
        requiredString(entry, "capability", path, issues);
      }
      if (kind === "toolbarItems" || kind === "contextActions") {
        requiredString(entry, "command", path, issues);
      }
      if (kind === "importers") stringArray(entry.accepts, `${path}.accepts`, issues);
      if (kind === "exporters") stringArray(entry.mimeTypes, `${path}.mimeTypes`, issues);
      if (kind === "settings") validateJsonSchema(entry.schema, `${path}.schema`, issues);
      if (kind === "resultViews" && entry.schema !== undefined) validateJsonSchema(entry.schema, `${path}.schema`, issues);
    });
  }
}

function contributionIds(value: unknown, kind: ContributionKind): Set<string> {
  if (!isRecord(value) || !Array.isArray(value[kind])) return new Set();
  return new Set(value[kind]
    .filter(isRecord)
    .map((entry) => entry.id)
    .filter((id): id is string => typeof id === "string"));
}

function validateContributionLinks(
  contributions: unknown,
  events: string[],
  permissions: string[],
  issues: ManifestIssue[],
): void {
  if (!isRecord(contributions)) return;
  const commands = contributionIds(contributions, "commands");
  const resultViews = contributionIds(contributions, "resultViews");
  const panels = contributionIds(contributions, "panels");
  const assistantTools = contributionIds(contributions, "assistantTools");
  const permissionSet = new Set(permissions);

  for (const kind of ["toolbarItems", "contextActions"] as const) {
    const entries = Array.isArray(contributions[kind]) ? contributions[kind] : [];
    entries.filter(isRecord).forEach((entry, index) => {
      if (typeof entry.command === "string" && !commands.has(entry.command)) {
        issues.push({
          path: `manifest.contributes.${kind}[${index}].command`,
          code: "reference",
          message: `references undeclared command ${entry.command}`,
        });
      }
    });
  }
  const analyses = Array.isArray(contributions.analyses) ? contributions.analyses : [];
  analyses.filter(isRecord).forEach((entry, index) => {
    if (typeof entry.resultView === "string" && !resultViews.has(entry.resultView)) {
      issues.push({
        path: `manifest.contributes.analyses[${index}].resultView`,
        code: "reference",
        message: `references undeclared result view ${entry.resultView}`,
      });
    }
  });

  const permissionByKind: Partial<Record<ContributionKind, ExtensionPermission>> = {
    assistantTools: "assistant.contribute",
    overlays: "view.overlay",
    importers: "file.open",
    exporters: "file.export",
    settings: "storage.extension",
  };
  for (const [kind, permission] of Object.entries(permissionByKind)) {
    if (contributionIds(contributions, kind as ContributionKind).size && !permissionSet.has(permission)) {
      issues.push({
        path: `manifest.permissions`,
        code: "permission",
        message: `${kind} contributions require ${permission}`,
      });
    }
  }

  events.forEach((event, index) => {
    const separator = event.indexOf(":");
    if (separator < 0) return;
    const kind = event.slice(0, separator);
    const id = event.slice(separator + 1);
    const known = kind === "onPanel" ? panels : kind === "onCommand" ? commands : kind === "onAssistantTool" ? assistantTools : null;
    if (known && !known.has(id)) {
      issues.push({
        path: `manifest.activationEvents[${index}]`,
        code: "reference",
        message: `references undeclared contribution ${id}`,
      });
    }
  });
}

function validateCatalog(value: unknown, issues: ManifestIssue[]): void {
  if (!isRecord(value)) {
    issues.push({ path: "manifest.catalog", code: "type", message: "must be an object" });
    return;
  }
  for (const key of ["tagline", "about", "icon", "category", "keywords"]) {
    requiredString(value, key, "manifest.catalog", issues);
  }
  stringArray(value.does, "manifest.catalog.does", issues);
}

export function validateManifestV2(
  value: unknown,
  options: ManifestValidationOptions = {},
): ManifestValidation {
  const issues: ManifestIssue[] = [];
  if (!isRecord(value)) {
    return {
      valid: false,
      issues: [{ path: "manifest", code: "type", message: "must be an object" }],
    };
  }
  if (value.manifestVersion !== 2) {
    issues.push({ path: "manifest.manifestVersion", code: "version", message: "must equal 2" });
  }
  const id = requiredString(value, "id", "manifest", issues);
  if (id && !ID.test(id)) {
    issues.push({ path: "manifest.id", code: "format", message: "must use lowercase letters, digits, dots, or dashes" });
  }
  requiredString(value, "name", "manifest", issues);
  const version = requiredString(value, "version", "manifest", issues);
  if (version && !VERSION.test(version)) {
    issues.push({ path: "manifest.version", code: "format", message: "must be a semantic version such as 1.2.0" });
  }
  const sdk = requiredString(value, "sdk", "manifest", issues);
  if (sdk) {
    const compatibility = sdkCompatibility(sdk);
    if (compatibility === "invalid") {
      issues.push({ path: "manifest.sdk", code: "format", message: "must be a supported semantic version range" });
    } else if (compatibility === "incompatible") {
      issues.push({ path: "manifest.sdk", code: "compatibility", message: `does not include host SDK ${SDK_V2_VERSION}` });
    }
  }
  requiredString(value, "description", "manifest", issues);

  if (!isRecord(value.runtime)) {
    issues.push({ path: "manifest.runtime", code: "type", message: "must be an object" });
  } else {
    if (value.runtime.kind !== "bundled" && value.runtime.kind !== "sandboxed") {
      issues.push({ path: "manifest.runtime.kind", code: "value", message: "must be bundled or sandboxed" });
    } else if (options.runtime && value.runtime.kind !== options.runtime) {
      issues.push({ path: "manifest.runtime.kind", code: "compatibility", message: `must be ${options.runtime} in this host` });
    }
    const entry = requiredString(value.runtime, "entry", "manifest.runtime", issues);
    if (entry && (entry.startsWith("/") || entry.includes("..") || entry.includes("\\"))) {
      issues.push({ path: "manifest.runtime.entry", code: "path", message: "must be a safe relative package path" });
    }
    if (value.runtime.kind === "sandboxed" && entry && !entry.toLowerCase().endsWith(".html")) {
      issues.push({ path: "manifest.runtime.entry", code: "format", message: "sandboxed entries must be HTML files" });
    }
  }

  const events = stringArray(value.activationEvents, "manifest.activationEvents", issues);
  if (events.length === 0) {
    issues.push({ path: "manifest.activationEvents", code: "empty", message: "must declare at least one activation event" });
  }
  for (let i = 0; i < events.length; i++) {
    if (!ACTIVATION.test(events[i])) {
      issues.push({ path: `manifest.activationEvents[${i}]`, code: "format", message: `unsupported activation event ${events[i]}` });
    }
  }

  const permissions = stringArray(value.permissions, "manifest.permissions", issues);
  const known = new Set<string>(EXTENSION_PERMISSIONS);
  const seenPermissions = new Set<string>();
  permissions.forEach((permission, index) => {
    if (!known.has(permission)) {
      issues.push({ path: `manifest.permissions[${index}]`, code: "unknown", message: `unknown permission ${permission}` });
    }
    if (seenPermissions.has(permission)) {
      issues.push({ path: `manifest.permissions[${index}]`, code: "duplicate", message: `duplicates ${permission}` });
    }
    seenPermissions.add(permission);
  });

  validateContributions(value.contributes, issues);
  validateContributionLinks(value.contributes, events, permissions, issues);

  if (isRecord(value.runtime) && value.runtime.kind === "sandboxed") {
    if (id && !id.includes(".")) {
      issues.push({ path: "manifest.id", code: "format", message: "installed extension ids must use reverse-domain notation" });
    }
    if (!isRecord(value.publisher)) {
      issues.push({ path: "manifest.publisher", code: "required", message: "is required for installed extensions" });
    }
    if (events.includes("onStartup")) {
      issues.push({ path: "manifest.activationEvents", code: "forbidden", message: "installed extensions cannot activate on startup" });
    }
    if (permissions.includes("geometry.mesh.read")) {
      issues.push({ path: "manifest.permissions", code: "forbidden", message: "installed extensions cannot read raw geometry" });
    }
  }
  validateCatalog(value.catalog, issues);

  if (isRecord(value.publisher)) {
    requiredString(value.publisher, "name", "manifest.publisher", issues);
    if (value.publisher.url !== undefined) {
      if (typeof value.publisher.url !== "string") {
        issues.push({ path: "manifest.publisher.url", code: "type", message: "must be a string" });
      } else {
        try {
          const url = new URL(value.publisher.url);
          if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error();
        } catch {
          issues.push({ path: "manifest.publisher.url", code: "format", message: "must be an HTTP or HTTPS URL" });
        }
      }
    }
  } else if (value.publisher !== undefined) {
    issues.push({ path: "manifest.publisher", code: "type", message: "must be an object" });
  }

  if (value.localCompanion !== undefined) {
    if (!isRecord(value.localCompanion)) {
      issues.push({ path: "manifest.localCompanion", code: "type", message: "must be an object" });
    } else {
      const companionId = requiredString(value.localCompanion, "id", "manifest.localCompanion", issues);
      if (companionId && (!ID.test(companionId) || !companionId.includes("."))) {
        issues.push({ path: "manifest.localCompanion.id", code: "format", message: "must use a reverse-domain provider id" });
      }
      const companionVersion = requiredString(value.localCompanion, "version", "manifest.localCompanion", issues);
      if (companionVersion && sdkCompatibility(companionVersion) === "invalid") {
        issues.push({ path: "manifest.localCompanion.version", code: "format", message: "must be a supported semantic version range" });
      }
      if (value.localCompanion.required !== undefined && typeof value.localCompanion.required !== "boolean") {
        issues.push({ path: "manifest.localCompanion.required", code: "type", message: "must be a boolean" });
      }
    }
  }
  if (permissions.includes("local.invoke") && !isRecord(value.localCompanion)) {
    issues.push({ path: "manifest.localCompanion", code: "permission", message: "is required by local.invoke" });
  }

  if (value.integrity !== undefined) {
    if (!isRecord(value.integrity)) {
      issues.push({ path: "manifest.integrity", code: "type", message: "must be an object" });
    } else {
      if (value.integrity.sha256 !== undefined &&
          (typeof value.integrity.sha256 !== "string" || !SHA256.test(value.integrity.sha256))) {
        issues.push({ path: "manifest.integrity.sha256", code: "format", message: "must be a 64-character hexadecimal SHA-256" });
      }
      if (value.integrity.signature !== undefined &&
          (typeof value.integrity.signature !== "string" || !value.integrity.signature.trim())) {
        issues.push({ path: "manifest.integrity.signature", code: "type", message: "must be a non-empty string" });
      }
    }
  }

  return issues.length
    ? { valid: false, issues }
    : { valid: true, issues: [], manifest: value as unknown as ExtensionManifestV2 };
}

export class ManifestValidationError extends Error {
  constructor(readonly issues: ManifestIssue[], id = "extension") {
    super(`${id} manifest is invalid:\n${issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`);
    this.name = "ManifestValidationError";
  }
}

export function assertManifestV2(
  value: unknown,
  options: ManifestValidationOptions = {},
): ExtensionManifestV2 {
  const validation = validateManifestV2(value, options);
  if (!validation.manifest) {
    const id = isRecord(value) && typeof value.id === "string" ? value.id : "extension";
    throw new ManifestValidationError(validation.issues, id);
  }
  return validation.manifest;
}

export function contributionsOf(manifest: ExtensionManifestV2): ExtensionContributions {
  return manifest.contributes;
}
