// The twelve rules that ship.
//
// Each one is the question a coordinator actually asks at a milestone, and
// each says how it decided, because a finding nobody can argue with is worth
// more than a finding nobody can reproduce.
import {
  boolParam,
  boxesOverlap,
  centreOf,
  listParam,
  numberParam,
  registerRule,
  rowsOfClasses,
  scopedRows,
  sizeOf,
  textParam,
  type Box,
  type RuleFinding,
  type ResolvedRule,
  type RuleRunContext,
} from "./engine.js";
import type { ElementRow } from "../data/model.js";

const label = (row: ElementRow): string => `${row.type.replace(/^Ifc/, "")} ${row.name || `#${row.id}`}`;

/** Elements the rule is allowed to read geometry for, capped so a huge model
 *  still answers. The cap is reported rather than silently applied. */
const GEOMETRY_CAP = 6000;

const readProperty = (row: ElementRow, names: string[]): string => {
  for (const name of names) {
    const wanted = name.toLowerCase();
    for (const [key, value] of Object.entries(row.props)) {
      const dot = key.lastIndexOf(".");
      const propertyName = dot < 0 ? key : key.slice(dot + 1);
      if (propertyName.toLowerCase() !== wanted) continue;
      if (value !== null && value !== undefined && value !== "") return String(value);
    }
    for (const [key, value] of Object.entries(row.attrs)) {
      if (key.toLowerCase() !== wanted) continue;
      if (value !== null && value !== undefined && value !== "") return String(value);
    }
  }
  return "";
};

const numberProperty = (row: ElementRow, names: string[]): number | null => {
  const text = readProperty(row, names);
  if (!text) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
};

// -- 1. duplicate GlobalId ---------------------------------------------------

registerRule({
  id: "duplicate-globalid",
  title: "Duplicate GlobalId",
  description: "Two elements carry the same GlobalId, so nothing downstream can tell them apart.",
  category: "Identity",
  severity: "error",
  params: [],
  async run(rule, context) {
    const byId = new Map<string, ElementRow[]>();
    for (const row of scopedRows(rule, context.model)) {
      if (!row.globalId) continue;
      const bucket = byId.get(row.globalId);
      if (bucket) bucket.push(row);
      else byId.set(row.globalId, [row]);
    }
    const findings: RuleFinding[] = [];
    for (const [globalId, rows] of byId) {
      if (rows.length < 2) continue;
      findings.push(finding(rule, `${rows.length} elements share GlobalId ${globalId}`, rows.map((row) => row.id),
        rows.map(label).join(", ")));
    }
    return findings;
  },
});

// -- 2. coincident copies ----------------------------------------------------

registerRule({
  id: "coincident-elements",
  title: "Coincident duplicate geometry",
  description: "Two elements have the same shape in the same place, which is a modelled-twice error rather than a clash.",
  category: "Geometry",
  severity: "error",
  geometric: true,
  params: [
    { key: "toleranceMm", label: "Placement tolerance (mm)", kind: "number", value: 20, hint: "How far apart two copies may sit and still count as coincident." },
  ],
  async run(rule, context) {
    const rows = scopedRows(rule, context.model);
    const ids = rows.map((row) => row.id).slice(0, GEOMETRY_CAP);
    if (ids.length === 0) return [];
    const signatures = await context.model.signatures(ids, context.signal);
    const tolerance = numberParam(rule, "toleranceMm", 20) / 1000;
    const buckets = new Map<string, number[]>();
    for (const [id, signature] of signatures) {
      const key = [
        signature.hash,
        ...signature.translation.map((value) => Math.round(value / Math.max(tolerance, 1e-6))),
      ].join("|");
      const bucket = buckets.get(key);
      if (bucket) bucket.push(id);
      else buckets.set(key, [id]);
    }
    const names = new Map(rows.map((row) => [row.id, label(row)]));
    const findings: RuleFinding[] = [];
    for (const group of buckets.values()) {
      if (group.length < 2) continue;
      findings.push(finding(
        rule,
        `${group.length} identical elements in the same place`,
        group,
        group.map((id) => names.get(id) ?? `#${id}`).join(", "),
        context.model.bounds(group[0]),
      ));
    }
    if (rows.length > GEOMETRY_CAP) {
      findings.push(capped(rule, rows.length));
    }
    return findings;
  },
});

// -- 3. self-intersection ----------------------------------------------------

