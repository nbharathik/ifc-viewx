// Clash detection over the bounding boxes the viewer already holds.
//
// Broad phase is a uniform grid built over set B; elements too large to bucket
// sensibly go in an oversized list tested against everything. Narrow phase is
// the box overlap itself, reported as depth and volume so the list sorts by
// how bad the hit is rather than by chance.
import { h } from "../../ui/kit.js";
import { emptyState } from "../../ui/shell.js";
import {
  bar, button, classCounts, classPicker, copyTable, field, grid, hint, note, number, page, progress,
  saveCsv, select, stats, type GridRow,
} from "../kit.js";
import { modelElements } from "../../llm/actions.js";
import type { Viewer } from "../../viewer-core/viewer.js";
import type { PluginApi, PluginInstance } from "../host.js";

interface Box {
  id: number;
  type: string;
  name: string;
  min: [number, number, number];
  max: [number, number, number];
}

interface Hit {
  a: Box;
  b: Box;
  depth: number;
  volume: number;
}

interface SweepResult {
  hits: Hit[];
  tested: number;
  truncated: boolean;
}

const STRUCTURE = ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcBeam", "IfcColumn", "IfcFooting", "IfcRoof", "IfcMember", "IfcPlate"];
const MEP = ["IfcDuctSegment", "IfcDuctFitting", "IfcPipeSegment", "IfcPipeFitting", "IfcCableCarrierSegment", "IfcCableSegment", "IfcFlowTerminal", "IfcAirTerminal", "IfcSanitaryTerminal", "IfcValve", "IfcPump", "IfcTank", "IfcSpaceHeater", "IfcElectricAppliance"];
const OPENINGS = ["IfcDoor", "IfcWindow", "IfcStair", "IfcRailing", "IfcFurnishingElement", "IfcCovering"];

const PRESETS: Array<[string, string[], string[]]> = [
  ["Structure vs services", STRUCTURE, MEP],
  ["Services vs services", MEP, MEP],
  ["Structure vs structure", STRUCTURE, STRUCTURE],
  ["Fit-out vs structure", OPENINGS, STRUCTURE],
];

/** Cells one element may occupy before it is treated as oversized. */
const MAX_SPAN = 64;
const RESULT_LIMIT = 4000;
const SLICE = 250;
const REPORT = ["A id", "A class", "A name", "B id", "B class", "B name", "Depth mm", "Volume m3"];

// setTimeout fallback: rAF never fires in a hidden tab, and the assistant can
// run a sweep while the user is on another tab.
const frame = (): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, 50);
    requestAnimationFrame(() => {
      clearTimeout(timer);
      resolve();
    });
  });

/** Every element of these classes that the viewer has a bounding box for. */
function boxesFor(viewer: Viewer, types: Set<string>): Box[] {
  const out: Box[] = [];
  for (const element of modelElements(viewer)) {
    if (!types.has(element.type)) continue;
    const bounds = viewer.getElementBounds(element.id);
    if (!bounds) continue;
    out.push({
      id: element.id,
      type: element.type,
      name: element.name,
      min: [bounds.min.x, bounds.min.y, bounds.min.z],
      max: [bounds.max.x, bounds.max.y, bounds.max.z],
    });
  }
  return out;
}

/**
 * The sweep itself, with no UI in it, so the panel and the assistant run the
 * same algorithm and can never disagree about a model. Yields between slices
 * so a long sweep does not freeze the tab.
 */
