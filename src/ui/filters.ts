// Filters: named, removable rules over the model's visibility. The viewer owns
// the rules and combines them: everything a Show rule keeps is unioned, so a
// second filter widens the view instead of emptying it, and Hide rules and
// hand-hidden elements subtract on top. The panel builds rules, the viewport
// chip shows what is applied and takes it back off.
import { attachPopover, h, icon, iconButton, toast } from "./kit.js";
import type { ItemProperties, SpatialNode, Viewer } from "../viewer-core/viewer.js";

export interface FilterRule {
  id: string;
  label: string;
  mode: "keep" | "hide";
  ids: number[];
}

/** Property reads are worker round trips, so one scan is bounded. */
const SCAN_LIMIT = 4000;
const SCAN_LANES = 12;
/** Rows rendered at once; the rest are reachable by typing into the search. */
const ROW_LIMIT = 40;

/**
 * Read properties for many elements with a few reads in flight. `missing`
 * counts elements with no readable data at all: a converted .ifcx carries
 * geometry only, and callers must say so rather than report an empty result.
 */
export async function scanElements(
  viewer: Viewer,
  ids: number[],
  match: (props: ItemProperties) => boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<{ ids: number[]; scanned: number; truncated: boolean; missing: number }> {
  const pool = ids.slice(0, SCAN_LIMIT);
  const hits: number[] = [];
  let next = 0;
  let done = 0;
  let missing = 0;
  const lane = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      if (index >= pool.length) return;
      const props = await viewer.getProperties(pool[index]);
      if (!props) missing++;
      else if (match(props)) hits.push(pool[index]);
      if (++done % 64 === 0) onProgress?.(done, pool.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(SCAN_LANES, pool.length) }, lane));
  hits.sort((a, b) => a - b);
  return { ids: hits, scanned: pool.length, truncated: ids.length > pool.length, missing };
}

/** Values of one property. An empty set name also searches direct attributes. */
function readProperty(props: ItemProperties, set: string, name: string): string[] {
  const wanted = name.toLowerCase();
  const found: string[] = [];
  for (const pset of props.psets) {
    if (set && pset.name.toLowerCase() !== set.toLowerCase()) continue;
    for (const property of pset.properties) {
      if (property.name.toLowerCase() === wanted && property.value !== null) {
        found.push(String(property.value));
      }
    }
  }
  if (!set) {
    for (const attribute of props.attributes) {
      if (attribute.name.toLowerCase() === wanted && attribute.value !== null) {
        found.push(String(attribute.value));
      }
    }
  }
  return found;
}

/**
 * Thin front end over the viewer's rule layer: the viewer decides what is on
 * screen, this only names things and reports what is in force. Nothing here
 * writes visibility directly, so the tree eyes, the class list and the panel
 * can no longer undo each other.
 */
export class FilterStore {
  private readonly listeners = new Set<() => void>();

  constructor(private readonly viewer: Viewer) {
    viewer.onModelLoaded(() => this.emit());
    viewer.onVisibilityChange(() => this.emit());
    viewer.onSectionChange(() => this.emit());
    viewer.onMeasureChange(() => this.emit());
  }

  list(): FilterRule[] {
    return this.viewer.getRules() as FilterRule[];
  }

  add(rule: Omit<FilterRule, "id">): FilterRule | null {
    if (rule.ids.length === 0) {
      toast("Nothing matched that filter", "info");
      return null;
    }
    return this.viewer.addRule(rule) as FilterRule;
  }

  remove(id: string): void {
    this.viewer.removeRule(id);
  }

  clear(): void {
    this.viewer.clearSection();
    this.viewer.showAll();
    this.viewer.resetMeasure();
  }

