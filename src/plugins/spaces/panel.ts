// The room book: every IfcSpace with what the file says about it.
//
// Authored quantities win. Where a space carries none, the bounding box
// footprint stands in and the row says so, because an area schedule quoted from
// an estimate without knowing it is worse than one with gaps in it.
import {
  bar, button, copyTable, emptyState, grid, h, header, hint, note, page, progress, saveXlsx, search, select, stats, toCsv,
  type ElementRow, type ExtensionContext, type GridRow,
} from "@ifcviewx/sdk";

/** Quantity names in priority order; the first one present wins. */
const NET_AREA = ["NetFloorArea", "NetArea", "NetSideArea"];
const GROSS_AREA = ["GrossFloorArea", "GrossArea", "Area"];
const VOLUME = ["NetVolume", "GrossVolume", "Volume"];
const HEIGHT = ["Height", "FinishCeilingHeight", "ClearHeight"];
const PERIMETER = ["Perimeter", "GrossPerimeter"];
/** Occupancy and category live in property sets rather than quantities. */
const OCCUPANTS = ["OccupancyNumber", "NumberOfPeople", "OccupancyNumberPeak"];
const CATEGORY = ["Category", "SpaceType", "OccupancyType", "LongName"];

type GroupBy = "storey" | "category" | "none";

const REPORT = [
  "Space id", "Name", "Long name", "Storey", "Category",
  "Net area m2", "Gross area m2", "Volume m3", "Height m", "Perimeter m", "Occupants", "Area source",
];

interface Room {
  id: number;
  name: string;
  longName: string;
  storey: string;
  category: string;
  net: number;
  gross: number;
  volume: number;
  height: number;
  perimeter: number;
  occupants: number | null;
  /** True when the area came from the file rather than from the bounding box. */
  authored: boolean;
}

interface Group {
  key: string;
  rooms: Room[];
}

const pick = (row: ElementRow, names: string[]): number | null => {
  for (const [key, value] of Object.entries(row.props)) {
    const leaf = key.slice(key.indexOf(".") + 1);
    if (names.includes(leaf) && typeof value === "number" && Number.isFinite(value)) return value;
  }
  return null;
};

const pickText = (row: ElementRow, names: string[]): string => {
  for (const name of names) {
    const attribute = row.attrs[name];
    if (typeof attribute === "string" && attribute) return attribute;
  }
  for (const [key, value] of Object.entries(row.props)) {
    const leaf = key.slice(key.indexOf(".") + 1);
    if (names.includes(leaf) && typeof value === "string" && value) return value;
  }
  return "";
};

