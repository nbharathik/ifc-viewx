import { bar, button, emptyState, grid, h, header, note, page, progress, stats } from "@ifcviewx/sdk";
import type { ExtensionContext, ExtensionInstance } from "@ifcviewx/sdk";

type Severity = "error" | "warning" | "info";

interface HealthFinding {
  severity: Severity;
  title: string;
  detail: string;
  ids: number[];
}

const finite = (values: number[]): boolean => values.every(Number.isFinite);
const CONTAINER_TYPES = new Set(["PROJECT", "SITE", "BUILDING", "BUILDINGSTOREY", "GROUP", "SYSTEM", "ZONE"]);

const expectsDisplayGeometry = (type: string): boolean =>
  !CONTAINER_TYPES.has(type.replace(/^IFC/i, "").replaceAll("_", "").toUpperCase());

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  const summary = h("div");
  const findings = h("div");
  const status = progress();
  let generation = 0;
  let full = false;
  let current: HealthFinding[] = [];

  const focus = (ids: number[]): void => {
    if (!ids.length) return;
    ctx.view.select(ids);
    ctx.view.frame(ids[0]);
  };

  const paint = (): void => {
    const elements = ctx.model.elements();
    if (!elements.length) {
      summary.replaceChildren();
      findings.replaceChildren(emptyState("check", "No model to audit", "Open an IFC model, then return to Model Health."));
      return;
    }
    const errors = current.filter((item) => item.severity === "error").reduce((sum, item) => sum + item.ids.length, 0);
    const warnings = current.filter((item) => item.severity === "warning").reduce((sum, item) => sum + item.ids.length, 0);
    summary.replaceChildren(stats([
      ["elements", elements.length.toLocaleString()],
      ["IFC classes", ctx.model.classes().length.toLocaleString()],
      ["errors", errors.toLocaleString(), errors ? "err" : "ok"],
      ["warnings", warnings.toLocaleString(), warnings ? "warn" : "ok"],
    ]));
    if (!current.length) {
      findings.replaceChildren(emptyState("check", "No problems found", full
        ? "The structural, geometry and property checks are clear."
        : "The fast structural and geometry checks are clear. Run the full audit for identity and property coverage."));
      return;
    }
    findings.replaceChildren(
      grid(["Severity", "Check", "Count"], current.map((item) => ({
        cells: [item.severity, item.title, item.ids.length],
        tone: item.severity === "error" ? "err" : item.severity === "warning" ? "warn" : undefined,
        title: `${item.detail} Click to select and frame the affected elements.`,
        pick: () => focus(item.ids),
      }))),
      note("Click a finding to select its affected elements. Errors can make results unreliable; warnings need review."),
    );
  };

  const quickFindings = (): HealthFinding[] => {
    const elements = ctx.model.elements();
    const noStorey: number[] = [];
    const noGeometry: number[] = [];
    const degenerate: number[] = [];
    for (const element of elements) {
      if (!element.storey.trim()) noStorey.push(element.id);
      const bounds = ctx.model.bounds(element.id);
      if (!bounds || !finite([bounds.min.x, bounds.min.y, bounds.min.z, bounds.max.x, bounds.max.y, bounds.max.z])) {
        if (expectsDisplayGeometry(element.type)) noGeometry.push(element.id);
        continue;
      }
      const spans = [bounds.max.x - bounds.min.x, bounds.max.y - bounds.min.y, bounds.max.z - bounds.min.z];
      if (spans.some((span) => span < 0) || spans.every((span) => span <= 1e-7)) degenerate.push(element.id);
    }
    const out: HealthFinding[] = [];
    if (noGeometry.length) out.push({
      severity: "warning", title: "No display geometry",
      detail: "These product elements have no finite geometry bounds and are not visible in the viewport.", ids: noGeometry,
    });
    if (noStorey.length) out.push({
      severity: "warning", title: "No storey containment",
      detail: "These placed elements are not assigned to a building storey.", ids: noStorey,
    });
    if (degenerate.length) out.push({
      severity: "warning", title: "Degenerate geometry extent",
      detail: "These elements collapse to a point or contain an inverted bounds axis.", ids: degenerate,
    });
    return out;
  };

  const runFull = async (): Promise<void> => {
    const token = ++generation;
    full = false;
    current = quickFindings();
    paint();
    try {
      const rows = await ctx.model.index().build((done, total) => status.set(done, total, "Reading model properties"));
      if (token !== generation) return;
      const missingGlobalId = rows.filter((row) => !row.globalId.trim()).map((row) => row.id);
      const noProperties = rows.filter((row) => Object.keys(row.props).length === 0).map((row) => row.id);
      const byGlobalId = new Map<string, number[]>();
      for (const row of rows) {
        const key = row.globalId.trim();
        if (!key) continue;
        byGlobalId.set(key, [...byGlobalId.get(key) ?? [], row.id]);
      }
      const duplicates = [...byGlobalId.values()].filter((ids) => ids.length > 1).flat();
      if (duplicates.length) current.unshift({
        severity: "error", title: "Duplicate GlobalIds",
        detail: "A GlobalId must identify exactly one IFC object within the model.", ids: duplicates,
      });
      if (missingGlobalId.length) current.push({
        severity: "warning", title: "Missing GlobalIds",
        detail: "These elements cannot be matched reliably across revisions or BCF topics.", ids: missingGlobalId,
      });
      if (noProperties.length) current.push({
        severity: "info", title: "No property-set values",
        detail: "These elements have no property or quantity set values.", ids: noProperties,
      });
      full = true;
      paint();
      ctx.feedback.publishFindings(
        `${current.length} model health check${current.length === 1 ? "" : "s"} need attention.`,
        current.flatMap((item) => item.ids.slice(0, 50).map((id) => ({
          severity: item.severity,
          title: item.title,
          detail: item.detail,
          expressID: id,
        }))).slice(0, 200),
      );
      ctx.feedback.log("Model health audit finished", "success");
    } catch (error) {
      if (token === generation) ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    } finally {
      if (token === generation) status.hide();
    }
  };

  const scan = button("Run full audit", () => void runFull(), "accent");
  const showAll = button("Show all", () => ctx.view.showAll());
  const root = page(
    header("Model health", "Catch identity, geometry and property problems before review."),
    bar(scan, showAll),
    status.root,
    summary,
    findings,
  );
  host.appendChild(root);

  const rebuild = (): void => {
    generation += 1;
    full = false;
    current = quickFindings();
    status.hide();
    paint();
  };
  rebuild();
  ctx.events.on("model", rebuild);

  return { dispose: () => { generation += 1; } };
}
