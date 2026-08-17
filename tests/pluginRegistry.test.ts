import { describe, expect, it } from "vitest";
import { findPlugin } from "../src/plugins/registry.js";

describe("extension registry", () => {
  it("discovers every bundled tool through the current extension manifest", () => {
    for (const id of ["storeys", "explorer", "clash", "model-health", "python", "finder", "spaces", "takeoff", "ids-studio"]) {
      expect(findPlugin(id)?.extension).toMatchObject({ manifestVersion: 2, id });
    }
  });
});