registerRule({
  id: "self-intersection",
  title: "Elements of one discipline intersecting each other",
  description: "A mesh-level clash inside one set, which a cross-discipline clash run never looks at.",
  category: "Geometry",
  severity: "warning",
  geometric: true,
  params: [
    { key: "classes", label: "Classes", kind: "classes", value: [], hint: "Blank tests everything in scope against itself." },
    { key: "toleranceMm", label: "Ignore overlaps thinner than (mm)", kind: "number", value: 10 },
  ],
  async run(rule, context) {
    const rows = rowsOfClasses(rule, context.model, listParam(rule, "classes"));
    const ids = rows.map((row) => row.id).slice(0, GEOMETRY_CAP);
    if (ids.length < 2) return [];
    const hits = await context.model.clash(ids, ids, numberParam(rule, "toleranceMm", 10), context.signal);
    const names = new Map(rows.map((row) => [row.id, label(row)]));
    const seen = new Set<string>();
    const findings: RuleFinding[] = [];
    for (const hit of hits) {
      if (hit.a === hit.b) continue;
      const key = hit.a < hit.b ? `${hit.a}-${hit.b}` : `${hit.b}-${hit.a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        ruleId: rule.id,
        ruleTitle: rule.title,
        severity: rule.severity,
        title: `${names.get(hit.a) ?? `#${hit.a}`} overlaps ${names.get(hit.b) ?? `#${hit.b}`}`,
        ids: [hit.a, hit.b],
        detail: `${(hit.distance * 1000).toFixed(0)} mm deep`,
        point: hit.point,
      });
    }
    if (rows.length > GEOMETRY_CAP) findings.push(capped(rule, rows.length));
    return findings;
  },
});

// -- 4. outside the storey band ---------------------------------------------

registerRule({
  id: "outside-storey",
  title: "Element outside its storey's height band",
  description: "The element sits under or over the storey it is filed in, which breaks every storey-based schedule.",
  category: "Structure",
  severity: "warning",
  geometric: true,
  params: [
    { key: "slack", label: "Allowance (m)", kind: "number", value: 0.5, hint: "How far past the band an element may reach." },
  ],
  async run(rule, context) {
    const storeys = await context.model.storeys();
    if (storeys.length === 0) return [];
    const known = storeys
      .filter((storey) => storey.elevation !== null)
      .sort((a, b) => (a.elevation ?? 0) - (b.elevation ?? 0));
    if (known.length === 0) return [];
    const bands = new Map<string, [number, number]>();
    const top = context.model.modelBox()?.max[1] ?? (known[known.length - 1].elevation ?? 0) + 4;
    known.forEach((storey, index) => {
      const from = storey.elevation ?? 0;
      const to = index + 1 < known.length ? (known[index + 1].elevation ?? from) : Math.max(top, from + 1);
      bands.set(storey.name, [from, to]);
    });
    const slack = numberParam(rule, "slack", 0.5);
    const findings: RuleFinding[] = [];
    for (const row of scopedRows(rule, context.model)) {
      const band = bands.get(row.storey);
      if (!band) continue;
      const box = context.model.bounds(row.id);
      if (!box) continue;
      // The scene is Y-up, so the storey band is compared against Y.
      const centre = centreOf(box)[1];
      if (centre >= band[0] - slack && centre <= band[1] + slack) continue;
      findings.push(finding(
        rule,
        `${label(row)} is filed under ${row.storey} but sits at ${centre.toFixed(2)} m`,
        [row.id],
        `${row.storey} spans ${band[0].toFixed(2)} to ${band[1].toFixed(2)} m`,
        box,
      ));
    }
    return findings;
  },
});

// -- 5. unbounded spaces -----------------------------------------------------

registerRule({
  id: "unbounded-space",
  title: "Space with no usable volume",
  description: "An IfcSpace with no geometry, or one thin enough to be a modelling accident, cannot carry an area schedule.",
  category: "Spaces",
  severity: "error",
  geometric: true,
  params: [
    { key: "minVolume", label: "Smallest real space (m3)", kind: "number", value: 0.5 },
  ],
  async run(rule, context) {
    const rows = rowsOfClasses(rule, context.model, ["IfcSpace"]);
    if (rows.length === 0) return [];
    const minimum = numberParam(rule, "minVolume", 0.5);
    const withGeometry = rows.filter((row) => context.model.bounds(row.id) !== null);
    const findings: RuleFinding[] = [];
    for (const row of rows) {
      if (context.model.bounds(row.id) === null) {
        findings.push(finding(rule, `${label(row)} has no geometry at all`, [row.id], "No bounding geometry in the file"));
      }
    }
    if (withGeometry.length === 0) return findings;
    const volumes = await context.model.volumes(withGeometry.map((row) => row.id).slice(0, GEOMETRY_CAP), context.signal);
    for (const row of withGeometry) {
      const measured = volumes.get(row.id);
      if (!measured) continue;
      if (measured.volume >= minimum && measured.closed) continue;
      findings.push(finding(
        rule,
        measured.closed
          ? `${label(row)} encloses only ${measured.volume.toFixed(3)} m3`
          : `${label(row)} is not a closed volume`,
        [row.id],
        measured.closed ? `Below the ${minimum} m3 threshold` : "The boundary mesh does not close, so no area or volume can be trusted",
        context.model.bounds(row.id),
      ));
    }
    if (withGeometry.length > GEOMETRY_CAP) findings.push(capped(rule, withGeometry.length));
    return findings;
  },
});

// -- 6. door clearance -------------------------------------------------------

registerRule({
  id: "door-clearance",
  title: "Door without clear space in front of it",
  description: "A bounding-box sweep in front of every door, so an obstruction is caught before somebody walks into it on site.",
  category: "Access",
  severity: "warning",
  geometric: true,
  params: [
    { key: "clearance", label: "Clear depth (m)", kind: "number", value: 0.9 },
    { key: "ignore", label: "Classes that may sit in the swing", kind: "classes", value: ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcOpeningElement", "IfcSpace", "IfcCovering", "IfcDoor"] },
  ],
  async run(rule, context) {
    const doors = rowsOfClasses(rule, context.model, ["IfcDoor"]);
    if (doors.length === 0) return [];
    const depth = numberParam(rule, "clearance", 0.9);
    const ignore = new Set(listParam(rule, "ignore").map((name) => name.toLowerCase()));
    const others = context.model
      .elements()
      .filter((row) => !ignore.has(row.type.toLowerCase()))
      .map((row) => ({ row, box: context.model.bounds(row.id) }))
      .filter((entry): entry is { row: ElementRow; box: Box } => entry.box !== null);
    const findings: RuleFinding[] = [];
    for (const door of doors) {
      const box = context.model.bounds(door.id);
      if (!box) continue;
      const size = sizeOf(box);
      // The thinnest horizontal axis is the leaf thickness, so the swing is
      // the volume in front of and behind it along that axis.
      const axis = size[0] <= size[2] ? 0 : 2;
      const swing: Box = {
        min: [...box.min] as [number, number, number],
        max: [...box.max] as [number, number, number],
      };
      swing.min[axis] -= depth;
      swing.max[axis] += depth;
      const blockers = others.filter((entry) => entry.row.id !== door.id && boxesOverlap(swing, entry.box));
      if (blockers.length === 0) continue;
      findings.push(finding(
        rule,
        `${label(door)} has ${blockers.length} object(s) inside its ${depth} m clear zone`,
        [door.id, ...blockers.slice(0, 8).map((entry) => entry.row.id)],
        blockers.slice(0, 5).map((entry) => label(entry.row)).join(", "),
        box,
      ));
    }
    return findings;
  },
});

// -- 7. hosted elements with no host ----------------------------------------

registerRule({
  id: "missing-host",
  title: "Hosted element with nothing to host it",
  description: "A door or window whose bounding box touches no wall, slab or roof, which usually means the host was deleted.",
  category: "Structure",
  severity: "error",
  geometric: true,
  params: [
    { key: "classes", label: "Hosted classes", kind: "classes", value: ["IfcDoor", "IfcWindow"] },
    { key: "hosts", label: "Host classes", kind: "classes", value: ["IfcWall", "IfcWallStandardCase", "IfcSlab", "IfcRoof", "IfcCurtainWall", "IfcPlate"] },
    { key: "slack", label: "Contact allowance (m)", kind: "number", value: 0.05 },
  ],
  async run(rule, context) {
    const hosted = rowsOfClasses(rule, context.model, listParam(rule, "classes"));
    if (hosted.length === 0) return [];
    const hostClasses = new Set(listParam(rule, "hosts").map((name) => name.toLowerCase()));
    const hosts = context.model
      .elements()
      .filter((row) => hostClasses.has(row.type.toLowerCase()))
      .map((row) => context.model.bounds(row.id))
      .filter((box): box is Box => box !== null);
    const slack = numberParam(rule, "slack", 0.05);
    const findings: RuleFinding[] = [];
    for (const row of hosted) {
      const box = context.model.bounds(row.id);
      if (!box) continue;
      if (hosts.some((host) => boxesOverlap(box, host, slack))) continue;
      findings.push(finding(rule, `${label(row)} touches no host element`, [row.id],
        `No ${[...hostClasses].map((name) => name.replace(/^ifc/, "")).join(", ")} within ${slack} m`, box));
    }
    return findings;
  },
});

// -- 8. unclassified ---------------------------------------------------------

registerRule({
  id: "unclassified",
  title: "Element with no classification reference",
  description: "Nothing to group the element by in a cost plan or an asset register.",
  category: "Data",
  severity: "warning",
  params: [
    { key: "properties", label: "Properties that count as a classification", kind: "classes", value: ["Classification", "ClassificationCode", "Uniclass", "Assembly Code", "OmniClass"] },
    { key: "classes", label: "Only these classes", kind: "classes", value: [] },
  ],
  async run(rule, context) {
    const names = listParam(rule, "properties");
    const rows = rowsOfClasses(rule, context.model, listParam(rule, "classes"));
    const missing = rows.filter((row) => readProperty(row, names) === "");
    if (missing.length === 0) return [];
    // One finding per class rather than per element: a reviewer reads twelve
    // rows, not four thousand.
    const byType = new Map<string, number[]>();
    for (const row of missing) {
      const bucket = byType.get(row.type);
      if (bucket) bucket.push(row.id);
      else byType.set(row.type, [row.id]);
    }
    return [...byType].map(([type, ids]) =>
      finding(rule, `${ids.length.toLocaleString()} ${type.replace(/^Ifc/, "")} elements carry no classification`, ids,
        `Looked for ${names.join(", ")}`));
  },
});

// -- 9. orphaned elements ----------------------------------------------------

registerRule({
  id: "orphaned",
  title: "Element outside the spatial structure",
  description: "The element hangs off no storey, so it is invisible to every storey filter, schedule and view.",
  category: "Structure",
  severity: "error",
  params: [],
  async run(rule, context) {
    const orphans = scopedRows(rule, context.model).filter((row) => row.storey.trim() === "");
    if (orphans.length === 0) return [];
    const byType = new Map<string, number[]>();
    for (const row of orphans) {
      const bucket = byType.get(row.type);
      if (bucket) bucket.push(row.id);
      else byType.set(row.type, [row.id]);
    }
    return [...byType].map(([type, ids]) =>
      finding(rule, `${ids.length.toLocaleString()} ${type.replace(/^Ifc/, "")} elements sit under no storey`, ids));
  },
});

// -- 10. naming convention ---------------------------------------------------

registerRule({
  id: "naming-convention",
  title: "Name does not follow the project convention",
  description: "One regular expression, applied to the elements in scope. This is where a client's own information protocol lands.",
  category: "Data",
  severity: "warning",
  params: [
    { key: "pattern", label: "Name must match", kind: "text", value: "^[A-Z]{2,}[-_]", hint: "A regular expression. Blank checks only that a name exists." },
    { key: "classes", label: "Only these classes", kind: "classes", value: [] },
    { key: "allowBlank", label: "A blank name is acceptable", kind: "boolean", value: false },
  ],
  async run(rule, context) {
    const rows = rowsOfClasses(rule, context.model, listParam(rule, "classes"));
    const source = textParam(rule, "pattern").trim();
    const allowBlank = boolParam(rule, "allowBlank", false);
    let pattern: RegExp | null = null;
    if (source) {
      try {
        pattern = new RegExp(source);
      } catch {
        throw new Error(`"${source}" is not a valid regular expression`);
      }
    }
    const bad = rows.filter((row) => {
      const name = (row.name || String(row.attrs.Name ?? "")).trim();
      if (!name) return !allowBlank;
      return pattern ? !pattern.test(name) : false;
    });
    if (bad.length === 0) return [];
    return [finding(
      rule,
      `${bad.length.toLocaleString()} element(s) do not match ${source || "the naming requirement"}`,
      bad.map((row) => row.id),
      bad.slice(0, 6).map((row) => row.name || `#${row.id}`).join(", "),
    )];
  },
});

