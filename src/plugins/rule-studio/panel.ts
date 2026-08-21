// Rule Studio: the checking pass a coordinator currently runs in another
// product and re-types into BCF by hand.
//
// The panel is setup and a docket. Everything that decides anything lives in
// the engine, so the same ruleset produces the same findings here, in a test
// and in whatever runs it next.
import {
  bar,
  button,
  contextRuleModel,
  defaultRuleset,
  emptyState,
  grid,
  h,
  header,
  hint,
  note,
  page,
  parseRuleset,
  progress,
  ruleDefinitions,
  runRuleset,
  select,
  serializeRuleset,
  stats,
  toCsv,
  toast,
  type ElementRow,
  type ExtensionContext,
  type ExtensionInstance,
  type GridRow,
  type ParamValue,
  type RuleFinding,
  type RuleInstance,
  type RuleReport,
  type RuleSeverity,
  type Ruleset,
  type Selector,
} from "@ifcviewx/sdk";

const SEVERITIES: Array<[string, string]> = [
  ["error", "Error"],
  ["warning", "Warning"],
  ["info", "Note"],
];

const TONE: Record<RuleSeverity, "err" | "warn" | undefined> = {
  error: "err",
  warning: "warn",
  info: undefined,
};

const CSV_HEADERS = ["Severity", "Rule", "Finding", "Detail", "Elements"];

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let ruleset: Ruleset = readRuleset(ctx);
  let report: RuleReport | null = null;
  let rows: ElementRow[] = [];
  let running = false;
  let controller: AbortController | null = null;
  let severityFilter = "all";

  const status = progress();
  const summary = h("div");
  const setup = h("div", { class: "rule-setup" });
  const docket = h("div", { class: "plug-results" });
  const runButton = button("Run ruleset", () => void run(), "accent");

  const store = (): void => ctx.storage.write("ruleset", ruleset);

  const paintSetup = (): void => {
    const definitions = new Map(ruleDefinitions().map((definition) => [definition.id, definition]));
    const cards = ruleset.rules.map((instance) => {
      const definition = definitions.get(instance.ruleId);
      if (!definition) {
        return h("div", { class: "note error", text: `Unknown rule "${instance.ruleId}"` });
      }
      const enable = h("input", { type: "checkbox", ...(instance.enabled !== false ? { checked: "" } : {}) });
      enable.addEventListener("change", () => {
        instance.enabled = enable.checked;
        store();
      });
      const severity = select(SEVERITIES, instance.severity ?? definition.severity, (value) => {
        instance.severity = value as RuleSeverity;
        store();
      });
      const body = h("div", { class: "rule-body" });
      const params = definition.params.map((param) => {
        const current = instance.params?.[param.key] ?? param.value;
        const write = (value: ParamValue): void => {
          instance.params = { ...(instance.params ?? {}), [param.key]: value };
          store();
        };
        if (param.kind === "boolean") {
          const input = h("input", { type: "checkbox", ...(current === true ? { checked: "" } : {}) });
          input.addEventListener("change", () => write(input.checked));
          return h("label", { class: "plug-field", title: param.hint ?? "" }, [h("span", { text: param.label }), input]);
        }
        const input = h("input", {
          type: param.kind === "number" ? "number" : "text",
          class: param.kind === "number" ? "plug-num" : "",
          value: Array.isArray(current) ? current.join(", ") : String(current),
          step: "any",
        });
        input.addEventListener("change", () => {
          if (param.kind === "number") write(Number(input.value));
          else if (param.kind === "classes") write(input.value.split(",").map((part) => part.trim()).filter(Boolean));
          else write(input.value);
        });
        return h("label", { class: "plug-field", title: param.hint ?? "" }, [h("span", { text: param.label }), input]);
      });
      body.append(
        h("div", { class: "note", text: definition.description }),
        h("div", { class: "rule-params" }, params),
        scopeEditor(instance, () => store()),
      );
      return h("details", { class: "fold rule-card" }, [
        h("summary", {}, [
          enable,
          h("span", { class: "grow", text: instance.title ?? definition.title }),
          h("span", { class: "n", text: definition.category }),
          severity,
        ]),
        body,
      ]);
    });
    const active = ruleset.rules.filter((rule) => rule.enabled !== false).length;
    setup.replaceChildren(
      h("div", { class: "group-title" }, [
        h("span", { text: ruleset.name }),
        h("span", { class: "n", text: `${active} of ${ruleset.rules.length} on` }),
      ]),
      ...cards,
    );
  };

  const paintDocket = (): void => {
    if (!report) {
      docket.replaceChildren(
        emptyState("shield", "Nothing checked yet", "Pick the rules that matter to this milestone, then run the set."),
      );
      summary.replaceChildren();
      return;
    }
    summary.replaceChildren(stats([
      ["errors", report.counts.error.toLocaleString(), report.counts.error ? "err" : "ok"],
      ["warnings", report.counts.warning.toLocaleString(), report.counts.warning ? "warn" : "ok"],
      ["notes", report.counts.info.toLocaleString()],
      ["rules run", report.ran.length.toLocaleString()],
      ["seconds", (report.elapsedMs / 1000).toFixed(1)],
    ]));
    const failed = report.ran.filter((entry) => entry.error);
    const visible = report.findings.filter((finding) => severityFilter === "all" || finding.severity === severityFilter);
    if (visible.length === 0) {
      docket.replaceChildren(
        emptyState("check", "Nothing to answer for", `Every rule that ran is clear at ${report.ruleset}'s settings.`),
        ...(failed.length ? [failure(failed)] : []),
      );
      return;
    }
    const gridRows: GridRow[] = visible.map((finding) => ({
      cells: [finding.severity, finding.ruleTitle, finding.title, finding.ids.length],
      tone: TONE[finding.severity],
      title: `${finding.detail ?? ""} Click to isolate the elements this finding is about.`,
      pick: () => focus(finding),
    }));
    docket.replaceChildren(
      grid(["", "Rule", "Finding", "Elements"], gridRows),
      note("Click a row to isolate and frame it. Raise issue turns everything shown into BCF topics."),
      ...(failed.length ? [failure(failed)] : []),
    );
  };

  const failure = (failed: RuleReport["ran"]): HTMLElement =>
    h("div", { class: "note error", text: `${failed.length} rule(s) could not run: ${failed.map((entry) => `${entry.title} (${entry.error})`).join("; ")}` });

  const focus = (finding: RuleFinding): void => {
    if (finding.ids.length === 0) return;
    ctx.view.isolate(finding.ids, `${finding.ruleTitle}: ${finding.title}`);
    ctx.view.select(finding.ids);
    if (finding.point) ctx.view.frameAt(finding.point, 2);
    else ctx.view.frame(finding.ids[0]);
  };

  const run = async (): Promise<void> => {
    if (running) {
      controller?.abort();
      return;
    }
    if (!ctx.session.model().loaded) return void toast("Open a model first", "info");
    running = true;
    const runController = new AbortController();
    controller = runController;
    runButton.textContent = "Stop";
    status.set(0, 1, "Reading properties");
    try {
      rows = await ctx.model.index().build((done, total) =>
        status.set(done, total, `Reading properties ${done.toLocaleString()} of ${total.toLocaleString()}`));
      const model = contextRuleModel(ctx, rows);
      report = await runRuleset(ruleset, {
        model,
        signal: runController.signal,
        progress: (done, total, label) => status.set(done, total, `${label} (${done} of ${total})`),
      });
      publish();
    } catch (error) {
      if (!runController.signal.aborted && !isAbortError(error)) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      running = false;
      if (controller === runController) controller = null;
      runButton.textContent = "Run ruleset";
      status.hide();
      paintDocket();
    }
  };

  /** The docket goes into the report and the shared findings list. */
  const publish = (): void => {
    if (!report) return;
    const worst = new Map<string, { severity: RuleSeverity; count: number; detail: string }>();
    for (const finding of report.findings) {
      const entry = worst.get(finding.ruleTitle);
      if (entry) {
        entry.count += Math.max(1, finding.ids.length);
      } else {
        worst.set(finding.ruleTitle, {
          severity: finding.severity,
          count: Math.max(1, finding.ids.length),
          detail: finding.title,
        });
      }
    }
    ctx.feedback.publishFindings(
      `${ruleset.name}: ${report.counts.error} error(s), ${report.counts.warning} warning(s) across ${report.ran.length} rule(s)`,
      [...worst].map(([title, entry]) => ({
        severity: entry.severity,
        title,
        count: entry.count,
        detail: entry.detail,
      })),
    );
    ctx.feedback.publishResults({
      title: ruleset.name,
      summary: `${report.counts.error} error(s), ${report.counts.warning} warning(s) from ${report.ran.length} rule(s)`,
      rows: report.findings.map((finding, index) => ({
        id: `${finding.ruleId}-${index}`,
        severity: finding.severity,
        title: finding.title,
        detail: finding.detail,
        group: finding.ruleTitle,
        ids: finding.ids,
        point: finding.point,
      })),
    });
    ctx.feedback.log(
      `${ruleset.name}: ${report.findings.length} finding(s) from ${report.ran.length} rule(s)`,
      report.counts.error ? "error" : "success",
    );
  };

  const exportRuleset = (): void => {
    ctx.files.export("rule-studio.ruleset", `${safeName(ruleset.name)}.rules.json`, serializeRuleset(ruleset), "application/json");
  };

  const importRuleset = async (): Promise<void> => {
    try {
      const opened = await ctx.files.open("rule-studio.ruleset");
      ruleset = parseRuleset(opened.text);
      store();
      paintSetup();
      ctx.feedback.log(`Loaded ruleset "${ruleset.name}" with ${ruleset.rules.length} rule(s)`, "success");
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const exportFindings = (): void => {
    if (!report || report.findings.length === 0) return void toast("Run the ruleset first", "info");
    const table = report.findings.map((finding) => [
      finding.severity,
      finding.ruleTitle,
      finding.title,
      finding.detail ?? "",
      finding.ids.join(" "),
    ]);
    ctx.files.export(
      "rule-studio.findings",
      `${safeName(ruleset.name)}-findings.csv`,
      `﻿${toCsv(CSV_HEADERS, table)}`,
      "text/csv",
    );
  };

  const raiseIssues = async (): Promise<void> => {
    if (!report || report.findings.length === 0) return void toast("Run the ruleset first", "info");
    const worth = report.findings
      .filter((finding) => finding.severity !== "info" && finding.ids.length > 0)
      .slice(0, 25);
    if (worth.length === 0) return void toast("Nothing worth raising", "info");
    for (const finding of worth) {
      await ctx.issues.create({
        title: `${finding.ruleTitle}: ${finding.title}`,
        description: [finding.detail, `Rule: ${finding.ruleTitle}`, `Ruleset: ${ruleset.name}`].filter(Boolean).join("\n"),
        elementIds: finding.ids.slice(0, 200),
        point: finding.point,
        priority: finding.severity === "error" ? "High" : "Normal",
      });
    }
    ctx.feedback.log(`Raised ${worth.length} issue(s) from ${ruleset.name}`, "success");
  };

  const root = page(
    header("Rule Studio", "Geometric, topological and relational checks, saved as one ruleset a project shares."),
    bar(
      runButton,
      button("Reset to shipped rules", () => {
        ruleset = defaultRuleset();
        store();
        paintSetup();
      }),
      button("Import", () => void importRuleset()),
      button("Export ruleset", () => exportRuleset()),
      button("CSV", () => exportFindings()),
      button("Raise issues", () => void raiseIssues().catch((error: Error) => ctx.feedback.log(error.message, "error"))),
      select([["all", "Everything"], ...SEVERITIES], severityFilter, (value) => {
        severityFilter = value;
        paintDocket();
      }),
      button("Show all", () => ctx.view.showAll()),
    ),
    hint("shield", "IDS asks whether the information is there. These rules ask whether the model is right, which needs geometry: overlaps, hosts, storey bands, clearances and quantities that disagree with the mesh."),
    status.root,
    summary,
    docket,
    h("div", { class: "group-title", text: "Rules" }),
    setup,
  );

  ctx.events.on("model", () => {
    report = null;
    rows = [];
    paintDocket();
  });

  host.appendChild(root);
  paintSetup();
  paintDocket();

  return {
    dispose: () => controller?.abort(),
  };
}

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

/** A compact scope editor: the query that narrows what a rule looks at. */
function scopeEditor(instance: RuleInstance, changed: () => void): HTMLElement {
  const kinds: Array<[string, string]> = [
    ["all", "Everything"],
    ["class", "Only these classes"],
    ["storey", "Only these storeys"],
    ["property", "Only where a property matches"],
  ];
  const row = h("div", { class: "rule-scope" });
  const current = instance.scope as Selector | null;
  const kind = current?.kind === "class" || current?.kind === "storey" || current?.kind === "property" ? current.kind : "all";

  const rebuild = (next: string): void => {
    row.replaceChildren(
      select(kinds, next, (value) => {
        instance.scope =
          value === "class" ? { kind: "class", values: [] }
          : value === "storey" ? { kind: "storey", values: [] }
          : value === "property" ? { kind: "property", set: "", name: "", op: "exists", value: "" }
          : null;
        changed();
        rebuild(value);
      }),
    );
    const scope = instance.scope as Selector | null;
    if (scope?.kind === "class" || scope?.kind === "storey") {
      const input = h("input", { type: "text", value: scope.values.join(", "), placeholder: scope.kind === "class" ? "IfcWall, IfcSlab" : "Level 1, Level 2" });
      input.addEventListener("change", () => {
        scope.values = input.value.split(",").map((part) => part.trim()).filter(Boolean);
        changed();
      });
      row.appendChild(input);
    } else if (scope?.kind === "property") {
      const name = h("input", { type: "text", value: scope.name, placeholder: "Property" });
      const value = h("input", { type: "text", value: scope.value, placeholder: "Value" });
      name.addEventListener("change", () => {
        scope.name = name.value.trim();
        changed();
      });
      value.addEventListener("change", () => {
        scope.value = value.value.trim();
        scope.op = value.value.trim() ? "is" : "exists";
        changed();
      });
      row.append(name, value);
    }
  };
  rebuild(kind);
  return row;
}

function readRuleset(ctx: ExtensionContext): Ruleset {
  const stored = ctx.storage.read<Ruleset | null>("ruleset", null);
  if (stored && Array.isArray(stored.rules) && stored.rules.length > 0) {
    let normalized: Ruleset;
    try {
      normalized = parseRuleset(JSON.stringify(stored));
    } catch {
      return defaultRuleset();
    }
    // A shipped rule added since the ruleset was stored is appended, so an
    // old saved set does not silently stop checking new things.
    const known = new Set(normalized.rules.map((rule) => rule.ruleId));
    for (const definition of ruleDefinitions()) {
      if (known.has(definition.id)) continue;
      normalized.rules.push({ id: `${definition.id}-new`, ruleId: definition.id, enabled: true, scope: null, params: {} });
    }
    return normalized;
  }
  return defaultRuleset();
}

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "ruleset";
