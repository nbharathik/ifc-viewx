// Structural QA, ported from the local service so it runs in the tab. No
// generated code is involved: every check is a walk over the entity graph,
// which web-ifc already holds in memory.
import { IfcModel, val } from "./model.js";

export type Severity = "error" | "warning" | "info";

export interface Check {
  id: string;
  severity: Severity;
  title: string;
  count: number;
  hint?: string;
  sample?: Array<Record<string, unknown>>;
}

export interface ValidationReport {
  ok: boolean;
  schema: string;
  totals: { entities: number; rooted: number; elements: number };
  counts: Record<Severity, number>;
  checks: Check[];
}

const MAX_SAMPLE = 20;
const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function validate(model: IfcModel): ValidationReport {
  const checks: Check[] = [];
  const add = (
    id: string,
    severity: Severity,
    title: string,
    items: Array<Record<string, unknown>>,
    hint = "",
  ): void => {
    if (items.length === 0) return;
    checks.push({ id, severity, title, count: items.length, sample: items.slice(0, MAX_SAMPLE), hint });
  };

  const rooted = model.byType("IfcRoot");
  const seen = new Map<string, number>();
  const duplicates: Array<Record<string, unknown>> = [];
  const blank: Array<Record<string, unknown>> = [];
  for (const id of rooted) {
    const guid = model.guidOf(id);
    if (!guid) {
      blank.push({ expressID: id, type: model.typeName(id) });
      continue;
    }
    if (seen.has(guid)) duplicates.push({ expressID: id, type: model.typeName(id), globalId: guid });
    else seen.set(guid, id);
  }
  add("duplicate_guid", "error", "Duplicate GlobalId", duplicates,
    "Two entities share an identifier; downstream tools will treat them as one.");
  add("missing_guid", "error", "Missing GlobalId", blank,
    "Every IfcRoot subtype must carry a GlobalId.");

  const elements = model.byType("IfcElement");
  const unplaced: Array<Record<string, unknown>> = [];
  const unnamed: Array<Record<string, unknown>> = [];
  const noPlacement: Array<Record<string, unknown>> = [];
  const noGeometry: Array<Record<string, unknown>> = [];
  for (const id of elements) {
    const line = model.line(id);
    if (!line) continue;
    const type = model.typeName(id);
    const name = val(line.Name);
    if (model.containerOf(id) === null && model.aggregateOf(id) === null) {
      unplaced.push({ expressID: id, type, name });
    }
    if (!String(name ?? "").trim()) unnamed.push({ expressID: id, type });
    if (!line.ObjectPlacement) noPlacement.push({ expressID: id, type, name });
    if (!line.Representation) noGeometry.push({ expressID: id, type, name });
  }
  add("orphan_elements", "warning", "Elements outside the spatial structure", unplaced,
    "These are not in any storey or space, so they will not appear in schedules.");
  add("unnamed_elements", "info", "Elements without a name", unnamed,
    "Names drive most schedules and the model tree.");
  add("missing_placement", "warning", "Elements without a placement", noPlacement,
    "Without ObjectPlacement an element has no location in the model.");
  add("missing_representation", "info", "Elements without geometry", noGeometry,
    "Legitimate for logical elements; unexpected for walls, slabs and doors.");

  if (model.byType("IfcBuildingStorey").length === 0) {
    add("no_storeys", "warning", "No building storeys", [{ note: "IfcBuildingStorey not found" }],
      "Storeys are how the viewer and most tools group elements.");
  }

  const projects = model.byType("IfcProject");
  if (projects.length === 0) {
    add("no_project", "error", "No IfcProject", [{ note: "the file has no project root" }]);
  } else if (!model.line(projects[0])?.UnitsInContext) {
    add("no_units", "warning", "No unit assignment", [{ expressID: projects[0] }],
      "Lengths and areas cannot be interpreted without IfcUnitAssignment.");
  }

  const emptySets = model
    .byType("IfcPropertySet")
    .filter((id) => {
      const set = model.line(id);
      return !set || !Array.isArray(set.HasProperties) || set.HasProperties.length === 0;
    })
    .map((id) => ({ expressID: id, name: val(model.line(id)?.Name) }));
  add("empty_property_sets", "info", "Empty property sets", emptySets);

  checks.sort((a, b) => ORDER[a.severity] - ORDER[b.severity] || a.id.localeCompare(b.id));
  const counts: Record<Severity, number> = { error: 0, warning: 0, info: 0 };
  for (const check of checks) counts[check.severity] += 1;

  return {
    ok: counts.error === 0,
    schema: model.schema,
    totals: { entities: model.entityCount(), rooted: rooted.length, elements: elements.length },
    counts,
    checks,
  };
}