// -- 11. placement and unit sanity ------------------------------------------

registerRule({
  id: "placement-sanity",
  title: "Element placed far from the model, or impossibly sized",
  description: "Catches the metre-versus-millimetre mistake and the element left at the origin, both of which ruin a federation.",
  category: "Geometry",
  severity: "error",
  geometric: true,
  params: [
    { key: "maxDistance", label: "Furthest from the model centre (m)", kind: "number", value: 2000 },
    { key: "maxSize", label: "Largest believable element (m)", kind: "number", value: 500 },
    { key: "minSize", label: "Smallest believable element (m)", kind: "number", value: 0.001 },
  ],
  async run(rule, context) {
    const placed = scopedRows(rule, context.model)
      .map((row) => ({ row, box: context.model.bounds(row.id) }))
      .filter((entry): entry is { row: ElementRow; box: Box } => entry.box !== null);
    if (placed.length === 0) return [];
    // The bounding box of the model is the wrong reference: one element left
    // at a millimetre coordinate drags the box centre halfway to it and every
    // correctly placed element then reads as the outlier. The median centre
    // is where the building actually is.
    const centre = medianPoint(placed.map((entry) => centreOf(entry.box)));
    const maxDistance = numberParam(rule, "maxDistance", 2000);
    const maxSize = numberParam(rule, "maxSize", 500);
    const minSize = numberParam(rule, "minSize", 0.001);
    const findings: RuleFinding[] = [];
    for (const { row, box } of placed) {
      const at = centreOf(box);
      const distance = Math.hypot(at[0] - centre[0], at[1] - centre[1], at[2] - centre[2]);
      const size = sizeOf(box);
      const longest = Math.max(...size);
      if (distance > maxDistance) {
        findings.push(finding(rule, `${label(row)} sits ${Math.round(distance).toLocaleString()} m from the model centre`, [row.id],
          "Usually a unit or placement error", box));
      } else if (longest > maxSize) {
        findings.push(finding(rule, `${label(row)} is ${Math.round(longest).toLocaleString()} m across`, [row.id],
          "Usually millimetres read as metres", box));
      } else if (longest > 0 && longest < minSize) {
        findings.push(finding(rule, `${label(row)} is ${longest.toExponential(1)} m across`, [row.id],
          "Degenerate geometry", box));
      }
    }
    return findings;
  },
});

