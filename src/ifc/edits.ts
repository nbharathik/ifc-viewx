// Typed edits. The assistant and the UI pick an operation from this list
// instead of writing code, so nothing arbitrary ever executes: every op is a
// named function with a schema, applied to a copy, and the diff that comes
// back is measured here rather than reported by whatever made the change.
import { IfcModel, val } from "./model.js";

export type EditOp =
  | { op: "setAttribute"; ids: number[]; attribute: string; value: string | number | boolean | null }
  | { op: "setProperty"; ids: number[]; set: string; property: string; value: string | number | boolean | null }
  | { op: "renameByPattern"; ids: number[]; find: string; replace: string }
  | { op: "deleteElements"; ids: number[] };

/** Attributes safe to write directly: plain IfcLabel/IfcText/IfcIdentifier. */
const TEXT_ATTRIBUTES = new Set(["Name", "Description", "ObjectType", "Tag", "LongName"]);

export interface EditDiff {
  added: number;
  removed: number;
  modified: number;
  addedSample?: Array<{ globalId: string; type?: string; name?: string }>;
  modifiedSample?: Array<{ globalId: string; type?: string; name?: string }>;
}

export interface EditOutcome {
  summary: string;
  affectedGuids: string[];
  entityCountBefore: number;
  entityCountAfter: number;
  diff: EditDiff;
  /** Per-element failures, named, so a partial batch is still reportable. */
  failures: string[];
}

/** Cheap per-entity fingerprint: type plus every scalar attribute. */
function signature(model: IfcModel, expressID: number): string {
  const line = model.line(expressID);
  if (!line) return "";
  const parts: string[] = [model.typeName(expressID)];
  for (const [key, raw] of Object.entries(line)) {
    if (key === "expressID" || key === "type") continue;
    if (Array.isArray(raw)) continue;
    const value = val(raw);
    if (value !== null && typeof value !== "object") parts.push(`${key}=${String(value)}`);
  }
  return parts.join("|");
}

function signatures(model: IfcModel): Map<string, string> {
  const out = new Map<string, string>();
  for (const [guid, id] of model.guidIndex()) out.set(guid, signature(model, id));
  return out;
}

function describe(model: IfcModel, guid: string): { globalId: string; type?: string; name?: string } {
  const id = model.guidIndex().get(guid);
  if (id === undefined) return { globalId: guid };
  const line = model.line(id);
  return {
    globalId: guid,
    type: model.typeName(id),
    name: String(val(line?.Name) ?? "") || undefined,
  };
}

function measure(model: IfcModel, before: Map<string, string>): EditDiff {
  model.reindex();
  const after = signatures(model);
  const added: string[] = [];
  const modified: string[] = [];
  let removed = 0;
  for (const [guid, sig] of after) {
    const previous = before.get(guid);
    if (previous === undefined) added.push(guid);
    else if (previous !== sig) modified.push(guid);
  }
  for (const guid of before.keys()) if (!after.has(guid)) removed += 1;
  return {
    added: added.length,
    removed,
    modified: modified.length,
    addedSample: added.slice(0, 10).map((g) => describe(model, g)),
    modifiedSample: modified.slice(0, 10).map((g) => describe(model, g)),
  };
}

/** Human sentence for the pending bar, in the same voice the service used. */
function summarise(op: EditOp, touched: number): string {
  const n = `${touched} element${touched === 1 ? "" : "s"}`;
  switch (op.op) {
    case "setAttribute":
      return `set ${op.attribute} on ${n}`;
    case "setProperty":
      return `set ${op.set}.${op.property} on ${n}`;
    case "renameByPattern":
      return `renamed ${n}`;
    case "deleteElements":
      return `deleted ${n}`;
  }
}

/** Relationships that list many elements: the deleted one leaves the list. */
const REL_LISTS: Array<[string, string]> = [
  ["IfcRelContainedInSpatialStructure", "RelatedElements"],
  ["IfcRelAggregates", "RelatedObjects"],
  ["IfcRelDefinesByProperties", "RelatedObjects"],
  ["IfcRelDefinesByType", "RelatedObjects"],
  ["IfcRelAssociatesMaterial", "RelatedObjects"],
  ["IfcRelAssociatesClassification", "RelatedObjects"],
  ["IfcRelAssignsToGroup", "RelatedObjects"],
];

/** Relationships that exist for one pair only: they go with the element. */
const REL_PAIRS: Array<[string, string[]]> = [
  ["IfcRelVoidsElement", ["RelatingBuildingElement", "RelatedOpeningElement"]],
  ["IfcRelFillsElement", ["RelatingOpeningElement", "RelatedBuildingElement"]],
  ["IfcRelSpaceBoundary", ["RelatingSpace", "RelatedBuildingElement"]],
];

/**
 * Take the elements out of every relationship that names them, before the
 * lines themselves go. DeleteLine on its own leaves those relationships
 * pointing at an express id that is not in the file any more, which is a
 * broken model that most readers refuse.
 */
