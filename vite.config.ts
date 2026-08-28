import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages serves the site from /<repo-name>/, so the base must match.
// Override with VITE_BASE=/ for local preview or custom domains.
const base = process.env.VITE_BASE ?? "/ifc-viewx/";

// Stamped into exported reports, so a result can be traced to the build that
// produced it. Read here rather than imported, to keep package.json out of the
// bundle.
const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

/** Keep the install-time cache small enough to remain reliable on mobile storage. */
export const OFFLINE_SHELL_BUDGET_BYTES = 2 * 1024 * 1024;

/** List emitted files so the worker can recognise, but not eagerly fetch, lazy assets. */
async function listOutputFiles(directory: string, relative = ""): Promise<string[]> {
  const entries = await readdir(resolve(directory, relative), { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listOutputFiles(directory, path));
    else files.push(path);
  }
  return files;
}

function attribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? null;
}

/**
 * Find only the resources needed to boot the viewer. Vite writes the entry,
 * its static imports and its stylesheet into index.html; everything else is
 * a lazy feature, worker or heavyweight runtime and belongs in the on-demand
 * cache instead.
 */
export function shellFiles(files: readonly string[], indexHtml: string): string[] {
  const selected = new Set<string>();
  if (files.includes("index.html")) selected.add("index.html");

  for (const match of indexHtml.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const kind = match[1]?.toLowerCase();
    const tag = match[0];
    const reference = kind === "script"
      ? attribute(tag, "src")
      : attribute(tag, "rel")?.toLowerCase().split(/\s+/).some((rel) => rel === "stylesheet" || rel === "modulepreload")
        ? attribute(tag, "href")
        : null;
    if (!reference || /^(?:data:|https?:|\/\/)/i.test(reference)) continue;

    const pathname = new URL(reference, "https://ifcviewx.invalid/").pathname;
    const file = files.find((candidate) => pathname === `/${candidate}` || pathname.endsWith(`/${candidate}`));
    if (file) selected.add(file);
  }

  return [...selected].sort();
}

/** Write a content-versioned worker after every build artifact exists. */
export async function writeOfflineWorker(directory: string): Promise<void> {
  const template = await readFile(new URL("./public/sw.js", import.meta.url), "utf8");
  const files = (await listOutputFiles(directory))
    .filter((file) => file !== "sw.js" && !file.endsWith(".map"))
    .sort();
  const hash = createHash("sha256");
  hash.update(version);
  hash.update(template);
  const contents = new Map<string, Buffer>();
  for (const file of files) {
    const content = await readFile(resolve(directory, file));
    contents.set(file, content);
    hash.update(file);
    hash.update(content);
  }
  const digest = hash.digest("hex").slice(0, 12);
  const shell = shellFiles(files, contents.get("index.html")?.toString("utf8") ?? "");
  const shellBytes = shell.reduce((total, file) => total + (contents.get(file)?.byteLength ?? 0), 0);
  if (shellBytes > OFFLINE_SHELL_BUDGET_BYTES) {
    throw new Error(
      `Offline shell is ${(shellBytes / 1024 / 1024).toFixed(2)} MiB; `
      + `the ${(OFFLINE_SHELL_BUDGET_BYTES / 1024 / 1024).toFixed(0)} MiB budget prevents eager-cache regressions.`,
    );
  }
  const precache = shell.map((file) => `./${file}`);
  const runtime = files.filter((file) => !shell.includes(file)).map((file) => `./${file}`);
  const worker = template
    .replace('"__IFCVIEWX_VERSION__"', JSON.stringify(`${version}-${digest}`))
    .replace("__IFCVIEWX_PRECACHE__", JSON.stringify(precache, null, 2))
    .replace("__IFCVIEWX_RUNTIME__", JSON.stringify(runtime, null, 2));
  await writeFile(resolve(directory, "sw.js"), worker, "utf8");
}

function offlineWorker(): Plugin {
  let outputDirectory = "dist";
  let root = process.cwd();
  return {
    name: "ifcviewx-offline-worker",
    apply: "build",
    configResolved(config) {
      root = config.root;
      outputDirectory = config.build.outDir;
    },
    async closeBundle() {
      await writeOfflineWorker(resolve(root, outputDirectory));
    },
  };
}

export default defineConfig({
  base,
  define: { __APP_VERSION__: JSON.stringify(version) },
  server: {
    // Vite does not read PORT on its own. Honouring it lets a tool that has
    // already been handed a free port use it; unset, Vite picks its own
    // default, so running `npm run dev` by hand is unchanged. The Local
    // Studio bridge trusts any localhost origin, so no port is special.
    port: Number(process.env.PORT) || undefined,
  },
  resolve: {
    alias: {
      // The one specifier a plugin imports. Kept in step with tsconfig paths.
      "@ifcviewx/sdk": fileURLToPath(new URL("./src/sdk/index.ts", import.meta.url)),
    },
  },
  plugins: [
    viteStaticCopy({
      targets: [
        // web-ifc's WASM binary is fetched at runtime by the parser worker.
        { src: "node_modules/web-ifc/web-ifc.wasm", dest: "wasm" },
      ],
    }),
    offlineWorker(),
  ],
  worker: {
    format: "es",
    rollupOptions: {
      output: {
        // web-ifc's glue is 3.5 MB and three separate bundles pull it in: the
        // viewer's parser worker, the semantic worker, and the inline
        // fallback. As a shared chunk it is downloaded and parsed once.
        manualChunks: (id) => (id.includes("node_modules/web-ifc") ? "web-ifc" : undefined),
      },
    },
  },
  build: {
    target: "es2022",
    sourcemap: false,
    // Three.js + web-ifc are the app; the default 500 kB nag does not apply.
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        // Three rarely changes; a separate chunk downloads in parallel and
        // stays cached across app deploys. web-ifc is split for the same
        // reason and so the inline fallback shares it with the workers.
        // three-mesh-bvh is deliberately excluded: it belongs to the clash
        // worker, and folding it into the always-loaded three chunk would
        // make every session pay for a panel most never open. The three
        // example exporters are excluded for the same reason: src/export
        // imports them dynamically and they must stay lazy.
        manualChunks: (id) =>
          id.includes("node_modules/three-mesh-bvh") ? undefined
          : id.includes("node_modules/three/examples/jsm/exporters") ? undefined
          : id.includes("node_modules/three") ? "three"
          : id.includes("node_modules/web-ifc") ? "web-ifc"
          : undefined,
        // Every plugin panel is its own lazy chunk, and they are all called
        // panel.ts, so name them after the folder. What a plugin costs is then
        // readable straight off the build output.
        chunkFileNames: (chunk) => {
          const plugin = /src[\\/]plugins[\\/]([^\\/]+)[\\/]panel\.ts$/.exec(chunk.facadeModuleId ?? "");
          return plugin ? `assets/plugin-${plugin[1]}-[hash].js` : "assets/[name]-[hash].js";
        },
      },
    },
  },
});
