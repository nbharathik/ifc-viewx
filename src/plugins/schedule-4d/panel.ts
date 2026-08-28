import {
  bar,
  button,
  emptyState,
  field,
  h,
  header,
  hint,
  note,
  page,
  progress,
  select,
  stats,
  type ExtensionContext,
  type ExtensionInstance,
  type Value,
} from "@ifcviewx/sdk";
import {
  addLink,
  buildScheduleTasks,
  csvCell,
  dateValue,
  emptyWorkspace,
  formatDay,
  matchFilter,
  parseScheduleCsv,
  readWorkspace,
  scheduleRange,
  snapshotAt,
  type ConstructionState,
  type ImportedScheduleTask,
  type ScheduleFilterRule,
  type ScheduleLink,
  type ScheduleTask,
  type ScheduleWorkspace,
} from "./schedule.js";

type StateFilter = "all" | ConstructionState;

const DAY = 86_400_000;
const ROW_LIMIT = 600;
const COLORS: Array<[number, number, number]> = [
  [100, 116, 139],
  [245, 158, 11],
  [239, 68, 68],
  [34, 197, 94],
];
const STATE_INDEX: Record<ConstructionState, number> = {
  planned: 1,
  active: 2,
  delayed: 3,
  completed: 4,
};
const STATE_WEIGHT: Record<ConstructionState, number> = {
  planned: 1,
  completed: 2,
  active: 3,
  delayed: 4,
};

const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, value));
const pct = (value: number): string => `${Math.round(value)}%`;
const isoDay = (value: number): string => new Date(value).toISOString().slice(0, 10);
const safeName = (value: string): string => value.replace(/\.[^.]+$/, "").replace(/[^a-z0-9_-]+/gi, "-").replace(/^-|-$/g, "") || "model";

function taskDepth(task: ScheduleTask, byKey: Map<string, ScheduleTask>): number {
  let depth = 0;
  let parent = task.parentKey;
  const seen = new Set<string>();
  while (parent && byKey.has(parent) && depth < 6 && !seen.has(parent)) {
    seen.add(parent);
    depth++;
    parent = byKey.get(parent)?.parentKey ?? null;
  }
  return depth;
}

function barStyle(start: number, finish: number, rangeStart: number, span: number): string {
  const left = clamp(((start - rangeStart) / span) * 100, 0, 100);
  const right = clamp(((finish - rangeStart) / span) * 100, 0, 100);
  return `left:${left}%;width:${Math.max(0.8, right - left)}%`;
}

/**
 * Uniform-duration steps only, so an axis tick and the gridline behind the
 * bars are the same percentage. Calendar months vary in length, so the long
 * steps are whole weeks and every label is read off the tick's real date.
 */
const TICK_DAYS = [1, 2, 7, 14, 28, 56, 91, 182, 364, 728, 1820];

interface Tick {
  at: number;
  percent: number;
  label: string;
}

function tickStepDays(spanDays: number, maxTicks: number): number {
  return TICK_DAYS.find((days) => spanDays / days <= maxTicks) ?? TICK_DAYS[TICK_DAYS.length - 1];
}

/**
 * Ticks are counted from the range start rather than snapped to a calendar
 * boundary, so tick k sits at exactly k steps and one repeating gradient can
 * draw the gridlines behind the bars with no phase offset to correct.
 */
