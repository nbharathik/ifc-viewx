// Tier-1 assistant tools: small JSON actions executed against the viewer,
// plus the model brief injected into the system prompt. Everything answers
// from data the viewer already holds; no Python runtime is involved.
import { elementsOf } from "../data/model.js";
import { buildIndex, type Bm25Index } from "./retrieval.js";
import type { CameraPose, SectionBox, SpatialNode, Viewer, ViewPreset } from "../viewer-core/viewer.js";
import type { ModelElement } from "../data/model.js";
import { measureDistance } from "../geometry/distance.js";
import { measureLaser } from "../geometry/laser.js";
import { extractSectionContours, type SectionAxis } from "../geometry/section.js";

export type IndexedElement = ModelElement;

let cached: {
  tree: SpatialNode;
  elements: IndexedElement[];
  groups?: Map<string, number[]>;
  search?: Bm25Index;
} | null = null;

/** Built on the first search and dropped with the tree it was built from. */
function searchIndex(viewer: Viewer): Bm25Index | null {
  const tree = viewer.getSpatialTree();
  if (!tree) return null;
  const elements = indexElements(tree);
  if (cached && cached.tree === tree && cached.search) return cached.search;
  const index = buildIndex(elements);
  if (cached && cached.tree === tree) cached.search = index;
  return index;
}

/** The walk itself is in the SDK; this is the copy the app reuses per tree. */
function indexElements(tree: SpatialNode): IndexedElement[] {
  if (cached?.tree === tree) return cached.elements;
  const elements = elementsOf(tree);
  cached = { tree, elements };
  return elements;
}

/**
 * Placed building elements per IFC class, taken from the spatial tree.
 * Deliberately not the raw entity histogram, which is dominated by
 * geometry primitives (IfcCartesianPoint, IfcPolyLoop) nobody asks about.
 * Cached with the tree: the type list and the palette both re-read it.
 */
export function elementsByType(viewer: Viewer): Map<string, number[]> {
  const tree = viewer.getSpatialTree();
  if (!tree) return new Map();
  const elements = indexElements(tree);
  if (cached && cached.tree === tree && cached.groups) return cached.groups;
  const groups = new Map<string, number[]>();
  for (const el of elements) {
    const ids = groups.get(el.type);
    if (ids) ids.push(el.id);
    else groups.set(el.type, [el.id]);
  }
  const sorted = new Map([...groups].sort((a, b) => b[1].length - a[1].length));
  if (cached && cached.tree === tree) cached.groups = sorted;
  return sorted;
}

/** Every placed element with its class, name and storey. Cached with the tree. */
export function modelElements(viewer: Viewer): IndexedElement[] {
  const tree = viewer.getSpatialTree();
  return tree ? indexElements(tree) : [];
}

export function elementCounts(viewer: Viewer): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [type, ids] of elementsByType(viewer)) counts[type] = ids.length;
  return counts;
}

/**
 * Names come out of the file, so they are quoted and stripped of the line
 * breaks that would let a crafted model write its own instructions into the
 * system prompt. The brief is data about the model, never a message from it.
 */
const quote = (text: string): string =>
  JSON.stringify(text.replace(/[\r\n]+/g, " ").slice(0, 120));

export function buildModelBrief(viewer: Viewer, fileName: string, schema: string | null): string | null {
  const stats = viewer.getStats();
  const tree = viewer.getSpatialTree();
  if (!stats || !tree) return null;
  const elements = indexElements(tree);
  const byType = new Map<string, number>();
  const byStorey = new Map<string, number>();
  for (const el of elements) {
    byType.set(el.type, (byType.get(el.type) ?? 0) + 1);
    if (el.storey) byStorey.set(el.storey, (byStorey.get(el.storey) ?? 0) + 1);
  }
  const top = [...byType.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);
  return [
    `Loaded model: ${quote(fileName)}${schema ? ` (${quote(schema)})` : ""}`,
    `Entities: ${stats.totalEntities}, placed elements: ${elements.length}, triangles: ${stats.triangleCount}`,
    `Storeys: ${[...byStorey.entries()].map(([n, c]) => `${quote(n)} (${c})`).join(", ") || "(none)"}`,
    `Element types: ${top.map(([t, c]) => `${quote(t)} x${c}`).join(", ")}`,
  ].join("\n");
}

