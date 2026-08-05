// App chrome around the ribbon: the top bar, the status bar, panel switching
// and the activity log. Pure presentation. Everything it can do is passed in
// as actions, so this module never reaches into the viewer or the service.
import { h, icon, iconButton, makeResizer, toast } from "./kit.js";

export interface ShellActions {
  toggleTheme(): void;
  openSettings(): void;
  openHelp(): void;
  openPalette(): void;
  clearSelection(): void;
  /** Fired after a tab becomes visible, so hosts can build it on demand. */
  tabShown(tab: TabId): void;
  setOutlinerPane(pane: PaneId): void;
}

export type TabId =
  | "properties"
  | "filters"
  | "ids"
  | "bcf"
  | "assistant"
  | "schedule"
  | "plugins"
  | "activity";
export type PaneId = "tree" | "types" | "summary";

const PANES: Array<[string, PaneId]> = [["Structure", "tree"], ["Types", "types"], ["Summary", "summary"]];

const TABS: Array<{ id: TabId; label: string; icon: string; key: string }> = [
  { id: "properties", label: "Properties", icon: "info", key: "P" },
  { id: "filters", label: "Filters", icon: "funnel", key: "R" },
  { id: "ids", label: "IDS checks", icon: "clipboard", key: "" },
  { id: "bcf", label: "Issues", icon: "flag", key: "" },
  { id: "schedule", label: "Schedule", icon: "table", key: "" },
  { id: "assistant", label: "Assistant", icon: "sparkle", key: "C" },
  { id: "plugins", label: "Plugins", icon: "blocks", key: "" },
  { id: "activity", label: "Activity", icon: "activity", key: "L" },
];

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

export class Shell {
  readonly outliner = $("outliner");
  readonly inspector = $("inspector");
  readonly viewerHost = $("viewer-host");
  /** Where main.ts mounts the Web Studio / Local Studio chip. */
  readonly barSlot = h("span", { class: "sb-item" });
  /** Top bar icon cluster; main.ts mounts the plugins button here. */
  readonly topSlot = h("span", { class: "top-slot" });
  private readonly tabButtons = new Map<TabId, HTMLButtonElement>();
  private readonly tabBadges = new Map<TabId, HTMLElement>();
  private readonly panes = new Map<string, HTMLElement>();
  private readonly paneButtons = new Map<PaneId, HTMLButtonElement>();
  private readonly status: Record<string, HTMLElement> = {};
  private readonly activityList: HTMLElement;
  private readonly activityEmpty: HTMLElement;
  private readonly project: HTMLElement;
  private readonly projectName: HTMLElement;
  private readonly projectDot: HTMLElement;
  private readonly selection: HTMLElement;
  private readonly themeButton: HTMLButtonElement;
  private readonly mounted = new Set<TabId>();
  private activeTab: TabId = "properties";
  private activityCount = 0;

  constructor(private readonly actions: ShellActions) {
    const bar = $("topbar");
    // The mark itself is a CSS background, so it stays identical to the favicon
    // and the splash without a third copy of the geometry living here.
    bar.prepend(h("span", { class: "brand", title: "IFCViewX" }));

    this.projectDot = h("span", { class: "dot" });
    this.projectName = h("span", { class: "name", text: "No model" });
    this.project = h("span", { class: "model-chip blank" }, [this.projectDot, this.projectName]);

    this.themeButton = iconButton("moon", "Switch theme", actions.toggleTheme);
    // Panel collapse lives in each panel, not up here: the control belongs
    // next to the thing it hides.
    $("topbar-right").append(
      this.project,
      this.barSlot,
      h("span", { class: "bar-sep" }),
      this.topSlot,
      iconButton("command", "Command palette  Ctrl+K", actions.openPalette),
      this.themeButton,
      iconButton("settings", "Settings  Ctrl+,", actions.openSettings),
      iconButton("help", "Keyboard shortcuts  ?", actions.openHelp),
    );
    $("outliner-actions").appendChild(
      iconButton("panel-left-close", "Collapse  Ctrl+B", () => this.togglePanel("outliner"), "icon-btn sm"),
    );
    $("inspector-actions").appendChild(
      iconButton("panel-right-close", "Collapse  \\", () => this.togglePanel("inspector"), "icon-btn sm"),
    );

    this.selection = h("span", { class: "sb-item hidden" });
    this.buildStatusBar();
    this.buildOutlinerSwitch();
    this.buildTabs();

    for (const [, id] of PANES) this.panes.set(id, $(`pane-${id}`));
    for (const tab of TABS) this.panes.set(tab.id, $(`tab-${tab.id}`));

    this.activityList = h("div", { class: "msgs log", id: "activity-list" });
    this.activityEmpty = emptyState("list", "Nothing yet", "Loads, edits and errors are recorded here.");
    const clear = h("button", { class: "link-btn", type: "button", text: "Clear" });
    clear.addEventListener("click", () => {
      this.activityList.replaceChildren();
      this.activityList.classList.add("hidden");
      this.activityEmpty.classList.remove("hidden");
      this.activityCount = 0;
      this.setTabBadge("activity", 0);
    });
    $("tab-activity").appendChild(
      h("div", { class: "page" }, [
        h("div", { class: "group-title" }, [h("span", { text: "Session" }), clear]),
        this.activityEmpty,
        this.activityList,
      ]),
    );
    this.activityList.classList.add("hidden");

    makeResizer({ host: this.outliner, side: "left", cssVar: "--w-outliner", storageKey: "ifcviewx.w.outliner", min: 200, max: 520 });
    makeResizer({ host: this.inspector, side: "right", cssVar: "--w-inspector", storageKey: "ifcviewx.w.inspector", min: 280, max: 680 });
  }