async function sweepBoxes(
  a: Box[],
  b: Box[],
  toleranceMm: number,
  onProgress?: (done: number, total: number, hits: number) => void,
): Promise<SweepResult> {
  const tol = toleranceMm / 1000;
  const hits: Hit[] = [];
  let tested = 0;
  let truncated = false;

  const cell = cellSize(b);
  const buckets = new Map<number, Box[]>();
  const oversized: Box[] = [];
  for (const box of b) {
    const span = cellsOf(box, cell);
    if (span.length > MAX_SPAN) oversized.push(box);
    else for (const key of span) push(buckets, key, box);
  }

  const seen = new Set<string>();
  const candidates = new Set<Box>();
  for (let start = 0; start < a.length; start += SLICE) {
    for (const box of a.slice(start, start + SLICE)) {
      candidates.clear();
      const span = cellsOf(box, cell);
      // An element too big to bucket has to see everything, or it would be
      // compared against a handful of arbitrary cells.
      if (span.length > MAX_SPAN) for (const other of b) candidates.add(other);
      else for (const key of span) for (const other of buckets.get(key) ?? []) candidates.add(other);
      for (const other of oversized) candidates.add(other);
      for (const other of candidates) {
        if (other.id === box.id) continue;
        tested += 1;
        const hit = overlap(box, other, tol);
        if (!hit) continue;
        const pair = box.id < other.id ? `${box.id}:${other.id}` : `${other.id}:${box.id}`;
        if (seen.has(pair)) continue;
        seen.add(pair);
        hits.push(hit);
        if (hits.length >= RESULT_LIMIT) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    onProgress?.(Math.min(start + SLICE, a.length), a.length, hits.length);
    await frame();
    if (truncated) break;
  }

  hits.sort((x, y) => y.volume - x.volume);
  return { hits, tested, truncated };
}

/** The sweep flattened to what an LLM can read in one report. */
export async function clashReport(
  viewer: Viewer,
  aTypes: string[],
  bTypes: string[],
  toleranceMm: number,
): Promise<Record<string, unknown>> {
  const a = aTypes.length ? aTypes : STRUCTURE;
  const b = bTypes.length ? bTypes : MEP;
  const boxesA = boxesFor(viewer, new Set(a));
  const boxesB = boxesFor(viewer, new Set(b));
  // Naming the empty side matters: "0 clashes" against an empty set reads as
  // a clean model when it actually means the classes were not in the file.
  if (boxesA.length === 0 || boxesB.length === 0) {
    const empty = boxesA.length === 0 ? `A (${a.join(", ")})` : `B (${b.join(", ")})`;
    throw new Error(`No elements with geometry in set ${empty}. Run a counts action to see which classes this model has.`);
  }
  const { hits, tested, truncated } = await sweepBoxes(boxesA, boxesB, toleranceMm);
  const worst = hits.slice(0, 20);
  return {
    setA: a,
    setB: b,
    toleranceMm,
    elementsA: boxesA.length,
    elementsB: boxesB.length,
    pairTests: tested,
    clashes: hits.length,
    shown: worst.length,
    truncated: truncated || worst.length < hits.length,
    method: "axis-aligned bounding boxes, so this screens for coordination problems rather than proving them",
    worst: worst.map((hit) => ({
      a: { id: hit.a.id, type: hit.a.type, name: hit.a.name },
      b: { id: hit.b.id, type: hit.b.type, name: hit.b.name },
      depthMm: Math.round(hit.depth * 1000),
      volumeM3: Number(hit.volume.toFixed(4)),
    })),
  };
}

export function mount(host: HTMLElement, api: PluginApi): PluginInstance {
  const setA = new Set<string>();
  const setB = new Set<string>();
  let tolerance = api.read("tolerance", 10);
  let hits: Hit[] = [];
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
    const elements = modelElements(api.viewer);
    root.replaceChildren();
    if (elements.length === 0) {
      root.appendChild(emptyState("cube", "No model loaded", "Open an IFC file and the class lists fill in."));
      return;
    }
    const counts = classCounts(elements.filter((el) => api.viewer.getElementBounds(el.id) !== null));
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
        api.write("tolerance", tolerance);
      }, 1)),
      run,
      button("Isolate hits", () => isolateHits()),
      button("Show all", () => api.viewer.showAll()),
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
      api.log("Pick at least one class in each set", "error");
      return;
    }
    running = true;
    const generation = models;
    const a = boxesFor(api.viewer, setA);
    const b = boxesFor(api.viewer, setB);
    status.set(0, a.length, `Indexing ${b.length.toLocaleString()} elements`);
    await frame();
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
    api.log(`Clash sweep: ${hits.length.toLocaleString()} hit(s) across ${tested.toLocaleString()} pair tests`, hits.length ? "info" : "success");
    paint();
  };

  const paint = (): void => {
    summary.replaceChildren(
      stats([
        ["clashes", hits.length.toLocaleString(), hits.length ? "err" : "ok"],
        ["pair tests", tested.toLocaleString()],
        ["deepest", hits[0] ? `${(deepest(hits) * 1000).toFixed(0)} mm` : "0"],
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
        api.viewer.isolate([hit.a.id, hit.b.id]);
        api.viewer.select(hit.a.id);
        api.viewer.fitToElement(hit.a.id);
      },
    }));
    results.append(grid(["Element A", "Element B", "Depth mm", "Volume m³"], rows));
    if (hits.length > rows.length) {
      results.appendChild(note(`Showing the worst ${rows.length} of ${hits.length.toLocaleString()}. The CSV holds all of them.`));
    }
    if (truncated) results.appendChild(note(`Stopped at ${RESULT_LIMIT.toLocaleString()} hits. Narrow the sets or raise the tolerance.`));
  };

  /** Everything caught by the sweep, so the whole problem is on screen at once. */
  const isolateHits = (): void => {
    if (hits.length === 0) return void api.log("Run a sweep first", "error");
    const ids = new Set<number>();
    for (const hit of hits) {
      ids.add(hit.a.id);
      ids.add(hit.b.id);
    }
    api.viewer.isolate([...ids]);
    api.log(`Isolated ${ids.size.toLocaleString()} clashing element(s)`);
  };

  const reportRows = (): Array<Array<string | number>> =>
    hits.map((hit) => [hit.a.id, hit.a.type, hit.a.name, hit.b.id, hit.b.type, hit.b.name, Math.round(hit.depth * 1000), Number(hit.volume.toFixed(5))]);

  const exportCsv = (): void => {
    if (hits.length === 0) return void api.log("Run a sweep first", "error");
    saveCsv(`clashes-${api.modelName() || "model"}.csv`, REPORT, reportRows());
  };

  build();
  host.appendChild(root);

  return {
    modelChanged: () => {
      models += 1;
      hits = [];
      tested = 0;
      truncated = false;
      build();
    },
  };
}