const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Work a viewer action delegates to, because it lives outside this module. */
export interface SemanticActions {
  check(): Promise<unknown>;
  schedule(type: string, properties: string[]): Promise<unknown>;
  /** Validate against whatever IDS the user has loaded. */
  ids(): Promise<unknown>;
  /** Triangle-level sweep between two class sets; empty sets mean the preset. */
  clash(a: string[], b: string[], tolerance: number, clearance: number, signal?: AbortSignal): Promise<unknown>;
}

/** Rows a report may carry into the context before it starts crowding it out. */
const REPORT_LIMIT = 40;
/** The palette holds 255 usable slots; a legend past this is unreadable anyway. */
const COLOR_GROUP_LIMIT = 12;
const VIEWS = ["front", "back", "left", "right", "top", "bottom", "iso"];

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).filter(Boolean) : [];

const round3 = (value: number): number => Number(value.toFixed(3));

/** `#rrggbb` when the model gave one, otherwise a spread-out fallback hue. */
function parseColor(value: unknown, index: number): [number, number, number] {
  const text = typeof value === "string" ? value.trim() : "";
  const hex = /^#?([0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const n = parseInt(hex[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  // Golden angle, the same walk the colour-by legend uses.
  const hue = (index * 137.508) % 360;
  return hslBytes(hue, 0.62, 0.55);
}

function hslBytes(h: number, s: number, l: number): [number, number, number] {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] =
    h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

/** Pull the camera back far enough to hold a box, keeping its direction. */
function frameBox(viewer: Viewer, box: SectionBox): CameraPose {
  const pose = viewer.getCamera();
  const centre: [number, number, number] = [
    (box.min[0] + box.max[0]) / 2,
    (box.min[1] + box.max[1]) / 2,
    (box.min[2] + box.max[2]) / 2,
  ];
  const radius = Math.max(
    0.5,
    Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) / 2,
  );
  const dir = [
    pose.position[0] - pose.target[0],
    pose.position[1] - pose.target[1],
    pose.position[2] - pose.target[2],
  ];
  const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
  const distance = radius * 2.4;
  return {
    ...pose,
    target: centre,
    position: [
      centre[0] + (dir[0] / len) * distance,
      centre[1] + (dir[1] / len) * distance,
      centre[2] + (dir[2] / len) * distance,
    ],
  };
}

