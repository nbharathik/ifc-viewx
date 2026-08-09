import {
  bar, button, compareSnapshots, elementsOf, emptyState, h, hint, note, openSideModel, page, progress, stats, toCsv,
} from "@ifcviewx/sdk";
import type {
  CompareEntry, CompareKind, CompareResult, CompareSnapshot, ElementRow, ExtensionContextV2,
  PluginInstance, SideModel, Value,
} from "@ifcviewx/sdk";

type Filter = "changed" | "geometry" | "placement" | "containment" | "properties" | "added" | "removed" | "unchanged";

const WINDOW = 12;
const LIST_LIMIT = 250;
const RESULT_LIMIT = 10_000;
const IGNORED = new Set(["GlobalId", "OwnerHistory", "expressID"]);
const FILTERS: Array<[Filter, string]> = [
  ["changed", "Changed"],
  ["geometry", "Shape"],
  ["placement", "Moved"],
  ["containment", "Level"],
  ["properties", "Data"],
  ["added", "Added"],
  ["removed", "Removed"],
  ["unchanged", "Same"],
];
const COLORS: Record<Exclude<CompareKind, "removed" | "unchanged">, [number, number, number]> = {
  added: [54, 211, 153],
  geometry: [232, 121, 249],
  placement: [34, 211, 238],
  containment: [167, 139, 250],
  properties: [251, 191, 36],
  mixed: [248, 113, 113],
};

const labelKind = (kind: CompareKind): string => ({
  added: "Added", removed: "Removed", geometry: "Shape", placement: "Moved",
  containment: "Level", properties: "Data", mixed: "Mixed", unchanged: "Same",
})[kind];

const show = (value: Value): string => {
  if (value === null || value === undefined || value === "") return "(none)";
  return typeof value === "number" ? String(Number(value.toFixed(4))) : String(value);
};

const mm = (metres: number): string => `${Math.round(metres * 1000).toLocaleString()} mm`;
const deltaMm = (metres: number): string => `${metres >= 0 ? "+" : ""}${Math.round(metres * 1000).toLocaleString()} mm`;

function flatten(row: ElementRow): Record<string, Value> {
  const values: Record<string, Value> = {};
  for (const [key, value] of Object.entries(row.attrs)) if (!IGNORED.has(key)) values[key] = value;
  for (const [key, value] of Object.entries(row.props)) values[key] = value;
  return values;
}

function matchesFilter(entry: CompareEntry, filter: Filter): boolean {
  if (filter === "changed") return entry.kind !== "unchanged";
  if (filter === "geometry" || filter === "placement" || filter === "containment" || filter === "properties") {
    return entry.categories.includes(filter);
  }
  return entry.kind === filter;
}

