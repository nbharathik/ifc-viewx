// @vitest-environment node
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { architectureReport, stronglyConnected, unapprovedCycles } from "../scripts/check-boundaries.mjs";

describe("architecture boundaries", () => {
  it("detects strongly connected components", () => {
    const graph = new Map([
      ["a", ["b"]],
      ["b", ["a", "c"]],
      ["c", []],
    ]);
    expect(stronglyConnected(graph)).toEqual([["a", "b"]]);
  });

  it("adds no dependency cycle or boundary violation", async () => {
    const baseline = JSON.parse(await readFile(
      new URL("../docs/refactor/architecture-baseline.json", import.meta.url),
      "utf8",
    )) as { allowedCycles: string[][] };
    const report = await architectureReport();
    expect(report.violations).toEqual([]);
    expect(unapprovedCycles(report, baseline)).toEqual([]);
  });
});
