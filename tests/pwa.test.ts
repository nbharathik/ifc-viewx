// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { writeOfflineWorker } from "../vite.config.js";

const worker = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8")) as {
  icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
  shortcuts?: unknown[];
  file_handlers?: Array<{ accept?: Record<string, string[]> }>;
};

describe("the installable field shell", () => {
  it("uses an atomic build-generated precache and only deletes its own old caches", () => {
    expect(worker).toContain("__IFCVIEWX_PRECACHE__");
    expect(worker).toContain("cache.addAll");
    expect(worker).toContain("ifcviewx:${scope.pathname}:");
    expect(worker).toContain("key.startsWith(CACHE_PREFIX)");
    expect(worker).toContain("cache.match(INDEX)");
    expect(worker).not.toContain(".then(() => self.skipWaiting())");
    expect(worker).not.toMatch(/\.json\)\$|includes\(["']\/assets\//);
  });

  it("does not hijack documentation or other navigations inside its scope", () => {
    expect(worker).toContain("url.pathname !== scope.pathname && url.pathname !== INDEX.pathname");
    expect(worker).not.toContain("caches.match(request)");
  });

  it("versions and precaches every file present in the completed build output", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "ifcviewx-pwa-"));
    try {
      mkdirSync(resolve(directory, "assets"));
      writeFileSync(resolve(directory, "index.html"), "shell");
      writeFileSync(resolve(directory, "manifest.webmanifest"), "{}");
      writeFileSync(resolve(directory, "assets", "lazy.js"), "export default 1");
      writeFileSync(resolve(directory, "ignored.map"), "source map");
      writeFileSync(resolve(directory, "sw.js"), "unstamped public copy");

      await writeOfflineWorker(directory);

      const built = readFileSync(resolve(directory, "sw.js"), "utf8");
      expect(built).toContain('"./assets/lazy.js"');
      expect(built).toContain('"./index.html"');
      expect(built).toContain('"./manifest.webmanifest"');
      expect(built).not.toContain("ignored.map");
      expect(built).not.toContain("__IFCVIEWX_VERSION__");
      expect(built).not.toContain("__IFCVIEWX_PRECACHE__");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not advertise a broken shortcut and declares supported launch files", () => {
    expect(manifest.shortcuts).toBeUndefined();
    const extensions = Object.values(manifest.file_handlers?.[0]?.accept ?? {}).flat();
    expect(extensions).toEqual(expect.arrayContaining([".ifc", ".ifcx", ".ifcpkg"]));
  });
});
