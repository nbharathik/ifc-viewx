import { unzipSync } from "fflate";
import { validateManifest } from "../manifest.js";
import type { PreparedExtensionPackage } from "./types.js";

export const PACKAGE_LIMITS = {
  compressedBytes: 5 * 1024 * 1024,
  uncompressedBytes: 12 * 1024 * 1024,
  fileBytes: 2 * 1024 * 1024,
  entryBytes: 1024 * 1024,
  files: 128,
} as const;

export class ExtensionPackageError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "ExtensionPackageError";
  }
}

interface ZipEntry {
  path: string;
  size: number;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

function safePath(path: string): boolean {
  if (!path || /[\u0000-\u001f\u007f]/.test(path) || path.includes("\\") || path.startsWith("/") || /^[A-Za-z]:/.test(path)) return false;
  const parts = path.split("/");
  return parts.every((part) => part !== "" && part !== "." && part !== ".." &&
    part.toLowerCase() !== "__proto__" && part.toLowerCase() !== "prototype" && part.toLowerCase() !== "constructor");
}

function centralDirectory(bytes: Uint8Array): ZipEntry[] {
  const uint16 = (at: number): number => bytes[at] | (bytes[at + 1] << 8);
  const uint32 = (at: number): number =>
    (bytes[at] | (bytes[at + 1] << 8) | (bytes[at + 2] << 16) | (bytes[at + 3] << 24)) >>> 0;
  const floor = Math.max(0, bytes.length - 65_557);
  let end = -1;
  for (let at = bytes.length - 22; at >= floor; at--) {
    if (uint32(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  if (end < 0) throw new ExtensionPackageError("The package is not a supported ZIP archive", "zip");
  // The classic EOCD can sit inside the last entry's comment while a ZIP64
  // locator hides the real, larger directory that fflate would follow past
  // every limit checked below.
  if (end >= 20 && uint32(end - 20) === 0x07064b50) {
    throw new ExtensionPackageError("Multi-disk and ZIP64 packages are not supported", "zip-profile");
  }
  const disk = uint16(end + 4);
  const centralDisk = uint16(end + 6);
  const entriesOnDisk = uint16(end + 8);
  const entries = uint16(end + 10);
  const centralSize = uint32(end + 12);
  const centralOffset = uint32(end + 16);
  const commentLength = uint16(end + 20);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries || entries === 0xffff ||
      centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    throw new ExtensionPackageError("Multi-disk and ZIP64 packages are not supported", "zip-profile");
  }
  if (entries > PACKAGE_LIMITS.files) {
    throw new ExtensionPackageError(`Packages may contain at most ${PACKAGE_LIMITS.files} files; this archive declares ${entries}`, "file-count");
  }
  if (end + 22 + commentLength !== bytes.length || centralOffset + centralSize !== end) {
    throw new ExtensionPackageError("The ZIP central directory does not match the archive", "zip");
  }

  const found: ZipEntry[] = [];
  const paths = new Set<string>();
  let total = 0;
  let at = centralOffset;
  for (let index = 0; index < entries; index++) {
    if (at + 46 > end || uint32(at) !== 0x02014b50) {
      throw new ExtensionPackageError("The ZIP central directory is malformed", "zip");
    }
    const flags = uint16(at + 8);
    const method = uint16(at + 10);
    const size = uint32(at + 24);
    const nameLength = uint16(at + 28);
    const extraLength = uint16(at + 30);
    const commentLength = uint16(at + 32);
    const external = uint32(at + 38);
    const next = at + 46 + nameLength + extraLength + commentLength;
    if (next > end) throw new ExtensionPackageError("A ZIP entry extends beyond the package", "zip");
    if (flags & 1) throw new ExtensionPackageError("Encrypted package entries are not supported", "encrypted");
    if (method !== 0 && method !== 8) throw new ExtensionPackageError("Only stored or deflated ZIP entries are supported", "compression");
    const path = textDecoder.decode(bytes.subarray(at + 46, at + 46 + nameLength));
    at = next;
    const directory = path.endsWith("/");
    const normalizedPath = directory ? path.slice(0, -1) : path;
    if (!safePath(normalizedPath)) throw new ExtensionPackageError(`Unsafe package path: ${path}`, "path");
    const key = normalizedPath.toLowerCase();
    if (paths.has(key)) throw new ExtensionPackageError(`Duplicate package path: ${path}`, "duplicate-path");
    paths.add(key);
    const mode = external >>> 16;
    if ((mode & 0o170000) === 0o120000) throw new ExtensionPackageError(`Symbolic links are not allowed: ${path}`, "symlink");
    if (size > PACKAGE_LIMITS.fileBytes) throw new ExtensionPackageError(`${path} exceeds the per-file size limit`, "file-size");
    total += size;
    if (total > PACKAGE_LIMITS.uncompressedBytes) {
      throw new ExtensionPackageError("The unpacked package is too large", "uncompressed-size");
    }
    if (directory) {
      if (size !== 0) throw new ExtensionPackageError(`Directory entries cannot carry data: ${path}`, "directory-data");
      continue;
    }
    found.push({ path, size });
  }
  if (at !== centralOffset + centralSize) {
    throw new ExtensionPackageError("The ZIP central directory entry count is inconsistent", "zip");
  }
  return found;
}

function validateEntryHtml(html: string): void {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (document.querySelector("parsererror")) throw new ExtensionPackageError("The panel entry is not valid HTML", "entry-html");
  const forbidden = document.querySelector("base, iframe, frame, object, embed, form, meta[http-equiv='refresh' i]");
  if (forbidden) throw new ExtensionPackageError(`<${forbidden.tagName.toLowerCase()}> is not allowed in a sandbox entry`, "entry-html");
  const external = document.querySelector("script[src], link[href]");
  if (external) throw new ExtensionPackageError("The first package format requires self-contained inline scripts and styles", "external-asset");
  const navigation = document.querySelector("a[ping], area[ping]") ?? [...document.querySelectorAll("a[href], area[href]")].find((element) => {
    const href = element.getAttribute("href")?.trim() ?? "";
    return !href.startsWith("#");
  });
  if (navigation) throw new ExtensionPackageError("Navigation links are not allowed in a sandbox entry", "navigation");
  for (const element of document.querySelectorAll<HTMLElement>("img[src], audio[src], video[src], source[src]")) {
    const value = element.getAttribute("src")?.trim() ?? "";
    if (value && !value.startsWith("data:") && !value.startsWith("blob:")) {
      throw new ExtensionPackageError("Media in the entry must use data or blob URLs", "external-asset");
    }
  }
  for (const style of document.querySelectorAll("style")) {
    if (/@import\b|url\s*\(\s*["']?(?:https?:|\/\/)/i.test(style.textContent ?? "")) {
      throw new ExtensionPackageError("Styles cannot import network resources", "network-resource");
    }
  }
}

async function sha256(bytes: Uint8Array): Promise<string> {
  if (!globalThis.crypto?.subtle) throw new ExtensionPackageError("This browser cannot hash extension packages", "crypto");
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export async function prepareExtensionPackage(input: Uint8Array): Promise<PreparedExtensionPackage> {
  if (input.byteLength === 0) throw new ExtensionPackageError("The package is empty", "empty");
  if (input.byteLength > PACKAGE_LIMITS.compressedBytes) {
    throw new ExtensionPackageError("The package exceeds the 5 MB compressed size limit", "compressed-size");
  }
  const listed = centralDirectory(input);
  if (!listed.some((entry) => entry.path === "extension.json")) {
    throw new ExtensionPackageError("extension.json must be at the package root", "manifest");
  }

  let unpacked: Record<string, Uint8Array>;
  try {
    unpacked = unzipSync(input);
  } catch (error) {
    throw new ExtensionPackageError(`The package could not be unpacked: ${error instanceof Error ? error.message : String(error)}`, "zip");
  }
  const files = new Map<string, Uint8Array>();
  for (const entry of listed) {
    const data = unpacked[entry.path];
    if (!data || data.byteLength !== entry.size) throw new ExtensionPackageError(`Package entry is corrupt: ${entry.path}`, "zip");
    files.set(entry.path, data);
  }

  let rawManifest: unknown;
  try {
    rawManifest = JSON.parse(textDecoder.decode(files.get("extension.json")!));
  } catch (error) {
    throw new ExtensionPackageError(`extension.json is invalid: ${error instanceof Error ? error.message : String(error)}`, "manifest");
  }
  const validation = validateManifest(rawManifest, { runtime: "sandboxed" });
  if (!validation.manifest) {
    throw new ExtensionPackageError(
      `extension.json is invalid:\n${validation.issues.map((issue) => `- ${issue.path}: ${issue.message}`).join("\n")}`,
      "manifest",
    );
  }
  const panels = validation.manifest.contributes.panels ?? [];
  if (panels.length !== 1) {
    throw new ExtensionPackageError("The first installed package format requires exactly one panel contribution", "contributions");
  }
  if (!validation.manifest.activationEvents.includes(`onPanel:${panels[0].id}`)) {
    throw new ExtensionPackageError(`activationEvents must include onPanel:${panels[0].id}`, "activation");
  }
  const entry = files.get(validation.manifest.runtime.entry);
  if (!entry) throw new ExtensionPackageError(`Missing runtime entry: ${validation.manifest.runtime.entry}`, "entry");
  if (entry.byteLength > PACKAGE_LIMITS.entryBytes) throw new ExtensionPackageError("The panel entry exceeds the 1 MB limit", "entry-size");
  let entryHtml: string;
  try {
    entryHtml = textDecoder.decode(entry);
  } catch {
    throw new ExtensionPackageError("The panel entry must be UTF-8 HTML", "entry-html");
  }
  validateEntryHtml(entryHtml);
  return {
    manifest: validation.manifest,
    hash: await sha256(input),
    bytes: input.slice(),
    files,
    entryHtml,
  };
}