// -- 12. quantity against geometry ------------------------------------------

registerRule({
  id: "quantity-vs-geometry",
  title: "Authored quantity disagrees with the mesh",
  description: "The volume in the quantity set is compared with the volume of the geometry that shipped with it.",
  category: "Data",
  severity: "warning",
  geometric: true,
  params: [
    { key: "tolerancePercent", label: "Allowed difference (%)", kind: "number", value: 15 },
    { key: "minVolume", label: "Ignore elements under (m3)", kind: "number", value: 0.01 },
  ],
  async run(rule, context) {
    const rows = scopedRows(rule, context.model).filter((row) => numberProperty(row, ["NetVolume", "GrossVolume", "Volume"]) !== null);
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id).slice(0, GEOMETRY_CAP);
    const volumes = await context.model.volumes(ids, context.signal);
    const tolerance = numberParam(rule, "tolerancePercent", 15) / 100;
    const floor = numberParam(rule, "minVolume", 0.01);
    const findings: RuleFinding[] = [];
    for (const row of rows) {
      const measured = volumes.get(row.id);
      const authored = numberProperty(row, ["NetVolume", "GrossVolume", "Volume"]);
      if (!measured || authored === null) continue;
      // An open mesh has no volume worth comparing, so it is not a finding here.
      if (!measured.closed) continue;
      if (authored < floor && measured.volume < floor) continue;
      const difference = Math.abs(measured.volume - authored) / Math.max(authored, floor);
      if (difference <= tolerance) continue;
      findings.push(finding(
        rule,
        `${label(row)} says ${authored.toFixed(3)} m3, the mesh measures ${measured.volume.toFixed(3)} m3`,
        [row.id],
        `${Math.round(difference * 100)}% apart`,
        context.model.bounds(row.id),
      ));
    }
    if (rows.length > GEOMETRY_CAP) findings.push(capped(rule, rows.length));
    return findings;
  },
});

/** Component-wise median, which no single outlier can move. */
function medianPoint(points: Array<[number, number, number]>): [number, number, number] {
  const axis = (index: number): number => {
    const values = points.map((point) => point[index]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };
  return [axis(0), axis(1), axis(2)];
}

function finding(
  rule: ResolvedRule,
  title: string,
  ids: number[],
  detail?: string,
  box?: Box | null,
): RuleFinding {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: rule.severity,
    title,
    ids,
    detail,
    point: box ? centreOf(box) : undefined,
  };
}

function capped(rule: ResolvedRule, total: number): RuleFinding {
  return {
    ruleId: rule.id,
    ruleTitle: rule.title,
    severity: "info",
    title: `Only the first ${GEOMETRY_CAP.toLocaleString()} of ${total.toLocaleString()} elements were read`,
    ids: [],
    detail: "Narrow the scope to check the rest.",
  };
}

/** Importing this module registers every rule; nothing else has to run. */
export const RULE_COUNT = 12;

export type { RuleRunContext };
