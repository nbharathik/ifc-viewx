// Conformance checking, offline.
//
// buildingSMART's validation service is free and good, and it is online only:
// the file leaves the machine. That is exactly the opening. These are the
// same three families it reports against, written as propositions so a
// failure says which rule failed and on what.
//
// What runs here is the schema and implementer-agreement half, which needs
// only the entity model the app already parses. The normative Gherkin rules
// are named and reported as not-run rather than quietly skipped: a rule that
// silently does not run reads exactly like a rule that passed.
import { ref, val, type IfcModel } from "./model.js";
import { schemaRow } from "./schemas.js";

export type ConformanceFamily = "schema" | "agreements" | "propositions" | "gherkin";

export type ConformanceOutcome = "pass" | "fail" | "not_run" | "not_applicable";

export interface ConformanceCheck {
  id: string;
  family: ConformanceFamily;
  /** Written the way the normative rule reads, so it can be looked up. */
  title: string;
  outcome: ConformanceOutcome;
  /** How many entities failed, when it failed. */
  count: number;
  detail: string;
  sample: Array<{ expressID: number; type: string; note?: string }>;
}

export interface ConformanceReport {
  schema: string;
  passed: number;
  failed: number;
  notRun: number;
  checks: ConformanceCheck[];
  /** True when nothing in the report needed a service to answer it. */
  offline: true;
}

const SAMPLE = 20;

/** IFC GUIDs are 22 characters of a base-64 alphabet all of its own. */
const GUID_ALPHABET = /^[0-9A-Za-z_$]{22}$/;

const hasValue = (value: unknown): boolean => val(value) !== null;
const hasValues = (value: unknown): boolean => Array.isArray(value) && value.some(hasValue);

/** Rules that need a full normative engine, named so they are visibly not run. */
const GHERKIN_RULES: Array<[string, string]> = [
  ["ALS000", "Alignment layouts have a consistent horizontal, vertical and cant"],
  ["GEM000", "Geometric representations use the declared context"],
  ["GRF001", "Georeferencing is complete and consistent"],
  ["PSE001", "Standard property sets carry the properties the schema defines for them"],
  ["SPS001", "Spatial containment follows the schema's allowed nesting"],
  ["MAT001", "Material associations resolve to a defined material"],
];

