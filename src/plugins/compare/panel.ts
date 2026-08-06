// Model compare: diff the open model against an earlier IFC.
//
// The baseline is parsed in its own worker with geometry skipped, so a second
// model costs parse time and property reads but no GPU memory. Matching is by
// GlobalId, which is what survives a round trip through authoring tools.
import { bar, button, elementsOf, emptyState, h, note, openSideModel, page, progress, saveCsv, stats } from "@ifcviewx/sdk";
import type { ElementRow, PluginContext, PluginInstance, SideModel, Value } from "@ifcviewx/sdk";

interface Snapshot {
  type: string;
  name: string;
  storey: string;
  values: Record<string, Value>;
}

interface Change {
  key: string;
  from: Value;
  to: Value;
}

interface Entry {
  globalId: string;
  id: number;
  type: string;
  name: string;
  storey: string;
  changes: Change[];
}

type View = "added" | "removed" | "changed";

const WINDOW = 12;
const LIST_LIMIT = 300;
/** Attributes that differ on every reopen and say nothing about the design. */
const IGNORED = new Set(["GlobalId", "OwnerHistory", "expressID"]);

export function mount(host: HTMLElement, ctx: PluginContext): PluginInstance {
  let side: SideModel | null = null;
  let closed = false;
  let baselineName = "";
  let added: Entry[] = [];
  let removed: Entry[] = [];
  let changed: Entry[] = [];
  let unchanged = 0;
  let view: View = "changed";
  let busy = false;

  const status = progress();
  const summary = h("div", {});
  const listHost = h("div", { class: "plug-results" });
  const tabs = h("div", { class: "seg plug-seg" });
  const picker = h("input", { type: "file", accept: ".ifc,.ifcx", class: "hidden" });
  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) void compare(file);
  });

  const root = page(
    bar(
      button("Choose baseline IFC", () => picker.click(), "accent"),
      button("Isolate added", () => isolate(added)),
      button("Isolate changed", () => isolate(changed)),
      button("Show all", () => ctx.showAll()),
      button("CSV", () => exportCsv()),
    ),
    picker,
    status.root,
    summary,
    tabs,
    listHost,
  );

  const isolate = (entries: Entry[]): void => {
    if (entries.length === 0) return void ctx.log("Nothing in that group", "error");
    ctx.isolate(entries.map((entry) => entry.id));
  };

  const compare = async (file: File): Promise<void> => {
    if (busy) return;
    if (!ctx.model().key) return void ctx.log("Open a model before comparing", "error");
    busy = true;
    baselineName = file.name;
    try {
      status.set(0, 1, `Indexing the open model`);
      const current = await ctx.index().build((done, total) => status.set(done, total, `Indexing the open model ${done.toLocaleString()} of ${total.toLocaleString()}`));
      status.set(0, 1, `Parsing ${file.name}`);
      const baseline = await readBaseline(file, (done, total) => status.set(done, total, `Reading ${file.name} ${done.toLocaleString()} of ${total.toLocaleString()}`));
      diff(current, baseline);
      ctx.log(`Compared against ${file.name}: ${added.length} added, ${removed.length} removed, ${changed.length} changed`, "success");
    } catch (err) {
      ctx.log(err instanceof Error ? err.message : String(err), "error");
    } finally {
      status.hide();
      busy = false;
      paint();
    }
  };

  const readBaseline = async (
    file: File,
    onProgress: (done: number, total: number) => void,
  ): Promise<Map<string, Snapshot>> => {
    side?.close();
    const model = await openSideModel(new Uint8Array(await file.arrayBuffer()));
    side = model;
    // A parse failure used to leave this worker alive with the whole model in
    // it, so the teardown is on every exit rather than on the happy path.
    try {
      // The panel can be closed while the parse above is still running, and by
      // then there is nothing to hand back.
      if (closed) return new Map();
      const elements = elementsOf(model.tree);

      const out = new Map<string, Snapshot>();
      let done = 0;
      let next = 0;
      const pump = async (): Promise<void> => {
        for (;;) {
          const at = next++;
          if (at >= elements.length) return;
          const element = elements[at];
          const properties = await model.properties(element.id);
          done += 1;
          if (done % 25 === 0 || done === elements.length) onProgress(done, elements.length);
          if (!properties) continue;
          const values: Record<string, Value> = {};
          let globalId = "";
          for (const attribute of properties.attributes) {
            if (attribute.name === "GlobalId") globalId = String(attribute.value ?? "");
            if (!IGNORED.has(attribute.name)) values[attribute.name] = attribute.value;
          }
          for (const set of properties.psets) {
            for (const property of set.properties) values[`${set.name}.${property.name}`] = property.value;
          }
          if (globalId) out.set(globalId, { type: element.type, name: element.name, storey: element.storey, values });
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(WINDOW, elements.length)) }, pump));
      return out;
    } finally {
      model.close();
      side = null;
    }
  };

  const diff = (current: ElementRow[], baseline: Map<string, Snapshot>): void => {
    added = [];
    removed = [];
    changed = [];
    unchanged = 0;
    const seen = new Set<string>();
    for (const row of current) {
      if (!row.globalId) continue;
      const before = baseline.get(row.globalId);
      seen.add(row.globalId);
      if (!before) {
        added.push({ globalId: row.globalId, id: row.id, type: row.type, name: row.name, storey: row.storey, changes: [] });
        continue;
      }
      const changes = differences(before.values, flatten(row));
      if (changes.length === 0) unchanged += 1;
      else changed.push({ globalId: row.globalId, id: row.id, type: row.type, name: row.name, storey: row.storey, changes });
    }
    for (const [globalId, snapshot] of baseline) {
      if (seen.has(globalId)) continue;
      removed.push({ globalId, id: 0, type: snapshot.type, name: snapshot.name, storey: snapshot.storey, changes: [] });
    }
    changed.sort((a, b) => b.changes.length - a.changes.length);
  };

  const paint = (): void => {
    if (!baselineName) {
      summary.replaceChildren();
      tabs.replaceChildren();
      listHost.replaceChildren(
        emptyState("compare", "Pick a baseline", "Choose an earlier version of this IFC and every element is matched by GlobalId."),
      );
      return;
    }
    summary.replaceChildren(
      stats([
        ["added", added.length.toLocaleString(), added.length ? "ok" : undefined],
        ["removed", removed.length.toLocaleString(), removed.length ? "err" : undefined],
        ["changed", changed.length.toLocaleString(), changed.length ? "warn" : undefined],
        ["unchanged", unchanged.toLocaleString()],
      ]),
    );
    tabs.replaceChildren();
    for (const [key, label, count] of [
      ["changed", "Changed", changed.length],
      ["added", "Added", added.length],
      ["removed", "Removed", removed.length],
    ] as Array<[View, string, number]>) {
      const button_ = h("button", { type: "button", text: `${label} ${count}`, "aria-pressed": String(view === key) });
      button_.addEventListener("click", () => {
        view = key;
        paint();
      });
      tabs.appendChild(button_);
    }

    const entries = view === "added" ? added : view === "removed" ? removed : changed;
    listHost.replaceChildren();
    if (entries.length === 0) {
      listHost.appendChild(emptyState("check-circle", `Nothing ${view}`, `Compared against ${baselineName}.`));
      return;
    }
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      const row = h("button", { class: "plug-row", type: "button", title: entry.globalId }, [
        h("span", { class: "grow", text: `${entry.type.replace(/^Ifc/, "")} ${entry.name || `#${entry.id}`}` }),
        h("span", { class: "n", text: view === "changed" ? `${entry.changes.length} change(s)` : entry.storey || "" }),
      ]);
      if (view !== "removed") {
        row.addEventListener("click", () => {
          ctx.select(entry.id);
          ctx.frame(entry.id);
        });
      } else {
        row.classList.add("dim");
      }
      listHost.appendChild(row);
      if (view === "changed") {
        listHost.appendChild(
          h("div", { class: "plug-changes" }, entry.changes.slice(0, 8).map((change) =>
            h("div", { class: "plug-change" }, [
              h("span", { class: "key", text: change.key }),
              h("span", { class: "was", text: show(change.from) }),
              h("span", { class: "arrow", text: "→" }),
              h("span", { class: "now", text: show(change.to) }),
            ]),
          )),
        );
      }
    }
    if (entries.length > LIST_LIMIT) listHost.appendChild(note(`Showing ${LIST_LIMIT} of ${entries.length.toLocaleString()}; the CSV holds all of them.`));
  };

  const exportCsv = (): void => {
    if (!baselineName) return void ctx.log("Run a comparison first", "error");
    const rows: Array<Array<Value>> = [];
    for (const entry of added) rows.push(["added", entry.globalId, entry.type, entry.name, entry.storey, "", "", ""]);
    for (const entry of removed) rows.push(["removed", entry.globalId, entry.type, entry.name, entry.storey, "", "", ""]);
    for (const entry of changed) {
      for (const change of entry.changes) {
        rows.push(["changed", entry.globalId, entry.type, entry.name, entry.storey, change.key, show(change.from), show(change.to)]);
      }
    }
    saveCsv(`compare-${ctx.model().name || "model"}.csv`, ["Kind", "GlobalId", "Class", "Name", "Storey", "Property", "Was", "Now"], rows);
  };

  host.appendChild(root);
  paint();

  ctx.on("model", () => {
    added = [];
    removed = [];
    changed = [];
    unchanged = 0;
    baselineName = "";
    paint();
  });

  return {
    dispose: () => {
      closed = true;
      side?.close();
    },
  };
}

function flatten(row: ElementRow): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(row.attrs)) if (!IGNORED.has(key)) values[key] = value;
  for (const [key, value] of Object.entries(row.props)) values[key] = value;
  return values;
}

function differences(before: Record<string, Value>, after: Record<string, Value>): Change[] {
  const changes: Change[] = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const from = before[key] ?? null;
    const to = after[key] ?? null;
    if (same(from, to)) continue;
    changes.push({ key, from, to });
  }
  return changes;
}

function same(a: Value, b: Value): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) < 1e-6;
  return String(a ?? "") === String(b ?? "");
}

function show(value: Value): string {
  if (value === null || value === undefined || value === "") return "(none)";
  return typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);
}