  /** Everything currently narrowing the view, rules and viewer state alike. */
  entries(): Array<{ label: string; detail: string; remove: () => void }> {
    const out = this.list().map((rule) => ({
      label: rule.label,
      detail: `${rule.mode === "hide" ? "hides" : "shows"} ${rule.ids.length.toLocaleString()}`,
      remove: () => this.remove(rule.id),
    }));
    const manual = this.viewer.getHiddenCount();
    if (manual > 0) {
      out.push({
        label: "Hidden by hand",
        detail: `${manual.toLocaleString()} element${manual === 1 ? "" : "s"}`,
        remove: () => this.viewer.setHidden(this.viewer.getHiddenIds(), false),
      });
    }
    const sections = this.viewer.getSections();
    if (sections.length) {
      out.push({
        label: "Section planes",
        detail: sections.map((section) => (section.axis ? section.axis.toUpperCase() : section.name)).join(", "),
        remove: () => this.viewer.clearSection(),
      });
    }
    const box = this.viewer.getSectionBox();
    if (box) {
      const size = box.max.map((value, i) => value - box.min[i]);
      out.push({
        label: "Section box",
        detail: size.map((value) => value.toFixed(1)).join(" x "),
        remove: () => this.viewer.setSectionBox(null),
      });
    }
    // Measurements stay on the model after the tool closes, so this is where
    // they come off, next to everything else drawn over the view.
    const measures = this.viewer.getMeasureCount();
    if (measures > 0) {
      out.push({
        label: "Measurements",
        detail: `${measures.toLocaleString()} placed`,
        remove: () => this.viewer.resetMeasure(),
      });
    }
    return out;
  }

  onChange(listener: () => void): void {
    this.listeners.add(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}

/**
 * The floating filter pill in the bottom-right corner of the viewport: it
 * only appears once something narrows the view, so its presence is the signal
 * that the model is filtered, and its popover lists every filter in force
 * (rules, hand-hidden elements, section planes) with a way to drop each one.
 */
export class FilterChip {
  private readonly root: HTMLElement;
  private readonly count = h("span");
  private readonly button = h(
    "button",
    { class: "chip-btn", type: "button", title: "What is applied to this view. Click to take any of it off." },
    [icon("funnel", 13)],
  );

  constructor(host: HTMLElement, private readonly store: FilterStore) {
    this.button.appendChild(this.count);
    this.root = h("div", { id: "filter-chip", class: "hidden" }, [this.button]);
    host.appendChild(this.root);
    attachPopover(this.button, (pop) => this.build(pop), "above");
    store.onChange(() => this.sync());
    this.sync();
  }

  private sync(): void {
    const entries = this.store.entries();
    this.count.textContent = `${entries.length} applied`;
    this.root.classList.toggle("hidden", entries.length === 0);
    const open = this.root.querySelector<HTMLElement>(".pop");
    if (open) this.build(open);
  }

  private build(pop: HTMLElement): void {
    const entries = this.store.entries();
    const list = h("div", { class: "pop-list" });
    for (const entry of entries) {
      list.appendChild(
        h("div", { class: "filter-row" }, [
          h("span", { class: "grow", text: entry.label, title: entry.label }),
          h("span", { class: "n", text: entry.detail }),
          iconButton("x", "Remove filter", () => entry.remove(), "icon-btn sm"),
        ]),
      );
    }
    const clear = h("button", { class: "btn grow", type: "button", text: "Clear everything" });
    clear.addEventListener("click", () => this.store.clear());
    pop.replaceChildren(
      h("div", { class: "pop-title", text: `Applied to this view (${entries.length})` }),
      list,
      h("div", { class: "pop-row" }, [clear]),
    );
  }
}

/**
 * One box, one list. Typing narrows classes and storeys and offers the query
 * itself as a name match; a row shows, its eye hides.
 */
export class FilterPanel {
  private readonly rules = h("div", { class: "filter-list" });
  private readonly results = h("div", { class: "filter-list scroll-box" });
  private readonly search = h("input", {
    type: "search",
    placeholder: "Filter by class, storey or name",
    spellcheck: "false",
  });
  private readonly setName = h("input", { type: "text", placeholder: "Pset (blank searches all of them)", "aria-label": "Property set" });
  private readonly propName = h("input", { type: "text", placeholder: "Property", "aria-label": "Property name" });
  private readonly propValue = h("input", { type: "text", placeholder: "Value (blank means present)", "aria-label": "Property value" });
  private readonly op = h("select", { "aria-label": "Comparison" });
  private readonly status = h("div", { class: "status-line" });
  private readonly clearAll: HTMLButtonElement;

  constructor(
    host: HTMLElement,
    private readonly viewer: Viewer,
    private readonly store: FilterStore,
  ) {
    this.op.append(
      h("option", { value: "is", text: "is" }),
      h("option", { value: "contains", text: "contains" }),
      h("option", { value: "not", text: "is not" }),
    );

    const clearAll = h("button", { class: "link-btn hidden", type: "button", text: "Clear all" });
    clearAll.addEventListener("click", () => store.clear());
    this.clearAll = clearAll;

    const runProp = h("button", { class: "btn accent", type: "button", text: "Apply" });
    runProp.addEventListener("click", () => void this.runProperty(runProp).catch((err: Error) => {
      this.status.textContent = err.message;
      this.status.classList.add("error");
      runProp.disabled = false;
    }));

    this.search.addEventListener("input", () => this.renderResults());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") this.results.querySelector<HTMLButtonElement>(".filter-row.pick")?.click();
    });

    // The property scan is the one slow, wordy path here, so it folds away.
    const advanced = h("details", { class: "fold" }, [
      h("summary", { text: "By property" }),
      this.setName,
      h("div", { class: "row" }, [this.propName, this.op]),
      h("div", { class: "row" }, [this.propValue, runProp]),
      this.status,
    ]);

    host.appendChild(
      h("div", { class: "page scroll" }, [
        h("div", { class: "group-title" }, [h("span", { text: "Applied" }), clearAll]),
        this.rules,
        h("div", { class: "group-title", text: "Add a filter" }),
        this.search,
        this.results,
        advanced,
      ]),
    );

    store.onChange(() => this.renderRules());
    viewer.onModelLoaded(() => this.refresh());
    this.refresh();
  }

