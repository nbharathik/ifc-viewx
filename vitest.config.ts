import { createRequire } from "node:module";
import { defineConfig } from "vitest/config";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  // Kept in step with vite.config.ts: the report stamps the build version, so
  // a test that renders one needs the same constant.
  define: { __APP_VERSION__: JSON.stringify(version) },
  test: {
    include: ["tests/**/*.test.ts"],
    // UI modules reach for `document` at import time, so even the pure logic
    // they sit beside needs a DOM to be importable.
    environment: "jsdom",
    // web-ifc has to compile its wasm before the first parse.
    testTimeout: 30_000,
  },
});
