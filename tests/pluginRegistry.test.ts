import { describe, expect, it } from "vitest";
import { findPlugin } from "../src/plugins/registry.js";

describe("plugin compatibility registry", () => {
  it("discovers SDK v2 JSON manifests and keeps SDK v1 manifests", () => {
    expect(findPlugin("storeys")).toMatchObject({ manifestVersion: 2 });
    expect(findPlugin("explorer")).toMatchObject({ manifestVersion: 2 });
    expect(findPlugin("clash")).toMatchObject({ manifestVersion: 2 });
    expect(findPlugin("python")).toMatchObject({ manifestVersion: 1 });
  });
});
