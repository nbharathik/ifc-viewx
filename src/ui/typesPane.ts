// Outliner pane that browses the model by IFC class. A row isolates its class;
// its eye hides that class without touching the rest of the model. Eye state is
// read back from the viewer, so it stays honest when Show all, the tree or the
// assistant changes visibility behind us.
import { h, iconButton } from "./kit.js";
import { emptyState } from "./shell.js";
import { elementsByType } from "../llm/actions.js";
import type { LazyCategory, Viewer } from "../viewer-core/viewer.js";

/** Geometry for these streams in on demand, so they toggle by category. */
const LAZY = new Set<string>(["IfcSpace", "IfcOpeningElement"]);

export class TypesPane {
  private readonly page = h("div", { class: "page scroll" });

  constructor(
    host: HTMLElement,
    private readonly viewer: Viewer,
    private readonly isolate: (type: string, add: boolean) => void,
  ) {
    host.appendChild(this.page);
  }

  render(): void {
    const groups = elementsByType(this.viewer);
    if (groups.size === 0) {
      this.page.replaceChildren(
        emptyState("layers", "No model loaded", "Element classes appear here once a file is open."),
      );
      return;
    }
    const showAll = h("button", { class: "link-btn", type: "button", text: "Show all" });
    showAll.addEventListener("click", () => this.viewer.showAll());
    const rows = h("div", {});
    const max = Math.max(...[...groups.values()].map((ids) => ids.length));
    for (const [type, ids] of groups) rows.appendChild(this.row(type, ids, max));
    this.page.replaceChildren(
      h("div", { class: "group-title" }, [h("span", { text: `${groups.size} classes` }), showAll]),
      rows,
    );
  }

  private row(type: string, ids: number[], max: number): HTMLElement {
    const lazy = LAZY.has(type);
    let drawn = 0;
    let shown = 0;
    for (const id of ids) {
      if (!this.viewer.hasGeometry(id)) continue;
      drawn++;
      if (this.viewer.isElementVisible(id)) shown++;
    }
    // Classes that carry no geometry (types, annotations) can only be counted.
    const inert = !lazy && drawn === 0;
    const on = lazy ? this.viewer.isCategoryVisible(type as LazyCategory) : shown > 0;

    const bar = h("i");
    bar.style.width = `${Math.max(4, (ids.length / max) * 100)}%`;
    const main = h("button", {
      class: "main",
      type: "button",
      title: inert
        ? `${type} carries no geometry`
        : `Show only these ${ids.length} ${type}\nCtrl-click to add them to the view`,
    }, [
      h("span", { class: "name", text: type.replace(/^Ifc/, "") }),
      h("span", { class: "bar" }, [bar]),
      h("span", { class: "n", text: ids.length.toLocaleString() }),
    ]);
    main.addEventListener("click", (e) => this.isolate(type, e.ctrlKey || e.metaKey || e.shiftKey));

    const eye = iconButton(on ? "eye" : "eye-off", `${on ? "Hide" : "Show"} ${type}`, () => {
      if (lazy) void this.viewer.setCategoryVisible(type as LazyCategory, !on);
      else this.viewer.setHidden(ids, on);
    }, "icon-btn sm");
    eye.disabled = inert;

    return h("div", { class: `type-row${on && !inert ? "" : " off"}` }, [main, eye]);
  }
}