  // -- chrome ---------------------------------------------------------------
  private buildStatusBar(): void {
    const bar = $("statusbar");
    const dot = h("span", { class: "dot" });
    const state = h("span", { text: "No model" });
    const counts = h("span", { class: "sb-item" });
    const hint = h("span", { class: "sb-item shrink" });
    const frame = h("span", { class: "sb-item mono" });
    bar.append(
      h("span", { class: "sb-item" }, [dot, state]),
      h("span", { class: "sb-sep" }),
      counts,
      h("span", { class: "grow" }),
      this.selection,
      hint,
      h("span", { class: "sb-sep" }),
      frame,
    );
    Object.assign(this.status, { dot, state, counts, hint, frame });
  }

  private buildOutlinerSwitch(): void {
    const target = $("outliner-switch");
    for (const [label, pane] of PANES) {
      const button = h("button", { type: "button", text: label, "aria-pressed": String(pane === "tree") });
      button.addEventListener("click", () => this.actions.setOutlinerPane(pane));
      this.paneButtons.set(pane, button);
      target.appendChild(button);
    }
  }

  /** Vertical rail on the outer edge: always visible, so it doubles as the
   *  way back when the panel is collapsed. */
  private buildTabs(): void {
    const rail = $("rail");
    for (const tab of TABS) {
      const badge = h("span", { class: "tab-badge hidden" });
      const first = tab.id === "properties";
      const button = h("button", {
        class: `rail-btn${first ? " active" : ""}`,
        id: `rail-${tab.id}`,
        type: "button",
        role: "tab",
        "aria-selected": String(first),
        "aria-controls": `tab-${tab.id}`,
        // Roving focus: one stop for the whole rail, arrows walk it.
        tabindex: first ? "0" : "-1",
        title: tab.key ? `${tab.label}  ${tab.key}` : tab.label,
        "aria-label": tab.label,
      }, [icon(tab.icon, 16), badge]);
      button.addEventListener("click", () => {
        // Clicking the panel you are already on closes it, like a toggle.
        if (this.activeTab === tab.id && this.isPanelOpen("inspector")) this.togglePanel("inspector");
        else this.selectTab(tab.id);
      });
      button.addEventListener("keydown", (e) => this.railKey(e));
      this.tabButtons.set(tab.id, button);
      this.tabBadges.set(tab.id, badge);
      rail.appendChild(button);
    }
  }

  /** Arrow keys walk the rail, Home and End jump to its ends. */
  private railKey(e: KeyboardEvent): void {
    const order = TABS.map((tab) => tab.id);
    const at = order.indexOf(this.activeTab);
    const next =
      e.key === "ArrowDown" || e.key === "ArrowRight" ? (at + 1) % order.length
      : e.key === "ArrowUp" || e.key === "ArrowLeft" ? (at - 1 + order.length) % order.length
      : e.key === "Home" ? 0
      : e.key === "End" ? order.length - 1
      : -1;
    if (next < 0) return;
    e.preventDefault();
    this.selectTab(order[next]);
    this.tabButtons.get(order[next])?.focus();
  }

  // -- state ----------------------------------------------------------------
  /** Switch tabs; the first time a tab is shown the host gets to build it. */
  selectTab(tab: TabId): void {
    this.activeTab = tab;
    if (this.inspector.classList.contains("collapsed")) this.togglePanel("inspector");
    $("inspector-title").textContent = TABS.find((item) => item.id === tab)?.label ?? "";
    for (const [id, button] of this.tabButtons) {
      button.classList.toggle("active", id === tab);
      button.setAttribute("aria-selected", String(id === tab));
      button.tabIndex = id === tab ? 0 : -1;
    }
    for (const item of TABS) this.panes.get(item.id)?.classList.toggle("hidden", item.id !== tab);
    if (tab === "activity") {
      this.activityCount = 0;
      this.setTabBadge("activity", 0);
    }
    if (!this.mounted.has(tab)) {
      this.mounted.add(tab);
      this.actions.tabShown(tab);
    }
  }

