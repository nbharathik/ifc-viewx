// Report Builder: the place a takeoff or a QA pass ends.
//
// Everything a template decides lives in template.ts, so the printed page,
// the workbook and the CSV are the same table rather than three renderings
// that drift apart.
import {
  bar,
  button,
  emptyState,
  grid,
  h,
  header,
  hint,
  note,
  page,
  progress,
  promptForm,
  saveXlsx,
  select,
  stats,
  toCsv,
  toast,
  type ElementRow,
  type ExtensionContext,
  type ExtensionInstance,
  type GridRow,
  type Value,
} from "@ifcviewx/sdk";
import {
  buildReportTable,
  FACT_KEYS,
  parseTemplates,
  REPORT_PRESETS,
  serializeTemplates,
  type Aggregate,
  type BuiltReport,
  type ReportScope,
  type ReportTemplate,
} from "./template.js";

const AGGREGATES: Array<[string, string]> = [
  ["none", "no total"],
  ["count", "count"],
  ["sum", "sum"],
  ["average", "average"],
  ["min", "minimum"],
  ["max", "maximum"],
];

const SCOPES: Array<[string, string]> = [
  ["everything", "The whole model"],
  ["visible", "What is visible"],
  ["selection", "The current selection"],
  ["class", "One or more classes"],
];

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let templates: ReportTemplate[] = readTemplates(ctx);
  let active: ReportTemplate = templates[0] ?? blankTemplate();
  let rows: ElementRow[] = [];
  let built: BuiltReport | null = null;
  let busy = false;

  const status = progress();
  const summary = h("div");
  const table = h("div", { class: "plug-results" });
  const setup = h("div", { class: "report-setup" });

  const store = (): void => {
    const at = templates.findIndex((template) => template.id === active.id);
    if (at >= 0) templates[at] = active;
    else templates.push(active);
    ctx.storage.write("templates", templates);
    ctx.storage.write("activeId", active.id);
  };

  const keyOptions = (): string[] => {
    const index = ctx.model.index();
    const keys = index.ready() ? index.propertyKeys().map(([key]) => key) : [];
    return [...FACT_KEYS, ...keys.slice(0, 500)];
  };

  const paintSetup = (): void => {
    const list = h("div", { class: "report-columns" });
    active.columns.forEach((column, index) => {
      const key = h("input", { type: "text", value: column.key, list: "report-keys", placeholder: "Pset.Property" });
      key.addEventListener("change", () => {
        column.key = key.value.trim();
        if (!column.header) {
          column.header = column.key;
          paintSetup();
        }
        store();
      });
      const label = h("input", { type: "text", value: column.header, placeholder: "Heading" });
      label.addEventListener("change", () => {
        column.header = label.value.trim() || column.key;
        store();
      });
      const aggregate = select(AGGREGATES, column.aggregate, (value) => {
        column.aggregate = value as Aggregate;
        store();
      });
      const up = h("button", { class: "icon-btn sm", type: "button", title: "Move up", "aria-label": "Move up", text: "↑" });
      up.addEventListener("click", () => {
        if (index === 0) return;
        [active.columns[index - 1], active.columns[index]] = [active.columns[index], active.columns[index - 1]];
        store();
        paintSetup();
      });
      const remove = h("button", { class: "icon-btn sm", type: "button", title: "Remove column", "aria-label": "Remove column", text: "×" });
      remove.addEventListener("click", () => {
        active.columns.splice(index, 1);
        store();
        paintSetup();
      });
      list.appendChild(h("div", { class: "report-column" }, [key, label, aggregate, up, remove]));
    });

    const add = button("Add column", () => {
      active.columns.push({ key: "", header: "", aggregate: "none" });
      store();
      paintSetup();
    });

    const scopeKind = active.scope.kind === "query" ? "class" : active.scope.kind;
    const scopeRow = h("div", { class: "report-scope" }, [
      select(SCOPES, scopeKind, (value) => {
        active.scope = value === "class"
          ? { kind: "query", selector: { kind: "class", values: [] } }
          : { kind: value as "everything" | "visible" | "selection" };
        store();
        paintSetup();
      }),
    ]);
    if (active.scope.kind === "query" && active.scope.selector.kind === "class") {
      const classes = h("input", {
        type: "text",
        value: active.scope.selector.values.join(", "),
        placeholder: "IfcDoor, IfcWindow",
        list: "report-classes",
      });
      classes.addEventListener("change", () => {
        if (active.scope.kind !== "query" || active.scope.selector.kind !== "class") return;
        active.scope.selector.values = classes.value.split(",").map((part) => part.trim()).filter(Boolean);
        store();
      });
      scopeRow.appendChild(classes);
    }

    const columnKeys = (): Array<[string, string]> => [
      ["", "no grouping"],
      ...active.columns.filter((column) => column.key).map((column) => [column.key, column.header || column.key] as [string, string]),
    ];

    const empties = h("input", { type: "checkbox", ...(active.dropEmptyRows ? { checked: "" } : {}) });
    empties.addEventListener("change", () => {
      active.dropEmptyRows = empties.checked;
      store();
    });

    setup.replaceChildren(
      h("datalist", { id: "report-keys" }, keyOptions().map((key) => h("option", { value: key }))),
      h("datalist", { id: "report-classes" }, ctx.model.classes().map(([name]) => h("option", { value: name }))),
      h("div", { class: "group-title", text: "Scope" }),
      scopeRow,
      h("div", { class: "group-title" }, [h("span", { text: "Columns" }), add]),
      list,
      h("div", { class: "report-fold" }, [
        h("label", { class: "plug-field" }, [h("span", { text: "Group by" }), select(columnKeys(), active.groupBy, (value) => {
          active.groupBy = value;
          store();
        })]),
        h("label", { class: "plug-field" }, [h("span", { text: "Sort by" }), select(columnKeys(), active.sortBy, (value) => {
          active.sortBy = value;
          store();
        })]),
        h("label", { class: "plug-field" }, [h("span", { text: "Drop empty rows" }), empties]),
      ]),
    );
  };

  const scopeIds = (): Set<number> | null => {
    if (active.scope.kind === "selection") {
      const selection = ctx.view.selection();
      return new Set(selection);
    }
    if (active.scope.kind === "visible") {
      return new Set(rows.filter((row) => ctx.view.isVisible(row.id)).map((row) => row.id));
    }
    return null;
  };

  const run = async (): Promise<void> => {
    if (busy) return;
    if (!ctx.session.model().loaded) return void toast("Open a model first", "info");
    busy = true;
    status.set(0, 1, "Reading properties");
    try {
      rows = await ctx.model.index().build((done, total) =>
        status.set(done, total, `Reading properties ${done.toLocaleString()} of ${total.toLocaleString()}`));
      built = buildReportTable({ template: active, rows, scopeIds: scopeIds() });
      paintTable();
      paintSetup();
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : "The report could not be built", "error");
    } finally {
      busy = false;
      status.hide();
    }
  };

  const paintTable = (): void => {
    if (!built) {
      summary.replaceChildren();
      table.replaceChildren(emptyState("clipboard", "No table yet", "Pick a scope and some columns, then run the report."));
      return;
    }
    summary.replaceChildren(stats([
      ["rows", built.rows.length.toLocaleString()],
      ["columns", built.headers.length.toLocaleString()],
      ["groups", built.groups.length.toLocaleString()],
      ["dropped", built.dropped.toLocaleString(), built.dropped ? "warn" : undefined],
    ]));
    if (built.rows.length === 0) {
      table.replaceChildren(
        emptyState("clipboard", "Nothing in scope", "No element matched this template on the model that is open."),
      );
      return;
    }
    const gridRows: GridRow[] = [];
    if (built.groups.length) {
      for (const group of built.groups) {
        gridRows.push({
          cells: [`${group.key}  (${group.rows.length})`, ...group.totals.slice(1)],
          tone: "ok",
          title: `Isolate ${group.rows.length} element(s) in ${group.key}`,
          pick: () => ctx.view.isolate(group.ids, `${active.name}: ${group.key}`),
        });
        for (const row of group.rows.slice(0, 200)) {
          gridRows.push({ cells: row.cells, pick: () => focus(row.id) });
        }
      }
    } else {
      for (const row of built.rows.slice(0, 1000)) {
        gridRows.push({ cells: row.cells, pick: () => focus(row.id) });
      }
    }
    if (built.totals.some((value) => value !== "")) {
      gridRows.push({ cells: built.totals.map((value, index) => (index === 0 && value === "" ? "Total" : value)), tone: "ok" });
    }
    table.replaceChildren(
      grid(built.headers, gridRows),
      built.rows.length > 1000
        ? note(`Showing the first 1,000 of ${built.rows.length.toLocaleString()} rows. Every export carries all of them.`)
        : note("Click a row to select and frame it. A group heading isolates the whole group."),
    );
  };

  const focus = (id: number): void => {
    ctx.view.select(id);
    ctx.view.frame(id);
  };

  const exportRows = (): Array<Array<Value | undefined>> => {
    if (!built) return [];
    if (built.groups.length === 0) return built.rows.map((row) => row.cells);
    const out: Array<Array<Value | undefined>> = [];
    for (const group of built.groups) {
      out.push([group.key, ...group.totals.slice(1)]);
      for (const row of group.rows) out.push(row.cells);
    }
    out.push(built.totals.map((value, index) => (index === 0 && value === "" ? "Total" : value)));
    return out;
  };

  const exportCsv = (): void => {
    if (!built) return void toast("Run the report first", "info");
    ctx.files.export(
      "report-builder.csv",
      `${safeName(active.name)}.csv`,
      `﻿${toCsv(built.headers, exportRows())}`,
      "text/csv",
    );
  };

  const exportXlsx = async (): Promise<void> => {
    if (!built) return void toast("Run the report first", "info");
    try {
      await saveXlsx(`${safeName(active.name)}.xlsx`, built.headers, exportRows(), { sheet: active.name.slice(0, 31) });
    } catch {
      ctx.feedback.log("The spreadsheet could not be written", "error");
    }
  };

  const exportHtml = (): void => {
    if (!built) return void toast("Run the report first", "info");
    ctx.files.export(
      "report-builder.html",
      `${safeName(active.name)}.html`,
      printable(built, ctx.session.model().name),
      "text/html",
    );
  };

  const saveAs = (): void => {
    promptForm("Save report template", [
      { key: "name", label: "Name", value: active.name },
      { key: "description", label: "What it shows", value: active.description },
    ], "Save", (values) => {
      active = {
        ...structuredClone(active),
        id: `rt-${Math.random().toString(36).slice(2, 9)}`,
        name: values.name.trim() || active.name,
        description: values.description.trim(),
      };
      store();
      paintTemplates();
      ctx.feedback.log(`Saved report template "${active.name}"`, "success");
    });
  };

  const templateSelect = h("select", { class: "plug-select", "aria-label": "Report template" });
  const paintTemplates = (): void => {
    templateSelect.replaceChildren(
      ...templates.map((template) => h("option", { value: template.id, text: template.name })),
    );
    templateSelect.value = active.id;
  };
  templateSelect.addEventListener("change", () => {
    const found = templates.find((template) => template.id === templateSelect.value);
    if (!found) return;
    active = found;
    built = null;
    ctx.storage.write("activeId", active.id);
    paintSetup();
    paintTable();
  });

  const presets = h("select", { class: "plug-select", "aria-label": "Start from a preset" });
  presets.append(h("option", { value: "", text: "Start from..." }));
  for (const preset of REPORT_PRESETS) presets.append(h("option", { value: preset.label, text: preset.label }));
  presets.addEventListener("change", () => {
    const preset = REPORT_PRESETS.find((entry) => entry.label === presets.value);
    presets.value = "";
    if (!preset) return;
    active = { ...structuredClone(preset.template), id: `rt-${Math.random().toString(36).slice(2, 9)}` };
    templates.push(active);
    store();
    paintTemplates();
    paintSetup();
    void run();
  });

  const importTemplate = async (): Promise<void> => {
    try {
      const opened = await ctx.files.open("report-builder.template");
      const found = parseTemplates(opened.text);
      if (found.length === 0) throw new Error("No report templates in that file");
      templates = [...templates.filter((template) => !found.some((entry) => entry.name === template.name)), ...found];
      active = found[0];
      store();
      paintTemplates();
      paintSetup();
      ctx.feedback.log(`Imported ${found.length} report template(s)`, "success");
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const root = page(
    header("Report builder", "Your columns, your grouping, saved as a template that reproduces on the next revision."),
    bar(
      templateSelect,
      presets,
      button("Run", () => void run(), "accent"),
      button("Save as", () => saveAs()),
      button("Import", () => void importTemplate()),
      button("Export template", () =>
        ctx.files.export("report-builder.template", `${safeName(active.name)}.report.json`, serializeTemplates([active]), "application/json")),
      button("CSV", () => exportCsv()),
      button("XLSX", () => void exportXlsx()),
      button("Print page", () => exportHtml()),
    ),
    hint("clipboard", "Columns read attributes, property sets, quantities and computed properties by the same name they have anywhere else in the app. Computed.<name> reaches a derived property."),
    status.root,
    summary,
    table,
    h("div", { class: "group-title", text: "Definition" }),
    setup,
  );

  ctx.events.on("model", () => {
    built = null;
    rows = [];
    paintTable();
  });

  host.appendChild(root);
  paintTemplates();
  paintSetup();
  paintTable();

  return {};
}

function blankTemplate(): ReportTemplate {
  return {
    id: `rt-${Math.random().toString(36).slice(2, 9)}`,
    name: "New report",
    description: "",
    scope: { kind: "everything" } as ReportScope,
    columns: [
      { key: "Type", header: "Class", aggregate: "count" },
      { key: "Name", header: "Name", aggregate: "none" },
      { key: "Storey", header: "Level", aggregate: "none" },
    ],
    groupBy: "Type",
    sortBy: "Name",
    sortDescending: false,
    dropEmptyRows: false,
  };
}

function readTemplates(ctx: ExtensionContext): ReportTemplate[] {
  const stored = ctx.storage.read<ReportTemplate[]>("templates", []);
  if (Array.isArray(stored) && stored.length > 0) {
    const normalized = parseTemplates(JSON.stringify(stored));
    if (normalized.length) return normalized;
  }
  return [blankTemplate()];
}

const esc = (text: string): string =>
  text.replace(/[<>&"']/g, (character) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character] ?? character);

/** A self-contained page: it opens and prints with no network of any kind. */
function printable(report: BuiltReport, modelName: string): string {
  const cell = (value: Value | undefined): string =>
    `<td${typeof value === "number" ? ' class="n"' : ""}>${esc(value === null || value === undefined ? "" : String(value))}</td>`;
  const body = report.groups.length
    ? report.groups
        .map((group) =>
          `<tr class="g"><td colspan="${report.headers.length}">${esc(group.key)} (${group.rows.length})</td></tr>` +
          group.rows.map((row) => `<tr>${row.cells.map(cell).join("")}</tr>`).join("") +
          `<tr class="t">${group.totals.map(cell).join("")}</tr>`)
        .join("")
    : report.rows.map((row) => `<tr>${row.cells.map(cell).join("")}</tr>`).join("");
  return (
    `<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8" />\n` +
    `<meta name="viewport" content="width=device-width, initial-scale=1" />\n` +
    `<title>${esc(report.template.name)}</title>\n<style>${PRINT_CSS}</style>\n</head>\n<body>\n` +
    `<header><h1>${esc(report.template.name)}</h1>` +
    `<p>${esc(report.template.description || "")}</p>` +
    `<p class="meta">${esc(modelName || "model")} · ${esc(new Date().toLocaleString())} · ${report.rows.length} rows</p></header>\n` +
    `<table><thead><tr>${report.headers.map((headerName) => `<th>${esc(headerName)}</th>`).join("")}</tr></thead>` +
    `<tbody>${body}</tbody>` +
    `<tfoot><tr>${report.totals.map((value, index) => cell(index === 0 && value === "" ? "Total" : value)).join("")}</tr></tfoot></table>\n` +
    `<footer>Produced by IFCViewX. This document is self-contained: it opens with no network access. Print it for PDF.</footer>\n` +
    `</body>\n</html>\n`
  );
}

const PRINT_CSS = `
:root { color-scheme: light; }
body { margin: 0; padding: 28px; font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif; color: #14181f; background: #fff; }
header { border-bottom: 1px solid #d6dae1; padding-bottom: 12px; margin-bottom: 16px; }
h1 { margin: 0 0 4px; font-size: 20px; letter-spacing: -0.02em; }
p { margin: 0; }
.meta { color: #667; font-size: 11px; margin-top: 6px; }
table { border-collapse: collapse; width: 100%; font-size: 12px; }
th, td { text-align: left; padding: 5px 8px; border-bottom: 1px solid #e6e9ee; vertical-align: top; }
th { background: #f3f5f8; font-size: 10px; text-transform: uppercase; letter-spacing: 0.08em; color: #556; }
td.n { text-align: right; font-variant-numeric: tabular-nums; }
tr.g td { background: #eef1f6; font-weight: 600; }
tr.t td, tfoot td { font-weight: 600; border-top: 1px solid #c8ced7; }
footer { margin-top: 18px; padding-top: 10px; border-top: 1px solid #d6dae1; color: #667; font-size: 10px; }
@media print { body { padding: 0; } thead { display: table-header-group; } tr { break-inside: avoid; } footer { position: fixed; bottom: 0; } }
`;

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
