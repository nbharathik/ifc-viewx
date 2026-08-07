import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages serves the site from /<repo-name>/, so the base must match.
// Override with VITE_BASE=/ for local preview or custom domains.
const base = process.env.VITE_BASE ?? "/ifc-viewx/";

// Stamped into exported reports, so a result can be traced to the build that
// produced it. Read here rather than imported, to keep package.json out of the
// bundle.
const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

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
        // make every session pay for a panel most never open.
        manualChunks: (id) =>
          id.includes("node_modules/three-mesh-bvh") ? undefined
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
