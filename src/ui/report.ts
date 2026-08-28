// Report: one self-contained HTML document. Inline CSS, the screenshot as a
// data URI, no request of any kind when it opens, so it survives being emailed
// or dropped in a shared folder. PDF is the browser's own print path against
// the print stylesheet, which costs no library and gets fonts and page breaks
// right for free.
//
// Every section is always present. A section with nothing behind it says "not
// run" rather than being dropped, because a missing section and a clean one
// look identical once the page is printed.
import type { ValidationReport } from "../ifc/checks.js";
import type { IdsReport } from "./ids.js";
import type { Viewer } from "../viewer-core/viewer.js";
import { clearFindings, publishFindings, publishedFindings } from "../results/findings.js";
import type { FindingSet, ReportFinding, Severity } from "../results/findings.js";

export { clearFindings, publishFindings, publishedFindings };
export type { FindingSet, ReportFinding, Severity };

export interface ReportIssue {
  title: string;
  status: string;
  priority: string;
  author: string;
  date: string;
  description: string;
  snapshot: string | null;
}

export interface ReportModel {
  title: string;
  generated: string;
  app: string;
  totals: { entities: number; triangles: number; visible: number; hidden: number };
  models: Array<{ name: string; elements: number; triangles: number; visible: boolean }>;
  section: string;
  screenshot: string | null;
  checks: ValidationReport | null;
  ids: IdsReport | null;
  findings: FindingSet[];
  issues: ReportIssue[] | null;
}

const esc = (text: string): string =>
  text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] ?? c);

const num = (value: number): string => value.toLocaleString("en-US");

const rows = (cells: string[][]): string =>
  cells.map((row) => `<tr>${row.map((cell) => `<td>${cell}</td>`).join("")}</tr>`).join("");

const table = (head: string[], body: string[][]): string =>
  `<table><thead><tr>${head.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows(body)}</tbody></table>`;

const pill = (severity: Severity | "pass" | "not_run" | "fail", text: string): string =>
  `<span class="pill ${severity}">${esc(text)}</span>`;

/** A section is never omitted; with nothing behind it, it says so. */
function section(id: string, title: string, body: string | null): string {
  return (
    `<section id="${id}"><h2>${esc(title)}</h2>` +
    (body ?? `<p class="none">Not run.</p>`) +
    `</section>`
  );
}

function overview(model: ReportModel): string {
  const tiles: Array<[string, string]> = [
    ["Entities", num(model.totals.entities)],
    ["Triangles", num(model.totals.triangles)],
    ["Visible elements", num(model.totals.visible)],
    ["Hidden elements", num(model.totals.hidden)],
    ["Models", num(model.models.length)],
    ["Section", model.section],
  ];
  const shot = model.screenshot
    ? `<figure><img src="${model.screenshot}" alt="View of the model at the time of the report" /><figcaption>The view this report was taken from.</figcaption></figure>`
    : `<p class="none">No screenshot was captured.</p>`;
  return (
    `<div class="tiles">` +
    tiles.map(([label, value]) => `<div class="tile"><span class="k">${esc(label)}</span><span class="v">${esc(value)}</span></div>`).join("") +
    `</div>` +
    shot
  );
}

function models(model: ReportModel): string | null {
  if (model.models.length === 0) return null;
  return table(
    ["Model", "Elements", "Triangles", "State"],
    model.models.map((entry) => [
      esc(entry.name),
      num(entry.elements),
      num(entry.triangles),
      entry.visible ? "visible" : "hidden",
    ]),
  );
}

function checks(report: ValidationReport | null): string | null {
  if (!report) return null;
  const plural = (count: number, one: string): string => `${num(count)} ${one}${count === 1 ? "" : "s"}`;
  const counts =
    `<p class="lede">${report.ok ? "No errors." : `${plural(report.counts.error, "error")}.`} ` +
    `${plural(report.counts.warning, "warning")}, ${plural(report.counts.info, "note")}. Schema ${esc(report.schema)}.</p>`;
  if (report.checks.length === 0) return `${counts}<p class="none">Every check passed.</p>`;
  return (
    counts +
    table(
      ["", "Check", "Count", "What it means"],
      report.checks.map((check) => [
        pill(check.severity, check.severity),
        esc(check.title),
        num(check.count),
        esc(check.hint ?? ""),
      ]),
    )
  );
}

