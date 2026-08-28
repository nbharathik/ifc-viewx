// @vitest-environment node
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { OFFLINE_SHELL_BUDGET_BYTES, writeOfflineWorker } from "../vite.config.js";

const worker = readFileSync(resolve(process.cwd(), "public/sw.js"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(process.cwd(), "public/manifest.webmanifest"), "utf8")) as {
  icons?: Array<{ src?: string; sizes?: string; purpose?: string }>;
  shortcuts?: unknown[];
  file_handlers?: Array<{ accept?: Record<string, string[]> }>;
};

describe("the installable field shell", () => {
  it("keeps lazy output out of install-time work and only deletes its own old caches", () => {
    expect(worker).toContain("__IFCVIEWX_PRECACHE__");
    expect(worker).toContain("__IFCVIEWX_RUNTIME__");
    expect(worker).not.toContain("cache.addAll");
    expect(worker).toContain("installShell()");
    expect(worker).toContain("MAX_RUNTIME_ENTRIES = 32");
    expect(worker).toContain("runtime:${VERSION}");
    expect(worker).toContain("RUNTIME_URLS.has(url.href)");
    expect(worker).toContain("cache && copy ? storeRuntime");
    expect(worker).toContain("An unavailable cache must not make an online application unavailable");
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

  it("precaches only the HTML boot graph and recognises lazy output for runtime caching", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "ifcviewx-pwa-"));
    try {
      mkdirSync(resolve(directory, "assets"));
      mkdirSync(resolve(directory, "wasm"));
      writeFileSync(resolve(directory, "index.html"), [
        '<link rel="manifest" href="./manifest.webmanifest">',
        '<link rel="stylesheet" href="/ifc-viewx/assets/app.css">',
        '<link rel="modulepreload" href="/ifc-viewx/assets/vendor.js">',
        '<script type="module" src="/ifc-viewx/assets/app.js"></script>',
      ].join("\n"));
      writeFileSync(resolve(directory, "manifest.webmanifest"), "{}");
      writeFileSync(resolve(directory, "assets", "app.css"), "body{}");
      writeFileSync(resolve(directory, "assets", "app.js"), "import './vendor.js'");
      writeFileSync(resolve(directory, "assets", "vendor.js"), "export default 1");
      writeFileSync(resolve(directory, "assets", "lazy.js"), "export default 1");
      writeFileSync(resolve(directory, "wasm", "web-ifc.wasm"), "optional wasm");
      writeFileSync(resolve(directory, "ignored.map"), "source map");
      writeFileSync(resolve(directory, "sw.js"), "unstamped public copy");

      await writeOfflineWorker(directory);

      const built = readFileSync(resolve(directory, "sw.js"), "utf8");
      const precache = injectedList(built, "PRECACHE");
      const runtime = injectedList(built, "RUNTIME");
      expect(precache).toEqual([
        "./assets/app.css",
        "./assets/app.js",
        "./assets/vendor.js",
        "./index.html",
      ]);
      expect(runtime).toEqual(expect.arrayContaining([
        "./assets/lazy.js",
        "./manifest.webmanifest",
        "./wasm/web-ifc.wasm",
      ]));
      for (const path of precache) expect(runtime).not.toContain(path);
      expect(built).not.toContain("ignored.map");
      expect(built).not.toContain("__IFCVIEWX_VERSION__");
      expect(built).not.toContain("__IFCVIEWX_PRECACHE__");
      expect(built).not.toContain("__IFCVIEWX_RUNTIME__");
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails the build when the eager offline shell exceeds its size budget", async () => {
    const directory = mkdtempSync(resolve(tmpdir(), "ifcviewx-pwa-budget-"));
    try {
      mkdirSync(resolve(directory, "assets"));
      writeFileSync(resolve(directory, "index.html"), '<script type="module" src="./assets/app.js"></script>');
      writeFileSync(resolve(directory, "assets", "app.js"), Buffer.alloc(OFFLINE_SHELL_BUDGET_BYTES + 1));
      await expect(writeOfflineWorker(directory)).rejects.toThrow("budget prevents eager-cache regressions");
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

function injectedList(source: string, name: "PRECACHE" | "RUNTIME"): string[] {
  const match = new RegExp(`const ${name} = (\\[[\\s\\S]*?\\]);`).exec(source);
  if (!match?.[1]) throw new Error(`Missing ${name} list`);
  return JSON.parse(match[1]) as string[];
}
