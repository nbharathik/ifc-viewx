import { describe, expect, it, beforeEach } from "vitest";
import {
  buildReport,
  clearFindings,
  publishFindings,
  publishedFindings,
  type ReportModel,
} from "../src/ui/report.js";
import type { ValidationReport } from "../src/ifc/checks.js";
import type { IdsReport } from "../src/ui/ids.js";

const SECTIONS = ["overview", "models", "checks", "ids", "findings", "issues"];

function base(): ReportModel {
  return {
    title: "Tower A",
    generated: "7 Aug 2026, 14:00",
    app: "IFCViewX 0.1.4",
    totals: { entities: 1234, triangles: 98765, visible: 290, hidden: 3 },
    models: [{ name: "arch.ifc", elements: 200, triangles: 60000, visible: true }],
    section: "none",
    screenshot: null,
    checks: null,
    ids: null,
    findings: [],
    issues: null,
  };
}

const checks = (): ValidationReport => ({
  ok: false,
  schema: "IFC4",
  totals: { entities: 1234, rooted: 400, elements: 293 },
  counts: { error: 1, warning: 2, info: 0 },
  checks: [
    { id: "duplicate_guid", severity: "error", title: "Duplicate GlobalId", count: 2, hint: "Two entities share an identifier." },
    { id: "orphan_elements", severity: "warning", title: "Elements outside the spatial structure", count: 7 },
  ],
});

const ids = (): IdsReport => ({
  ids: "Project delivery",
  file: "spec.ids",
  specifications: [
    { name: "Walls are fire rated", status: "fail", applicable: 20, passed: 18, failed: 2, truncated: false, blockedBy: [], notChecked: [], requirements: ["FireRating"], failures: [{ id: 5, reason: "FireRating" }] },
    { name: "Doors are classified", status: "not_run", applicable: 0, passed: 0, failed: 0, truncated: false, blockedBy: ["classification"], notChecked: ["classification"], requirements: [], failures: [] },
  ],
  failedSpecifications: 1,
  notRunSpecifications: 1,
  readable: true,
});

