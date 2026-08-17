// Outliner pane that browses the model by its organizing entities: IFC groups
// and systems, presentation layers, classification references and materials.
// The index is fetched lazily on first open, merged across federated models by
// the viewer, and invalidated whenever another model loads.
import { busyRow, h, iconButton, toast } from "./kit.js";
import { emptyState } from "./shell.js";
import type { OrganizeIndex, Viewer } from "../viewer-core/viewer.js";

type OrganizeMode = "groups" | "layers" | "classes" | "materials";

const MODES: Array<[OrganizeMode, string]> = [
  ["groups", "Groups"],
  ["layers", "Layers"],
  ["classes", "Classes"],
  ["materials", "Materials"],
];

const EMPTY_HINT: Record<OrganizeMode, string> = {
  groups: "This model authors no IfcGroup, IfcSystem or IfcZone.",
  layers: "This model authors no presentation layers.",
  classes: "This model authors no classification references.",
  materials: "This model authors no material associations.",
};

/** These lists stay short compared to the tree; past this the rest is counted. */
const MAX_ROWS = 500;

interface OrganizeRow {
  label: string;
  tag: string | null;
  ids: number[];
}

export class OrganizePane {
  private readonly page = h("div", { class: "page scroll" });
  private index: OrganizeIndex | null = null;
  private loading = false;
  private pending: Promise<void> = Promise.resolve();
  private mode: OrganizeMode = "groups";
  /** Bumped on every model swap so an in-flight fetch cannot land stale. */
  private generation = 0;

  constructor(host: HTMLElement, private readonly viewer: Viewer) {
    host.appendChild(this.page);
    viewer.onModelLoaded(() => {
      this.generation += 1;
      this.index = null;
      this.loading = false;
      if (!this.page.closest(".hidden")) this.render();
    });
  }

  render(): void {
    if (this.viewer.getStats() && !this.index && !this.loading) {
      this.loading = true;
      const generation = this.generation;
      this.pending = this.viewer
        .getOrganizeIndex()
        .then((index) => {
          if (generation !== this.generation) return;
          this.index = index;
        })
        .catch((err: Error) => {
          if (generation !== this.generation) return;
          this.index = { groups: [], layers: [], classifications: [], materials: [] };
          toast(err.message, "error");
        })
        .finally(() => {
          if (generation !== this.generation) return;
          this.loading = false;
          this.paint();
        });
    }
    this.paint();
  }

  /** Resolves once the fetch started by render() has painted. */
  ready(): Promise<void> {
    return this.pending;
  }

  private rows(): OrganizeRow[] {
    const index = this.index;
    if (!index) return [];
    if (this.mode === "groups") {
      return index.groups.map((group) => ({
        label: group.name || `Group #${group.expressID}`,
        tag: group.ifcType,
        ids: group.ids,
      }));
    }
    if (this.mode === "layers") return index.layers.map((layer) => ({ label: layer.name, tag: null, ids: layer.ids }));
    if (this.mode === "classes") {
      return index.classifications.map((ref) => ({
        label: ref.code ?? ref.system,
        tag: ref.code ? ref.system : null,
        ids: ref.ids,
      }));
    }
    return index.materials.map((material) => ({ label: material.name || "(unnamed)", tag: null, ids: material.ids }));
  }

  private paint(): void {
    if (!this.viewer.getStats()) {
      this.page.replaceChildren(
        emptyState("layers", "No model loaded", "Groups, layers, classifications and materials appear here."),
      );
      return;
    }
    const seg = h("div", { class: "seg org-switch", role: "tablist", "aria-label": "Organize mode" });
    for (const [mode, label] of MODES) {
      const button = h("button", { type: "button", text: label, "aria-pressed": String(mode === this.mode) });
      button.addEventListener("click", () => {
        this.mode = mode;
        this.paint();
      });
      seg.appendChild(button);
    }
    if (this.loading) {
      this.page.replaceChildren(seg, busyRow("Reading groups, layers and materials"));
      return;
    }
    const rows = this.rows();
    const label = MODES.find(([mode]) => mode === this.mode)?.[1].toLowerCase() ?? "";
    if (rows.length === 0) {
      this.page.replaceChildren(seg, emptyState("layers", `No ${label}`, EMPTY_HINT[this.mode]));
      return;
    }
    const list = h("div", {});
    for (const row of rows.slice(0, MAX_ROWS)) list.appendChild(this.row(row));
    if (rows.length > MAX_ROWS) {
      list.appendChild(h("div", { class: "hint-line", text: `${(rows.length - MAX_ROWS).toLocaleString()} more not shown` }));
    }
    this.page.replaceChildren(
      seg,
      h("div", { class: "group-title" }, [h("span", { text: `${rows.length.toLocaleString()} ${label}` })]),
      list,
    );
  }

  private row(entry: OrganizeRow): HTMLElement {
    const count = entry.ids.length;
    const main = h("button", {
      class: "main",
      type: "button",
      title: `Select these ${count} element(s)`,
    }, [
      h("span", { class: "name", text: entry.label }),
      ...(entry.tag ? [h("span", { class: "tag", text: entry.tag })] : []),
      h("span", { class: "n", text: count.toLocaleString() }),
    ]);
    main.addEventListener("click", () => this.viewer.selectMany(entry.ids));
    const isolate = iconButton("focus", `Isolate ${entry.label}`, () => this.viewer.isolate(entry.ids, entry.label), "icon-btn sm");
    const hide = iconButton("eye", `Hide ${entry.label}`, () => this.viewer.setHidden(entry.ids, true), "icon-btn sm");
    return h("div", { class: "type-row org-row" }, [main, isolate, hide]);
  }
}