export function mount(host: HTMLElement, ctx: ExtensionContextV2): PluginInstance {
  let side: SideModel | null = null;
  let controller: AbortController | null = null;
  let result: CompareResult | null = null;
  let baselineName = "";
  let filter: Filter = "changed";
  let selectedGlobal = "";
  let resultHandle = "";
  let paintFrame = 0;
  const status = progress();
  const summary = h("div");
  const tabs = h("div", { class: "seg plug-seg cmp-filters" });
  const detailHost = h("div", { class: "cmp-detail-host" });
  const listHost = h("div", { class: "plug-results cmp-results" });
  const search = h("input", { class: "plug-search-input", type: "search", placeholder: "Filter class, name, level or GlobalId", spellcheck: "false" });
  const picker = h("input", { type: "file", accept: ".ifc,.ifcx", class: "hidden" });
  const beforeLabel = h("span", { class: "cmp-revision before", text: "A  baseline" });
  const afterLabel = h("span", { class: "cmp-revision after", text: "B  open model" });
  const root = page();
  root.classList.add("model-compare");

  const currentEntries = (): CompareEntry[] => result?.entries.filter((entry) => entry.id > 0) ?? [];
  const filtered = (): CompareEntry[] => {
    const query = search.value.trim().toLowerCase();
    return (result?.entries ?? []).filter((entry) => matchesFilter(entry, filter) && (!query
      || `${entry.type} ${entry.name} ${entry.storey} ${entry.globalId}`.toLowerCase().includes(query)));
  };
  const count = (target: Filter): number => (result?.entries ?? []).filter((entry) => matchesFilter(entry, target)).length;

  const clearColor = (): void => ctx.view.colorBy(new Map(), []);
  const colorize = (entries = currentEntries()): void => {
    const colors = Object.values(COLORS);
    const names = Object.keys(COLORS) as Array<keyof typeof COLORS>;
    const assignment = new Map<number, number>();
    for (const entry of entries) {
      if (entry.kind === "removed" || entry.kind === "unchanged") continue;
      const color = entry.kind === "mixed" ? "mixed" : entry.kind;
      assignment.set(entry.id, names.indexOf(color) + 1);
    }
    ctx.view.colorBy(assignment, colors);
    ctx.feedback.toast(`Colored ${assignment.size.toLocaleString()} current element${assignment.size === 1 ? "" : "s"}`, "success");
  };
  const isolateFiltered = (): void => {
    const ids = filtered().map((entry) => entry.id).filter((id) => id > 0);
    if (!ids.length) return void ctx.feedback.toast("No current elements in this view", "error");
    ctx.view.isolate(ids, `Compare: ${filter}`);
  };

  picker.addEventListener("change", () => {
    const file = picker.files?.[0];
    picker.value = "";
    if (file) void run(file);
  });
  search.addEventListener("input", () => queuePaint());

  root.append(
    h("div", { class: "cmp-revision-trace" }, [
      beforeLabel,
      h("span", { class: "cmp-trace-line" }, [h("i"), h("b")]),
      afterLabel,
    ]),
    bar(
      button("Choose baseline IFC", () => picker.click(), "accent"),
      button("Isolate view", isolateFiltered),
      button("Color changes", () => colorize(filtered())),
      button("Clear color", clearColor),
      button("Show all", () => ctx.view.showAll()),
      button("CSV", () => exportCsv()),
    ),
    picker,
    status.root,
    summary,
    search,
    tabs,
    detailHost,
    listHost,
    hint("info", "Compact mesh signatures run in the geometry worker. The baseline geometry is released after its signatures are built, so comparison does not duplicate GPU meshes."),
  );

  const readBaseline = async (file: File, signal: AbortSignal): Promise<CompareSnapshot[]> => {
    side?.close();
    status.set(0, 1, `Reading baseline geometry from ${file.name}`);
    const model = await openSideModel(new Uint8Array(await file.arrayBuffer()), {
      geometrySignatures: true,
      signal,
      onProgress: (value) => status.set(
        value.entities || value.meshes,
        Math.max(1, value.totalEntities),
        `${value.phase === "geometry" ? "Meshing" : "Parsing"} ${file.name}`,
      ),
    });
    side = model;
    try {
      const signatures = new Map(model.geometrySignatures().map((signature) => [signature.id, signature]));
      const elements = elementsOf(model.tree);
      const rows: CompareSnapshot[] = new Array(elements.length);
      let done = 0;
      let next = 0;
      const pump = async (): Promise<void> => {
        for (;;) {
          if (signal.aborted) throw new DOMException("Comparison cancelled", "AbortError");
          const at = next++;
          if (at >= elements.length) return;
          const element = elements[at];
          const properties = await model.properties(element.id);
          const values: Record<string, Value> = {};
          let globalId = "";
          if (properties) {
            for (const attribute of properties.attributes) {
              if (attribute.name === "GlobalId") globalId = String(attribute.value ?? "");
              if (!IGNORED.has(attribute.name)) values[attribute.name] = attribute.value;
            }
            for (const set of properties.psets) {
              for (const property of set.properties) values[`${set.name}.${property.name}`] = property.value;
            }
          }
          rows[at] = { ...element, globalId, values, geometry: signatures.get(element.id) };
          done += 1;
          if (done % 25 === 0 || done === elements.length) {
            status.set(done, elements.length, `Indexing baseline data ${done.toLocaleString()} of ${elements.length.toLocaleString()}`);
          }
        }
      };
      await Promise.all(Array.from({ length: Math.max(1, Math.min(WINDOW, elements.length)) }, pump));
      return rows;
    } finally {
      model.close();
      if (side === model) side = null;
    }
  };

  const run = async (file: File): Promise<void> => {
    if (!ctx.session.model().loaded) return void ctx.feedback.toast("Open a model before comparing", "error");
    controller?.abort();
    const next = new AbortController();
    controller = next;
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = "";
    clearColor();
    baselineName = file.name;
    result = null;
    selectedGlobal = "";
    paint();
    if (file.size > 250 * 1024 * 1024) {
      ctx.feedback.toast("This is a large browser comparison. Exact and oversized revision pairs belong on the optional Local Studio route.", "info");
    }
    try {
      const elements = ctx.model.elements();
      status.set(0, Math.max(1, elements.length), "Building current revision signatures");
      const [currentRows, currentGeometry, baseline] = await Promise.all([
        ctx.model.index().build((done, total) => status.set(done, total, `Indexing current data ${done.toLocaleString()} of ${total.toLocaleString()}`)),
        ctx.geometry.signatures(elements.map((element) => element.id), { signal: next.signal }),
        readBaseline(file, next.signal),
      ]);
      if (next.signal.aborted) return;
      const signatures = new Map(currentGeometry.signatures.map((signature) => [signature.id, signature]));
      const current: CompareSnapshot[] = currentRows.map((row) => ({
        globalId: row.globalId,
        id: row.id,
        type: row.type,
        name: row.name,
        storey: row.storey,
        values: flatten(row),
        geometry: signatures.get(row.id),
      }));
      result = compareSnapshots(current, baseline);
      if (resultHandle) ctx.results.dispose(resultHandle);
      const changed = result.entries.filter((entry) => entry.kind !== "unchanged");
      resultHandle = ctx.results.create("compare.results", changed.slice(0, RESULT_LIMIT).map((entry) => ({
        globalId: entry.globalId,
        id: entry.id,
        kind: entry.kind,
        categories: entry.categories,
        type: entry.type,
        name: entry.name,
        storey: entry.storey,
        propertyChanges: entry.changes.length,
        translationMm: entry.geometry ? Number((entry.geometry.translationDistance * 1000).toFixed(2)) : null,
        rotationDegrees: entry.geometry ? Number(entry.geometry.rotationDegrees.toFixed(3)) : null,
        shapeChanged: entry.geometry?.shapeChanged ?? false,
      })), { metadata: {
        baseline: file.name,
        current: ctx.session.model().name,
        fidelity: "mesh",
        engine: currentGeometry.engine,
        geometryCompared: result.geometryCompared,
        geometryMissing: result.geometryMissing,
        truncated: changed.length > RESULT_LIMIT,
      } }).id;
      const warnings = changed.filter((entry) => entry.categories.includes("geometry") || entry.categories.includes("placement"));
      ctx.feedback.publishFindings(
        `${changed.length.toLocaleString()} changed elements against ${file.name}.`,
        warnings.slice(0, 100).map((entry) => ({
          severity: "warning",
          title: `${labelKind(entry.kind)}: ${entry.type.replace(/^Ifc/, "")} ${entry.name || entry.globalId}`,
          detail: entry.geometry ? `${mm(entry.geometry.translationDistance)} moved, ${entry.geometry.rotationDegrees.toFixed(2)} degrees rotated` : entry.storey,
          expressID: entry.id || undefined,
        })),
      );
      ctx.feedback.log(`Compared ${result.entries.length.toLocaleString()} matched records against ${file.name}`, "success");
      colorize(changed);
    } catch (error) {
      if (!(next.signal.aborted || (error instanceof DOMException && error.name === "AbortError"))) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    } finally {
      if (controller === next) {
        controller = null;
        status.hide();
        paint();
      }
    }
  };

  const detail = (entry: CompareEntry): HTMLElement => {
    const geometryRows: HTMLElement[] = [];
    if (entry.geometry) {
      const moved = entry.geometry.translation;
      geometryRows.push(
        h("div", { class: "cmp-delta" }, [h("span", { text: "Translation" }), h("b", { text: `${mm(entry.geometry.translationDistance)}  X ${deltaMm(moved[0])}  Y ${deltaMm(moved[1])}  Z ${deltaMm(moved[2])}` })]),
        h("div", { class: "cmp-delta" }, [h("span", { text: "Rotation" }), h("b", { text: `${entry.geometry.rotationDegrees.toFixed(2)} degrees` })]),
        h("div", { class: "cmp-delta" }, [h("span", { text: "Bounds size" }), h("b", { text: `X ${deltaMm(entry.geometry.size[0])}  Y ${deltaMm(entry.geometry.size[1])}  Z ${deltaMm(entry.geometry.size[2])}` })]),
        h("div", { class: "cmp-delta" }, [h("span", { text: "Mesh" }), h("b", { text: `${entry.geometry.beforeTriangles.toLocaleString()} to ${entry.geometry.afterTriangles.toLocaleString()} triangles${entry.geometry.shapeChanged ? ", signature changed" : ""}` })]),
      );
    }
    const changes = entry.changes.slice(0, 40).map((change) => h("div", { class: "plug-change" }, [
      h("span", { class: "key", text: change.key }),
      h("span", { class: "was", text: show(change.from) }),
      h("span", { class: "arrow", text: "to" }),
      h("span", { class: "now", text: show(change.to) }),
    ]));
    return h("section", { class: `cmp-detail kind-${entry.kind}` }, [
      h("header", {}, [
        h("span", { class: `cmp-kind kind-${entry.kind}`, text: labelKind(entry.kind) }),
        h("div", { class: "grow" }, [h("b", { text: `${entry.type.replace(/^Ifc/, "")} ${entry.name || `#${entry.id}`}` }), h("span", { text: entry.globalId })]),
        entry.id ? button("Frame", () => { ctx.view.select(entry.id); ctx.view.frame(entry.id); }) : "",
      ]),
      geometryRows.length ? h("div", { class: "cmp-geometry-deltas" }, geometryRows) : "",
      entry.before?.storey !== entry.after?.storey ? h("div", { class: "cmp-level-change", text: `Level: ${entry.before?.storey || "(none)"} to ${entry.after?.storey || "(none)"}` }) : "",
      changes.length ? h("div", { class: "plug-changes cmp-changes" }, changes) : note(entry.kind === "added" ? "Only in the open model." : entry.kind === "removed" ? "Only in the baseline." : "No property-value changes."),
      entry.changes.length > 40 ? note(`Showing 40 of ${entry.changes.length.toLocaleString()} property changes. The CSV contains all changes.`) : "",
    ]);
  };

  const selectEntry = (entry: CompareEntry, row: HTMLElement): void => {
    selectedGlobal = entry.globalId;
    listHost.querySelector(".cmp-row.active")?.classList.remove("active");
    row.classList.add("active");
    detailHost.replaceChildren(detail(entry));
    if (entry.id) {
      ctx.view.select(entry.id);
      ctx.view.frame(entry.id);
    }
  };

  const paint = (): void => {
    beforeLabel.textContent = baselineName ? `A  ${baselineName}` : "A  baseline";
    afterLabel.textContent = `B  ${ctx.session.model().name || "open model"}`;
    if (!result) {
      summary.replaceChildren();
      tabs.replaceChildren();
      detailHost.replaceChildren();
      listHost.replaceChildren(emptyState("compare", baselineName ? "Building revision trace" : "Choose a baseline", baselineName
        ? `Reading ${baselineName} without adding a second render model.`
        : "Compare an earlier IFC against the open revision by GlobalId, mesh shape, placement, level and property data."));
      return;
    }
    const categoryCount = (category: CompareEntry["categories"][number]): number => result!.entries.filter((entry) => entry.categories.includes(category)).length;
    summary.replaceChildren(
      stats([
        ["added", result.counts.added.toLocaleString(), result.counts.added ? "ok" : undefined],
        ["removed", result.counts.removed.toLocaleString(), result.counts.removed ? "err" : undefined],
        ["shape", categoryCount("geometry").toLocaleString(), categoryCount("geometry") ? "warn" : undefined],
        ["moved", categoryCount("placement").toLocaleString(), categoryCount("placement") ? "warn" : undefined],
        ["data", categoryCount("properties").toLocaleString()],
      ]),
      ...(result.geometryMissing ? [note(`${result.geometryMissing.toLocaleString()} matched element${result.geometryMissing === 1 ? "" : "s"} had no retained mesh in one revision. Their data changes are still complete.`)] : []),
    );
    tabs.replaceChildren();
    for (const [key, label] of FILTERS) {
      const tab = h("button", { type: "button", text: `${label} ${count(key).toLocaleString()}`, "aria-pressed": String(filter === key) });
      tab.addEventListener("click", () => { filter = key; selectedGlobal = ""; paint(); });
      tabs.appendChild(tab);
    }
    const entries = filtered();
    const fragment = document.createDocumentFragment();
    if (!entries.length) fragment.appendChild(emptyState("search", "No changes in this view", "Try another change type or clear the search field."));
    for (const entry of entries.slice(0, LIST_LIMIT)) {
      const categories = entry.kind === "mixed" ? entry.categories.map((value) => labelKind(value)).join(" + ") : labelKind(entry.kind);
      const row = h("button", { class: `plug-row cmp-row kind-${entry.kind}${selectedGlobal === entry.globalId ? " active" : ""}`, type: "button", title: entry.globalId }, [
        h("span", { class: "cmp-row-trace" }, [h("i"), h("b")]),
        h("span", { class: "grow" }, [h("b", { text: `${entry.type.replace(/^Ifc/, "")} ${entry.name || `#${entry.id}`}` }), h("span", { text: entry.storey || "No level" })]),
        h("span", { class: "cmp-row-state", text: categories }),
      ]);
      row.addEventListener("click", () => selectEntry(entry, row));
      fragment.appendChild(row);
    }
    if (entries.length > LIST_LIMIT) fragment.appendChild(note(`Showing ${LIST_LIMIT} of ${entries.length.toLocaleString()} results. Search to narrow the list; CSV includes all rows.`));
    listHost.replaceChildren(fragment);
    const selected = entries.find((entry) => entry.globalId === selectedGlobal);
    detailHost.replaceChildren(...(selected ? [detail(selected)] : []));
  };

  const queuePaint = (): void => {
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => { paintFrame = 0; paint(); });
  };

  const exportCsv = (): void => {
    if (!result) return void ctx.feedback.toast("Run a comparison first", "error");
    const rows: Array<Array<Value>> = [];
    for (const entry of result.entries.filter((value) => value.kind !== "unchanged")) {
      const base: Value[] = [entry.kind, entry.categories.join("+"), entry.globalId, entry.type, entry.name, entry.storey,
        entry.geometry ? Number((entry.geometry.translationDistance * 1000).toFixed(2)) : null,
        entry.geometry ? Number(entry.geometry.rotationDegrees.toFixed(3)) : null,
        entry.geometry?.shapeChanged ?? false];
      if (!entry.changes.length) rows.push([...base, "", "", ""]);
      else for (const change of entry.changes) rows.push([...base, change.key, show(change.from), show(change.to)]);
    }
    const name = `compare-${ctx.session.model().name || "model"}.csv`;
    ctx.files.export("compare.csv", name, `\uFEFF${toCsv(["State", "Categories", "GlobalId", "Class", "Name", "Storey", "Translation mm", "Rotation degrees", "Shape changed", "Property", "Was", "Now"], rows)}`, "text/csv");
  };

  ctx.events.on("model", () => {
    controller?.abort();
    side?.close();
    side = null;
    result = null;
    baselineName = "";
    selectedGlobal = "";
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = "";
    clearColor();
    paint();
  });

  paint();
  host.appendChild(root);
  return {
    dispose: () => {
      controller?.abort();
      side?.close();
      if (paintFrame) cancelAnimationFrame(paintFrame);
      clearColor();
    },
  };
}
