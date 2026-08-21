// The plugin registry: a static, signed index.
//
// Everything the platform already does well stays: a package is a file, the
// permission diff is shown before it runs, and a bad update rolls back. What
// was missing is a way to find one without being handed a zip.
//
// A registry is one JSON file on static hosting, signed, listing packages by
// their hash. There is no server, no account and no telemetry: the index is
// fetched, its signature checked against a key pinned in this build, and each
// download verified against the hash the index named. A package whose bytes
// do not match its entry never reaches the installer.
import { EXTENSION_PERMISSIONS, type ExtensionPermission } from "../sdk/contributions.js";

export const REGISTRY_URL_KEY = "ifcviewx.registry.url";
export const REGISTRY_FORMAT = "ifcviewx.registry";
const INDEX_LIMIT = 1024 * 1024;
const PACKAGE_LIMIT = 5 * 1024 * 1024;
const ENTRY_ID = /^[a-z][a-z0-9-]*$/;
const ENTRY_HASH = /^[0-9a-f]{64}$/i;
const ENTRY_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface RegistryEntry {
  id: string;
  name: string;
  version: string;
  description: string;
  /** Absolute or index-relative URL of the package file. */
  url: string;
  /** Lowercase hex SHA-256 of the package bytes. */
  sha256: string;
  size: number;
  publisher: string;
  permissions: ExtensionPermission[];
  category?: string;
  keywords?: string;
  homepage?: string;
  updatedAt?: string;
}

export interface RegistryIndex {
  format: typeof REGISTRY_FORMAT;
  version: 1;
  name: string;
  updatedAt: string;
  packages: RegistryEntry[];
}

export type RegistryTrust = "signed" | "unsigned" | "invalid";

export interface RegistryResult {
  index: RegistryIndex;
  trust: RegistryTrust;
  source: string;
}

/**
 * The publisher key this build trusts, as a P-256 JWK. ECDSA rather than
 * Ed25519 because every browser this app supports has P-256 in WebCrypto and
 * not all of them have Ed25519 yet.
 *
 * An empty key means this build pins nobody, and every index it reads is
 * reported as unsigned rather than quietly treated as trusted.
 */
function configuredKey(): JsonWebKey | null {
  const configured = import.meta.env.VITE_PLUGIN_REGISTRY_JWK;
  if (!configured) return null;
  try {
    const key = JSON.parse(configured) as JsonWebKey;
    return key.kty === "EC" && key.crv === "P-256" && typeof key.x === "string" && typeof key.y === "string" && !key.d
      ? { kty: "EC", crv: "P-256", x: key.x, y: key.y }
      : null;
  } catch {
    return null;
  }
}

export const TRUSTED_KEY: JsonWebKey | null = configuredKey();

const hex = (buffer: ArrayBuffer): string =>
  [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const view = new Uint8Array(bytes);
  const digest = await crypto.subtle.digest("SHA-256", view.buffer as ArrayBuffer);
  return hex(digest);
}

function base64ToBytes(text: string): Uint8Array {
  const normalized = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) out[index] = binary.charCodeAt(index);
  return out;
}

/**
 * Verify a detached signature over the exact index bytes. The signature does
 * not travel inside the JSON it signs, so what is verified is byte-for-byte
 * what was parsed.
 */
export async function verifyIndex(
  bytes: Uint8Array,
  signature: string | null,
  trustedKey: JsonWebKey | null = TRUSTED_KEY,
): Promise<RegistryTrust> {
  if (!trustedKey) return "unsigned";
  if (!signature) return "unsigned";
  try {
    const key = await crypto.subtle.importKey(
      "jwk",
      trustedKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const view = new Uint8Array(bytes);
    const ok = await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      key,
      base64ToBytes(signature).buffer as ArrayBuffer,
      view.buffer as ArrayBuffer,
    );
    return ok ? "signed" : "invalid";
  } catch {
    return "invalid";
  }
}

export function parseRegistry(text: string): RegistryIndex {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) throw new Error("The registry index is not an object");
  const value = parsed as Partial<RegistryIndex>;
  if (value.format !== REGISTRY_FORMAT) throw new Error("That file is not an IFCViewX plugin registry");
  if (value.version !== 1) throw new Error("This IFCViewX build does not support that registry version");
  if (!Array.isArray(value.packages)) throw new Error("The registry index carries no packages");
  if (value.packages.length > 1_000) throw new Error("The registry index contains too many packages");
  const packages: RegistryEntry[] = [];
  const identities = new Set<string>();
  for (const raw of value.packages) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as RegistryEntry;
    // An entry with no hash cannot be pinned, so it is dropped rather than
    // offered: an unpinned download is exactly what this format exists to stop.
    if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id) ||
      typeof entry.url !== "string" || !entry.url.trim()) continue;
    if (typeof entry.sha256 !== "string" || !ENTRY_HASH.test(entry.sha256)) continue;
    if (typeof entry.version !== "string" || !ENTRY_VERSION.test(entry.version)) continue;
    if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > PACKAGE_LIMIT) continue;
    if (!Array.isArray(entry.permissions) ||
      !entry.permissions.every((permission) => EXTENSION_PERMISSIONS.includes(permission as ExtensionPermission))) continue;
    const identity = `${entry.id}@${entry.version}`;
    if (identities.has(identity)) continue;
    identities.add(identity);
    packages.push({
      ...entry,
      sha256: entry.sha256.toLowerCase(),
      permissions: [...new Set(entry.permissions)],
      version: entry.version,
      name: typeof entry.name === "string" && entry.name ? entry.name : entry.id,
      description: typeof entry.description === "string" ? entry.description : "",
      publisher: typeof entry.publisher === "string" ? entry.publisher : "unknown",
      size: entry.size,
    });
  }
  return {
    format: REGISTRY_FORMAT,
    version: 1,
    name: typeof value.name === "string" && value.name ? value.name : "Plugin registry",
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : "",
    packages,
  };
}

