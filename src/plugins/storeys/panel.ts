// Storey navigator: the level walk every review starts with.
//
// One click isolates a level and leaves the camera alone, which is what makes
// stepping up and down readable. The ceiling cut puts a horizontal section at
// the level above so you look down into the storey instead of at its slab.
import { bar, button, emptyState, h, header, iconButton, note, page } from "@ifcviewx/sdk";
import type { ExtensionContext, ExtensionInstance, SpatialNode } from "@ifcviewx/sdk";

interface Storey {
  id: number;
  name: string;
  ids: number[];
  base: number;
  top: number;
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let storeys: Storey[] = [];
  let active = -1;
  let cut = ctx.storage.read("cut", false);

  const list = h("div", { class: "plug-results" });
  const head = h("div", {});
  const root = page(
    header("Storey navigator", "Walk the building one level at a time. The camera stays put."),
    head,
    list,
  );

  const collect = (): Storey[] => {
    const tree = ctx.model.tree();
    if (!tree) return [];
    const nodes: SpatialNode[] = [];
    const walk = (node: SpatialNode): void => {
      if (node.type === "IfcBuildingStorey") nodes.push(node);
      node.children.forEach(walk);
    };
    walk(tree);
    const found = nodes.map((node) => {
      const ids = ctx.model.subtree(node.expressID);
      let base = Infinity;
      let top = -Infinity;
      for (const id of ids) {
        const bounds = ctx.model.bounds(id);
        if (!bounds) continue;
        base = Math.min(base, bounds.min.y);
        top = Math.max(top, bounds.max.y);
      }
      return {
        id: node.expressID,
        name: node.name || `Storey #${node.expressID}`,
        ids,
        base: Number.isFinite(base) ? base : 0,
        top: Number.isFinite(top) ? top : 0,
      };
    });
    return found.sort((a, b) => b.base - a.base);
  };

  const show = (index: number): void => {
    const storey = storeys[index];
    if (!storey) return;
    active = index;
    ctx.view.isolate(storey.ids);
    applyCut();
    paint();
  };

  /** Cut just under the level above, so its floor slab stops blocking the view. */
  const applyCut = (): void => {
    const storey = storeys[active];
    if (!cut || !storey) {
      // Only the plugin's own horizontal cut goes; planes the user set with the
      // section tool are not this plugin's to throw away.
      const kept = ctx.view.sections().filter((section) => section.axis !== "y");
      if (kept.length !== ctx.view.sections().length) ctx.view.setSections(kept);
      return;
    }
    const above = storeys[active - 1];
    const offset = above ? (above.base + storey.top) / 2 : storey.top;
    const others = ctx.view.sections().filter((section) => section.axis !== "y");
    ctx.view.setSections([...others, { axis: "y", offset, flip: false }]);
  };

  const showAll = (): void => {
    active = -1;
    ctx.view.showAll();
    ctx.view.setSections([]);
    paint();
  };

  const step = (delta: number): void => {
    if (storeys.length === 0) return;
    const next = active < 0 ? 0 : Math.min(storeys.length - 1, Math.max(0, active + delta));
    show(next);
  };

  const paint = (): void => {
    if (storeys.length === 0) {
      head.replaceChildren();
      list.replaceChildren(
        emptyState("layers", "No storeys in this model", "The navigator lists every IfcBuildingStorey and what it contains."),
      );
      return;
    }
    const cutButton = button(cut ? "Ceiling cut on" : "Ceiling cut", () => {
      cut = !cut;
      ctx.storage.write("cut", cut);
      applyCut();
      paint();
    }, cut ? "accent" : "");
    head.replaceChildren(
      bar(
        iconButton("chevron", "Level above", () => step(-1), "icon-btn sm up"),
        iconButton("chevron", "Level below", () => step(1), "icon-btn sm"),
        button("Show all", () => showAll()),
        cutButton,
      ),
    );

    const most = Math.max(1, ...storeys.map((storey) => storey.ids.length));
    list.replaceChildren();
    storeys.forEach((storey, index) => {
      const fill = h("i");
      fill.style.width = `${Math.max(4, (storey.ids.length / most) * 100)}%`;
      const row = h("button", {
        class: `plug-storey${index === active ? " on" : ""}`,
        type: "button",
        title: `Isolate ${storey.ids.length.toLocaleString()} element(s) on ${storey.name}`,
      }, [
        h("span", { class: "lvl", text: `${storey.base.toFixed(2)} m` }),
        h("span", { class: "grow" }, [
          h("span", { class: "nm", text: storey.name }),
          h("span", { class: "bar" }, [fill]),
        ]),
        h("span", { class: "n", text: storey.ids.length.toLocaleString() }),
      ]);
      row.addEventListener("click", () => (index === active ? showAll() : show(index)));
      list.appendChild(row);
    });
    list.appendChild(note("Click a level to isolate it, click it again to release. The camera stays where it is."));
  };

  const rebuild = (): void => {
    storeys = collect();
    active = -1;
    paint();
  };

  host.appendChild(root);
  rebuild();
  ctx.events.on("model", () => rebuild());

  return {
    dispose: () => {
      if (active >= 0) ctx.view.setSections([]);
    },
  };
}
