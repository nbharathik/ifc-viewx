// @vitest-environment node
import { describe, expect, it } from "vitest";

import { collectProjectMetrics } from "../scripts/project-metrics.mjs";

describe("project metrics", () => {
  it("reports deterministic source areas and optional build artifacts", async () => {
    const metrics = await collectProjectMetrics({ includeBuild: false });
    expect(metrics.schemaVersion).toBe(1);
    expect(metrics.source.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(metrics.source.totals.files).toBeGreaterThan(0);
    expect(metrics.source.areas["src/viewer-core"]?.files).toBeGreaterThan(0);
    expect(metrics.build).toBeNull();
  });
});