/** Fetch and verify an index. The signature sits beside it as `.sig`. */
export async function fetchRegistry(url: string, signal?: AbortSignal): Promise<RegistryResult> {
  signal?.throwIfAborted();
  const target = secureUrl(url);
  const response = await fetch(target, { credentials: "omit", cache: "no-cache", signal });
  if (!response.ok) throw new Error(`The registry answered ${response.status}`);
  const source = responseTarget(response, target);
  const bytes = await readLimited(response, INDEX_LIMIT, "registry index");
  signal?.throwIfAborted();
  const signatureUrl = new URL(source);
  signatureUrl.pathname += ".sig";
  let signature: string | null = null;
  try {
    const signatureResponse = await fetch(signatureUrl, { credentials: "omit", cache: "no-cache", signal });
    if (signatureResponse.ok) {
      responseTarget(signatureResponse, signatureUrl);
      signature = new TextDecoder().decode(await readLimited(signatureResponse, 4_096, "registry signature"));
    }
  } catch (error) {
    if (signal?.aborted) throw error;
  }
  const trust = await verifyIndex(bytes, signature?.trim() ?? null);
  signal?.throwIfAborted();
  if (trust === "invalid") throw new Error("The registry signature does not match the key this build trusts");
  if (trust !== "signed") {
    throw new Error(TRUSTED_KEY
      ? "The registry is missing its required signature"
      : "Remote plugin registries are disabled because this build pins no publisher key");
  }
  return { index: parseRegistry(new TextDecoder().decode(bytes)), trust, source: source.href };
}

/**
 * Download one package and check it against the hash the index pinned. A
 * mismatch is a hard failure: the index is the authority on what that version
 * is, and anything else claiming to be it is not it.
 */
export async function fetchPackage(
  entry: RegistryEntry,
  indexUrl: string,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  signal?.throwIfAborted();
  assertPackagePin(entry);
  const url = secureUrl(new URL(entry.url, indexUrl).href);
  const response = await fetch(url, { credentials: "omit", signal });
  if (!response.ok) throw new Error(`${entry.name} answered ${response.status}`);
  responseTarget(response, url);
  const bytes = await readLimited(response, entry.size, `${entry.name} package`);
  if (bytes.byteLength !== entry.size) throw new Error(`${entry.name} does not match the size the registry declared`);
  signal?.throwIfAborted();
  const digest = await sha256Hex(bytes);
  signal?.throwIfAborted();
  if (digest !== entry.sha256.toLowerCase()) {
    throw new Error(`${entry.name} does not match the hash the registry pinned. It was not installed.`);
  }
  return bytes;
}

function assertPackagePin(entry: RegistryEntry): void {
  if (typeof entry.id !== "string" || !ENTRY_ID.test(entry.id) ||
    typeof entry.version !== "string" || !ENTRY_VERSION.test(entry.version)) {
    throw new Error("The registry package has an invalid id or version binding");
  }
  if (typeof entry.url !== "string" || !entry.url.trim()) throw new Error("The registry package URL is missing");
  if (typeof entry.sha256 !== "string" || !ENTRY_HASH.test(entry.sha256)) {
    throw new Error("The registry package has no valid SHA-256 binding");
  }
  if (!Number.isSafeInteger(entry.size) || entry.size <= 0 || entry.size > PACKAGE_LIMIT) {
    throw new Error("The registry package has no valid size binding");
  }
}

function secureUrl(value: string): URL {
  const url = new URL(value);
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "::1";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) {
    throw new Error("Plugin registries and packages require HTTPS (HTTP is accepted only on localhost)");
  }
  if (url.username || url.password) throw new Error("Plugin registry URLs cannot contain credentials");
  url.hash = "";
  return url;
}

function responseTarget(response: Response, fallback: URL): URL {
  return response.url ? secureUrl(response.url) : fallback;
}

async function readLimited(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(`The ${label} exceeds its size limit`);
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) throw new Error(`The ${label} exceeds its size limit`);
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new Error(`The ${label} exceeds its size limit`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Permissions this entry asks for that the installed version does not have. */
export function permissionDiff(
  entry: RegistryEntry,
  granted: ExtensionPermission[],
): { added: ExtensionPermission[]; removed: ExtensionPermission[] } {
  const has = new Set(granted);
  const wants = new Set(entry.permissions);
  return {
    added: entry.permissions.filter((permission) => !has.has(permission)),
    removed: granted.filter((permission) => !wants.has(permission)),
  };
}

let transientRegistryUrl = "";

export function registryUrl(): string {
  try {
    return localStorage.getItem(REGISTRY_URL_KEY) ?? transientRegistryUrl;
  } catch {
    return transientRegistryUrl;
  }
}

export function setRegistryUrl(url: string): void {
  transientRegistryUrl = url;
  try {
    if (url) localStorage.setItem(REGISTRY_URL_KEY, url);
    else localStorage.removeItem(REGISTRY_URL_KEY);
  } catch {
    // The transient value keeps the registry usable for this tab.
  }
}
