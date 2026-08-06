import { defineConfig } from "vite";
import { viteStaticCopy } from "vite-plugin-static-copy";

// GitHub Pages serves the site from /<repo-name>/, so the base must match.
// Override with VITE_BASE=/ for local preview or custom domains.
const base = process.env.VITE_BASE ?? "/ifc-viewx/";

export default defineConfig({
  base,
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
        manualChunks: (id) =>
          id.includes("node_modules/three") ? "three"
          : id.includes("node_modules/web-ifc") ? "web-ifc"
          : undefined,
      },
    },
  },
});
