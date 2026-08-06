// Element schedules: pick a class, add pset columns, get a table. Property
// columns resolve through the element type, which is the part a plain
// instance read gets wrong. Runs in this tab. Rows select in the viewer; the
// table exports as CSV.
import { h, icon, spinner, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import { saveCsv, type Value } from "../sdk/data.js";
import type { ScheduleReport } from "../ifc/ifcEngine.js";

export interface ScheduleActions {
  /** Element classes present in the model, most common first. */
  types(): string[];
  run(type: string, properties: string[]): Promise<ScheduleReport>;
  select(expressID: number): void;
}

export class SchedulePanel {
  private readonly type = h("select", { class: "grow", title: "Element class", "aria-label": "Element class" });
  private readonly props = h("input", { type: "text", placeholder: "Pset.Property, Property", list: "schedule-props", "aria-label": "Property columns" });
  private readonly datalist = h("datalist", { id: "schedule-props" });
  private readonly runBtn = h("button", { class: "btn accent", type: "button", text: "Run" });
  private readonly exportBtn = h("button", { class: "btn", type: "button", title: "Download CSV" }, [icon("download", 14)]);
  private readonly status = h("div", { class: "status-line" });
  private readonly host = h("div", { class: "grid-wrap hidden" });
  private readonly empty = emptyState("table", "No schedule yet", "Pick a class and run to build a table of every element.");
  private report: ScheduleReport | null = null;

  constructor(mount: HTMLElement, private readonly actions: ScheduleActions) {
    this.exportBtn.disabled = true;
    this.runBtn.addEventListener("click", () => void this.run());
    this.exportBtn.addEventListener("click", () => this.exportCsv());
    this.props.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.run();
    });

    mount.appendChild(
      h("div", { class: "page" }, [
        h("div", { class: "row" }, [this.type, this.runBtn, this.exportBtn]),
        this.props,
        this.datalist,
        this.status,
        this.empty,
        this.host,
      ]),
    );
    this.refreshTypes();
  }

  /** Repopulate the class list; call after a model loads. */
  refreshTypes(): void {
    const current = this.type.value;
    const types = this.actions.types();
    this.type.replaceChildren(
      ...(types.length ? types : ["IfcElement"]).map((name) => h("option", { value: name, text: name })),
    );
    if (types.includes(current)) this.type.value = current;
    // The table belongs to the model it was built from: exporting or clicking
    // through the previous model's rows after a new one loads is nonsense.
    this.clear();
  }

  /** Back to the empty state, with nothing left to export or select from. */
  private clear(): void {
    this.report = null;
    this.exportBtn.disabled = true;
    this.host.replaceChildren();
    this.host.classList.add("hidden");
    this.empty.classList.remove("hidden");
    this.status.textContent = "";
    this.status.classList.remove("error");
  }

  private async run(): Promise<void> {
    if (this.runBtn.disabled) return;
    const type = this.type.value || "IfcElement";
    const properties = this.props.value
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean);
    this.runBtn.disabled = true;
    this.runBtn.classList.add("busy");
    // Every element of the class is read through its type, so a large model
    // takes a moment: the line turns while it does.
    this.status.replaceChildren(spinner(12), h("span", { text: `Reading ${type}` }));
    this.status.classList.remove("error");
    try {
      const report = await this.actions.run(type, properties);
      this.report = report;
      this.render(report);
    } catch (err) {
      // A failure with the previous run's table still on screen reads as if
      // that table were the result; drop it, then say what went wrong.
      this.clear();
      this.status.textContent = err instanceof Error ? err.message : String(err);
      this.status.classList.add("error");
    } finally {
      this.runBtn.disabled = false;
      this.runBtn.classList.remove("busy");
    }
  }

  private render(report: ScheduleReport): void {
    this.datalist.replaceChildren(
      ...report.availableProperties.map((name) => h("option", { value: name })),
    );
    this.exportBtn.disabled = report.rows.length === 0;
    this.status.textContent = `${report.returned.toLocaleString()} of ${report.total.toLocaleString()} ${report.type}${
      report.truncated ? " · truncated" : ""
    }`;
    this.status.classList.remove("error");
    // A class with no instances is an answer, not an empty grid of headers.
    if (report.rows.length === 0) {
      this.host.replaceChildren();
      this.host.classList.add("hidden");
      this.empty.classList.remove("hidden");
      return;
    }
    this.empty.classList.add("hidden");
    this.host.classList.remove("hidden");

    const head = h("tr", {}, report.columns.map((name) => h("th", { text: name, title: name })));
    const body = h("tbody");
    for (const row of report.rows) {
      const id = Number(row.expressID);
      const tr = h("tr", { title: `Select #${id}` }, report.columns.map((name) => {
        const value = row[name];
        const text = value === null || value === undefined ? "" : String(value);
        return h("td", { class: typeof value === "number" ? "num" : "", text, title: text });
      }));
      tr.addEventListener("click", () => {
        body.querySelector("tr.sel")?.classList.remove("sel");
        tr.classList.add("sel");
        if (Number.isFinite(id)) this.actions.select(id);
      });
      body.appendChild(tr);
    }
    this.host.replaceChildren(h("table", { class: "grid" }, [h("thead", {}, [head]), body]));
  }

  private exportCsv(): void {
    if (!this.report) return;
    const { columns, rows, type, truncated, total } = this.report;
    saveCsv(`${type}-schedule.csv`, columns, rows.map((row) => columns.map((name) => row[name] as Value)));
    // The engine caps a run, so a CSV can be a slice; saying so beats a file
    // that looks complete and is not.
    toast(
      truncated
        ? `Exported ${rows.length.toLocaleString()} of ${total.toLocaleString()} rows: the run was capped`
        : "Schedule exported as CSV",
      truncated ? "info" : "success",
    );
  }
}
