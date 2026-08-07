// The clash panel: pick two sets of classes, sweep, read the hits.
//
// The sweep itself is not here. It lives in core, runs in a worker, and is
// published through the SDK, so this panel and the assistant's clash tool run
// one algorithm and can never disagree about a model.
import {
  bar, button, cancelClash, classCounts, classPicker, CLASH_LIMIT, copyTable, emptyState, field,
  grid, h, hint, idsOfTypes, MEP, note, number, OPENINGS, page, progress, saveCsv, select, stats,
  STRUCTURE, worstDepth,
} from "@ifcviewx/sdk";
import type { ClashPair, GridRow, PluginContext, PluginInstance, ReportFinding, SweepResult } from "@ifcviewx/sdk";

const PRESETS: Array<[string, string[], string[]]> = [
  ["Structure vs services", STRUCTURE, MEP],
  ["Services vs services", MEP, MEP],
  ["Structure vs structure", STRUCTURE, STRUCTURE],
  ["Fit-out vs structure", OPENINGS, STRUCTURE],
];

const REPORT = ["Kind", "A id", "A GlobalId", "A class", "A name", "B id", "B GlobalId", "B class", "B name", "Value mm", "X", "Y", "Z"];

/** Hard clashes deeper than this are the ones that stop work on site. */
const SEVERE_MM = 50;