export function mount(host: HTMLElement, ctx: ExtensionContext): void {
  let groupBy = ctx.storage.read<GroupBy>("groupBy", "storey");
  let query = "";
  let rows: ElementRow[] = [];
  let busy = false;
  /** Bumped by every model change, so a build in flight knows it is stale. */
  let models = 0;

  const status = progress();
  const summary = h("div", {});
  const table = h("div", { class: "plug-results" });
  const root = page();

  /**
   * Footprint of the bounding box. A space is a volume with vertical sides far
   * more often than not, so its box footprint is a fair stand-in for the floor
   * area, and a poor one for anything sloped, which is why it is labelled.
   */
  const boxArea = (id: number): number => {
    const bounds = ctx.model.bounds(id);
    if (!bounds) return 0;
    return Math.abs((bounds.max.x - bounds.min.x) * (bounds.max.y - bounds.min.y));
  };

  const boxHeight = (id: number): number => {
    const bounds = ctx.model.bounds(id);
    return bounds ? Math.abs(bounds.max.z - bounds.min.z) : 0;
  };

  const roomsOf = (): Room[] => {
    const found: Room[] = [];
    for (const row of rows) {
      if (row.type !== "IfcSpace") continue;
      const net = pick(row, NET_AREA);
      const gross = pick(row, GROSS_AREA);
      const authored = net !== null || gross !== null;
      const fallback = authored ? 0 : boxArea(row.id);
      const occupants = pick(row, OCCUPANTS);
      found.push({
        id: row.id,
        name: row.name || String(row.attrs.Name ?? ""),
        longName: String(row.attrs.LongName ?? ""),
        storey: row.storey || "(no storey)",
        category: pickText(row, CATEGORY) || "(uncategorised)",
        net: net ?? gross ?? fallback,
        gross: gross ?? net ?? fallback,
        volume: pick(row, VOLUME) ?? 0,
        height: pick(row, HEIGHT) ?? boxHeight(row.id),
        perimeter: pick(row, PERIMETER) ?? 0,
        occupants: occupants === null ? null : Math.round(occupants),
        authored,
      });
    }
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? found.filter((room) =>
          `${room.name} ${room.longName} ${room.storey} ${room.category} ${room.id}`.toLowerCase().includes(needle),
        )
      : found;
    return matched.sort((a, b) => b.net - a.net || a.name.localeCompare(b.name));
  };

  const grouped = (list: Room[]): Group[] => {
    if (groupBy === "none") return [{ key: "", rooms: list }];
    const map = new Map<string, Room[]>();
    for (const room of list) {
      const key = groupBy === "storey" ? room.storey : room.category;
      const bucket = map.get(key);
      if (bucket) bucket.push(room);
      else map.set(key, [room]);
    }
    return [...map.entries()]
      .map(([key, group]) => ({ key, rooms: group }))
      .sort((a, b) => total(b.rooms).net - total(a.rooms).net);
  };

  const total = (list: Room[]): { net: number; gross: number; volume: number; people: number; authored: number } =>
    list.reduce(
      (sum, room) => ({
        net: sum.net + room.net,
        gross: sum.gross + room.gross,
        volume: sum.volume + room.volume,
        people: sum.people + (room.occupants ?? 0),
        authored: sum.authored + (room.authored ? 1 : 0),
      }),
      { net: 0, gross: 0, volume: 0, people: 0, authored: 0 },
    );

  const load = async (force = false): Promise<void> => {
    if (busy) return;
    const index = ctx.model.index();
    if (force) index.invalidate();
    if (!ctx.session.model().loaded) {
      table.replaceChildren(emptyState("cube", "No model loaded", "Open an IFC file to read its spaces."));
      return;
    }
    busy = true;
    const generation = models;
    status.set(0, 1, "Reading spaces");
    rows = await index.build((done, count) =>
      status.set(done, count, `Reading ${done.toLocaleString()} of ${count.toLocaleString()}`),
    );
    status.hide();
    busy = false;
    // Express ids from the model this started against mean something else in
    // the one that replaced it while the index built.
    if (generation !== models) return void load();
    paint();
  };

  const paint = (): void => {
    const list = roomsOf();
    if (list.length === 0) {
      summary.replaceChildren();
      table.replaceChildren(
        rows.length === 0
          ? emptyState("layers", "Nothing read yet", "Open a model, then let the index build.")
          : emptyState(
              "layers",
              query ? "No space matches that" : "This model has no IfcSpace",
              query ? "Clear the search to see the whole book." : "Spaces are authored in the model; this file carries none.",
            ),
      );
      return;
    }
    const sum = total(list);
    summary.replaceChildren(
      stats([
        ["spaces", list.length.toLocaleString()],
        ["net area", `${sum.net.toFixed(1)} m²`],
        ["gross area", `${sum.gross.toFixed(1)} m²`],
        ["volume", sum.volume > 0 ? `${sum.volume.toFixed(1)} m³` : "-"],
        ["occupants", sum.people > 0 ? sum.people.toLocaleString() : "-"],
        ["authored", `${Math.round((sum.authored / list.length) * 100)}%`, sum.authored === list.length ? "ok" : "warn"],
      ]),
    );

    table.replaceChildren();
    for (const group of grouped(list)) {
      const groupTotal = total(group.rooms);
      if (group.key) {
        table.appendChild(
          h("div", { class: "group-title" }, [
            h("span", { text: `${group.key}  ${group.rooms.length} space(s)` }),
            h("span", { text: `${groupTotal.net.toFixed(1)} m²` }),
          ]),
        );
      }
      const gridRows: GridRow[] = group.rooms.map((room) => ({
        cells: [
          room.name || room.longName || `#${room.id}`,
          room.category,
          Number(room.net.toFixed(2)),
          Number(room.volume.toFixed(2)),
          room.occupants ?? "",
        ],
        title: `${room.longName || room.name} · #${room.id}${room.authored ? "" : " · area estimated from the bounding box"}`,
        tone: room.authored ? undefined : "warn",
        pick: () => void show(room.id),
      }));
      table.appendChild(grid(["Room", "Category", "Net m²", "Volume m³", "People"], gridRows));
    }
    if (sum.authored < list.length) {
      table.appendChild(
        note(
          `${list.length - sum.authored} space(s) carry no authored area, so their footprint was measured from the bounding box. Those rows are marked.`,
        ),
      );
    }
  };

  /** Spaces are not in the default geometry stream, so showing one loads it. */
  const show = async (id: number): Promise<void> => {
    try {
      if (!ctx.view.categoryVisible("IfcSpace")) {
        ctx.feedback.log("Loading space geometry");
        await ctx.view.setCategoryVisible("IfcSpace", true);
      }
      ctx.view.isolate([id], "Room");
      ctx.view.select(id);
      ctx.view.frame(id);
    } catch (err) {
      ctx.feedback.log(err instanceof Error ? err.message : String(err), "error");
    }
  };

  const reportRows = (): Array<Array<string | number>> =>
    roomsOf().map((room) => [
      room.id,
      room.name,
      room.longName,
      room.storey,
      room.category,
      Number(room.net.toFixed(3)),
      Number(room.gross.toFixed(3)),
      Number(room.volume.toFixed(3)),
      Number(room.height.toFixed(3)),
      Number(room.perimeter.toFixed(3)),
      room.occupants ?? "",
      room.authored ? "authored" : "bounding box",
    ]);

  const exportCsv = (): void => {
    const list = roomsOf();
    if (list.length === 0) return void ctx.feedback.log("Nothing to export yet", "error");
    const csv = toCsv(REPORT, reportRows());
    ctx.files.export("spaces.csv", `rooms-${ctx.session.model().name || "model"}.csv`, `\uFEFF${csv}`, "text/csv");
  };

  const exportXlsx = async (): Promise<void> => {
    if (roomsOf().length === 0) return void ctx.feedback.log("Nothing to export yet", "error");
    const name = `rooms-${ctx.session.model().name || "model"}.xlsx`;
    try {
      await saveXlsx(name, REPORT, reportRows(), { sheet: "Rooms" });
    } catch {
      ctx.feedback.log("The spreadsheet could not be written", "error");
    }
  };

  root.append(
    header("Room book", "Every space with its area, volume and occupancy. Estimated rows are marked."),
    bar(
      select(
        [["storey", "By storey"], ["category", "By category"], ["none", "Flat list"]],
        groupBy,
        (value) => {
          groupBy = value as GroupBy;
          ctx.storage.write("groupBy", groupBy);
          paint();
        },
      ),
      search("Search rooms", (value) => {
        query = value;
        paint();
      }),
      button("Rebuild", () => void load(true)),
      button("Show all", () => ctx.view.showAll()),
      button("CSV", () => exportCsv()),
      button("XLSX", () => void exportXlsx()),
      button("Copy", () => (roomsOf().length ? copyTable(REPORT, reportRows()) : ctx.feedback.log("Nothing to copy yet", "error"))),
    ),
    hint(
      "info",
      "Areas are the file's own authored quantities where it has them. Rows marked amber were measured from the bounding box instead, which is a footprint, not a floor area.",
    ),
    status.root,
    summary,
    table,
  );

  ctx.events.on("model", () => {
    models += 1;
    rows = [];
    void load();
  });

  host.appendChild(root);
  void load();
}
