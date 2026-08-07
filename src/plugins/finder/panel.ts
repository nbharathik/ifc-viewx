// Model Finder: ranked search over the model, and a working set to act on.
//
// The index is the app's own BM25, not a second copy, so a result here is a
// result the assistant would have given for the same words. Names and classes
// are free; property values cost a full property read, so they are opt in and
// the panel says which of the two it is searching.
import {
  bar, buildIndex, button, emptyState, grid, h, hint, note, page, progress, saveCsv, search,
  type Bm25Index, type ElementRow, type GridRow, type ModelElement, type PluginContext, type SearchHit,
} from "@ifcviewx/sdk";

/** Rows on screen. Past this the list stops being a list and becomes a wall. */
const SHOWN = 200;
/** Property text per element, capped so one huge pset cannot dominate scoring. */
const PROP_CHARS = 400;

const REPORT = ["Express id", "Class", "Name", "Storey", "Score"];

export function mount(host: HTMLElement, ctx: PluginContext): void {
  let query = "";
  let index: Bm25Index | null = null;
  /** Which text the current index was built from, so the label cannot lie. */
  let deep = false;
  let hits: SearchHit[] = [];
  let building = false;

  const status = progress();
  const results = h("div", { class: "plug-results" });
  const summary = h("div", {});
  const root = page();

  /** Property values as one searchable string per element. */
  const propText = (rows: ElementRow[]): Map<number, string> => {
    const text = new Map<number, string>();
    for (const row of rows) {
      const parts: string[] = [];
      for (const [key, value] of Object.entries(row.props)) {
        if (value === null || value === "") continue;
        parts.push(`${key.slice(key.indexOf(".") + 1)} ${value}`);
        if (parts.join(" ").length > PROP_CHARS) break;
      }
      for (const [name, value] of Object.entries(row.attrs)) {
        if (typeof value === "string" && value) parts.push(`${name} ${value}`);
      }
      text.set(row.id, parts.join(" ").slice(0, PROP_CHARS));
    }
    return text;
  };

  const rebuild = (withProperties: boolean, rows: ElementRow[] = []): void => {
    const elements: ModelElement[] = ctx.elements();
    const extra = withProperties ? propText(rows) : null;
    index = buildIndex(elements, extra ? (element) => extra.get(element.id) : undefined);
    deep = withProperties;
    run();
  };

  const run = (): void => {
    hits = index && query.trim() ? index.search(query, SHOWN) : [];
    render();
  };

  const ids = (): number[] => hits.map((hit) => hit.id);

  const render = (): void => {
    const total = index?.size ?? 0;
    summary.replaceChildren(
      note(
        !total
          ? "Open a model to search it."
          : !query.trim()
            ? `${total.toLocaleString()} elements indexed by ${deep ? "class, name, storey and property values" : "class, name and storey"}. Type to search.`
            : `${hits.length.toLocaleString()} match${hits.length === 1 ? "" : "es"}, best first.`,
      ),
    );

    if (!total || !query.trim()) {
      results.replaceChildren(
        emptyState("search", "Nothing searched yet", "Words can come in any order: try \"external wall level 1\"."),
      );
      return;
    }
    if (hits.length === 0) {
      results.replaceChildren(
        emptyState("search", "No match", deep ? "No element carries those words." : "Add property values to the index and try again."),
      );
      return;
    }
    const rows: GridRow[] = hits.map((hit) => ({
      cells: [String(hit.id), hit.type.replace(/^Ifc/, ""), hit.name || "(unnamed)", hit.storey || "-", hit.score.toFixed(2)],
      title: `Select and frame ${hit.name || hit.type}`,
      pick: () => {
        ctx.select(hit.id);
        ctx.frame(hit.id);
      },
    }));
    results.replaceChildren(grid(REPORT, rows));
  };

  const withProperties = button("Add property values", () => {
    if (building || deep) return;
    building = true;
    withProperties.disabled = true;
    status.set(0, 1, "Reading properties");
    void ctx.index()
      .build((done, total) => status.set(done, total, `Reading ${done.toLocaleString()} of ${total.toLocaleString()}`))
      .then((rows) => {
        rebuild(true, rows);
        withProperties.textContent = "Property values indexed";
      })
      .catch((error: Error) => {
        ctx.toast(error.message, "error");
        withProperties.disabled = false;
      })
      .finally(() => {
        building = false;
        status.hide();
      });
  });

  const box = button("Box results", () => {
    const found = ids();
    if (!found.length) return ctx.toast("Search for something first", "info");
    const fitted = ctx.boxAround(found);
    if (!fitted) return ctx.toast("None of those has geometry to box", "info");
    ctx.setSectionBox(fitted);
    ctx.log(`Section box around ${found.length} search result(s)`);
  });

  root.append(
    bar(
      search("Search class, name, storey or property", (value) => {
        query = value;
        run();
      }),
      button("Select all", () => {
        const found = ids();
        if (found.length) ctx.select(found);
      }),
      button("Isolate", () => {
        const found = ids();
        if (found.length) ctx.isolate(found, `Search: ${query.trim().slice(0, 40)}`);
      }),
      box,
      withProperties,
      button("CSV", () => {
        saveCsv(
          "search-results.csv",
          REPORT,
          hits.map((hit) => [hit.id, hit.type, hit.name, hit.storey, hit.score]),
        );
      }),
    ),
    status.root,
    summary,
    results,
    hint("info", "Class names are split, so \"wall\" finds IfcWallStandardCase. Property values are only searched after you add them."),
  );
  host.appendChild(root);

  ctx.on("model", () => {
    query = "";
    withProperties.disabled = false;
    withProperties.textContent = "Add property values";
    rebuild(false);
  });
  rebuild(false);
}
