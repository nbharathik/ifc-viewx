import { describe, expect, it, vi } from "vitest";
import { zipSync } from "fflate";

import {
  fetchPackage,
  fetchRegistry,
  parseRegistry,
  permissionDiff,
  sha256Hex,
  verifyIndex,
  REGISTRY_FORMAT,
  type RegistryEntry,
} from "../src/extensions/registry.js";
import { InstalledExtensionManager } from "../src/extensions/installed/manager.js";
import { MemoryExtensionStore } from "../src/extensions/installed/store.js";
import type { ExtensionManifest } from "../src/sdk/contributions.js";

const EXTENSION_ID = "org.acme.tools";

const entry = (patch: Partial<RegistryEntry> = {}): RegistryEntry => ({
  id: EXTENSION_ID,
  name: "Acme Tools",
  version: "1.2.0",
  description: "A plugin",
  url: "packages/acme-1.2.0.zip",
  sha256: "a".repeat(64),
  size: 4096,
  publisher: "Acme",
  permissions: ["model.structure.read"],
  ...patch,
});

const index = (packages: RegistryEntry[]) =>
  JSON.stringify({ format: REGISTRY_FORMAT, version: 1, name: "Acme registry", updatedAt: "2026-08-01", packages });

const base64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};

function extensionArchive(): Uint8Array {
  const manifest: ExtensionManifest = {
    manifestVersion: 2,
    id: EXTENSION_ID,
    name: "Acme Tools",
    version: "1.2.0",
    sdk: ">=2.0.0 <3",
    description: "A signed registry package fixture.",
    publisher: { name: "Acme" },
    runtime: { kind: "sandboxed", entry: "panel.html" },
    activationEvents: ["onPanel:main"],
    permissions: ["model.structure.read"],
    contributes: { panels: [{ id: "main", title: "Acme Tools" }] },
    catalog: {
      tagline: "Registry fixture",
      about: "Proves signed package resolution and installation.",
      icon: "blocks",
      category: "Tests",
      keywords: "signed registry",
      does: ["Install from a signed registry"],
    },
  };
  const encode = (value: string): Uint8Array => new TextEncoder().encode(value);
  return zipSync({
    "extension.json": encode(JSON.stringify(manifest)),
    "panel.html": encode("<!doctype html><html><body><script>IFCViewX.ready()</script></body></html>"),
  });
}

describe("parsing an index", () => {
  it("reads a well-formed index", () => {
    const parsed = parseRegistry(index([entry()]));
    expect(parsed.name).toBe("Acme registry");
    expect(parsed.packages).toHaveLength(1);
    expect(parsed.packages[0].id).toBe(EXTENSION_ID);
  });

  it("accepts only well-formed reverse-domain package ids", () => {
    const parsed = parseRegistry(index([
      entry(),
      entry({ id: "acme-tools" }),
      entry({ id: "org..acme" }),
      entry({ id: "org.acme." }),
      entry({ id: "Org.acme" }),
    ]));
    expect(parsed.packages.map((item) => item.id)).toEqual([EXTENSION_ID]);
  });

  it("uses the manifest SemVer rules for registry version pins", () => {
    const parsed = parseRegistry(index([
      entry({ version: "1.2.0+build.7" }),
      entry({ id: "org.acme.leading-zero", version: "01.2.0" }),
      entry({ id: "org.acme.bad-prerelease", version: "1.2.0-beta.01" }),
    ]));
    expect(parsed.packages.map(({ id, version }) => [id, version])).toEqual([
      [EXTENSION_ID, "1.2.0+build.7"],
    ]);
  });

  it("refuses a file that is not a registry", () => {
    expect(() => parseRegistry(JSON.stringify({ packages: [] }))).toThrow();
    expect(() => parseRegistry(JSON.stringify({ format: REGISTRY_FORMAT }))).toThrow();
    expect(() => parseRegistry(JSON.stringify({ format: REGISTRY_FORMAT, version: 2, packages: [] }))).toThrow(/version/);
  });

  it("drops an entry with no usable hash rather than offering an unpinned download", () => {
    const parsed = parseRegistry(index([
      entry(),
      entry({ id: "org.acme.no-hash", sha256: "" as string }),
      entry({ id: "org.acme.short-hash", sha256: "abc" }),
    ]));
    expect(parsed.packages.map((item) => item.id)).toEqual([EXTENSION_ID]);
  });

  it("normalizes a hash written in upper case", () => {
    const parsed = parseRegistry(index([entry({ sha256: "A".repeat(64) })]));
    expect(parsed.packages[0].sha256).toBe("a".repeat(64));
  });

  it("fills in what an entry left out", () => {
    const parsed = parseRegistry(index([entry({ name: undefined as never, publisher: undefined as never })]));
    expect(parsed.packages[0].name).toBe(EXTENSION_ID);
    expect(parsed.packages[0].publisher).toBe("unknown");
  });

  it("drops entries with unknown permissions before the UI can render them", () => {
    const parsed = parseRegistry(index([entry(), entry({ id: "org.acme.bad", permissions: ["root.everything" as never] })]));
    expect(parsed.packages.map((item) => item.id)).toEqual([EXTENSION_ID]);
  });

  it("deduplicates one id and version and caps pathological catalogs", () => {
    expect(parseRegistry(index([entry(), entry()])).packages).toHaveLength(1);
    expect(() => parseRegistry(index(Array.from({ length: 1_001 }, (_, number) =>
      entry({ id: `org.acme.package-${number}`, version: "1.0.0" })))))
      .toThrow(/too many/i);
  });
});