/** Execute one JSON viewer action and return a report string for the LLM. */
export async function runViewerAction(
  viewer: Viewer,
  raw: string,
  semantic?: SemanticActions,
  signal?: AbortSignal,
): Promise<string> {
  let action: Record<string, unknown>;
  try {
    action = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("viewer action must be a single valid JSON object");
  }
  const kind = String(action.action ?? "");
  const id = Number(action.id);
  // Number(null) is 0 and Number(true) is 1, so a malformed array would pass
  // the non-empty guard below and report touching elements that do not exist.
  const ids = Array.isArray(action.ids)
    ? action.ids.filter((value) => typeof value === "number" || typeof value === "string")
        .map(Number)
        .filter((value) => Number.isFinite(value) && value > 0)
    : [];
  const tree = viewer.getSpatialTree();

  switch (kind) {
    case "find": {
      if (!tree) throw new Error("no model loaded");
      const type = lower(action.type);
      const name = lower(action.name);
      const storey = lower(action.storey);
      const hits = indexElements(tree).filter(
        (el) =>
          (!type || el.type.toLowerCase().includes(type)) &&
          (!name || el.name.toLowerCase().includes(name)) &&
          (!storey || el.storey.toLowerCase().includes(storey)),
      );
      const shown = hits.slice(0, REPORT_LIMIT);
      return JSON.stringify({
        matches: hits.length,
        shown: shown.length,
        truncated: shown.length < hits.length,
        elements: shown,
      });
    }
    case "search": {
      const index = searchIndex(viewer);
      if (!index) throw new Error("no model loaded");
      const query = typeof action.query === "string" ? action.query : "";
      if (!query.trim()) throw new Error("search needs a query");
      const asked = Number(action.limit);
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, REPORT_LIMIT) : 20;
      const hits = index.search(query, limit);
      return JSON.stringify({ indexed: index.size, shown: hits.length, elements: hits });
    }
    case "counts":
      // Placed elements, which is what the tool description promises and what
      // every other count in the app means. The raw entity histogram counts
      // types, styles and relationships as well.
      return JSON.stringify(elementCounts(viewer));
    case "storeys": {
      if (!tree) throw new Error("no model loaded");
      const rows = new Map<string, Map<string, number>>();
      for (const el of indexElements(tree)) {
        const types = rows.get(el.storey) ?? new Map<string, number>();
        types.set(el.type, (types.get(el.type) ?? 0) + 1);
        rows.set(el.storey, types);
      }
      return JSON.stringify(
        [...rows.entries()].map(([storey, types]) => ({
          storey,
          elements: [...types.values()].reduce((a, b) => a + b, 0),
          topTypes: Object.fromEntries([...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)),
        })),
      );
    }
    case "properties": {
      if (!Number.isFinite(id)) throw new Error("properties needs an id");
      const props = await viewer.getProperties(id);
      if (!props) throw new Error(`no properties for expressID ${id}`);
      return JSON.stringify({
        id,
        type: props.type,
        attributes: Object.fromEntries(
          props.attributes.filter((a) => a.value !== null).map((a) => [a.name, a.value]),
        ),
        psets: props.psets.map((set) => ({
          name: set.name,
          kind: set.kind,
          values: Object.fromEntries(set.properties.map((p) => [p.name, p.value])),
        })),
      });
    }
    case "select": {
      const wanted = ids.length ? ids : Number.isFinite(id) && id > 0 ? [id] : [];
      if (wanted.length === 0) throw new Error("select needs an id or ids");
      if (wanted.length === 1) {
        viewer.select(wanted[0]);
        viewer.fitToElement(wanted[0]);
        return `selected and framed ${wanted[0]}`;
      }
      viewer.selectMany(wanted, "replace");
      const box = viewer.boxAround(wanted, 0.15);
      if (box) viewer.setCamera(frameBox(viewer, box));
      return `selected ${wanted.length} element(s)`;
    }
    case "selection": {
      const selected = viewer.getSelectedIds();
      const types = viewer.getElementTypes();
      const byId = new Map(modelElements(viewer).map((el) => [el.id, el]));
      return JSON.stringify({
        count: selected.length,
        elements: selected.slice(0, REPORT_LIMIT).map((sid) => ({
          id: sid,
          type: byId.get(sid)?.type ?? types.get(sid) ?? "",
          name: byId.get(sid)?.name ?? "",
          storey: byId.get(sid)?.storey ?? "",
        })),
        truncated: selected.length > REPORT_LIMIT,
      });
    }
    case "visibility": {
      const counts = viewer.getVisibilityCounts();
      const box = viewer.getSectionBox();
      return JSON.stringify({
        ...counts,
        hiddenByHand: viewer.getHiddenCount(),
        rules: viewer.getRules().map((rule) => ({ label: rule.label, mode: rule.mode, elements: rule.ids.length })),
        sections: viewer.getSections().map((section) =>
          section.axis
            ? { axis: section.axis, offset: Number(section.offset.toFixed(3)) }
            : { name: section.name, normal: section.normal.map(round3), offset: Number(section.offset.toFixed(3)) },
        ),
        sectionBox: box ? { min: box.min.map(round3), max: box.max.map(round3) } : null,
        spacesLoaded: viewer.isCategoryVisible("IfcSpace"),
        openingsLoaded: viewer.isCategoryVisible("IfcOpeningElement"),
      });
    }
    case "unhide":
      if (ids.length === 0) throw new Error("unhide needs ids");
      viewer.setHidden(ids, false);
      return `unhid ${ids.length} element(s)`;
    case "categories": {
      const changed: string[] = [];
      for (const category of ["IfcSpace", "IfcOpeningElement"] as const) {
        const want = action[category];
        if (typeof want !== "boolean") continue;
        await viewer.setCategoryVisible(category, want);
        changed.push(`${category}=${want}`);
      }
      if (changed.length === 0) throw new Error("categories needs IfcSpace and/or IfcOpeningElement as booleans");
      return changed.join(", ");
    }
    case "color": {
      const groups = Array.isArray(action.groups) ? action.groups : [];
      if (groups.length === 0) {
        viewer.clearColorOverride();
        return "colouring removed";
      }
      const assignment = new Map<number, number>();
      const colors: Array<[number, number, number]> = [];
      const labels: string[] = [];
      for (const raw of groups.slice(0, COLOR_GROUP_LIMIT)) {
        const group = raw as { ids?: unknown; color?: unknown; label?: unknown };
        const members = Array.isArray(group.ids) ? group.ids.map(Number).filter((v) => Number.isFinite(v) && v > 0) : [];
        if (members.length === 0) continue;
        // Palette index 0 means "no override", so groups are numbered from 1.
        const index = colors.length + 1;
        colors.push(parseColor(group.color, index));
        labels.push(String(group.label ?? `group ${index}`));
        for (const member of members) assignment.set(member, index);
      }
      if (assignment.size === 0) throw new Error("color needs at least one group with ids");
      viewer.setColorOverride(assignment, colors);
      return `coloured ${assignment.size} element(s) in ${colors.length} group(s): ${labels.join(", ")}`;
    }
    case "section": {
      if (action.clear === true) {
        viewer.clearSection();
        return "sections cleared";
      }
      if (action.fromPick === true) {
        if (viewer.getSections().length >= 8) throw new Error("plane limit reached: remove a section first");
        const added = viewer.addSectionFromPick();
        if (!added) throw new Error("no picked surface: ask the user to click a face first");
        return `cut on the picked face (${added.name})`;
      }
      if (Array.isArray(action.normal)) {
        const raw = action.normal.map(Number);
        const len = raw.length === 3 ? Math.hypot(raw[0], raw[1], raw[2]) : 0;
        if (!Number.isFinite(len) || len < 1e-9) throw new Error("section normal must be a non-zero 3-vector");
        const offset = Number(action.offset);
        if (!Number.isFinite(offset)) throw new Error("an arbitrary section needs a numeric offset");
        viewer.setSections([
          ...viewer.getSections(),
          {
            id: "",
            name: "Assistant plane",
            normal: [raw[0] / len, raw[1] / len, raw[2] / len],
            offset,
            flip: action.flip === true,
          },
        ]);
        return "cut on an arbitrary plane";
      }
      const axis = lower(action.axis);
      if (axis !== "x" && axis !== "y" && axis !== "z") throw new Error('section needs axis "x", "y" or "z"');
      const index = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const bounds = viewer.getModelBox();
      const offset = Number(action.offset);
      viewer.setSections([
        ...viewer.getSections().filter((section) => section.axis !== axis),
        {
          axis,
          offset: Number.isFinite(offset) ? offset : (bounds.min[index] + bounds.max[index]) / 2,
          flip: action.flip === true,
        },
      ]);
      return `cut on ${axis}`;
    }
    case "sectionContours": {
      const requestedAxis = lower(action.axis);
      // The contour engine is axis-only; an arbitrary plane cannot seed it.
      const active = viewer.getSections().find((section) => section.axis !== undefined);
      const axis: SectionAxis = requestedAxis === "x" || requestedAxis === "y" || requestedAxis === "z"
        ? requestedAxis
        : active?.axis ?? "y";
      const axisAt = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const requestedOffset = Number(action.offset);
      const offset = Number.isFinite(requestedOffset)
        ? requestedOffset
        : active?.axis === axis
          ? active.offset
          : (viewer.getModelBox().min[axisAt] + viewer.getModelBox().max[axisAt]) / 2;
      const askedSegments = Number(action.maxSegments);
      const maxSegments = Number.isFinite(askedSegments)
        ? Math.min(100_000, Math.max(1_000, Math.floor(askedSegments)))
        : 50_000;
      viewer.setSections([{ axis, offset, flip: action.flip === true }]);
      const result = await extractSectionContours(viewer, axis, offset, {
        includeHidden: action.includeHidden === true,
        maxSegments,
        signal,
      });
      const byId = new Map(modelElements(viewer).map((element) => [element.id, element]));
      const groups = new Map<number, { type: string; paths: number; closed: number; open: number; length: number }>();
      for (const line of result.polylines) {
        const group = groups.get(line.elementId) ?? {
          type: line.elementType,
          paths: 0,
          closed: 0,
          open: 0,
          length: 0,
        };
        group.paths += 1;
        group.closed += line.closed ? 1 : 0;
        group.open += line.closed ? 0 : 1;
        group.length += line.length;
        groups.set(line.elementId, group);
      }
      const allRows = [...groups].map(([id, group]) => ({
        id,
        type: byId.get(id)?.type || group.type,
        name: byId.get(id)?.name || "",
        storey: byId.get(id)?.storey || "",
        paths: group.paths,
        closed: group.closed,
        open: group.open,
        lengthM: Number(group.length.toFixed(4)),
      }));
      const rowLimit = 5_000;
      return JSON.stringify({
        axis,
        offset: Number(offset.toFixed(4)),
        fidelity: result.fidelity,
        engine: result.engine,
        geometryRevision: result.geometryRevision,
        segmentCount: result.segmentCount,
        pathCount: result.polylines.length,
        closedCount: result.closedCount,
        openCount: result.openCount,
        intersectedElements: allRows.length,
        testedElements: result.testedElements,
        missingGeometry: result.missing,
        truncated: result.truncated,
        rowsTruncated: allRows.length > rowLimit,
        rows: allRows.slice(0, rowLimit),
      });
    }
    case "sectionBox": {
      if (action.clear === true) {
        viewer.setSectionBox(null);
        return "section box removed";
      }
      const target = ids.length ? ids : viewer.getSelectedIds();
      if (target.length === 0) throw new Error("sectionBox needs ids, or a selection to box");
      const box = viewer.boxAround(target);
      if (!box) throw new Error("none of those elements has geometry to box");
      viewer.setSectionBox(box);
      return `boxed around ${target.length} element(s)`;
    }
    case "models": {
      const toggle = (list: unknown, visible: boolean): number => {
        if (!Array.isArray(list)) return 0;
        let n = 0;
        for (const raw of list) {
          const index = Number(raw);
          if (!Number.isInteger(index) || index < 0) continue;
          viewer.setModelVisible(index, visible);
          n++;
        }
        return n;
      };
      toggle(action.show, true);
      toggle(action.hide, false);
      return JSON.stringify({
        models: viewer.getModels().map((model) => ({
          index: model.index,
          name: model.name,
          visible: model.visible,
          elements: model.elements,
        })),
      });
    }
    case "camera": {
      const view = lower(action.view);
      if (view) {
        if (!VIEWS.includes(view)) throw new Error(`view must be one of ${VIEWS.join(", ")}`);
        viewer.viewFrom(view as ViewPreset);
        return `looking from ${view}`;
      }
      const pose = viewer.getCamera();
      return JSON.stringify({ position: pose.position.map(round3), target: pose.target.map(round3) });
    }
    case "fit":
      if (Number.isFinite(id) && id > 0) viewer.fitToElement(id);
      else viewer.fitToModel();
      return "view framed";
    case "isolate":
      if (ids.length === 0) throw new Error("isolate needs ids; use find first");
      viewer.isolate(ids);
      return `isolated ${ids.length} element(s)`;
    case "hide":
      if (ids.length === 0) throw new Error("hide needs ids; use find first");
      viewer.setHidden(ids, true);
      return `hid ${ids.length} element(s)`;
    case "show":
      viewer.showAll();
      return "everything visible";
    case "check": {
      if (!semantic) throw new Error("model checks are unavailable");
      return JSON.stringify(await semantic.check());
    }
    case "schedule": {
      if (!semantic) throw new Error("schedules are unavailable");
      const type = typeof action.type === "string" && action.type ? action.type : "IfcElement";
      const properties = stringList(action.properties);
      const report = (await semantic.schedule(type, properties)) as {
        rows?: unknown[];
        availableProperties?: string[];
        truncated?: boolean;
      };
      // A whole table would swamp the context, so the rows are capped here as
      // well as in the engine. Both caps have to show up in the same flag, or
      // the model reads 40 rows and reports 40 as the total.
      const rows = report.rows ?? [];
      const capped = rows.slice(0, REPORT_LIMIT);
      return JSON.stringify({
        ...report,
        rows: capped,
        shown: capped.length,
        truncated: Boolean(report.truncated) || capped.length < rows.length,
        availableProperties: (report.availableProperties ?? []).slice(0, 60),
      });
    }
    case "ids": {
      if (!semantic) throw new Error("IDS validation is unavailable");
      return JSON.stringify(await semantic.ids());
    }
    case "clash": {
      if (!semantic) throw new Error("clash detection is unavailable");
      const tolerance = Number(action.tolerance);
      const clearance = Number(action.clearance);
      return JSON.stringify(
        await semantic.clash(
          stringList(action.a),
          stringList(action.b),
          Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 10,
          Number.isFinite(clearance) && clearance > 0 ? clearance : 0,
          signal,
        ),
      );
    }
    case "distance": {
      const a = Number(action.a);
      const b = Number(action.b);
      const maxDistance = Number(action.maxDistance);
      const result = await measureDistance(viewer, a, b, {
        maxDistance: Number.isFinite(maxDistance) && maxDistance >= 0 ? maxDistance : undefined,
        signal,
      });
      if (result.missing > 0) throw new Error("one or both elements have no retained mesh geometry");
      if (result.distance === null) {
        return JSON.stringify({
          ...result,
          note: "the elements are farther apart than maxDistance",
        });
      }
      let measurementId: number | null = null;
      if (result.pointA && result.pointB && result.point) {
        viewer.selectMany([a, b], "replace");
        if (result.distance > 0) {
          measurementId = viewer.addMeasurement(result.pointA, result.pointB).id;
        }
        viewer.fitToPoint(result.point, Math.max(0.5, result.distance * 1.5));
      }
      return JSON.stringify({
        ...result,
        measurementId,
        distanceMm: Number((result.distance * 1000).toFixed(2)),
        pointA: result.pointA?.map(round3),
        pointB: result.pointB?.map(round3),
        point: result.point?.map(round3),
      });
    }
    case "laser": {
      const lastPick = viewer.getLastPick();
      const supplied = Array.isArray(action.origin) ? action.origin.map(Number) : null;
      const origin = supplied?.length === 3 && supplied.every(Number.isFinite)
        ? supplied as [number, number, number]
        : lastPick?.point;
      if (!origin) throw new Error("click a model surface or provide an origin point first");
      const sourceValue = Number(action.source);
      const maxDistance = Number(action.maxDistance);
      const result = await measureLaser(viewer, origin, {
        source: Number.isFinite(sourceValue) && sourceValue > 0 ? sourceValue : lastPick?.expressID,
        includeHidden: action.includeHidden === true,
        maxDistance: Number.isFinite(maxDistance) && maxDistance > 0 ? maxDistance : 30,
        signal,
      });
      const measurementIds: number[] = [];
      const rows = result.axes.flatMap((axis) => [axis.negative, axis.positive]
        .filter((hit): hit is NonNullable<typeof hit> => hit !== null)
        .map((hit) => ({
          axis: hit.axis,
          direction: hit.direction,
          id: hit.elementId,
          type: hit.elementType,
          distanceMm: Number((hit.distance * 1000).toFixed(2)),
          point: hit.point.map(round3),
        })));
      for (const axis of result.axes) {
        const start = axis.negative?.point ?? result.origin;
        const end = axis.positive?.point ?? result.origin;
        if (start === result.origin && end === result.origin) continue;
        measurementIds.push(viewer.addMeasurement(start, end).id);
      }
      const ids = [...new Set(rows.map((row) => row.id))];
      if (result.source) ids.unshift(result.source);
      if (ids.length) viewer.selectMany(ids, "replace");
      const reach = Math.max(0.75, ...rows.map((row) => row.distanceMm / 1000));
      viewer.fitToPoint(result.origin, Math.min(reach, 20));
      return JSON.stringify({
        ...result,
        origin: result.origin.map(round3),
        sourceNormal: result.sourceNormal?.map(round3) ?? null,
        axes: result.axes.map((axis) => ({
          axis: axis.axis,
          negativeMm: axis.negative ? Number((axis.negative.distance * 1000).toFixed(2)) : null,
          positiveMm: axis.positive ? Number((axis.positive.distance * 1000).toFixed(2)) : null,
          spanMm: axis.span === null ? null : Number((axis.span * 1000).toFixed(2)),
        })),
        rows,
        measurementIds,
      });
    }
    default:
      throw new Error(`unknown action "${kind}"`);
  }
}
