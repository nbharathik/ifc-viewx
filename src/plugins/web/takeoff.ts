// Quantity takeoff from the quantities the file actually carries.
//
// Authored Qto values win; the bounding box only fills the gaps, and the
// coverage column says how much of a row is real so nobody quotes an estimate
// by accident.
import { h } from "../../ui/kit.js";
import { emptyState } from "../../ui/shell.js";
import {
  bar, button, copyTable, grid, hint, note, page, progress, saveCsv, select, stats,
  type ElementRow, type GridRow,
} from "../kit.js";
import type { PluginApi, PluginInstance } from "../host.js";

/** Quantity names in priority order; the first one present wins. */
const VOLUME = ["NetVolume", "GrossVolume", "Volume"];
const AREA = ["NetArea", "GrossArea", "NetSideArea", "GrossSideArea", "NetFloorArea", "GrossFloorArea", "Area"];
const LENGTH = ["Length", "NetLength", "GrossLength"];

type GroupBy = "type" | "storey" | "both";

const REPORT = ["Group", "Count", "Volume m3", "Area m2", "Length m", "Box volume m3", "Coverage %"];

interface Group {
  key: string;
  ids: number[];
  count: number;
  volume: number;
  area: number;
  length: number;
  box: number;
  authored: number;
}

export function mount(host: HTMLElement, api: PluginApi): PluginInstance {
  let groupBy = api.read<GroupBy>("groupBy", "type");
  let rows: ElementRow[] = [];
  let busy = false;

  const status = progress();
  const summary = h("div", {});
  const table = h("div", { class: "plug-results" });
  const root = page(
    bar(
      select([["type", "By class"], ["storey", "By storey"], ["both", "Class and storey"]], groupBy, (value) => {
        groupBy = value as GroupBy;
        api.write("groupBy", groupBy);
        paint();
      }),
      button("Rebuild", () => void load(true)),
      button("Show all", () => api.viewer.showAll()),
      button("CSV", () => exportCsv()),
      button("Copy", () => (rows.length ? copyTable(REPORT, reportRows()) : api.log("Nothing to copy yet", "error"))),
    ),
    hint("info", "Volumes and areas come from the file's quantity sets. Elements without them fall back to their bounding box, which the coverage column reports."),
    status.root,
    summary,
    table,
  );

  const load = async (force = false): Promise<void> => {
    if (busy) return;
    const index = api.index();
    if (force) index.invalidate();
    if (!api.modelKey()) {
      table.replaceChildren(emptyState("cube", "No model loaded", "Open an IFC file to take off quantities."));
      return;
    }
    busy = true;
    status.set(0, 1, "Reading quantities");
    const key = api.modelKey();
    rows = await index.build((done, total) => status.set(done, total, `Reading quantities ${done.toLocaleString()} of ${total.toLocaleString()}`));
    if (key !== api.modelKey()) {
      busy = false;
      return void load();
    }
    status.hide();
    busy = false;
    paint();
  };

  const groups = (): Group[] => {
    const map = new Map<string, Group>();
    for (const row of rows) {
      const key =
        groupBy === "type" ? row.type : groupBy === "storey" ? row.storey || "(no storey)" : `${row.storey || "(no storey)"} · ${row.type}`;
      let group = map.get(key);
      if (!group) {
        group = { key, ids: [], count: 0, volume: 0, area: 0, length: 0, box: 0, authored: 0 };
        map.set(key, group);
      }
      const volume = pick(row, VOLUME);
      const area = pick(row, AREA);
      const length = pick(row, LENGTH);
      group.ids.push(row.id);
      group.count += 1;
      group.volume += volume ?? 0;
      group.area += area ?? 0;
      group.length += length ?? 0;
      group.box += boxVolume(api, row.id);
      if (volume !== null || area !== null) group.authored += 1;
    }
    return [...map.values()].sort((a, b) => b.volume - a.volume || b.count - a.count);
  };

  const paint = (): void => {
    if (rows.length === 0) {
      summary.replaceChildren();
      table.replaceChildren(emptyState("calculator", "Nothing to take off yet", "Open a model, then let the index build."));
      return;
    }
    const list = groups();
    const total = list.reduce(
      (sum, group) => ({
        count: sum.count + group.count,
        volume: sum.volume + group.volume,
        area: sum.area + group.area,
        authored: sum.authored + group.authored,
      }),
      { count: 0, volume: 0, area: 0, authored: 0 },
    );
    summary.replaceChildren(
      stats([
        ["elements", total.count.toLocaleString()],
        ["volume m³", total.volume.toFixed(1)],
        ["area m²", total.area.toFixed(1)],
        ["with quantities", `${Math.round((total.authored / Math.max(1, total.count)) * 100)}%`, total.authored ? "ok" : "warn"],
      ]),
    );
    const gridRows: GridRow[] = list.map((group) => ({
      cells: [
        group.key.replace(/Ifc/g, ""),
        group.count,
        Number(group.volume.toFixed(3)),
        Number(group.area.toFixed(2)),
        Number(group.length.toFixed(2)),
        Number(group.box.toFixed(2)),
        `${Math.round((group.authored / group.count) * 100)}%`,
      ],
      title: `Isolate ${group.count} element(s)`,
      pick: () => {
        api.viewer.isolate(group.ids);
        api.log(`Isolated ${group.count.toLocaleString()} element(s) in ${group.key}`);
      },
    }));
    table.replaceChildren(grid(["Group", "Count", "Volume m³", "Area m²", "Length m", "Box m³", "Coverage"], gridRows));
    if (total.authored === 0) {
      table.appendChild(note("This model carries no quantity sets, so only counts and box volumes are real numbers."));
    }
  };

  const reportRows = (): Array<Array<string | number>> =>
    groups().map((group) => [
      group.key,
      group.count,
      Number(group.volume.toFixed(4)),
      Number(group.area.toFixed(3)),
      Number(group.length.toFixed(3)),
      Number(group.box.toFixed(3)),
      Math.round((group.authored / group.count) * 100),
    ]);

  const exportCsv = (): void => {
    if (rows.length === 0) return void api.log("Nothing to export yet", "error");
    saveCsv(`takeoff-${api.modelName() || "model"}.csv`, REPORT, reportRows());
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

/** First matching quantity on the element, whatever set it lives in. */
function pick(row: ElementRow, names: string[]): number | null {
  for (const name of names) {
    for (const [key, value] of Object.entries(row.props)) {
      if (!key.endsWith(`.${name}`)) continue;
      const numeric = typeof value === "number" ? value : Number(value);
      if (Number.isFinite(numeric) && numeric !== 0) return numeric;
    }
  }
  return null;
}

function boxVolume(api: PluginApi, id: number): number {
  const bounds = api.viewer.getElementBounds(id);
  if (!bounds) return 0;
  return (
    Math.max(0, bounds.max.x - bounds.min.x) *
    Math.max(0, bounds.max.y - bounds.min.y) *
    Math.max(0, bounds.max.z - bounds.min.z)
  );
}
