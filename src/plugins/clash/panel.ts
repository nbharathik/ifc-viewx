// The clash panel: pick two sets of classes, sweep, read the hits.
//
// The sweep itself is not here. It lives in core and is published through the
// SDK, so this panel and the assistant's clash tool run one algorithm and can
// never disagree about a model.
import {
  bar, boxesFor, button, classCounts, classPicker, CLASH_LIMIT, copyTable, deepestHit, emptyState,
  field, grid, h, hint, MEP, nextFrame, note, number, OPENINGS, page, progress, saveCsv, select,
  stats, STRUCTURE, sweepBoxes,
} from "@ifcviewx/sdk";
import type { ClashHit, GridRow, PluginContext, PluginInstance } from "@ifcviewx/sdk";

const PRESETS: Array<[string, string[], string[]]> = [
  ["Structure vs services", STRUCTURE, MEP],
  ["Services vs services", MEP, MEP],
  ["Structure vs structure", STRUCTURE, STRUCTURE],
  ["Fit-out vs structure", OPENINGS, STRUCTURE],
];

const REPORT = ["A id", "A class", "A name", "B id", "B class", "B name", "Depth mm", "Volume m3"];

export function mount(host: HTMLElement, ctx: PluginContext): PluginInstance {
  const setA = new Set<string>();
  const setB = new Set<string>();
  let tolerance = ctx.read("tolerance", 10);
  let hits: ClashHit[] = [];
  let tested = 0;
  let truncated = false;
  let running = false;
  /** Bumped by every model change, so a sweep in flight knows it is stale. */
  let models = 0;

  const status = progress();
  const results = h("div", { class: "plug-results" });
  const summary = h("div", {});
  const pickers = h("div", { class: "plug-two" });
  const root = page();

  const build = (): void => {
    const elements = ctx.elements();
    root.replaceChildren();
    if (elements.length === 0) {
      root.appendChild(emptyState("cube", "No model loaded", "Open an IFC file and the class lists fill in."));
      return;
    }
    const counts = classCounts(elements.filter((el) => ctx.bounds(el.id) !== null));
    const presets: Array<[string, string]> = [["", "Preset"], ...PRESETS.map(([label]) => [label, label] as [string, string])];

    const run = button("Run sweep", () => void sweep(), "accent");
    const controls = bar(
      select(presets, "", (value) => {
        const preset = PRESETS.find(([label]) => label === value);
        if (!preset) return;
        apply(setA, preset[1], counts);
        apply(setB, preset[2], counts);
        build();
      }),
      field("Tolerance mm", number(tolerance, (value) => {
        tolerance = Math.max(0, value);
        ctx.write("tolerance", tolerance);
      }, 1)),
      run,
      button("Isolate hits", () => isolateHits()),
      button("Show all", () => ctx.showAll()),
      button("CSV", () => exportCsv()),
      button("Copy", () => copyTable(REPORT, reportRows())),
    );

    pickers.replaceChildren(
      h("div", { class: "plug-col" }, [
        h("div", { class: "group-title" }, [h("span", { text: `Set A  ${setA.size || "none"}` })]),
        classPicker(counts, setA, () => build()),
      ]),
      h("div", { class: "plug-col" }, [
        h("div", { class: "group-title" }, [h("span", { text: `Set B  ${setB.size || "none"}` })]),
        classPicker(counts, setB, () => build()),
      ]),
    );

    root.append(
      controls,
      hint("info", "Axis-aligned boxes, so this screens for coordination problems rather than proving them. Raise the tolerance to drop the grazes."),
      pickers,
      status.root,
      summary,
      results,
    );
    paint();
  };

  const apply = (target: Set<string>, wanted: string[], counts: Array<[string, number]>): void => {
    target.clear();
    for (const [type] of counts) if (wanted.includes(type)) target.add(type);
  };

  const sweep = async (): Promise<void> => {
    if (running) return;
    if (setA.size === 0 || setB.size === 0) {
      ctx.log("Pick at least one class in each set", "error");
      return;
    }
    running = true;
    const generation = models;
    const a = boxesFor(ctx, setA);
    const b = boxesFor(ctx, setB);
    status.set(0, a.length, `Indexing ${b.length.toLocaleString()} elements`);
    await nextFrame();
    try {
      const result = await sweepBoxes(a, b, tolerance, (done, total, found) =>
        status.set(done, total, `Sweeping ${found.toLocaleString()} hits so far`),
      );
      // Express ids from the model this started against mean something else in
      // the one that replaced it while the sweep ran.
      if (generation !== models) return;
      ({ hits, tested, truncated } = result);
    } finally {
      status.hide();
      running = false;
    }
    if (generation !== models) return;
    ctx.log(`Clash sweep: ${hits.length.toLocaleString()} hit(s) across ${tested.toLocaleString()} pair tests`, hits.length ? "info" : "success");
    paint();
  };

  const paint = (): void => {
    summary.replaceChildren(
      stats([
        ["clashes", hits.length.toLocaleString(), hits.length ? "err" : "ok"],
        ["pair tests", tested.toLocaleString()],
        ["deepest", hits[0] ? `${(deepestHit(hits) * 1000).toFixed(0)} mm` : "0"],
        ["largest", hits[0] ? `${hits[0].volume.toFixed(3)} m³` : "0"],
      ]),
    );
    results.replaceChildren();
    if (hits.length === 0) {
      results.appendChild(
        emptyState("check-circle", tested ? "No clashes over the tolerance" : "Nothing swept yet", tested ? "Lower the tolerance to catch grazes." : "Pick the two sets, then run the sweep."),
      );
      return;
    }
    const rows: GridRow[] = hits.slice(0, 500).map((hit) => ({
      cells: [
        `${hit.a.type.replace(/^Ifc/, "")} #${hit.a.id}`,
        `${hit.b.type.replace(/^Ifc/, "")} #${hit.b.id}`,
        Number((hit.depth * 1000).toFixed(0)),
        Number(hit.volume.toFixed(4)),
      ],
      title: `${hit.a.name || hit.a.type} vs ${hit.b.name || hit.b.type}`,
      tone: hit.depth > 0.05 ? "err" : "warn",
      pick: () => {
        ctx.isolate([hit.a.id, hit.b.id]);
        ctx.select(hit.a.id);
        ctx.frame(hit.a.id);
      },
    }));
    results.append(grid(["Element A", "Element B", "Depth mm", "Volume m³"], rows));
    if (hits.length > rows.length) {
      results.appendChild(note(`Showing the worst ${rows.length} of ${hits.length.toLocaleString()}. The CSV holds all of them.`));
    }
    if (truncated) results.appendChild(note(`Stopped at ${CLASH_LIMIT.toLocaleString()} hits. Narrow the sets or raise the tolerance.`));
  };

  /** Everything caught by the sweep, so the whole problem is on screen at once. */
  const isolateHits = (): void => {
    if (hits.length === 0) return void ctx.log("Run a sweep first", "error");
    const ids = new Set<number>();
    for (const hit of hits) {
      ids.add(hit.a.id);
      ids.add(hit.b.id);
    }
    ctx.isolate([...ids]);
    ctx.log(`Isolated ${ids.size.toLocaleString()} clashing element(s)`);
  };

  const reportRows = (): Array<Array<string | number>> =>
    hits.map((hit) => [hit.a.id, hit.a.type, hit.a.name, hit.b.id, hit.b.type, hit.b.name, Math.round(hit.depth * 1000), Number(hit.volume.toFixed(5))]);

  const exportCsv = (): void => {
    if (hits.length === 0) return void ctx.log("Run a sweep first", "error");
    saveCsv(`clashes-${ctx.model().name || "model"}.csv`, REPORT, reportRows());
  };

  ctx.on("model", () => {
    models += 1;
    hits = [];
    tested = 0;
    truncated = false;
    build();
  });

  build();
  host.appendChild(root);

  return {};
}

