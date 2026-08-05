// Tier-1 assistant tools: small JSON actions executed against the viewer,
// plus the model brief injected into the system prompt. Everything answers
// from data the viewer already holds; no Python runtime is involved.
import type { SpatialNode, Viewer } from "../viewer-core/viewer.js";

export interface IndexedElement {
  id: number;
  type: string;
  name: string;
  storey: string;
}

const SPATIAL_TYPES = new Set(["IfcProject", "IfcSite", "IfcBuilding", "IfcBuildingStorey"]);

let cached: { tree: SpatialNode; elements: IndexedElement[]; groups?: Map<string, number[]> } | null = null;

function indexElements(tree: SpatialNode): IndexedElement[] {
  if (cached?.tree === tree) return cached.elements;
  const elements: IndexedElement[] = [];
  const visit = (node: SpatialNode, storey: string): void => {
    if (node.type === "IfcBuildingStorey") storey = node.name ?? "(unnamed storey)";
    else if (!SPATIAL_TYPES.has(node.type)) {
      elements.push({ id: node.expressID, type: node.type, name: node.name ?? "", storey });
    }
    for (const child of node.children) visit(child, storey);
  };
  visit(tree, "");
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
    `Loaded model: ${fileName}${schema ? ` (${schema})` : ""}`,
    `Entities: ${stats.totalEntities}, placed elements: ${elements.length}, triangles: ${stats.triangleCount}`,
    `Storeys: ${[...byStorey.entries()].map(([n, c]) => `${n} (${c})`).join(", ") || "(none)"}`,
    `Element types: ${top.map(([t, c]) => `${t} x${c}`).join(", ")}`,
  ].join("\n");
}

const lower = (v: unknown): string => (typeof v === "string" ? v.trim().toLowerCase() : "");

/** Work a viewer action delegates to, because it lives outside this module. */
export interface SemanticActions {
  check(): Promise<unknown>;
  schedule(type: string, properties: string[]): Promise<unknown>;
  /** Validate against whatever IDS the user has loaded. */
  ids(): Promise<unknown>;
  /** Bounding-box sweep between two class sets; empty sets mean the preset. */
  clash(a: string[], b: string[], tolerance: number): Promise<unknown>;
}

/** Rows a report may carry into the context before it starts crowding it out. */
const REPORT_LIMIT = 40;

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.map(String).filter(Boolean) : [];

/** Execute one JSON viewer action and return a report string for the LLM. */
export async function runViewerAction(
  viewer: Viewer,
  raw: string,
  semantic?: SemanticActions,
): Promise<string> {
  let action: Record<string, unknown>;
  try {
    action = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("viewer action must be a single valid JSON object");
  }
  const kind = String(action.action ?? "");
  const id = Number(action.id);
  const ids = Array.isArray(action.ids)
    ? action.ids.map(Number).filter(Number.isFinite)
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
    case "counts":
      return JSON.stringify(await viewer.getCountsByType());
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
    case "select":
      if (!Number.isFinite(id)) throw new Error("select needs an id");
      viewer.select(id);
      viewer.fitToElement(id);
      return `selected and framed ${id}`;
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
      return JSON.stringify(
        await semantic.clash(
          stringList(action.a),
          stringList(action.b),
          Number.isFinite(tolerance) && tolerance >= 0 ? tolerance : 10,
        ),
      );
    }
    default:
      throw new Error(`unknown action "${kind}"`);
  }
}