function ids(report: IdsReport | null): string | null {
  if (!report) return null;
  const notRun = report.notRunSpecifications;
  const lede =
    `<p class="lede">${esc(report.ids)}${report.file ? ` (${esc(report.file)})` : ""}. ` +
    `${num(report.specifications.length)} specifications, ${num(report.failedSpecifications)} with failures` +
    (notRun ? `, ${num(notRun)} not run` : "") +
    `.</p>` +
    (report.readable
      ? ""
      : `<p class="warn">Nothing could be read from this model, so these results describe no elements.</p>`);
  return (
    lede +
    table(
      ["", "Specification", "Applicable", "Passed", "Failed", "Note"],
      report.specifications.map((spec) => [
        pill(spec.status, spec.status === "not_run" ? "not run" : spec.status),
        esc(spec.name),
        num(spec.applicable),
        num(spec.passed),
        num(spec.failed),
        esc(
          spec.blockedBy.length
            ? `blocked by ${spec.blockedBy.join(", ")}`
            : spec.truncated
              ? "capped before the end"
              : spec.notChecked.length
                ? `${spec.notChecked.join(", ")} not evaluated`
                : "",
        ),
      ]),
    )
  );
}

function findings(sets: FindingSet[]): string | null {
  if (sets.length === 0) return null;
  return sets
    .map(
      (set) =>
        `<h3>${esc(set.source)}</h3><p class="lede">${esc(set.summary)}</p>` +
        (set.findings.length === 0
          ? `<p class="none">Nothing found.</p>`
          : table(
              ["", "Finding", "Count", "Detail"],
              set.findings.map((finding) => [
                pill(finding.severity, finding.severity),
                esc(finding.title),
                finding.count === undefined ? "" : num(finding.count),
                esc(finding.detail ?? ""),
              ]),
            )),
    )
    .join("");
}