  refresh(): void {
    this.renderRules();
    this.renderResults();
  }

  /**
   * Classes and storeys the query matches, plus the query itself as a name
   * match. Clicking a row shows only it; the eye hides it instead.
   */
  private renderResults(): void {
    const query = this.search.value.trim().toLowerCase();
    const rows: Array<{ label: string; count: number; icon: string; ids: () => number[] }> = [];

    const counts = new Map<string, number>();
    for (const type of this.viewer.getElementTypes().values()) {
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    for (const [type, count] of [...counts].sort((a, b) => b[1] - a[1])) {
      if (query && !type.toLowerCase().includes(query)) continue;
      rows.push({
        label: type.replace(/^Ifc/, ""),
        count,
        icon: "cube",
        ids: () => [...this.viewer.getElementTypes()].filter(([, t]) => t === type).map(([id]) => id),
      });
    }

    const storeys: SpatialNode[] = [];
    const walk = (node: SpatialNode): void => {
      if (node.type === "IfcBuildingStorey") storeys.push(node);
      node.children.forEach(walk);
    };
    const tree = this.viewer.getSpatialTree();
    if (tree) walk(tree);
    for (const node of storeys) {
      const name = node.name || `#${node.expressID}`;
      if (query && !name.toLowerCase().includes(query)) continue;
      rows.push({
        label: name,
        count: this.viewer.getSubtreeElementIds(node.expressID).length,
        icon: "layers",
        ids: () => this.viewer.getSubtreeElementIds(node.expressID),
      });
    }

    if (query) {
      const matched = this.matchNames(query);
      if (matched.length) {
        rows.unshift({
          label: `Named "${this.search.value.trim()}"`,
          count: matched.length,
          icon: "search",
          ids: () => matched,
        });
      }
    }

    if (rows.length === 0) {
      this.results.replaceChildren(
        h("div", { class: "note", text: query ? "Nothing matches that." : "Load a model to see its classes." }),
      );
      return;
    }
    // Storeys are appended after every class, so a slice off the end would
    // hide them entirely on a model with many classes: interleave instead.
    const shown = rows.length > ROW_LIMIT
      ? [...rows.filter((row) => row.icon !== "cube").slice(0, ROW_LIMIT / 2),
         ...rows.filter((row) => row.icon === "cube")].slice(0, ROW_LIMIT)
      : rows;
    this.results.replaceChildren(
      ...shown.map((row) => {
        const show = h("button", { class: "filter-row pick grow", type: "button", title: `Show only ${row.label}` }, [
          icon(row.icon, 13),
          h("span", { class: "grow", text: row.label }),
          h("span", { class: "n", text: row.count.toLocaleString() }),
        ]);
        show.addEventListener("click", () => this.store.add({ label: row.label, mode: "keep", ids: row.ids() }));
        const hide = iconButton(
          "eye-off",
          `Hide ${row.label}`,
          () => this.store.add({ label: row.label, mode: "hide", ids: row.ids() }),
          "icon-btn sm",
        );
        return h("div", { class: "filter-pair" }, [show, hide]);
      }),
    );
    if (rows.length > shown.length) {
      this.results.appendChild(
        h("div", { class: "note", text: `${rows.length - shown.length} more; type to narrow the list.` }),
      );
    }
  }

  private matchNames(text: string): number[] {
    const ids: number[] = [];
    const walk = (node: SpatialNode): void => {
      if ((node.name ?? "").toLowerCase().includes(text)) {
        // A storey can hold tens of thousands of elements, and spreading that
        // into push() blows the argument limit; append them one at a time.
        for (const id of this.viewer.getSubtreeElementIds(node.expressID)) ids.push(id);
      }
      node.children.forEach(walk);
    };
    const tree = this.viewer.getSpatialTree();
    if (tree) walk(tree);
    for (const [id, type] of this.viewer.getElementTypes()) {
      if (type.toLowerCase().includes(text)) ids.push(id);
    }
    return [...new Set(ids)];
  }

  private renderRules(): void {
    const entries = this.store.entries();
    // Nothing applied, nothing to clear: an always-on control is a dead one.
    this.clearAll.classList.toggle("hidden", entries.length === 0);
    if (entries.length === 0) {
      this.rules.replaceChildren(
        h("div", { class: "note", text: "Nothing filtered. The whole model is visible." }),
        h("div", { class: "note", text: "Show filters add up: two of them show both sets. Hide filters cut into that." }),
      );
      return;
    }
    this.rules.replaceChildren(
      ...entries.map((entry) =>
        h("div", { class: "filter-row" }, [
          h("span", { class: "grow", text: entry.label, title: entry.label }),
          h("span", { class: "n", text: entry.detail }),
          iconButton("x", "Remove filter", () => entry.remove(), "icon-btn sm"),
        ]),
      ),
    );
  }

  private async runProperty(button: HTMLButtonElement): Promise<void> {
    const name = this.propName.value.trim();
    if (!name) return toast("Name the property first", "info");
    const set = this.setName.value.trim();
    const wanted = this.propValue.value.trim().toLowerCase();
    const op = this.op.value;
    const pool = [...this.viewer.getElementTypes().keys()].filter((id) => this.viewer.isElementVisible(id));
    button.disabled = true;
    this.status.classList.remove("error");
    this.status.textContent = `Reading ${pool.length.toLocaleString()} elements`;
    const found = await scanElements(
      this.viewer,
      pool,
      (props) => {
        const values = readProperty(props, set, name);
        // "is not" with no value asks for the elements that lack the property,
        // which is the opposite of what a bare presence test returns.
        if (!wanted) return op === "not" ? values.length === 0 : values.length > 0;
        const hit = values.some((value) =>
          op === "contains" ? value.toLowerCase().includes(wanted) : value.toLowerCase() === wanted,
        );
        return op === "not" ? !hit : hit;
      },
      (done, total) => (this.status.textContent = `Reading ${done}/${total}`),
    );
    button.disabled = false;
    if (found.missing === found.scanned && found.scanned > 0) {
      this.status.textContent = "This file carries no properties. Open the .ifc instead of the converted .ifcx.";
      this.status.classList.add("error");
      return;
    }
    const label = `${set ? `${set}.` : ""}${name} ${this.op.selectedOptions[0].text}${wanted ? ` "${this.propValue.value.trim()}"` : ""}`;
    this.status.textContent = `${found.ids.length.toLocaleString()} of ${found.scanned.toLocaleString()} matched${
      found.truncated ? `, scan capped at ${SCAN_LIMIT.toLocaleString()}` : ""
    }`;
    // A capped scan cannot answer for the rest, and a keep rule would hide
    // every unscanned element as if it had been tested and failed.
    if (found.truncated) {
      this.status.classList.add("error");
      this.status.textContent += `. Narrow the view to under ${SCAN_LIMIT.toLocaleString()} elements first.`;
      return;
    }
    this.store.add({ label, mode: "keep", ids: found.ids });
  }
}
