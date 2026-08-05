// Element Explorer: every placed element as a row, any property as a column.
//
// The property index is shared with the other data plugins, so opening this
// after a takeoff costs nothing. Only a page of rows is rendered; the filter,
// the viewport actions and the CSV all work on the whole match set.
import { h, iconButton } from "../../ui/kit.js";
import { emptyState } from "../../ui/shell.js";
import {
  bar, button, copyTable, grid, note, page, progress, saveCsv, select,
  type ElementRow, type GridRow, type Value,
} from "../kit.js";
import type { PluginApi, PluginInstance } from "../host.js";

const PAGE = 400;

interface Column {
  key: string;
  label: string;
  read(row: ElementRow): Value;
}

const BASE: Column[] = [
  { key: "id", label: "Id", read: (row) => row.id },
  { key: "type", label: "Class", read: (row) => row.type },
  { key: "name", label: "Name", read: (row) => row.name },
  { key: "storey", label: "Storey", read: (row) => row.storey },
  { key: "globalId", label: "GlobalId", read: (row) => row.globalId },
];

export function mount(host: HTMLElement, api: PluginApi): PluginInstance {
  let rows: ElementRow[] = [];
  let extra: string[] = api.read<string[]>("columns", []);
  let query = "";
  let typeFilter = "";
  let sortBy = 0;
  let descending = false;
  let busy = false;

  const status = progress();
  const controls = h("div", {});
  const chips = h("div", { class: "chips" });
  const table = h("div", { class: "plug-results" });
  const search = h("input", { type: "search", class: "plug-search-input", placeholder: "Search every column" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    paint();
  });

  const root = page(
    bar(
      search,
      button("Isolate", () => act("isolate")),
      button("Hide", () => act("hide")),
      button("Show all", () => api.viewer.showAll()),
      button("CSV", () => exportCsv()),
      button("Copy", () => {
        const cols = columns();
        copyTable(cols.map((column) => column.label), filtered().map((row) => cols.map((column) => column.read(row))));
      }),
    ),
    controls,
    chips,
    status.root,
    table,
  );

  const columns = (): Column[] => [
    ...BASE,
    ...extra.map((key) => ({ key, label: key.split(".").pop() ?? key, read: (row: ElementRow) => row.props[key] ?? "" })),
  ];

  const filtered = (): ElementRow[] => {
    const cols = columns();
    const found = rows.filter((row) => {
      if (typeFilter && row.type !== typeFilter) return false;
      if (!query) return true;
      return cols.some((column) => String(column.read(row) ?? "").toLowerCase().includes(query));
    });
    const column = cols[sortBy] ?? cols[0];
    found.sort((a, b) => {
      const left = column.read(a);
      const right = column.read(b);
      const order =
        typeof left === "number" && typeof right === "number"
          ? left - right
          : String(left ?? "").localeCompare(String(right ?? ""), undefined, { numeric: true });
      return descending ? -order : order;
    });
    return found;
  };

  /** Every property the filtered class actually carries, most common first. */
  const addClassColumns = (): void => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      if (typeFilter && row.type !== typeFilter) continue;
      for (const key of Object.keys(row.props)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const found = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([key]) => key);
    if (found.length === 0) return void api.log(`${typeFilter} carries no property sets`, "error");
    extra = [...new Set([...extra, ...found.slice(0, 30)])];
    api.write("columns", extra);
    paint();
    api.log(`Added ${Math.min(found.length, 30)} column(s) from ${typeFilter}`);
  };

  const act = (mode: "isolate" | "hide"): void => {
    const ids = filtered().map((row) => row.id);
    if (ids.length === 0) return void api.log("Nothing matches the filter", "error");
    if (mode === "isolate") api.viewer.isolate(ids);
    else api.viewer.setHidden(ids, true);
    api.log(`${mode === "isolate" ? "Isolated" : "Hid"} ${ids.length.toLocaleString()} element(s)`);
  };

  const load = async (): Promise<void> => {
    if (busy) return;
    if (!api.modelKey()) {
      table.replaceChildren(emptyState("cube", "No model loaded", "Open an IFC file to explore its data."));
      return;
    }
    busy = true;
    status.set(0, 1, "Indexing properties");
    const key = api.modelKey();
    rows = await api.index().build((done, total) => status.set(done, total, `Indexing ${done.toLocaleString()} of ${total.toLocaleString()} elements`));
    if (key !== api.modelKey()) {
      busy = false;
      return void load();
    }
    status.hide();
    busy = false;
    paint();
  };

  const paint = (): void => {
    if (rows.length === 0) {
      controls.replaceChildren();
      chips.replaceChildren();
      table.replaceChildren(emptyState("table", "No elements indexed", "Open a model and the table fills in."));
      return;
    }
    const types = [...new Set(rows.map((row) => row.type))].sort();
    const keys = api.index().propertyKeys();
    controls.replaceChildren(
      bar(
        select([["", `All classes  ${rows.length.toLocaleString()}`], ...types.map((type) => [type, type] as [string, string])], typeFilter, (value) => {
          typeFilter = value;
          paint();
        }),
        select(
          [["", `Add column  ${keys.length}`], ...keys.filter(([key]) => !extra.includes(key)).slice(0, 300).map(([key, count]) => [key, `${key}  (${count})`] as [string, string])],
          "",
          (value) => {
            if (!value) return;
            extra = [...extra, value];
            api.write("columns", extra);
            paint();
          },
        ),
        // Filtering to one class and then adding its columns one by one is the
        // slow path everybody hits first.
        ...(typeFilter ? [button("All its columns", () => addClassColumns())] : []),
        ...(extra.length ? [button("Clear columns", () => {
          extra = [];
          api.write("columns", extra);
          paint();
        })] : []),
      ),
    );
    chips.replaceChildren();
    for (const key of extra) {
      const chip = h("span", { class: "chip static" }, [
        h("span", { text: key }),
        iconButton("x", `Remove ${key}`, () => {
          extra = extra.filter((other) => other !== key);
          api.write("columns", extra);
          paint();
        }, "icon-btn sm"),
      ]);
      chips.appendChild(chip);
    }

    const cols = columns();
    const found = filtered();
    const shown = found.slice(0, PAGE);
    const gridRows: GridRow[] = shown.map((row) => ({
      cells: cols.map((column) => column.read(row)),
      pick: () => {
        api.viewer.select(row.id);
        api.viewer.fitToElement(row.id);
      },
    }));
    table.replaceChildren(
      grid(cols.map((column, at) => (at === sortBy ? `${column.label} ${descending ? "▾" : "▴"}` : column.label)), gridRows, (column) => {
        descending = column === sortBy ? !descending : false;
        sortBy = column;
        paint();
      }),
      note(`${found.length.toLocaleString()} of ${rows.length.toLocaleString()} elements${found.length > PAGE ? `, showing the first ${PAGE}` : ""}`),
    );
  };

  const exportCsv = (): void => {
    const cols = columns();
    const found = filtered();
    if (found.length === 0) return void api.log("Nothing to export", "error");
    saveCsv(
      `elements-${api.modelName() || "model"}.csv`,
      cols.map((column) => column.label),
      found.map((row) => cols.map((column) => column.read(row))),
    );
  };

  host.appendChild(root);
  void load();

  return {
    modelChanged: () => {
      rows = [];
      paint();
      void load();
    },
  };
}
