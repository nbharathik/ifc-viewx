import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const { version } = createRequire(import.meta.url)("./package.json") as { version: string };

export default defineConfig({
  // Kept in step with vite.config.ts: the report stamps the build version, so
  // a test that renders one needs the same constant.
  define: { __APP_VERSION__: JSON.stringify(version) },
  resolve: {
    alias: {
      "@ifcviewx/sdk": fileURLToPath(new URL("./src/sdk/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    // A jsdom instance per CPU can exhaust memory on high-core developer
    // machines and starve slower workbook/WASM tests. Four keeps useful
    // parallelism while making the suite deterministic locally and in CI.
    maxWorkers: 4,
    // UI modules reach for `document` at import time, so even the pure logic
    // they sit beside needs a DOM to be importable.
    environment: "jsdom",
    // web-ifc compiles Wasm and workbook tests compress ZIPs in-process. Keep
    // headroom for their cold tests on contended runners without removing the
    // guard against genuinely stuck work.
    testTimeout: 45_000,
  },
});