describe("report document", () => {
  beforeEach(() => clearFindings());

  it("carries every section even when nothing ran", () => {
    const html = buildReport(base());
    for (const id of SECTIONS) expect(html).toContain(`<section id="${id}">`);
  });

  it("marks a section that did not run rather than dropping it", () => {
    const html = buildReport(base());
    // Checks, IDS, findings and issues are all absent in the base model.
    expect(html.match(/Not run\./g)).toHaveLength(4);
    expect(html).toContain("Model checks");
    expect(html).toContain("IDS validation");
  });

  it("makes no request when opened", () => {
    const model = base();
    model.screenshot = "data:image/jpeg;base64,/9j/4AAQ";
    model.issues = [
      { title: "Clash at grid B", status: "Open", priority: "High", author: "me", date: "2026-08-07T09:00:00Z", description: "Duct through beam", snapshot: "data:image/png;base64,iVBOR" },
    ];
    const html = buildReport(model);
    // Any attribute that would fetch something. data: and #anchors are inert.
    const remote = [...html.matchAll(/\b(?:src|href|srcset|action|poster|data-src)\s*=\s*"([^"]*)"/g)]
      .map((match) => match[1])
      .filter((value) => !value.startsWith("data:") && !value.startsWith("#"));
    expect(remote).toEqual([]);
    expect(html).not.toMatch(/https?:\/\//);
    expect(html).not.toContain("@import");
    expect(html).not.toContain("url(");
  });

  it("gives every federated model its own row and counts", () => {
    const model = base();
    model.models = [
      { name: "arch.ifc", elements: 200, triangles: 60000, visible: true },
      { name: "struct.ifc", elements: 93, triangles: 38765, visible: false },
      { name: "mep.ifc", elements: 41, triangles: 900, visible: true },
    ];
    const html = buildReport(model);
    for (const entry of model.models) {
      expect(html).toContain(entry.name);
      expect(html).toContain(entry.elements.toLocaleString("en-US"));
    }
    expect(html).toContain("hidden");
  });

  it("prints check severities and their counts", () => {
    const html = buildReport({ ...base(), checks: checks() });
    expect(html).toContain("Duplicate GlobalId");
    expect(html).toContain('class="pill error"');
    expect(html).toContain('class="pill warning"');
    expect(html).toContain("Schema IFC4");
  });

  it("shows a not-run IDS specification as not run, never as a pass", () => {
    const html = buildReport({ ...base(), ids: ids() });
    const idsSection = html.slice(html.indexOf('<section id="ids">'), html.indexOf('<section id="findings">'));
    expect(idsSection).toContain("Doors are classified");
    expect(idsSection).toContain("not run");
    expect(idsSection).toContain("blocked by classification");
    expect(idsSection).not.toContain('class="pill pass"');
  });

  it("says so when nothing in the model could be read", () => {
    const blind = { ...ids(), readable: false };
    const html = buildReport({ ...base(), ids: blind });
    expect(html).toContain("Nothing could be read from this model");
  });

  it("escapes model content so a crafted name cannot inject markup", () => {
    const model = base();
    model.models = [{ name: '<img src=x onerror="alert(1)">', elements: 1, triangles: 1, visible: true }];
    const html = buildReport(model);
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x");
  });

  it("stays well under 5 MB with a screenshot", () => {
    const model = base();
    // A 1100px jpeg of a busy view sits near 300 kB; this is triple that.
    model.screenshot = `data:image/jpeg;base64,${"A".repeat(900_000)}`;
    model.checks = checks();
    model.ids = ids();
    expect(new Blob([buildReport(model)]).size).toBeLessThan(5 * 1024 * 1024);
  });
});

describe("plugin findings", () => {
  beforeEach(() => clearFindings());

  it("replaces a set rather than stacking a second copy", () => {
    publishFindings({ id: "clash", source: "Clash", summary: "first", findings: [] });
    publishFindings({ id: "clash", source: "Clash", summary: "second", findings: [] });
    expect(publishedFindings()).toHaveLength(1);
    expect(publishedFindings()[0].summary).toBe("second");
  });

  it("keeps sets from different plugins apart", () => {
    publishFindings({ id: "clash", source: "Clash", summary: "a", findings: [] });
    publishFindings({ id: "spaces", source: "Spaces", summary: "b", findings: [] });
    expect(publishedFindings().map((set) => set.id)).toEqual(["clash", "spaces"]);
    clearFindings("clash");
    expect(publishedFindings().map((set) => set.id)).toEqual(["spaces"]);
  });

  it("rejects malformed plugin finding payloads", () => {
    expect(() => publishFindings({
      id: "bad",
      source: "Plugin",
      summary: "",
      findings: [{ severity: "error", title: "Bad", count: -1 }],
    })).toThrow(/count/i);
    expect(publishedFindings()).toHaveLength(0);
  });

  it("renders a published set into the findings section", () => {
    const html = buildReport({
      ...base(),
      findings: [
        {
          id: "clash",
          source: "Clash detection",
          summary: "12 hits over 10 mm",
          findings: [
            { severity: "error", title: "Hard clashes over 50 mm", count: 4, detail: "deepest 180 mm" },
            { severity: "warning", title: "Clashes under 50 mm", count: 8 },
          ],
        },
      ],
    });
    expect(html).toContain("Clash detection");
    expect(html).toContain("Hard clashes over 50 mm");
    expect(html).toContain("deepest 180 mm");
    expect(html).not.toContain("<h2>Findings</h2><p class=\"none\">Not run.</p>");
  });

  it("reports an empty result as nothing found, not as not run", () => {
    const html = buildReport({
      ...base(),
      findings: [{ id: "clash", source: "Clash detection", summary: "no hits", findings: [] }],
    });
    const section = html.slice(html.indexOf('<section id="findings">'), html.indexOf('<section id="issues">'));
    expect(section).toContain("Nothing found.");
    expect(section).not.toContain("Not run.");
  });
});