export function checkConformance(model: IfcModel): ConformanceReport {
  const checks: ConformanceCheck[] = [];

  const add = (
    id: string,
    family: ConformanceFamily,
    title: string,
    failures: Array<{ expressID: number; type: string; note?: string }>,
    detail: string,
    applicable = true,
  ): void => {
    checks.push({
      id,
      family,
      title,
      outcome: !applicable ? "not_applicable" : failures.length === 0 ? "pass" : "fail",
      count: failures.length,
      detail,
      sample: failures.slice(0, SAMPLE),
    });
  };

  // -- schema ---------------------------------------------------------------

  const supportedSchema = schemaRow(model.schema) !== null;
  checks.push({
    id: "SCH001",
    family: "schema",
    title: "The file declares a schema this reader implements",
    outcome: supportedSchema ? "pass" : "fail",
    count: supportedSchema ? 0 : 1,
    detail: `The file declares ${model.schema}.`,
    sample: [],
  });

  const rooted = model.byType("IfcRoot");
  const missingGuid: Array<{ expressID: number; type: string }> = [];
  const badGuid: Array<{ expressID: number; type: string; note?: string }> = [];
  const seen = new Map<string, number>();
  const duplicates: Array<{ expressID: number; type: string; note?: string }> = [];
  for (const id of rooted) {
    const guid = model.guidOf(id);
    const type = model.typeName(id);
    if (!guid) {
      missingGuid.push({ expressID: id, type });
      continue;
    }
    if (!GUID_ALPHABET.test(guid)) badGuid.push({ expressID: id, type, note: guid });
    if (seen.has(guid)) duplicates.push({ expressID: id, type, note: guid });
    else seen.set(guid, id);
  }
  add("SCH002", "schema", "Every IfcRoot carries a GlobalId", missingGuid,
    "GlobalId is a required attribute on every rooted entity.");
  add("SCH003", "schema", "Every GlobalId is a well-formed IFC GUID", badGuid,
    "An IFC GUID is 22 characters from the 0-9 A-Z a-z _ $ alphabet.");
  add("SCH004", "schema", "No two entities share a GlobalId", duplicates,
    "Identity is what every downstream tool joins on.");

  const projects = model.byType("IfcProject");
  checks.push({
    id: "SCH005",
    family: "schema",
    title: "The file contains exactly one IfcProject",
    outcome: projects.length === 1 ? "pass" : "fail",
    count: projects.length === 1 ? 0 : Math.abs(projects.length - 1),
    detail: `Found ${projects.length}.`,
    sample: projects.slice(1).map((id) => ({ expressID: id, type: "IfcProject" })),
  });

  const project = projects[0] ? model.line(projects[0]) : null;
  add(
    "SCH006",
    "schema",
    "The project declares its units",
    project && !hasValue(project.UnitsInContext) ? [{ expressID: projects[0], type: "IfcProject" }] : [],
    "Without IfcUnitAssignment no length, area or volume in the file can be interpreted.",
    projects.length > 0,
  );
  add(
    "SCH007",
    "schema",
    "The project declares a geometric representation context",
    project && !hasValues(project.RepresentationContexts) ? [{ expressID: projects[0], type: "IfcProject" }] : [],
    "Representations are meaningless without the context they are expressed in.",
    projects.length > 0,
  );

  // -- implementer agreements ----------------------------------------------

  const elements = model.byType("IfcElement");
  const noPlacement: Array<{ expressID: number; type: string }> = [];
  const noContainer: Array<{ expressID: number; type: string }> = [];
  const noOwner: Array<{ expressID: number; type: string }> = [];
  for (const id of elements) {
    const line = model.line(id);
    if (!line) continue;
    const type = model.typeName(id);
    if (!hasValue(line.ObjectPlacement)) noPlacement.push({ expressID: id, type });
    if (model.containerOf(id) === null && model.aggregateOf(id) === null) noContainer.push({ expressID: id, type });
    if (!hasValue(line.OwnerHistory)) noOwner.push({ expressID: id, type });
  }
  add("AGR001", "agreements", "Every element has an object placement", noPlacement,
    "An element with no placement has no location, whatever geometry it carries.");
  add("AGR002", "agreements", "Every element is contained in the spatial structure", noContainer,
    "An element outside the spatial structure is invisible to storey filters and schedules.");
  add("AGR003", "agreements", "Every element carries an owner history", noOwner,
    "Optional in IFC4 and expected by most receiving tools; a warning rather than a fault.");

  const storeys = model.byType("IfcBuildingStorey");
  const buildings = model.byType("IfcBuilding");
  const sites = model.byType("IfcSite");
  add(
    "AGR004",
    "agreements",
    "The spatial structure reaches site, building and storey",
    sites.length && buildings.length && storeys.length
      ? []
      : [{ expressID: projects[0] ?? 0, type: "IfcProject", note: `site ${sites.length}, building ${buildings.length}, storey ${storeys.length}` }],
    "A model with no storeys cannot be filed, scheduled or issued by level.",
  );

  const badElevation = storeys
    .filter((id) => {
      const line = model.line(id);
      return line !== null && val(line.Elevation) === null;
    })
    .map((id) => ({ expressID: id, type: "IfcBuildingStorey" }));
  add("AGR005", "agreements", "Every storey declares its elevation", badElevation,
    "Elevation is what orders the storeys and what a section cut is measured against.");

  // -- informal propositions -----------------------------------------------

  const emptySets = model
    .byType("IfcPropertySet")
    .filter((id) => {
      const set = model.line(id);
      return !set || !hasValues(set.HasProperties);
    })
    .map((id) => ({ expressID: id, type: "IfcPropertySet" }));
  add("PRP001", "propositions", "No property set is empty", emptySets,
    "An empty set is carried through every exchange and means nothing at either end.");

  const unnamed = elements
    .filter((id) => !String(val(model.line(id)?.Name) ?? "").trim())
    .map((id) => ({ expressID: id, type: model.typeName(id) }));
  add("PRP002", "propositions", "Every element carries a name", unnamed,
    "Names drive the model tree and nearly every schedule.");

  const usedTypes = new Set<number>();
  for (const id of model.byType("IfcRelDefinesByType", false)) {
    const relation = model.line(id);
    const type = ref(relation?.RelatingType);
    if (
      type !== null &&
      Array.isArray(relation?.RelatedObjects) &&
      relation.RelatedObjects.some((object) => ref(object) !== null)
    ) {
      usedTypes.add(type);
    }
  }
  const typesWithoutOccurrence = model
    .byType("IfcTypeObject")
    .filter((id) => !usedTypes.has(id))
    .map((id) => ({ expressID: id, type: model.typeName(id) }));
  add("PRP003", "propositions", "Every type object is used by an occurrence", typesWithoutOccurrence,
    "An unused type is dead weight in the file and a common sign of a partial export.");

  // -- the rules that need a normative engine -------------------------------

  for (const [id, title] of GHERKIN_RULES) {
    checks.push({
      id,
      family: "gherkin",
      title,
      outcome: "not_run",
      count: 0,
      detail: "This is a normative Gherkin rule. It runs through IfcOpenShell in Local Studio, which is also on this machine.",
      sample: [],
    });
  }

  const passed = checks.filter((check) => check.outcome === "pass").length;
  const failed = checks.filter((check) => check.outcome === "fail").length;
  const notRun = checks.filter((check) => check.outcome === "not_run").length;
  return { schema: model.schema, passed, failed, notRun, checks, offline: true };
}

export const FAMILY_LABEL: Record<ConformanceFamily, string> = {
  schema: "Schema",
  agreements: "Implementer agreements",
  propositions: "Informal propositions",
  gherkin: "Normative rules",
};
