// The extension context, seen as a RuleModel.
//
// Rules read this and nothing else, so the same twelve run against fixtures
// in a test, against the real BVH in a tab, and against whatever a sandboxed
// extension is given. Everything expensive is memoized for the length of one
// run: three geometric rules ask for the same bounds and the same storey
// bands, and the worker round trip is the cost that matters.
import type { ElementRow } from "../sdk/data.js";
import type { ExtensionContext } from "../sdk/types.js";
import { matchText, readRowProperty, type Selector } from "../views/definition.js";
import type { Box, ClashHit, RuleModel, StoreyInfo } from "./engine.js";

export function contextRuleModel(ctx: ExtensionContext, rows: ElementRow[]): RuleModel {
  const boxes = new Map<number, Box | null>();
  let storeyCache: Promise<StoreyInfo[]> | null = null;
  let modelBoxCache: Box | null | undefined;

  const bounds = (id: number): Box | null => {
    const cached = boxes.get(id);
    if (cached !== undefined) return cached;
    const found = ctx.model.bounds(id);
    const box: Box | null = found
      ? { min: [found.min.x, found.min.y, found.min.z], max: [found.max.x, found.max.y, found.max.z] }
      : null;
    boxes.set(id, box);
    return box;
  };

  return {
    elements: () => rows,
    select: (scope) => select(scope, rows, ctx),
    bounds,
    modelBox: () => {
      if (modelBoxCache === undefined) {
        const box = ctx.view.modelBox();
        modelBoxCache = box ? { min: [...box.min] as [number, number, number], max: [...box.max] as [number, number, number] } : null;
      }
      return modelBoxCache;
    },
    storeys: () => {
      storeyCache ??= Promise.resolve(storeyBands(rows, bounds));
      return storeyCache;
    },
    clash: async (a, b, toleranceMm, signal): Promise<ClashHit[]> => {
      if (a.length === 0 || b.length === 0) return [];
      const result = await ctx.geometry.clash(a, b, { toleranceMm, signal });
      return result.hits.map((hit) => ({ a: hit.a, b: hit.b, distance: hit.distance, point: hit.point }));
    },
    volumes: async (ids, signal) => {
      const out = new Map<number, { volume: number; closed: boolean }>();
      const withGeometry = ids.filter((id) => bounds(id) !== null);
      if (withGeometry.length === 0) return out;
      const result = await ctx.geometry.volumes(withGeometry, { signal });
      for (const entry of result.volumes) out.set(entry.id, { volume: entry.volume, closed: entry.closed });
      return out;
    },
    signatures: async (ids, signal) => {
      const out = new Map<number, { hash: string; translation: [number, number, number] }>();
      const withGeometry = ids.filter((id) => bounds(id) !== null);
      if (withGeometry.length === 0) return out;
      const result = await ctx.geometry.signatures(withGeometry, { signal });
      for (const signature of result.signatures) {
        out.set(signature.id, { hash: signature.shapeHash, translation: signature.translation });
      }
      return out;
    },
  };
}

/** The same selector language saved views use, answered from index rows. */
export function select(scope: Selector, rows: ElementRow[], ctx: ExtensionContext): number[] {
  if (scope.kind === "all") return rows.map((row) => row.id);
  if (scope.kind === "ids") {
    const present = new Set(rows.map((row) => row.id));
    return scope.ids.filter((id) => present.has(id));
  }
  if (scope.kind === "any") {
    const out = new Set<number>();
    for (const inner of scope.of) {
      for (const id of select(inner, rows, ctx)) out.add(id);
    }
    return [...out];
  }
  if (scope.kind === "every") {
    if (scope.of.length === 0) return [];
    let kept: number[] | null = null;
    for (const inner of scope.of) {
      const ids = new Set(select(inner, rows, ctx));
      kept = kept === null ? [...ids] : kept.filter((id) => ids.has(id));
    }
    return kept ?? [];
  }
  if (scope.kind === "not") {
    const excluded = new Set(select(scope.of, rows, ctx));
    return rows.map((row) => row.id).filter((id) => !excluded.has(id));
  }
  if (scope.kind === "class") {
    const wanted = new Set(scope.values.map((value) => value.toLowerCase().replace(/^ifc/, "")));
    return rows.filter((row) => wanted.has(row.type.toLowerCase().replace(/^ifc/, ""))).map((row) => row.id);
  }
  if (scope.kind === "storey") {
    const wanted = new Set(scope.values.map((value) => value.toLowerCase()));
    return rows.filter((row) => wanted.has(row.storey.toLowerCase())).map((row) => row.id);
  }
  if (scope.kind === "model") {
    const wanted = new Set(scope.values.map((value) => value.toLowerCase()));
    const names = new Map(ctx.view.models().map((model) => [model.index, (model.name || `Model ${model.index + 1}`).toLowerCase()]));
    return rows.filter((row) => {
      const name = names.get(ctx.model.modelOf(row.id));
      return name !== undefined && wanted.has(name);
    }).map((row) => row.id);
  }
  if (scope.kind === "name") {
    return rows.filter((row) => matchText([row.name], scope.op, scope.value)).map((row) => row.id);
  }
  return rows
    .filter((row) => matchText(readRowProperty(row, scope.set, scope.name), scope.op, scope.value))
    .map((row) => row.id);
}

/**
 * Storey levels taken from the elements filed under each storey rather than
 * from IfcBuildingStorey.Elevation.
 *
 * Elevation is an IFC Z in the project's own length unit, while bounds are
 * scene-space and Y-up: crossing both seams needs a unit the entity does not
 * carry. The median floor height of a storey's own elements is in the right
 * frame by construction, and a median survives the very elements the rule is
 * looking for.
 */
export function storeyBands(rows: ElementRow[], bounds: (id: number) => Box | null): StoreyInfo[] {
  const floors = new Map<string, number[]>();
  for (const row of rows) {
    const name = row.storey.trim();
    if (!name) continue;
    const box = bounds(row.id);
    if (!box) continue;
    const bucket = floors.get(name);
    if (bucket) bucket.push(box.min[1]);
    else floors.set(name, [box.min[1]]);
  }
  const out: StoreyInfo[] = [];
  let id = 0;
  for (const [name, values] of floors) {
    values.sort((a, b) => a - b);
    out.push({ id: --id, name, elevation: values[Math.floor(values.length / 2)] });
  }
  return out.sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
}