export function timelineTicks(
  rangeStart: number,
  rangeFinish: number,
  maxTicks: number,
): { ticks: Tick[]; stepPercent: number } {
  const span = Math.max(DAY, rangeFinish - rangeStart);
  const step = tickStepDays(span / DAY, Math.max(2, maxTicks)) * DAY;
  const format = new Intl.DateTimeFormat(undefined, step >= 364 * DAY
    ? { year: "numeric", month: "short", timeZone: "UTC" }
    : step >= 28 * DAY
      ? { month: "short", year: "2-digit", timeZone: "UTC" }
      : { month: "short", day: "2-digit", timeZone: "UTC" });
  const ticks: Tick[] = [];
  for (let at = rangeStart; at <= rangeFinish && ticks.length <= 64; at += step) {
    ticks.push({ at, percent: ((at - rangeStart) / span) * 100, label: format.format(at) });
  }
  return { ticks, stepPercent: (step / span) * 100 };
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let graph = { schedules: [], tasks: [], sequences: [] } as Awaited<ReturnType<typeof ctx.model.scheduleGraph>>;
  let workspace = emptyWorkspace("");
  let tasks: ScheduleTask[] = [];
  let selectedKey = "";
  let query = "";
  let discipline = "all";
  let stateFilter: StateFilter = "all";
  let cursor = Date.now();
  let rangeStart = cursor - 14 * DAY;
  let rangeFinish = cursor + 30 * DAY;
  let playing = 0;
  let resultHandle = "";
  let baseVisibility = new Map<number, boolean>();
  /** Row nodes the timeline scrub updates in place instead of rebuilding. */
  let rows: Array<{ task: ScheduleTask; row: HTMLElement; bar: HTMLElement | null; cell: HTMLElement }> = [];
  /** What the open task card was built from, so scrubbing never rebuilds it. */
  let detailSignature = "";

  const loadProgress = progress();
  const summary = h("div");
  const axis = h("div", { class: "s4d-axis" });
  const gantt = h("div", { class: "s4d-gantt" });
  const detail = h("div", { class: "s4d-detail" });
  const empty = emptyState("clock", "No schedule loaded", "Open an IFC with tasks or import a CSV with Task ID, Start, Finish and Progress columns.");
  const search = h("input", { class: "plug-search-input", type: "search", placeholder: "Find task, activity ID or schedule", spellcheck: "false", "aria-label": "Find task, activity ID, or schedule" });
  const disciplineSelect = select([["all", "All disciplines"]], discipline, (value) => {
    discipline = value;
    syncModelVisibility();
    paint();
    colorModel();
  });
  const dateInput = h("input", { class: "s4d-date", type: "date", "aria-label": "Construction date" });
  const slider = h("input", { class: "s4d-slider", type: "range", min: "0", max: "1", value: "0", step: "1", "aria-label": "Model timeline" });
  const playButton = button("Play", () => togglePlay(), "accent");
  const todayButton = button("Today", () => setCursor(Date.now()));
  const stateTabs = h("div", { class: "seg plug-seg s4d-state-tabs" });
  const importCsvButton = button("Import CSV", () => void importCsv());
  const mappingButton = button("Import mapping", () => void importMapping());
  const board = h("div", { class: "s4d-board" }, [h("div", { class: "s4d-chart" }, [axis, gantt]), detail]);
  const root = page();
  root.classList.add("schedule-4d");

  root.append(
    header("4D schedule", "IFC tasks and field progress on one model timeline.", "IFC + CSV"),
    bar(
      importCsvButton,
      mappingButton,
      button("Export mapping", () => exportMapping()),
      button("Progress CSV", () => exportReport()),
      button("Clear colour", () => ctx.view.colorBy(new Map(), [])),
    ),
    loadProgress.root,
    summary,
    h("section", { class: "s4d-clock" }, [
      h("div", { class: "s4d-clock-controls" }, [playButton, todayButton, dateInput]),
      slider,
    ]),
    h("div", { class: "s4d-filters" }, [search, field("Discipline", disciplineSelect)]),
    stateTabs,
    empty,
    board,
    hint("info", "Mappings and imported progress are stored beside the model in this browser. The IFC is never edited. Export the mapping JSON to move or archive it."),
  );

  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    paintGantt();
  });
  slider.addEventListener("input", () => setCursor(rangeStart + Number(slider.value) * DAY));
  dateInput.addEventListener("change", () => {
    const value = dateValue(dateInput.value);
    if (Number.isFinite(value)) setCursor(clamp(value, rangeStart, rangeFinish));
  });

  const workspaceKey = (): string => `workspace.${ctx.session.model().key}`;

  const save = (): void => {
    workspace.modelKey = ctx.session.model().key;
    ctx.storage.write(workspaceKey(), workspace);
  };

  const refreshTasks = (): void => {
    tasks = buildScheduleTasks(graph, workspace);
    const [from, to] = scheduleRange(tasks, Date.now());
    // Whole UTC days, so a day or week tick always lands on midnight.
    rangeStart = Math.floor(from / DAY) * DAY;
    rangeFinish = Math.ceil(to / DAY) * DAY;
    if (rangeFinish <= rangeStart) rangeFinish = rangeStart + DAY;
    cursor = clamp(cursor, rangeStart, rangeFinish);
    const days = Math.max(1, Math.ceil((rangeFinish - rangeStart) / DAY));
    slider.max = String(days);
    slider.value = String(Math.round((cursor - rangeStart) / DAY));
    dateInput.min = isoDay(rangeStart);
    dateInput.max = isoDay(rangeFinish);
    dateInput.value = isoDay(cursor);
    const names = [...new Set(tasks.map((task) => task.modelName).filter(Boolean))].sort();
    disciplineSelect.replaceChildren(
      h("option", { value: "all", text: "All disciplines" }),
      ...names.map((name) => h("option", { value: name, text: name })),
    );
    if (discipline !== "all" && !names.includes(discipline)) discipline = "all";
    disciplineSelect.value = discipline;
    if (selectedKey && !tasks.some((task) => task.key === selectedKey)) selectedKey = "";
  };

  const load = async (): Promise<void> => {
    stopPlayback();
    ctx.view.colorBy(new Map(), []);
    if (!ctx.session.model().loaded) {
      graph = { schedules: [], tasks: [], sequences: [] };
      workspace = emptyWorkspace("");
      tasks = [];
      paint();
      return;
    }
    loadProgress.set(0, 1, "Reading IFC task graph in the parser worker");
    try {
      const key = ctx.session.model().key;
      graph = await ctx.model.scheduleGraph();
      if (key !== ctx.session.model().key) return;
      baseVisibility = new Map(ctx.view.models().map((model) => [model.index, model.visible]));
      workspace = ctx.storage.read<ScheduleWorkspace>(workspaceKey(), emptyWorkspace(key));
      if (workspace.version !== 1) workspace = emptyWorkspace(key);
      cursor = Date.now();
      refreshTasks();
      publishResults();
      paint();
      colorModel();
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      graph = { schedules: [], tasks: [], sequences: [] };
      tasks = [];
      paint();
    } finally {
      loadProgress.hide();
    }
  };

  const visibleTasks = (): ScheduleTask[] => tasks.filter((task) => {
    if (discipline !== "all" && task.modelName !== discipline) return false;
    const snapshot = snapshotAt(task, cursor);
    if (stateFilter !== "all" && snapshot.state !== stateFilter) return false;
    return !query || `${task.externalId} ${task.name} ${task.scheduleName} ${task.modelName}`.toLowerCase().includes(query);
  });

  const setCursor = (value: number): void => {
    cursor = clamp(value, rangeStart, rangeFinish);
    slider.value = String(Math.round((cursor - rangeStart) / DAY));
    dateInput.value = isoDay(cursor);
    scrub();
    colorModel();
  };

  /**
   * Everything the status date moves, and nothing else. Playback steps this
   * five times a second, so it must not rebuild the mapping controls or read
   * the element list.
   */
  const scrub = (): void => {
    paintCursorLine();
    paintTotals();
    // A state filter changes which rows belong in the view, so only an
    // unfiltered Gantt can be updated in place.
    if (stateFilter === "all") refreshRows();
    else paintGantt();
    refreshDetail();
  };

  const percentAt = (value: number): number =>
    clamp(((value - rangeStart) / Math.max(DAY, rangeFinish - rangeStart)) * 100, 0, 100);

  const paintCursorLine = (): void => {
    const at = percentAt(cursor);
    board.style.setProperty("--s4d-cursor", `${at}%`);
    const now = Date.now();
    board.style.setProperty("--s4d-today", now >= rangeStart && now <= rangeFinish ? `${percentAt(now)}%` : "-9%");
    const flag = axis.querySelector<HTMLElement>(".s4d-axis-cursor");
    if (flag) flag.textContent = formatDay(cursor);
  };

  const togglePlay = (): void => {
    if (playing) return stopPlayback();
    if (cursor >= rangeFinish) cursor = rangeStart;
    playButton.textContent = "Pause";
    const step = Math.max(1, Math.ceil((rangeFinish - rangeStart) / DAY / 160));
    playing = window.setInterval(() => {
      const next = cursor + step * DAY;
      if (next >= rangeFinish) {
        setCursor(rangeFinish);
        stopPlayback();
      } else setCursor(next);
    }, 180);
  };

  const stopPlayback = (): void => {
    if (playing) window.clearInterval(playing);
    playing = 0;
    playButton.textContent = "Play";
  };

  /**
   * A discipline can come from a CSV column that names no open model. Hiding
   * every model in that case would blank the viewport, so the filter only
   * drives visibility when it matches a loaded file.
   */
  const syncModelVisibility = (): void => {
    const models = ctx.view.models();
    const isolate = discipline !== "all" && models.some((model) => model.name === discipline);
    for (const model of models) {
      const visible = isolate ? model.name === discipline : (baseVisibility.get(model.index) ?? true);
      ctx.view.setModelVisible(model.index, visible);
    }
  };

  const colorModel = (): void => {
    if (!tasks.length) return;
    const assignment = new Map<number, number>();
    const weights = new Map<number, number>();
    for (const task of tasks) {
      if (discipline !== "all" && task.modelName !== discipline) continue;
      const state = snapshotAt(task, cursor).state;
      for (const id of task.elementIds) {
        if ((weights.get(id) ?? 0) > STATE_WEIGHT[state]) continue;
        weights.set(id, STATE_WEIGHT[state]);
        assignment.set(id, STATE_INDEX[state]);
      }
    }
    ctx.view.colorBy(assignment, COLORS);
  };

  const paint = (): void => {
    empty.classList.toggle("hidden", tasks.length > 0);
    board.classList.toggle("hidden", tasks.length === 0);
    paintTotals();
    paintAxis();
    paintGantt();
    detailSignature = "";
    paintDetail();
  };

  /** One pass over the tasks feeds both the headline stats and the state tabs. */
  const paintTotals = (): void => {
    if (!tasks.length) {
      summary.replaceChildren();
      stateTabs.replaceChildren();
      return;
    }
    const counts: Record<ConstructionState, number> = { planned: 0, active: 0, delayed: 0, completed: 0 };
    let linked = 0;
    let actual = 0;
    let planned = 0;
    for (const task of tasks) {
      const snapshot = snapshotAt(task, cursor);
      counts[snapshot.state]++;
      if (task.elementIds.length) linked++;
      actual += snapshot.actualProgress;
      planned += snapshot.plannedProgress;
    }
    actual /= tasks.length;
    planned /= tasks.length;
    summary.replaceChildren(stats([
      ["tasks", tasks.length.toLocaleString()],
      ["linked", `${linked.toLocaleString()} / ${tasks.length.toLocaleString()}`, linked ? "ok" : "warn"],
      ["planned", pct(planned)],
      ["actual", pct(actual), actual + 5 < planned ? "warn" : "ok"],
      ["delayed", counts.delayed.toLocaleString(), counts.delayed ? "err" : "ok"],
    ]));

    stateTabs.replaceChildren();
    const filters: StateFilter[] = ["all", "planned", "active", "delayed", "completed"];
    for (const filter of filters) {
      const count = filter === "all" ? tasks.length : counts[filter];
      const tab = h("button", {
        type: "button",
        class: filter === "all" ? undefined : filter,
        text: `${filter === "all" ? "All" : filter} ${count}`,
        "aria-pressed": String(stateFilter === filter),
      });
      tab.addEventListener("click", () => {
        stateFilter = filter;
        paintTotals();
        paintGantt();
      });
      stateTabs.appendChild(tab);
    }
  };

  /**
   * The axis shares the row grid, so a tick sits exactly above the day it
   * names and the gridline the tracks draw behind the bars.
   */
  const paintAxis = (): void => {
    if (!tasks.length) return void axis.replaceChildren();
    // The track is roughly half a row wide, and a date label needs ~80px, so
    // the tick budget is read off the row width at about a third of that rate.
    const width = gantt.clientWidth || root.clientWidth || 520;
    const { ticks, stepPercent } = timelineTicks(rangeStart, rangeFinish, clamp(Math.round(width / 150), 3, 12));
    board.style.setProperty("--s4d-tick", `${stepPercent}%`);
    const line = h("div", { class: "s4d-axis-track" }, ticks.map((tick) =>
      h("span", { style: `left:${tick.percent}%`, text: tick.label }),
    ));
    line.appendChild(h("b", { class: "s4d-axis-cursor", text: formatDay(cursor) }));
    axis.replaceChildren(
      h("span", { class: "s4d-axis-lead", text: "TASK" }),
      line,
      h("span", { class: "s4d-axis-unit", text: "DONE" }),
    );
    paintCursorLine();
  };

  const paintGantt = (): void => {
    rows = [];
    if (!tasks.length) return void gantt.replaceChildren();
    const listed = visibleTasks();
    const span = Math.max(DAY, rangeFinish - rangeStart);
    const byKey = new Map(tasks.map((task) => [task.key, task]));
    const fragment = document.createDocumentFragment();
    if (!listed.length) fragment.appendChild(emptyState("search", "No tasks in this view", "Change the status, discipline or search filter."));
    for (const task of listed.slice(0, ROW_LIMIT)) {
      const snapshot = snapshotAt(task, cursor);
      const start = dateValue(task.plannedStart);
      const finish = dateValue(task.plannedFinish);
      const actualStart = dateValue(task.actualStart ?? task.plannedStart);
      let actualFinish = dateValue(task.actualFinish);
      if (!Number.isFinite(actualFinish) && Number.isFinite(actualStart) && Number.isFinite(finish)) {
        actualFinish = actualStart + Math.max(0, finish - actualStart) * task.progress / 100;
      }
      const track = h("div", { class: "s4d-track" });
      let bar: HTMLElement | null = null;
      if (Number.isFinite(start) && Number.isFinite(finish)) {
        bar = h("span", {
          class: `s4d-plan-bar ${snapshot.state}${task.isMilestone ? " milestone" : ""}`,
          style: barStyle(start, Math.max(start, finish), rangeStart, span),
          title: `Planned ${formatDay(start)} to ${formatDay(finish)}`,
        });
        track.appendChild(bar);
      } else track.appendChild(h("span", { class: "s4d-no-date", text: "UNSCHEDULED" }));
      if (Number.isFinite(actualStart) && Number.isFinite(actualFinish) && actualFinish >= actualStart) {
        track.appendChild(h("span", {
          class: "s4d-actual-bar",
          style: barStyle(actualStart, actualFinish, rangeStart, span),
          title: `Actual ${formatDay(actualStart)} to ${formatDay(actualFinish)}`,
        }));
      }
      const depth = taskDepth(task, byKey);
      const cell = h("span", { class: "s4d-progress-cell" }, [
        h("b", { text: `${Math.round(task.progress)}%` }),
        h("span", { text: snapshot.state }),
      ]);
      const row = h("button", {
        class: `s4d-task-row ${snapshot.state}${selectedKey === task.key ? " selected" : ""}`,
        type: "button",
        "aria-pressed": String(selectedKey === task.key),
        title: `${task.name}\n${task.externalId} · planned ${formatDay(task.plannedStart)} to ${formatDay(task.plannedFinish)}`,
      }, [
        h("span", { class: "s4d-task-meta", style: `--task-depth:${depth}` }, [
          h("b", { text: task.name }),
          h("span", { text: `${task.externalId} · ${task.modelName || "No discipline"}` }),
        ]),
        track,
        cell,
      ]);
      row.addEventListener("click", () => selectTask(task));
      rows.push({ task, row, bar, cell });
      fragment.appendChild(row);
    }
    if (listed.length > ROW_LIMIT) fragment.appendChild(note(`Showing ${ROW_LIMIT} of ${listed.length.toLocaleString()} tasks. Search or filter to narrow the Gantt.`));
    gantt.replaceChildren(fragment);
  };

  /** Restate the rows already on screen at the new status date. */
  const refreshRows = (): void => {
    for (const entry of rows) {
      const state = snapshotAt(entry.task, cursor).state;
      entry.row.className = `s4d-task-row ${state}${selectedKey === entry.task.key ? " selected" : ""}`;
      if (entry.bar) entry.bar.className = `s4d-plan-bar ${state}${entry.task.isMilestone ? " milestone" : ""}`;
      const label = entry.cell.lastElementChild;
      if (label) label.textContent = state;
    }
  };

  const selectTask = (task: ScheduleTask): void => {
    selectedKey = task.key;
    if (task.elementIds.length) ctx.view.select(task.elementIds.slice(0, 1500));
    for (const entry of rows) {
      const on = entry.task.key === selectedKey;
      entry.row.classList.toggle("selected", on);
      entry.row.setAttribute("aria-pressed", String(on));
    }
    paintDetail();
  };

  /** Only the parts of the open card that the status date moves. */
  const refreshDetail = (): void => {
    const task = tasks.find((item) => item.key === selectedKey);
    const card = detail.querySelector<HTMLElement>(".s4d-task-card");
    if (!task || !card) return;
    const snapshot = snapshotAt(task, cursor);
    card.className = `s4d-task-card ${snapshot.state}`;
    const badge = card.querySelector<HTMLElement>(".s4d-state-badge");
    if (badge) badge.textContent = snapshot.state;
    const gap = card.querySelector<HTMLElement>('[data-metric="gap"] b');
    if (gap) gap.textContent = `${Math.round(snapshot.actualProgress - snapshot.plannedProgress)} points`;
    const variance = card.querySelector<HTMLElement>('[data-metric="variance"] b');
    if (variance) variance.textContent = snapshot.varianceDays ? `${snapshot.varianceDays.toFixed(1)} days late` : "On plan";
  };

  const paintDetail = (): void => {
    if (!tasks.length) {
      detailSignature = "";
      return void detail.replaceChildren();
    }
    const task = tasks.find((item) => item.key === selectedKey);
    if (!task) {
      detailSignature = "";
      detail.replaceChildren(emptyState("list", "Choose a task to map it", "A task can keep its native IFC products and add links from the current selection, a saved selection set, GlobalIds or a class and storey filter."));
      return;
    }
    // Rebuilding drops whatever the user typed into the mapping controls, so
    // the card is only rebuilt when the task or its links actually change.
    const signature = `${task.key}|${task.links.map((link) => `${link.kind}:${link.label}:${link.elementIds.length}`).join("|")}`;
    if (signature === detailSignature) return void refreshDetail();
    detailSignature = signature;
    const snapshot = snapshotAt(task, cursor);
    const setSelect = h("select", { class: "plug-select", "aria-label": "Saved selection set" });
    const sets = ctx.view.rules().filter((rule) => rule.ids.length);
    setSelect.append(
      h("option", { value: "", text: sets.length ? "Choose selection set" : "No saved selection sets" }),
      ...sets.map((rule) => h("option", { value: rule.id, text: `${rule.label} (${rule.ids.length})` })),
    );
    const classSelect = h("select", { class: "plug-select", "aria-label": "IFC class filter" });
    classSelect.append(h("option", { value: "", text: "Any class" }), ...ctx.model.classes().map(([name, count]) => h("option", { value: name, text: `${name.replace(/^Ifc/, "")} (${count})` })));
    const storeySelect = h("select", { class: "plug-select", "aria-label": "Storey filter" });
    const storeys = [...new Set(ctx.model.elements().map((element) => element.storey).filter(Boolean))].sort();
    storeySelect.append(h("option", { value: "", text: "Any storey" }), ...storeys.map((name) => h("option", { value: name, text: name })));
    const nameInput = h("input", { class: "plug-search-input", type: "text", placeholder: "Name contains (optional)", "aria-label": "Element name filter" });
    const globalInput = h("input", { class: "plug-search-input", type: "text", placeholder: "GlobalId; GlobalId", "aria-label": "GlobalIds" });

    const links = h("div", { class: "s4d-links" });
    if (task.nativeElementIds.length) links.appendChild(h("div", { class: "s4d-link native" }, [
      h("span", { class: "s4d-link-kind", text: "IFC" }),
      h("span", { class: "grow", text: `Native IfcRelAssignsToProcess · ${task.nativeElementIds.length.toLocaleString()} products` }),
    ]));
    for (const link of task.links) {
      const row = h("div", { class: "s4d-link" }, [
        h("span", { class: "s4d-link-kind", text: link.kind.replace("-", " ") }),
        h("span", { class: "grow", text: `${link.label} · ${link.elementIds.length.toLocaleString()} elements` }),
        button("Remove", () => removeLink(task, link)),
      ]);
      links.appendChild(row);
    }
    if (!links.childElementCount) links.appendChild(note("No products are linked yet. The schedule dates still report, but the task cannot colour the model."));

    detail.replaceChildren(h("section", { class: `s4d-task-card ${snapshot.state}` }, [
      h("header", {}, [
        h("span", { class: "s4d-state-badge", text: snapshot.state }),
        h("div", { class: "grow" }, [h("b", { text: task.name }), h("span", { text: `${task.externalId} · ${task.source.toUpperCase()}` })]),
        button("BCF issue", () => void createIssue(task)),
      ]),
      h("div", { class: "s4d-comparison" }, [
        metric("Planned", `${formatDay(task.plannedStart)} to ${formatDay(task.plannedFinish)}`),
        metric("Actual", task.actualStart || task.actualFinish ? `${formatDay(task.actualStart)} to ${formatDay(task.actualFinish)}` : `${Math.round(task.progress)}% reported`),
        metric("Progress gap", `${Math.round(snapshot.actualProgress - snapshot.plannedProgress)} points`, "gap"),
        metric("Finish variance", snapshot.varianceDays ? `${snapshot.varianceDays.toFixed(1)} days late` : "On plan", "variance"),
      ]),
      bar(
        button("Select products", () => task.elementIds.length ? ctx.view.select(task.elementIds) : ctx.feedback.toast("This task has no linked products", "error")),
        button("Isolate products", () => task.elementIds.length ? ctx.view.isolate(task.elementIds, `4D: ${task.name}`) : ctx.feedback.toast("This task has no linked products", "error")),
        button("Show all", () => ctx.view.showAll()),
      ),
      h("div", { class: "s4d-map-grid" }, [
        mappingBlock("Current selection", "Use the elements selected in the viewer.", [
          selectionButton(task),
        ]),
        mappingBlock("Saved selection set", "Copy a named visibility set into this mapping.", [
          setSelect,
          button("Link set", () => {
            const rule = sets.find((item) => item.id === setSelect.value);
            if (!rule) return void ctx.feedback.toast("Choose a selection set", "error");
            link(task, { kind: "selection-set", label: rule.label, elementIds: rule.ids });
          }),
        ]),
        mappingBlock("Rule filter", "Match by discipline, IFC class, storey and optional name.", [
          classSelect,
          storeySelect,
          nameInput,
          button("Link filter", () => {
            const rule: ScheduleFilterRule = {
              type: classSelect.value || undefined,
              storey: storeySelect.value || undefined,
              nameContains: nameInput.value.trim() || undefined,
              modelIndex: task.modelIndex ?? undefined,
            };
            const ids = matchFilter(ctx.model.elements(), rule);
            if (!ids.length) return void ctx.feedback.toast("That filter matches no model elements", "error");
            const label = [classSelect.value || "Any class", storeySelect.value || "Any storey", nameInput.value.trim()].filter(Boolean).join(" · ");
            link(task, { kind: "filter", label, elementIds: ids, rule });
          }),
        ]),
        mappingBlock("GlobalIds", "Resolve one or more stable IFC GlobalIds.", [
          globalInput,
          button("Link GlobalIds", () => void linkGlobalIds(task, globalInput.value)),
        ]),
      ]),
      h("div", { class: "group-title", text: "Product links" }),
      links,
    ]));
  };

  const metric = (label: string, value: string, key = ""): HTMLElement =>
    h("div", { class: "s4d-metric", "data-metric": key || undefined }, [h("span", { text: label }), h("b", { text: value })]);

  /** Its label follows the viewport selection without rebuilding the card. */
  const selectionButton = (task: ScheduleTask): HTMLButtonElement => {
    const node = button(`Link selection (${ctx.view.selection().length})`, () => linkSelection(task), "accent");
    node.classList.add("s4d-link-selection");
    return node;
  };

  const syncSelectionButton = (): void => {
    const node = detail.querySelector<HTMLButtonElement>(".s4d-link-selection");
    if (node) node.textContent = `Link selection (${ctx.view.selection().length})`;
  };

  const mappingBlock = (title: string, copy: string, controls: HTMLElement[]): HTMLElement => h("section", { class: "s4d-map-block" }, [
    h("b", { text: title }),
    h("span", { text: copy }),
    h("div", { class: "s4d-map-controls" }, controls),
  ]);

  const linkSelection = (task: ScheduleTask): void => {
    const ids = ctx.view.selection();
    if (!ids.length) return void ctx.feedback.toast("Select model elements first", "error");
    link(task, { kind: "selection", label: `Selection ${formatDay(Date.now())}`, elementIds: ids });
  };

  const link = (task: ScheduleTask, added: ScheduleLink): void => {
    addLink(workspace, task.key, added);
    save();
    refreshTasks();
    publishResults();
    paint();
    colorModel();
    ctx.feedback.toast(`Linked ${added.elementIds.length.toLocaleString()} elements to ${task.externalId}`, "success");
  };

  const removeLink = (task: ScheduleTask, removed: ScheduleLink): void => {
    const mapping = workspace.mappings[task.key];
    if (!mapping) return;
    mapping.links = mapping.links.filter((link) => link !== removed && !(link.kind === removed.kind && link.label === removed.label));
    mapping.updatedAt = new Date().toISOString();
    if (!mapping.links.length) delete workspace.mappings[task.key];
    save();
    refreshTasks();
    publishResults();
    paint();
    colorModel();
  };

  const globalIdIndex = async (): Promise<Map<string, number[]>> => {
    loadProgress.set(0, 1, "Resolving IFC GlobalIds");
    const rows = await ctx.model.index().build((done, total) => loadProgress.set(done, total, `Resolving GlobalIds ${done.toLocaleString()} of ${total.toLocaleString()}`));
    const index = new Map<string, number[]>();
    for (const row of rows) {
      const key = row.globalId.trim().toLowerCase();
      if (!key) continue;
      const ids = index.get(key) ?? [];
      ids.push(row.id);
      index.set(key, ids);
    }
    loadProgress.hide();
    return index;
  };

  const linkGlobalIds = async (task: ScheduleTask, input: string): Promise<void> => {
    const globalIds = input.split(/[|;,\s]+/).map((value) => value.trim()).filter(Boolean);
    if (!globalIds.length) return void ctx.feedback.toast("Enter at least one GlobalId", "error");
    try {
      const index = await globalIdIndex();
      const ids = globalIds.flatMap((id) => index.get(id.toLowerCase()) ?? []);
      const missing = globalIds.filter((id) => !index.has(id.toLowerCase()));
      if (!ids.length) return void ctx.feedback.toast("None of those GlobalIds are in the open model", "error");
      link(task, { kind: "global-id", label: `${globalIds.length} GlobalIds${missing.length ? `, ${missing.length} missing` : ""}`, elementIds: ids, globalIds });
    } catch (error) {
      loadProgress.hide();
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const resolveImportedGlobalIds = async (imported: ImportedScheduleTask[]): Promise<void> => {
    const withIds = imported.filter((task) => task.globalIds.length);
    if (!withIds.length) return;
    const index = await globalIdIndex();
    refreshTasks();
    for (const item of withIds) {
      const task = tasks.find((candidate) => candidate.externalId.toLowerCase() === item.externalId.toLowerCase());
      if (!task) continue;
      const ids = item.globalIds.flatMap((id) => index.get(id.toLowerCase()) ?? []);
      if (ids.length) addLink(workspace, task.key, {
        kind: "global-id",
        label: `CSV GlobalIds (${item.globalIds.length})`,
        elementIds: ids,
        globalIds: item.globalIds,
      });
    }
  };

  const importCsv = async (): Promise<void> => {
    try {
      const opened = await ctx.files.open("schedule-4d.csv");
      const imported = parseScheduleCsv(opened.text);
      workspace.imported = imported;
      refreshTasks();
      await resolveImportedGlobalIds(imported);
      save();
      refreshTasks();
      publishResults();
      paint();
      colorModel();
      ctx.feedback.toast(`Imported ${imported.length.toLocaleString()} schedule tasks from ${opened.name}`, "success");
    } catch (error) {
      loadProgress.hide();
      if (!(error instanceof DOMException && error.name === "AbortError")) ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const importMapping = async (): Promise<void> => {
    try {
      const opened = await ctx.files.open("schedule-4d.mapping");
      workspace = readWorkspace(JSON.parse(opened.text), ctx.session.model().key);
      save();
      refreshTasks();
      publishResults();
      paint();
      colorModel();
      ctx.feedback.toast(`Imported mappings from ${opened.name}`, "success");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const exportMapping = (): void => {
    if (!ctx.session.model().loaded) return void ctx.feedback.toast("Open a model first", "error");
    const payload = JSON.stringify({ ...workspace, exportedAt: new Date().toISOString(), modelName: ctx.session.model().name }, null, 2);
    ctx.files.export("schedule-4d.mapping", `4d-mapping-${safeName(ctx.session.model().name)}.json`, payload, "application/json");
  };

  const reportRows = (): Value[][] => tasks.map((task) => {
    const snapshot = snapshotAt(task, cursor);
    return [
      task.externalId,
      task.name,
      task.scheduleName,
      task.modelName,
      task.source,
      task.plannedStart,
      task.plannedFinish,
      task.actualStart,
      task.actualFinish,
      Number(snapshot.plannedProgress.toFixed(1)),
      Number(snapshot.actualProgress.toFixed(1)),
      Number((snapshot.actualProgress - snapshot.plannedProgress).toFixed(1)),
      Number(snapshot.varianceDays.toFixed(1)),
      snapshot.state,
      task.elementIds.length,
      task.links.map((link) => link.kind).join("+"),
    ];
  });

  const exportReport = (): void => {
    if (!tasks.length) return void ctx.feedback.toast("Load or import a schedule first", "error");
    const headers = ["Task ID", "Task", "Schedule", "Discipline", "Source", "Planned start", "Planned finish", "Actual start", "Actual finish", "Planned %", "Actual %", "Progress variance points", "Finish variance days", "State", "Linked elements", "Mapping methods"];
    const csv = [headers, ...reportRows()].map((row) => row.map(csvCell).join(",")).join("\r\n");
    ctx.files.export("schedule-4d.report", `4d-progress-${isoDay(cursor)}.csv`, `\uFEFF${csv}`, "text/csv");
  };

  const publishResults = (): void => {
    if (resultHandle) ctx.results.dispose(resultHandle);
    if (!tasks.length) {
      resultHandle = "";
      return;
    }
    const items = tasks.map((task) => {
      const snapshot = snapshotAt(task, cursor);
      return {
        taskId: task.externalId,
        name: task.name,
        schedule: task.scheduleName,
        discipline: task.modelName,
        source: task.source,
        state: snapshot.state,
        plannedProgress: Number(snapshot.plannedProgress.toFixed(1)),
        actualProgress: Number(snapshot.actualProgress.toFixed(1)),
        varianceDays: Number(snapshot.varianceDays.toFixed(1)),
        linkedElements: task.elementIds.length,
      };
    });
    resultHandle = ctx.results.create("schedule-4d.results", items, { metadata: {
      model: ctx.session.model().name,
      asOf: isoDay(cursor),
      nativeSchedules: graph.schedules.length,
      nativeTasks: graph.tasks.length,
      importedTasks: workspace.imported.length,
    } }).id;
    const delayed = tasks.filter((task) => snapshotAt(task, Date.now()).state === "delayed");
    ctx.feedback.publishFindings(
      `${delayed.length.toLocaleString()} delayed tasks across ${tasks.length.toLocaleString()} scheduled tasks.`,
      delayed.slice(0, 100).map((task) => ({
        severity: "warning",
        title: `Delayed: ${task.name}`,
        detail: `${task.externalId} · ${Math.round(task.progress)}% complete · planned finish ${formatDay(task.plannedFinish)}`,
        expressID: task.elementIds[0],
      })),
    );
  };

  const createIssue = async (task: ScheduleTask): Promise<void> => {
    const snapshot = snapshotAt(task, cursor);
    try {
      const issue = await ctx.issues.create({
        title: `${snapshot.state === "delayed" ? "Delayed task" : "4D state"}: ${task.name}`,
        description: `${task.externalId} is ${snapshot.state} at ${formatDay(cursor)}. Planned ${formatDay(task.plannedStart)} to ${formatDay(task.plannedFinish)}. Actual progress ${Math.round(task.progress)}%, planned progress ${Math.round(snapshot.plannedProgress)}%.`,
        elementIds: task.elementIds,
        priority: snapshot.state === "delayed" ? "High" : "Normal",
        metadata: {
          taskId: task.externalId,
          state: snapshot.state,
          statusDate: isoDay(cursor),
          progress: Math.round(task.progress),
          discipline: task.modelName,
        },
      });
      ctx.feedback.toast(`Created BCF issue ${issue.title}`, "success");
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const offModel = ctx.events.on("model", () => void load());
  const offSelection = ctx.events.on("selection", syncSelectionButton);
  // Moving the panel between the inspector and the wide workspace changes how
  // many date ticks fit, so the axis is redrawn from the measured width.
  const observer = typeof ResizeObserver === "function"
    ? new ResizeObserver(() => {
      if (tasks.length) paintAxis();
    })
    : null;
  observer?.observe(gantt);
  host.appendChild(root);
  void load();

  return {
    dispose: () => {
      stopPlayback();
      observer?.disconnect();
      offModel();
      offSelection();
      if (resultHandle) ctx.results.dispose(resultHandle);
      ctx.view.colorBy(new Map(), []);
      for (const model of ctx.view.models()) ctx.view.setModelVisible(model.index, baseVisibility.get(model.index) ?? model.visible);
    },
  };
}