function detachElements(model: IfcModel, ids: Set<number>): void {
  for (const [relType, field] of REL_LISTS) {
    for (const rid of model.byType(relType, false)) {
      const rel = model.line(rid);
      const list = rel?.[field];
      if (!rel || !Array.isArray(list)) continue;
      const handles = list as Array<{ value?: number }>;
      const kept = handles.filter((handle) => handle.value === undefined || !ids.has(handle.value));
      if (kept.length === handles.length) continue;
      if (kept.length === 0) {
        model.api.DeleteLine(model.id, rid);
        continue;
      }
      rel[field] = kept as never;
      model.write(rel);
    }
  }
  for (const [relType, fields] of REL_PAIRS) {
    for (const rid of model.byType(relType, false)) {
      const rel = model.line(rid);
      if (!rel) continue;
      const touched = fields.some((field) => {
        const value = (rel[field] as { value?: number } | null)?.value;
        return value !== undefined && ids.has(value);
      });
      if (touched) model.api.DeleteLine(model.id, rid);
    }
  }
}

export function applyEdit(model: IfcModel, op: EditOp): EditOutcome {
  const before = signatures(model);
  const entityCountBefore = before.size;
  const affected: string[] = [];

  if (op.op === "deleteElements") detachElements(model, new Set(op.ids));

  if (op.op === "setAttribute" && !TEXT_ATTRIBUTES.has(op.attribute)) {
    throw new Error(
      `${op.attribute} is not a text attribute. Allowed: ${[...TEXT_ATTRIBUTES].join(", ")}.`,
    );
  }

  const failures: string[] = [];
  for (const id of op.ids) {
    const line = model.line(id);
    if (!line) continue;
    const guid = model.guidOf(id);
    try {
      applyToOne(model, op, id, line, guid, affected);
    } catch (err) {
      // One malformed entity must not lose the rest of the batch, and the
      // report has to name it: web-ifc's own errors say nothing about which.
      failures.push(`#${id} (${model.typeName(id)}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const diff = measure(model, before);
  const summary = summarise(op, affected.length);
  return {
    summary: failures.length ? `${summary}; ${failures.length} failed` : summary,
    affectedGuids: affected,
    entityCountBefore,
    entityCountAfter: model.guidIndex().size,
    diff,
    failures,
  };
}

function applyToOne(
  model: IfcModel,
  op: EditOp,
  id: number,
  line: Record<string, unknown>,
  guid: string | null,
  affected: string[],
): void {
  if (op.op === "deleteElements") {
    model.api.DeleteLine(model.id, id);
    if (guid) affected.push(guid);
    return;
  }

  if (op.op === "setAttribute") {
    if (!model.writeAttribute(id, op.attribute, op.value)) {
      throw new Error(`${op.attribute} is not an attribute of this entity`);
    }
    if (guid) affected.push(guid);
    return;
  }

  if (op.op === "renameByPattern") {
    // An empty separator splices the replacement between every character.
    if (!op.find) throw new Error("renameByPattern needs a non-empty find");
    const current = String(val(line.Name) ?? "");
    const next = current.split(op.find).join(op.replace);
    if (next === current) return;
    if (!model.writeAttribute(id, "Name", next)) throw new Error("this entity has no Name");
    if (guid) affected.push(guid);
    return;
  }

  // setProperty only writes into a property that already exists: creating a
  // set means creating entities and an ownership history, a separate step.
  if (!writeExistingProperty(model, id, op.set, op.property, op.value)) {
    throw new Error(`has no ${op.set}.${op.property}; setProperty only writes existing properties`);
  }
  if (guid) affected.push(guid);
}

/**
 * An IFC value holder carries its own type (IfcBoolean, IfcInteger, ...), and
 * dropping a string into one silently produces a file no reader agrees with.
 * A holder is only rewritten when the new value has the shape it already held.
 */
function fitsHolder(previous: unknown, value: string | number | boolean | null): boolean {
  if (previous === null || previous === undefined) return true;
  if (typeof previous === typeof value) return true;
  // web-ifc reports IFC booleans as the STEP tokens ".T." and ".F.".
  return typeof value === "boolean" && typeof previous === "string" && /^\.[TFU]\.$/.test(previous);
}

function writeExistingProperty(
  model: IfcModel,
  expressID: number,
  setName: string,
  property: string,
  value: string | number | boolean | null,
): boolean {
  // The model already indexes property sets by owner; rescanning every
  // IfcRelDefinesByProperties per element made setProperty quadratic.
  for (const setID of model.setsOf(expressID)) {
    const set = model.line(setID);
    if (!set || String(val(set.Name) ?? "") !== setName) continue;
    for (const handle of (set.HasProperties as Array<{ value?: number }> | undefined) ?? []) {
      if (handle.value === undefined) continue;
      const line = model.line(handle.value);
      if (!line || String(val(line.Name) ?? "") !== property) continue;
      const holder = line.NominalValue as { value?: unknown } | null | undefined;
      if (holder && typeof holder === "object") {
        if (!fitsHolder(holder.value, value)) {
          throw new Error(
            `${setName}.${property} holds a ${typeof holder.value}, not a ${typeof value}`,
          );
        }
        holder.value = value;
      } else {
        line.NominalValue = { type: 1, value } as never;
      }
      model.write(line);
      return true;
    }
  }
  return false;
}