function issues(list: ReportIssue[] | null): string | null {
  if (!list) return null;
  if (list.length === 0) return `<p class="none">No issues were raised.</p>`;
  return list
    .map(
      (issue) =>
        `<article class="issue">` +
        (issue.snapshot && /^data:image\//i.test(issue.snapshot) ? `<img src="${esc(issue.snapshot)}" alt="" />` : "") +
        `<div><h3>${esc(issue.title)}</h3>` +
        `<p class="meta">${esc(issue.status)} · ${esc(issue.priority)} · ${esc(issue.author)} · ${esc(issue.date.slice(0, 10))}</p>` +
        (issue.description ? `<p>${esc(issue.description)}</p>` : "") +
        `</div></article>`,
    )
    .join("");
}

const CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px; font: 14px/1.55 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: #14181f; background: #fff; }
main { max-width: 940px; margin: 0 auto; }
h1 { font-size: 26px; margin: 0 0 4px; letter-spacing: -0.01em; }
h2 { font-size: 17px; margin: 0 0 12px; padding-bottom: 6px; border-bottom: 1px solid #e3e6ea; }
h3 { font-size: 14px; margin: 18px 0 6px; }
header { margin-bottom: 28px; }
header .meta { color: #5d6672; margin: 0; font-size: 13px; }
section { margin-bottom: 34px; }
p { margin: 0 0 10px; }
.lede { color: #414a56; }
.none { color: #6b7480; font-style: italic; }
.warn { color: #8a3b12; background: #fdf1e7; border: 1px solid #f0cdae; border-radius: 6px; padding: 8px 10px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; margin-bottom: 18px; }
.tile { border: 1px solid #e3e6ea; border-radius: 8px; padding: 10px 12px; }
.tile .k { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: #6b7480; }
.tile .v { display: block; font-size: 18px; font-variant-numeric: tabular-nums; margin-top: 2px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th { text-align: left; font-weight: 600; color: #5d6672; padding: 6px 8px; border-bottom: 1px solid #e3e6ea; }
td { padding: 6px 8px; border-bottom: 1px solid #f0f2f4; vertical-align: top; }
td:nth-child(n+3) { font-variant-numeric: tabular-nums; }
figure { margin: 0; }
figure img { width: 100%; max-height: 460px; object-fit: contain; border: 1px solid #e3e6ea; border-radius: 8px; display: block; }
figcaption { color: #6b7480; font-size: 12px; margin-top: 6px; }
.pill { display: inline-block; padding: 1px 7px; border-radius: 999px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.pill.error, .pill.fail { background: #fdeaea; color: #96231f; }
.pill.warning { background: #fdf1e7; color: #8a3b12; }
.pill.info, .pill.not_run { background: #eef1f4; color: #4b5563; }
.pill.pass { background: #e8f5ec; color: #1f6b39; }
.issue { display: flex; gap: 14px; align-items: flex-start; border: 1px solid #e3e6ea; border-radius: 8px; padding: 12px; margin-bottom: 10px; }
.issue img { width: 180px; border-radius: 6px; flex: none; }
.issue h3 { margin: 0 0 2px; }
.issue .meta { color: #6b7480; font-size: 12px; }
footer { color: #6b7480; font-size: 12px; border-top: 1px solid #e3e6ea; padding-top: 12px; }
@media print {
  body { padding: 0; font-size: 11pt; }
  section { break-inside: avoid; }
  h2 { break-after: avoid; }
  tr, .issue, figure { break-inside: avoid; }
  .tile { border-color: #ccc; }
}
`;

/** The whole document, as a string. Pure, so a test can read it. */
export function buildReport(model: ReportModel): string {
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${esc(model.title)}</title>\n<style>${CSS}</style>\n</head>\n<body>\n<main>\n` +
    `<header><h1>${esc(model.title)}</h1>` +
    `<p class="meta">${esc(model.generated)} · ${esc(model.app)}</p></header>\n` +
    section("overview", "Overview", overview(model)) +
    section("models", "Models", models(model)) +
    section("checks", "Model checks", checks(model.checks)) +
    section("ids", "IDS validation", ids(model.ids)) +
    section("findings", "Findings", findings(model.findings)) +
    section("issues", "Issues", issues(model.issues)) +
    `<footer>Produced by ${esc(model.app)}. This document is self-contained: it opens with no network access.</footer>\n` +
    `</main>\n</body>\n</html>\n`
  );
}

export interface ReportSources {
  viewer: Viewer;
  title: string;
  app: string;
  checks(): ValidationReport | null;
  ids(): IdsReport | null;
  issues(): ReportIssue[] | null;
  /** Width of the embedded screenshot; 0 skips it. */
  shotWidth?: number;
}

/** Describes the active cut in one phrase, for the overview tile. */
function sectionLabel(viewer: Viewer): string {
  const box = viewer.getSectionBox();
  if (box) return "section box";
  const planes = viewer.getSections();
  if (planes.length === 0) return "none";
  return planes
    .map((plane) => `${plane.axis ? plane.axis.toUpperCase() : plane.name} at ${plane.offset.toFixed(2)} m`)
    .join(", ");
}

async function shot(viewer: Viewer, width: number): Promise<string | null> {
  if (width <= 0) return null;
  const blob = await viewer.captureImage(width, "image/jpeg", 0.72);
  if (!blob) return null;
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Gather what is on screen right now. Nothing here starts a pass of its own:
 * checks and IDS are shown only if they were run, so the report describes the
 * session rather than quietly re-running work under a different setting.
 */
export async function collectReport(sources: ReportSources): Promise<ReportModel> {
  const { viewer } = sources;
  const stats = viewer.getStats();
  const counts = viewer.getVisibilityCounts();
  return {
    title: sources.title,
    generated: new Date().toLocaleString(),
    app: sources.app,
    totals: {
      entities: stats?.totalEntities ?? 0,
      triangles: stats?.triangleCount ?? 0,
      visible: counts.total - counts.hidden,
      hidden: counts.hidden,
    },
    models: viewer.getModels().map((entry) => ({
      name: entry.name,
      elements: entry.elements,
      triangles: entry.triangles,
      visible: entry.visible,
    })),
    section: sectionLabel(viewer),
    screenshot: await shot(viewer, sources.shotWidth ?? 1100),
    checks: sources.checks(),
    ids: sources.ids(),
    findings: publishedFindings(),
    issues: sources.issues(),
  };
}