export function mount(host: HTMLElement, ctx: PluginContext): PluginInstance {
  const setA = new Set<string>();
  const setB = new Set<string>();
  let tolerance = ctx.read("tolerance", 10);
  let clearance = ctx.read("clearance", 0);
  let result: SweepResult | null = null;
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
      field("Clearance mm", number(clearance, (value) => {
        clearance = Math.max(0, value);
        ctx.write("clearance", clearance);
      }, 5)),
      running
        ? button("Stop", () => cancelClash(ctx.viewer), "warn")
        : button("Run sweep", () => void sweep(), "accent"),
      button("Isolate hits", () => isolateHits()),
      button("Show all", () => ctx.showAll()),
      button("CSV", () => void exportCsv()),
      button("Copy", () => void copyRows()),
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
      hint(
        "info",
        clearance > 0
          ? `Triangle-level intersection over the loaded geometry. Pairs that miss are also checked for a gap under ${clearance} mm.`
          : "Triangle-level intersection over the loaded geometry, not bounding boxes. Raise the tolerance to drop the grazes, set a clearance to catch near misses.",
      ),
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
    const generation = models;
    const elements = ctx.elements();
    const has = (id: number): boolean => ctx.bounds(id) !== null;
    const a = idsOfTypes(elements, setA, has);
    const b = idsOfTypes(elements, setB, has);
    running = true;
    build();
    status.set(0, 1, `Preparing ${a.length.toLocaleString()} against ${b.length.toLocaleString()} elements`);
    try {
      const swept = await ctx.clash(a, b, {
        toleranceMm: tolerance,
        clearanceMm: clearance,
        onProgress: ({ done, total, hits }) =>
          status.set(done, total, `Testing geometry, ${hits.toLocaleString()} found so far`),
      });
      // Element ids from the model this started against mean something else in
      // the one that replaced it while the sweep ran.
      if (generation !== models) return;
      result = swept;
    } catch (err) {
      if (generation === models) ctx.log(err instanceof Error ? err.message : String(err), "error");
      return;
    } finally {
      status.hide();
      running = false;
      if (generation === models) build();
    }
    const hard = hits().filter((hit) => hit.kind === "hard").length;
    ctx.log(
      `Clash sweep: ${hard.toLocaleString()} clash(es) in ${(result.elapsedMs / 1000).toFixed(1)}s across ${result.pairsTested.toLocaleString()} geometry tests`,
      hard ? "info" : "success",
    );
    publish();
  };

  const hits = (): ClashPair[] => result?.hits ?? [];

  /** Severe and minor split at 50 mm: a graze is not the same finding as a hit. */
  const publish = (): void => {
    if (!result) return;
    const hard = hits().filter((hit) => hit.kind === "hard");
    const near = hits().filter((hit) => hit.kind === "clearance");
    const severe = hard.filter((hit) => hit.distance * 1000 > SEVERE_MM);
    const findings: ReportFinding[] = [];
    if (severe.length) {
      findings.push({
        severity: "error",
        title: `Hard clashes over ${SEVERE_MM} mm`,
        count: severe.length,
        detail: `deepest ${(worstDepth(severe) * 1000).toFixed(0)} mm`,
      });
    }
    if (hard.length > severe.length) {
      findings.push({ severity: "warning", title: `Hard clashes under ${SEVERE_MM} mm`, count: hard.length - severe.length });
    }
    if (near.length) {
      findings.push({ severity: "warning", title: `Pairs closer than ${clearance} mm`, count: near.length });
    }
    if (result.missing) {
      findings.push({ severity: "info", title: "Elements without retained geometry, so they were not tested", count: result.missing });
    }
    if (result.truncated) {
      findings.push({ severity: "info", title: `Stopped at ${CLASH_LIMIT.toLocaleString()} results, so the sweep is incomplete` });
    }
    const sets = `${[...setA].join(", ")} against ${[...setB].join(", ")}`;
    ctx.publishFindings(
      `${hard.length.toLocaleString()} clash(es) over ${tolerance} mm from ${result.pairsTested.toLocaleString()} geometry tests. ${sets}.`,
      findings,
    );
  };

  const paint = (): void => {
    const hard = hits().filter((hit) => hit.kind === "hard");
    const near = hits().length - hard.length;
    const tiles: Array<[string, string, string?]> = [
      ["clashes", hard.length.toLocaleString(), hard.length ? "err" : "ok"],
    ];
    if (clearance > 0) tiles.push(["near misses", near.toLocaleString(), near ? "warn" : "ok"]);
    tiles.push(
      ["elements", result ? `${result.elementsA.toLocaleString()} v ${result.elementsB.toLocaleString()}` : "0"],
      ["geometry tests", (result?.pairsTested ?? 0).toLocaleString()],
      ["deepest", hard.length ? `${(worstDepth(hard) * 1000).toFixed(0)} mm` : "0"],
      ["took", result ? `${(result.elapsedMs / 1000).toFixed(1)} s` : "0"],
    );
    summary.replaceChildren(stats(tiles));
    results.replaceChildren();
    if (hits().length === 0) {
      // An empty result has two very different meanings, and saying which one
      // it is matters more than the zero does: a clean model, or nothing that
      // could be tested in the first place.
      const nothingTested = result !== null && result.pairsTested === 0;
      results.appendChild(
        emptyState(
          "check-circle",
          !result ? "Nothing swept yet"
            : nothingTested ? "No pair of these two sets came close enough to test"
            : "Nothing intersects over the tolerance",
          !result ? "Pick the two sets, then run the sweep."
            : nothingTested ? "The two sets are physically apart in this model. Try other classes."
            : "Lower the tolerance, or set a clearance to catch near misses.",
        ),
      );
      if (result?.missing) {
        results.appendChild(note(`${result.missing.toLocaleString()} element(s) had no geometry to test.`));
      }
      return;
    }
    const names = new Map(ctx.elements().map((element) => [element.id, element.name]));
    const label = (id: number, type: string): string => `${type.replace(/^Ifc/, "")} #${ctx.expressOf(id)}`;
    const rows: GridRow[] = hits().slice(0, 500).map((hit) => ({
      cells: [
        hit.kind === "hard" ? "clash" : "close",
        label(hit.a, hit.aType),
        label(hit.b, hit.bType),
        Number((hit.distance * 1000).toFixed(hit.distance < 0.01 ? 1 : 0)),
      ],
      title: `${names.get(hit.a) || hit.aType} vs ${names.get(hit.b) || hit.bType}`,
      tone: hit.kind === "clearance" ? "warn" : hit.distance * 1000 > SEVERE_MM ? "err" : "warn",
      pick: () => show(hit),
    }));
    results.append(grid(["Kind", "Element A", "Element B", "mm"], rows));
    if (hits().length > rows.length) {
      results.appendChild(note(`Showing the worst ${rows.length} of ${hits().length.toLocaleString()}. The CSV holds all of them.`));
    }
    if (result?.truncated) {
      results.appendChild(note(`Stopped at ${CLASH_LIMIT.toLocaleString()} results. Narrow the sets or raise the tolerance.`));
    }
    if (result?.missing) {
      results.appendChild(note(`${result.missing.toLocaleString()} element(s) had no geometry to test.`));
    }
  };

  /** Both elements alone, framed on the collision rather than on either box. */
  const show = (hit: ClashPair): void => {
    ctx.isolate([hit.a, hit.b]);
    ctx.select([hit.a, hit.b]);
    const reach = Math.max(hit.extent[0], hit.extent[1], hit.extent[2], 0.4);
    ctx.frameAt(hit.point, reach * 2.5);
  };

  /** Everything caught by the sweep, so the whole problem is on screen at once. */
  const isolateHits = (): void => {
    if (hits().length === 0) return void ctx.log("Run a sweep first", "error");
    const ids = new Set<number>();
    for (const hit of hits()) {
      ids.add(hit.a);
      ids.add(hit.b);
    }
    ctx.isolate([...ids]);
    ctx.log(`Isolated ${ids.size.toLocaleString()} clashing element(s)`);
  };

  /**
   * GlobalId is what survives a round trip through authoring tools, so an
   * exported clash carries it as well as the STEP line number. The shared
   * property index is used when a data plugin has already built it; otherwise
   * only the elements in the results are read, rather than the whole model.
   */
  const globalIds = async (): Promise<Map<number, string>> => {
    const guid = new Map<number, string>();
    const index = ctx.index();
    if (index.ready()) {
      for (const row of index.all()) guid.set(row.id, row.globalId);
      return guid;
    }
    const ids = [...new Set(hits().flatMap((hit) => [hit.a, hit.b]))];
    let next = 0;
    const pump = async (): Promise<void> => {
      for (let at = next++; at < ids.length; at = next++) {
        const props = await ctx.properties(ids[at]).catch(() => null);
        const value = props?.attributes.find((item) => item.name === "GlobalId")?.value;
        if (value !== undefined && value !== null) guid.set(ids[at], String(value));
      }
    };
    await Promise.all(Array.from({ length: Math.min(12, ids.length) }, pump));
    return guid;
  };

  const reportRows = async (): Promise<Array<Array<string | number>>> => {
    const guid = await globalIds();
    const names = new Map(ctx.elements().map((element) => [element.id, element.name]));
    return hits().map((hit) => [
      hit.kind,
      ctx.expressOf(hit.a), guid.get(hit.a) ?? "", hit.aType, names.get(hit.a) ?? "",
      ctx.expressOf(hit.b), guid.get(hit.b) ?? "", hit.bType, names.get(hit.b) ?? "",
      Math.round(hit.distance * 1000),
      Number(hit.point[0].toFixed(3)), Number(hit.point[1].toFixed(3)), Number(hit.point[2].toFixed(3)),
    ]);
  };

  const copyRows = async (): Promise<void> => {
    if (hits().length === 0) return void ctx.log("Run a sweep first", "error");
    copyTable(REPORT, await reportRows());
  };

  const exportCsv = async (): Promise<void> => {
    if (hits().length === 0) return void ctx.log("Run a sweep first", "error");
    saveCsv(`clashes-${ctx.model().name || "model"}.csv`, REPORT, await reportRows());
  };

  ctx.on("model", () => {
    models += 1;
    result = null;
    build();
  });

  build();
  host.appendChild(root);

  return {
    dispose: () => cancelClash(ctx.viewer),
  };
}
