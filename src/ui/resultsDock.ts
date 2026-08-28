// One dock for every result producer.
//
// With twenty-odd tools shipped, the weakness is coherence: six panels each
// owned a private list with its own grouping and its own export, so results
// could not be compared and a reviewer relearned the table every time.
// Coordination is a list-driven job, so the list is shared and the panels
// keep only their setup.
import { h, icon, iconButton, makeResizer, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import { clearDocket, docketSets, onDocketChange } from "../results/docket.js";
import type { DocketRow, DocketSet, DocketSeverity } from "../results/docket.js";

export { clearDocket, docketSets, onDocketChange, publishDocket } from "../results/docket.js";
export type { DocketRow, DocketSet, DocketSeverity } from "../results/docket.js";

export interface DocketActions {
  isolate(ids: number[], label: string): void;
  select(ids: number[]): void;
  frameAt(point: [number, number, number]): void;
  frame(id: number): void;
  showAll(): void;
  raiseIssue(title: string, ids: number[], detail: string, point?: [number, number, number], batch?: boolean): void;
  log(message: string, kind?: "info" | "success" | "error"): void;
}


const SEVERITY_ORDER: Record<DocketSeverity, number> = { error: 0, warning: 1, info: 2 };
const ROW_LIMIT = 600;
const STATUSES: Array<[DocketRow["status"], string]> = [
  ["open", "Open"],
  ["accepted", "Accepted"],
  ["rejected", "Rejected"],
];

/**
 * The dock itself: one resizable panel across the bottom of the viewport,
 * tabbed by producer, with the same grouping, severity stripes, assignment and
 * BCF handoff whatever produced the rows.
 */
export class ResultsDock {
  private readonly root: HTMLElement;
  private readonly tabs = h("div", { class: "dock-tabs" });
  private readonly body = h("div", { class: "dock-body" });
  private readonly summary = h("span", { class: "dock-summary" });
  private readonly search = h("input", {
    type: "search",
    class: "dock-search",
    placeholder: "Filter findings",
    "aria-label": "Filter findings",
  });
  private active = "";
  private severity = "all";
  private groupBy: "group" | "severity" | "none" = "group";
  private query = "";
  private open = false;
  /** Rows the user has acted on, keyed set id then row id. */
  private readonly marks = new Map<string, Map<string, { status: DocketRow["status"]; assignee: string }>>();

  constructor(host: HTMLElement, private readonly actions: DocketActions) {
    const close = iconButton("x", "Close the results dock", () => this.setOpen(false), "icon-btn sm");
    const showAll = iconButton("eye", "Show the whole model again", () => actions.showAll(), "icon-btn sm");
    const clear = iconButton("trash", "Clear this result set", () => {
      if (this.active) clearDocket(this.active);
    }, "icon-btn sm");
    const bcf = iconButton("flag", "Raise every shown finding as an issue", () => this.raiseAll(), "icon-btn sm");

    const grouping = h("select", { class: "dock-select", "aria-label": "Group findings by" });
    grouping.append(
      h("option", { value: "group", text: "By group" }),
      h("option", { value: "severity", text: "By severity" }),
      h("option", { value: "none", text: "Flat list" }),
    );
    grouping.addEventListener("change", () => {
      this.groupBy = grouping.value as typeof this.groupBy;
      this.paint();
    });

    const severity = h("select", { class: "dock-select", "aria-label": "Severity" });
    severity.append(
      h("option", { value: "all", text: "All severities" }),
      h("option", { value: "error", text: "Errors" }),
      h("option", { value: "warning", text: "Warnings" }),
      h("option", { value: "info", text: "Notes" }),
    );
    severity.addEventListener("change", () => {
      this.severity = severity.value;
      this.paint();
    });

    this.search.addEventListener("input", () => {
      this.query = this.search.value.trim().toLowerCase();
      this.paint();
    });

    this.root = h("div", { class: "results-dock hidden", id: "results-dock", role: "region", "aria-label": "Results" }, [
      h("div", { class: "dock-head" }, [
        this.tabs,
        h("span", { class: "grow" }),
        this.summary,
        this.search,
        grouping,
        severity,
        bcf,
        showAll,
        clear,
        close,
      ]),
      this.body,
    ]);
    host.appendChild(this.root);
    makeResizer({
      host: this.root,
      side: "top",
      cssVar: "--h-dock",
      storageKey: "ifcviewx.h.dock",
      min: 120,
      max: 560,
    });
    onDocketChange(() => this.sync());
    this.sync();
  }

  setOpen(open: boolean): void {
    this.open = open;
    this.root.classList.toggle("hidden", !open);
    if (open) this.paint();
  }

  toggle(): void {
    this.setOpen(!this.open);
  }

  isOpen(): boolean {
    return this.open;
  }

  /** How many findings are on the dock right now, for the status bar chip. */
  count(): number {
    return docketSets().reduce((total, set) => total + set.rows.length, 0);
  }

  /** Called when a set is published, so a producer can pull the dock open. */
  show(id: string): void {
    this.active = id;
    this.setOpen(true);
    this.paint();
  }

  private sync(): void {
    const list = docketSets();
    const liveSets = new Map(list.map((set) => [set.id, new Set(set.rows.map((row) => row.id))]));
    for (const [setId, marks] of this.marks) {
      const liveRows = liveSets.get(setId);
      if (!liveRows) {
        this.marks.delete(setId);
        continue;
      }
      for (const rowId of marks.keys()) if (!liveRows.has(rowId)) marks.delete(rowId);
      if (marks.size === 0) this.marks.delete(setId);
    }
    if (!list.some((set) => set.id === this.active)) this.active = list[0]?.id ?? "";
    if (list.length === 0) this.setOpen(false);
    this.paint();
  }

  private paint(): void {
    const list = docketSets();
    this.tabs.replaceChildren(
      ...list.map((set) => {
        const errors = set.rows.filter((row) => row.severity === "error").length;
        const tab = h("button", {
          class: `dock-tab${set.id === this.active ? " active" : ""}`,
          type: "button",
          title: set.summary,
        }, [
          h("span", { text: set.title }),
          h("span", { class: `dock-count${errors ? " err" : ""}`, text: String(set.rows.length) }),
        ]);
        tab.addEventListener("click", () => {
          this.active = set.id;
          this.paint();
        });
        return tab;
      }),
    );
    const set = list.find((entry) => entry.id === this.active);
    if (!set) {
      this.summary.textContent = "";
      this.body.replaceChildren(emptyState("list", "No results yet", "Clash, rules, IDS and compare all land here."));
      return;
    }
    this.summary.textContent = set.summary;
    const rows = this.visible(set);
    if (rows.length === 0) {
      this.body.replaceChildren(emptyState("check", "Nothing matches", "Every finding in this set is filtered out."));
      return;
    }
    const buckets = new Map<string, DocketRow[]>();
    for (const row of rows) {
      const key = this.groupBy === "none" ? "" : this.groupBy === "severity" ? row.severity : row.group ?? set.title;
      const bucket = buckets.get(key);
      if (bucket) bucket.push(row);
      else buckets.set(key, [row]);
    }
    const nodes: HTMLElement[] = [];
    let shown = 0;
    for (const [key, bucket] of buckets) {
      if (key) {
        const isolate = h("button", { class: "dock-group", type: "button", title: `Isolate all ${bucket.length}` }, [
          h("span", { class: "grow", text: key }),
          h("span", { class: "n", text: String(bucket.length) }),
        ]);
        isolate.addEventListener("click", () => {
          const ids = [...new Set(bucket.flatMap((row) => row.ids))];
          if (ids.length) this.actions.isolate(ids, `${set.title}: ${key}`);
        });
        nodes.push(isolate);
      }
      for (const row of bucket) {
        if (shown >= ROW_LIMIT) break;
        shown++;
        nodes.push(this.row(set, row));
      }
    }
    if (rows.length > shown) {
      nodes.push(h("div", { class: "note", text: `Showing ${shown.toLocaleString()} of ${rows.length.toLocaleString()}. Narrow the filter to see the rest.` }));
    }
    this.body.replaceChildren(...nodes);
  }

  private visible(set: DocketSet): DocketRow[] {
    return set.rows
      .filter((row) => this.severity === "all" || row.severity === this.severity)
      .filter((row) => !this.query || `${row.title} ${row.detail ?? ""} ${row.group ?? ""}`.toLowerCase().includes(this.query))
      .sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity]);
  }

  private row(set: DocketSet, row: DocketRow): HTMLElement {
    const mark = this.marks.get(set.id)?.get(row.id);
    const status = mark?.status ?? row.status ?? "open";
    const open = h("button", { class: "dock-row-main grow", type: "button", title: row.detail ?? row.title }, [
      h("span", { class: `dock-dot ${row.severity}` }),
      h("span", { class: "grow dock-title", text: row.title }),
      ...(row.detail ? [h("span", { class: "dock-detail", text: row.detail })] : []),
      h("span", { class: "n", text: row.ids.length ? `${row.ids.length}` : "" }),
    ]);
    open.addEventListener("click", () => {
      if (row.ids.length) {
        this.actions.isolate(row.ids, `${set.title}: ${row.title}`);
        this.actions.select(row.ids);
      }
      if (row.point) this.actions.frameAt(row.point);
      else if (row.ids.length) this.actions.frame(row.ids[0]);
    });

    const state = h("select", { class: "dock-select sm", "aria-label": "Status" });
    for (const [value, label] of STATUSES) state.append(h("option", { value: value ?? "open", text: label }));
    state.value = status ?? "open";
    state.addEventListener("change", () => this.mark(set.id, row.id, { status: state.value as DocketRow["status"] }));

    const assignee = h("input", {
      class: "dock-assign",
      type: "text",
      value: mark?.assignee ?? row.assignee ?? "",
      placeholder: "Assign",
      "aria-label": "Assign to",
    });
    assignee.addEventListener("change", () => this.mark(set.id, row.id, { assignee: assignee.value.trim() }));

    const flag = iconButton("flag", "Raise this as an issue", () => {
      this.actions.raiseIssue(`${set.title}: ${row.title}`, row.ids, row.detail ?? "", row.point);
    }, "icon-btn sm");

    return h("div", { class: `dock-row ${status ?? "open"}` }, [open, state, assignee, flag]);
  }

  private mark(setId: string, rowId: string, patch: { status?: DocketRow["status"]; assignee?: string }): void {
    const bucket = this.marks.get(setId) ?? new Map<string, { status: DocketRow["status"]; assignee: string }>();
    const current = bucket.get(rowId) ?? { status: "open" as DocketRow["status"], assignee: "" };
    bucket.set(rowId, { ...current, ...patch });
    this.marks.set(setId, bucket);
    this.paint();
  }

  private raiseAll(): void {
    const set = docketSets().find((entry) => entry.id === this.active);
    if (!set) return;
    const rows = this.visible(set).filter((row) => row.severity !== "info" && row.ids.length > 0).slice(0, 25);
    if (rows.length === 0) return void toast("Nothing worth raising in this view", "info");
    for (const row of rows) {
      this.actions.raiseIssue(`${set.title}: ${row.title}`, row.ids, row.detail ?? "", row.point, true);
    }
    this.actions.log(`Raised ${rows.length} issue(s) from ${set.title}`, "success");
  }
}

/** The chip that opens the dock, for the status bar. */
export function docketChip(open: () => void): HTMLElement {
  const count = h("b", { text: "0" });
  const button = h("button", { class: "sb-btn", type: "button", title: "Results dock" }, [
    icon("list", 12),
    count,
    h("span", { text: "findings" }),
  ]);
  button.addEventListener("click", open);
  const wrap = h("span", { class: "sb-item hidden" }, [button, h("span", { class: "sb-sep" })]);
  const sync = (): void => {
    const total = docketSets().reduce((sum, set) => sum + set.rows.length, 0);
    count.textContent = total.toLocaleString();
    wrap.classList.toggle("hidden", total === 0);
  };
  onDocketChange(sync);
  sync();
  return wrap;
}