  /** A panel whose lazy build failed is not mounted, so it can be retried. */
  unmount(tab: TabId): void {
    this.mounted.delete(tab);
  }

  setOutlinerPane(pane: PaneId): void {
    if (this.outliner.classList.contains("collapsed")) this.togglePanel("outliner");
    for (const [, id] of PANES) this.panes.get(id)?.classList.toggle("hidden", id !== pane);
    for (const [key, button] of this.paneButtons) button.setAttribute("aria-pressed", String(key === pane));
  }

  togglePanel(which: "outliner" | "inspector"): void {
    const host = which === "outliner" ? this.outliner : this.inspector;
    const collapsed = host.classList.toggle("collapsed");
    if (which === "inspector") {
      // The rail is always on screen and reopens the panel, so no pull tab.
      for (const [id, button] of this.tabButtons) {
        button.classList.toggle("active", !collapsed && id === this.activeTab);
      }
      return;
    }
    document.getElementById("pull-outliner")?.remove();
    if (collapsed) {
      const tab = h("button", {
        class: "pulltab left",
        id: "pull-outliner",
        type: "button",
        title: "Show structure panel  Ctrl+B",
      }, [icon("panel-left-open", 12)]);
      tab.addEventListener("click", () => this.togglePanel("outliner"));
      $("workspace").appendChild(tab);
    }
  }

  isPanelOpen(which: "outliner" | "inspector"): boolean {
    const host = which === "outliner" ? this.outliner : this.inspector;
    return !host.classList.contains("collapsed");
  }

  setTheme(dark: boolean): void {
    this.themeButton.replaceChildren(icon(dark ? "moon" : "sun"));
  }

  setTabBadge(tab: TabId, value: number): void {
    const badge = this.tabBadges.get(tab);
    if (!badge) return;
    badge.textContent = value > 99 ? "99+" : String(value);
    badge.classList.toggle("hidden", !value);
  }

  setProject(name: string, schema: string | null): void {
    this.projectName.textContent = name || "No model";
    this.project.classList.toggle("blank", !name);
    this.project.querySelector(".tag")?.remove();
    if (schema) this.project.appendChild(h("span", { class: "tag", text: schema }));
  }

  setStatus(state: string, kind: "idle" | "live" | "busy" = "idle"): void {
    this.status.state.textContent = state;
    this.status.dot.className = `dot${kind === "live" ? " on" : kind === "busy" ? " busy" : ""}`;
    this.projectDot.className = this.status.dot.className;
  }

  setCounts(entities: number | null, triangles: number | null): void {
    if (entities === null || triangles === null) return this.status.counts.replaceChildren();
    this.status.counts.replaceChildren(
      h("b", { text: entities.toLocaleString() }),
      h("span", { text: "entities" }),
      h("b", { text: `${(triangles / 1e6).toFixed(2)}M` }),
      h("span", { text: "triangles" }),
    );
  }

  setHint(text: string): void {
    this.status.hint.textContent = text;
  }

  setFrameTime(text: string): void {
    this.status.frame.textContent = text;
  }

  /** Selected element readout in the status bar, with a clear affordance. */
  setSelection(label: string | null): void {
    this.selection.classList.toggle("hidden", label === null);
    if (label === null) return;
    const open = h("button", { class: "sb-btn", type: "button", title: "Show properties" }, [
      icon("info", 12),
      h("b", { text: label }),
    ]);
    open.addEventListener("click", () => this.selectTab("properties"));
    const clear = iconButton("x", "Clear selection  Esc", () => this.actions.clearSelection(), "icon-btn sm");
    this.selection.replaceChildren(open, clear, h("span", { class: "sb-sep" }));
  }

  /** Append to the activity log and badge the tab when it is not visible. */
  log(message: string, kind: "info" | "success" | "error" = "info", notify = false): void {
    const time = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    const mark = { info: "info", success: "check-circle", error: "alert" }[kind];
    const list = this.activityList;
    // Follow the tail only when the reader is already at it.
    const follow = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
    this.activityEmpty.classList.add("hidden");
    list.classList.remove("hidden");
    list.appendChild(
      h("div", { class: `log-row ${kind}` }, [
        icon(mark, 12),
        h("span", { class: "grow", text: message }),
        h("span", { class: "time", text: time }),
      ]),
    );
    if (follow) list.scrollTop = list.scrollHeight;
    if (this.activeTab !== "activity") this.setTabBadge("activity", ++this.activityCount);
    if (notify) toast(message, kind);
  }
}

/** Shared illustration-free empty state used by every panel. */
export function emptyState(iconName: string, title: string, sub?: string): HTMLElement {
  return h("div", { class: "empty" }, [
    icon(iconName, 20),
    h("div", { text: title }),
    ...(sub ? [h("div", { class: "sub", text: sub })] : []),
  ]);
}