describe("trust", () => {
  it("reports an index as unsigned when this build pins no key", async () => {
    expect(await verifyIndex(new TextEncoder().encode("{}"), "c2ln")).toBe("unsigned");
    expect(await verifyIndex(new TextEncoder().encode("{}"), null)).toBe("unsigned");
  });

  it("verifies a real P-256 signature against the supplied publisher key", async () => {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const bytes = new TextEncoder().encode(index([entry()]));
    const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, bytes));
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(await verifyIndex(bytes, base64Url(signature), publicKey)).toBe("signed");
    expect(await verifyIndex(new Uint8Array([...bytes, 0x20]), base64Url(signature), publicKey)).toBe("invalid");
  });

  it("resolves and installs a reverse-domain package from a verified signed entry", async () => {
    const packageBytes = extensionArchive();
    const registryEntry = entry({
      sha256: await sha256Hex(packageBytes),
      size: packageBytes.byteLength,
    });
    const registryBytes = new TextEncoder().encode(index([registryEntry]));
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    const signature = new Uint8Array(await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      registryBytes,
    ));
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    expect(await verifyIndex(registryBytes, base64Url(signature), publicKey)).toBe("signed");

    const [resolved] = parseRegistry(new TextDecoder().decode(registryBytes)).packages;
    expect(resolved.id).toBe(EXTENSION_ID);
    const requests: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return new Response(packageBytes.slice().buffer as ArrayBuffer);
    }) as typeof fetch;
    try {
      const downloaded = await fetchPackage(resolved, "https://registry.example.org/plugins/index.json");
      const manager = new InstalledExtensionManager(new MemoryExtensionStore());
      await manager.install(await manager.prepare(downloaded));
      expect(manager.current(EXTENSION_ID)).toMatchObject({
        version: registryEntry.version,
        hash: registryEntry.sha256,
        manifest: { id: EXTENSION_ID, runtime: { kind: "sandboxed" } },
      });
      expect(requests).toEqual(["https://registry.example.org/plugins/packages/acme-1.2.0.zip"]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("downloading a package", () => {
  const bytes = new Uint8Array([1, 2, 3, 4, 5]);

  it("accepts a package whose bytes match the pinned hash", async () => {
    const digest = await sha256Hex(bytes);
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    try {
      const got = await fetchPackage(entry({ sha256: digest, size: bytes.byteLength }), "https://example.org/index.json");
      expect([...got]).toEqual([...bytes]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses a package whose bytes do not match, and says so", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response(bytes)) as typeof fetch;
    try {
      await expect(fetchPackage(entry({ size: bytes.byteLength }), "https://example.org/index.json")).rejects.toThrow(/hash/i);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("resolves a relative package URL against the index", async () => {
    const digest = await sha256Hex(bytes);
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return new Response(bytes);
    }) as typeof fetch;
    try {
      await fetchPackage(entry({ sha256: digest, size: bytes.byteLength }), "https://example.org/plugins/index.json");
      expect(seen[0]).toBe("https://example.org/plugins/packages/acme-1.2.0.zip");
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects registry URLs carrying embedded credentials", async () => {
    await expect(fetchPackage(entry(), "https://user:secret@example.org/index.json")).rejects.toThrow(/credentials/i);
  });

  it("rejects malformed size, hash, and version pins before fetching", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as typeof fetch;
    try {
      await expect(fetchPackage(entry({ id: "acme-tools" }), "https://example.org/index.json")).rejects.toThrow(/id or version binding/i);
      await expect(fetchPackage(entry({ size: Number.NaN }), "https://example.org/index.json")).rejects.toThrow(/size binding/i);
      await expect(fetchPackage(entry({ sha256: "not-a-hash" }), "https://example.org/index.json")).rejects.toThrow(/SHA-256 binding/i);
      await expect(fetchPackage(entry({ version: "latest" }), "https://example.org/index.json")).rejects.toThrow(/version binding/i);
      await expect(fetchPackage(entry({ version: "01.2.0" }), "https://example.org/index.json")).rejects.toThrow(/version binding/i);
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("honours cancellation before starting a package request", async () => {
    const original = globalThis.fetch;
    const fetcher = vi.fn();
    globalThis.fetch = fetcher as typeof fetch;
    const controller = new AbortController();
    controller.abort();
    try {
      await expect(fetchPackage(entry(), "https://example.org/index.json", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
      expect(fetcher).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects an insecure final package URL after a redirect", async () => {
    const original = globalThis.fetch;
    const redirected = new Response(bytes);
    Object.defineProperty(redirected, "url", { value: "http://cdn.example.org/acme.zip" });
    globalThis.fetch = vi.fn(async () => redirected) as typeof fetch;
    try {
      await expect(fetchPackage(entry({ size: bytes.length }), "https://example.org/index.json")).rejects.toThrow(/HTTPS/i);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("fetching an index", () => {
  it("fails closed when a build has no publisher key", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL) =>
      String(input).endsWith(".sig")
        ? new Response("", { status: 404 })
        : new Response(index([entry()]))) as typeof fetch;
    try {
      await expect(fetchRegistry("https://example.org/index.json")).rejects.toThrow(/publisher key|required signature/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("reports the status when the registry is not there", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { status: 404 })) as typeof fetch;
    try {
      await expect(fetchRegistry("https://example.org/index.json")).rejects.toThrow(/404/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("rejects an oversized index before parsing it", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response("", { headers: { "content-length": String(2 * 1024 * 1024) } })) as typeof fetch;
    try {
      await expect(fetchRegistry("https://example.org/index.json")).rejects.toThrow(/size limit/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("uses the secure final index URL for its signature and relative packages", async () => {
    const original = globalThis.fetch;
    const seen: string[] = [];
    const redirected = new Response(index([entry()]));
    Object.defineProperty(redirected, "url", { value: "https://cdn.example.org/catalog/index.json" });
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seen.push(String(input));
      return seen.length === 1 ? redirected : new Response("", { status: 404 });
    }) as typeof fetch;
    try {
      await expect(fetchRegistry("https://example.org/index.json")).rejects.toThrow(/publisher key|required signature/);
      expect(seen).toEqual([
        "https://example.org/index.json",
        "https://cdn.example.org/catalog/index.json.sig",
      ]);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe("permission diff", () => {
  it("names what an update newly asks for and what it gives up", () => {
    const diff = permissionDiff(
      entry({ permissions: ["model.structure.read", "file.export"] }),
      ["model.structure.read", "view.control"],
    );
    expect(diff.added).toEqual(["file.export"]);
    expect(diff.removed).toEqual(["view.control"]);
  });

  it("treats a first install as everything being new", () => {
    expect(permissionDiff(entry(), []).added).toEqual(["model.structure.read"]);
  });
});
