import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // UI modules reach for `document` at import time, so even the pure logic
    // they sit beside needs a DOM to be importable.
    environment: "jsdom",
    // web-ifc has to compile its wasm before the first parse.
    testTimeout: 30_000,
  },
});