function deepest(hits: Hit[]): number {
  let max = 0;
  for (const hit of hits) if (hit.depth > max) max = hit.depth;
  return max;
}

function overlap(a: Box, b: Box, tolerance: number): Hit | null {
  const dx = Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]);
  if (dx <= tolerance) return null;
  const dy = Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]);
  if (dy <= tolerance) return null;
  const dz = Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]);
  if (dz <= tolerance) return null;
  return { a, b, depth: Math.min(dx, dy, dz), volume: dx * dy * dz };
}

/** Grid pitch from the median box, so cells hold a handful of elements each. */
function cellSize(boxes: Box[]): number {
  if (boxes.length === 0) return 1;
  const sizes = boxes.map((box) => Math.max(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]));
  sizes.sort((a, b) => a - b);
  return Math.max(0.25, sizes[Math.floor(sizes.length / 2)] * 2);
}

function cellsOf(box: Box, cell: number): number[] {
  const lo = box.min.map((value) => Math.floor(value / cell));
  const hi = box.max.map((value) => Math.floor(value / cell));
  const keys: number[] = [];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        keys.push(hash(x, y, z));
        if (keys.length > MAX_SPAN) return keys;
      }
    }
  }
  return keys;
}

/** Cheap 3D cell hash; collisions only cost an extra narrow-phase test. */
function hash(x: number, y: number, z: number): number {
  return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0) >>> 0;
}

function push(map: Map<number, Box[]>, key: number, box: Box): void {
  const list = map.get(key);
  if (list) list.push(box);
  else map.set(key, [box]);
}
