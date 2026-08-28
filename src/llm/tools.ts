// The tool catalog, in one place.
//
// The block the model reads in its system prompt and the list the user sees in
// assistant settings are both rendered from this array, so what the assistant
// is told it has and what the app claims it has cannot drift apart. A new tool
// is one row here plus one case in actions.ts.
export type ToolTier = "viewer" | "edit" | "python";
export type AssistantMode = "query" | "edit";

export interface ToolSpec {
  name: string;
  tier: ToolTier;
  /** Icon shown wherever the tool is named, in settings and in the transcript. */
  icon: string;
  /** Exact call shape, as the model has to write it. */
  syntax: string;
  /** What it does, in the words the model reads. */
  summary: string;
  /** The same thing in the words a user reads. */
  plain: string;
  /**
   * JSON Schema for the arguments, when the provider takes tools natively.
   * Absent for the Python tiers, which are written as code and never called.
   */
  params?: { properties: Record<string, unknown>; required?: string[] };
}

const ID_LIST = { type: "array", items: { type: "integer" }, description: "expressIDs from a find call" };
const SCALAR = { type: ["string", "number", "boolean"], description: "the new value" };

export const TOOLS: ToolSpec[] = [
  { name: "find", tier: "viewer", icon: "search", syntax: '{"action":"find","type":"door","name":"","storey":""}',
    summary: "substring filters; lists elements (id, type, name, storey)",
    plain: "Find elements by type, name or storey",
    params: { properties: {
      type: { type: "string", description: "IFC class substring, e.g. door or IfcWall" },
      name: { type: "string", description: "name substring" },
      storey: { type: "string", description: "storey name substring" },
    } } },
  { name: "counts", tier: "viewer", icon: "calculator", syntax: '{"action":"counts"}',
    summary: "element counts per IFC class",
    plain: "Count elements by IFC class",
    params: { properties: {} } },
  { name: "storeys", tier: "viewer", icon: "layers", syntax: '{"action":"storeys"}',
    summary: "storeys with element summaries",
    plain: "List storeys and what is on them",
    params: { properties: {} } },
  { name: "properties", tier: "viewer", icon: "list", syntax: '{"action":"properties","id":123}',
    summary: "attributes, psets, quantities of one element",
    plain: "Read one element in full",
    params: { properties: { id: { type: "integer", description: "expressID" } }, required: ["id"] } },
  { name: "select", tier: "viewer", icon: "focus", syntax: '{"action":"select","ids":[123,124]}',
    summary: "highlight and frame elements in 3D; one id or a set",
    plain: "Select and frame elements",
    params: { properties: {
      id: { type: "integer", description: "a single expressID" },
      ids: { type: "array", items: { type: "integer" }, description: "several expressIDs at once" },
    } } },
  { name: "fit", tier: "viewer", icon: "frame", syntax: '{"action":"fit","id":123}',
    summary: "frame an element; omit id for the whole model",
    plain: "Frame an element, or the whole model",
    params: { properties: { id: { type: "integer", description: "expressID; omit to frame everything" } } } },
  { name: "isolate", tier: "viewer", icon: "eye", syntax: '{"action":"isolate","ids":[1,2]}',
    summary: "show only these elements",
    plain: "Show only the chosen elements",
    params: { properties: { ids: ID_LIST }, required: ["ids"] } },
  { name: "hide", tier: "viewer", icon: "eye-off", syntax: '{"action":"hide","ids":[1,2]}',
    summary: "hide these elements",
    plain: "Hide the chosen elements",
    params: { properties: { ids: ID_LIST }, required: ["ids"] } },
  { name: "show", tier: "viewer", icon: "eye", syntax: '{"action":"show"}',
    summary: "make everything visible again",
    plain: "Show everything again",
    params: { properties: {} } },
  { name: "check", tier: "viewer", icon: "shield", syntax: '{"action":"check"}',
    summary: "structural QA: identity, containment, placement, units, naming",
    plain: "Run the model quality checks",
    params: { properties: {} } },
  { name: "schedule", tier: "viewer", icon: "table", syntax: '{"action":"schedule","type":"IfcDoor","properties":["Pset_DoorCommon.FireRating"]}',
    summary: "table of a class; omit properties to list what is available",
    plain: "Build a schedule table for a class",
    params: { properties: {
      type: { type: "string", description: "IFC class, e.g. IfcDoor" },
      properties: { type: "array", items: { type: "string" }, description: 'columns as "Set.Property"; omit to list what exists' },
    }, required: ["type"] } },
  { name: "ids", tier: "viewer", icon: "clipboard", syntax: '{"action":"ids"}',
    summary: "validate against the IDS the user loaded; pass/fail per specification",
    plain: "Validate against your loaded IDS",
    params: { properties: {} } },
  { name: "clash", tier: "viewer", icon: "compare", syntax: '{"action":"clash","a":["IfcWall"],"b":["IfcDuctSegment"],"tolerance":10}',
    summary: "triangle-level clash sweep with rows ready to group by severity, classPair, level, primary or kind; omit a/b for structure vs services",
    plain: "Clash sweep between two sets of classes",
    params: { properties: {
      a: { type: "array", items: { type: "string" }, description: "IFC classes for set A" },
      b: { type: "array", items: { type: "string" }, description: "IFC classes for set B" },
      tolerance: { type: "number", description: "millimetres of penetration to ignore" },
      clearance: { type: "number", description: "millimetres; above zero, also report pairs that pass closer than this" },
    } } },
  { name: "distance", tier: "viewer", icon: "measure", syntax: '{"action":"distance","a":123,"b":456}',
    summary: "exact shortest mesh distance between two elements, with witness points in the viewer",
    plain: "Measure the shortest distance between elements",
    params: { properties: {
      a: { type: "integer", description: "first element id" },
      b: { type: "integer", description: "second element id" },
      maxDistance: { type: "number", description: "optional search limit in metres" },
    }, required: ["a", "b"] } },
  { name: "laser", tier: "viewer", icon: "ruler", syntax: '{"action":"laser","origin":[1.2,3.4,5.6],"source":123}',
    summary: "cast a three-axis laser from a surface point to the next visible meshes; omit origin to reuse the last viewport click",
    plain: "Measure six directions from a surface",
    params: { properties: {
      origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3, description: "surface point [x,y,z]; omit to use the last viewport click" },
      source: { type: "integer", description: "element at the origin, excluded from axis hits" },
      maxDistance: { type: "number", description: "axis search range in metres, default 30" },
      includeHidden: { type: "boolean", description: "include hidden elements; false by default" },
    } } },
  { name: "search", tier: "viewer", icon: "search", syntax: '{"action":"search","query":"external fire rated door level 2"}',
    summary: "ranked full-text search over names, classes, storeys and property values; use this before find when the wording is loose",
    plain: "Search the model in plain words",
    params: { properties: {
      query: { type: "string", description: "words to look for, in any order" },
      limit: { type: "integer", description: "rows to return, default 20" },
    }, required: ["query"] } },
  { name: "selection", tier: "viewer", icon: "focus", syntax: '{"action":"selection"}',
    summary: "what the user has selected right now, with class and name",
    plain: "Read the current selection",
    params: { properties: {} } },
  { name: "visibility", tier: "viewer", icon: "eye", syntax: '{"action":"visibility"}',
    summary: "what is hidden and why: counts, named rules, section state, lazy categories",
    plain: "Report what is hidden",
    params: { properties: {} } },
  { name: "unhide", tier: "viewer", icon: "eye", syntax: '{"action":"unhide","ids":[1,2]}',
    summary: "make these elements visible again without showing everything",
    plain: "Unhide just these elements",
    params: { properties: { ids: ID_LIST }, required: ["ids"] } },
  { name: "categories", tier: "viewer", icon: "layers", syntax: '{"action":"categories","IfcSpace":true}',
    summary: "spaces and openings are off by default and carry no geometry until switched on; do this before measuring or listing rooms",
    plain: "Load spaces or openings",
    params: { properties: {
      IfcSpace: { type: "boolean", description: "show room volumes" },
      IfcOpeningElement: { type: "boolean", description: "show door and window openings" },
    } } },
  { name: "color", tier: "viewer", icon: "palette", syntax: '{"action":"color","groups":[{"label":"fire rated","ids":[1,2],"color":"#e11d48"}]}',
    summary: "paint groups of elements; omit groups to take the colouring off",
    plain: "Colour elements by group",
    params: { properties: {
      groups: {
        type: "array",
        description: "up to 12 groups; omit to clear",
        items: { type: "object", properties: {
          label: { type: "string" },
          ids: { type: "array", items: { type: "integer" } },
          color: { type: "string", description: "#rrggbb; assigned for you when omitted" },
        }, required: ["ids"] },
      },
    } } },
  { name: "section", tier: "viewer", icon: "section", syntax: '{"action":"section","axis":"y","offset":3.2}',
    summary: "one axis-aligned cut, an arbitrary plane via normal, or a cut on the last picked face; pass clear to remove",
    plain: "Cut the model on a plane",
    params: { properties: {
      axis: { type: "string", enum: ["x", "y", "z"], description: "y is the horizontal cut that makes a plan" },
      offset: { type: "number", description: "where along the axis or normal; omit for the middle on axis cuts, required with normal" },
      normal: { type: "array", items: { type: "number" }, description: "3-vector for an arbitrary plane; overrides axis" },
      fromPick: { type: "boolean", description: "cut on the last surface the user clicked" },
      flip: { type: "boolean", description: "keep the other half" },
      clear: { type: "boolean", description: "remove every cut" },
    } } },
  { name: "sectionContours", tier: "viewer", icon: "section", syntax: '{"action":"sectionContours","axis":"y","offset":3.2}',
    summary: "build element-owned 2D contour summaries at an axis-aligned cut and put the same plane in the 3D view; omit axis and offset to reuse the active cut or model middle",
    plain: "Analyze a section drawing",
    params: { properties: {
      axis: { type: "string", enum: ["x", "y", "z"], description: "y produces a plan; x and z produce elevations" },
      offset: { type: "number", description: "cut position in model metres" },
      flip: { type: "boolean", description: "keep the other half in 3D" },
      includeHidden: { type: "boolean", description: "also analyze currently hidden elements" },
      maxSegments: { type: "integer", description: "mesh segment budget from 1,000 to 100,000; default 50,000" },
    } } },
  { name: "sectionBox", tier: "viewer", icon: "cube", syntax: '{"action":"sectionBox","ids":[1,2]}',
    summary: "clip to a box around these elements; pass clear to remove it",
    plain: "Box the view around elements",
    params: { properties: {
      ids: ID_LIST,
      clear: { type: "boolean", description: "remove the box" },
    } } },
  { name: "models", tier: "viewer", icon: "layers", syntax: '{"action":"models","hide":[1]}',
    summary: "the federated models with their element counts; pass show/hide to switch a discipline on or off. Element ids carry their model, so a result from one file never touches another",
    plain: "List or toggle the loaded models",
    params: { properties: {
      show: { type: "array", items: { type: "integer" }, description: "model indexes to show" },
      hide: { type: "array", items: { type: "integer" }, description: "model indexes to hide" },
    } } },
  { name: "camera", tier: "viewer", icon: "frame", syntax: '{"action":"camera","view":"top"}',
    summary: "move to a preset viewpoint, or read where the camera is when no view is given",
    plain: "Move or read the camera",
    params: { properties: {
      view: { type: "string", enum: ["front", "back", "left", "right", "top", "bottom", "iso"] },
    } } },

  { name: "setAttribute", tier: "edit", icon: "edit", syntax: '{"op":"setAttribute","ids":[1,2],"attribute":"Name","value":"Level 1 Door"}',
    summary: "attribute is one of Name, Description, ObjectType, Tag, LongName",
    plain: "Change a name, description, type or tag",
    params: { properties: {
      ids: ID_LIST,
      attribute: { type: "string", enum: ["Name", "Description", "ObjectType", "Tag", "LongName"] },
      value: SCALAR,
    }, required: ["ids", "attribute", "value"] } },
  { name: "renameByPattern", tier: "edit", icon: "search", syntax: '{"op":"renameByPattern","ids":[1,2],"find":"Basic Wall","replace":"Wall"}',
    summary: "substring replace inside each element's existing name",
    plain: "Find and replace inside names",
    params: { properties: {
      ids: ID_LIST,
      find: { type: "string", description: "substring to look for" },
      replace: { type: "string", description: "what to put in its place" },
    }, required: ["ids", "find", "replace"] } },
  { name: "setProperty", tier: "edit", icon: "sliders", syntax: '{"op":"setProperty","ids":[1],"set":"Pset_WallCommon","property":"IsExternal","value":true}',
    summary: "only writes a property that already exists on that element",
    plain: "Change a property that already exists",
    params: { properties: {
      ids: ID_LIST,
      set: { type: "string", description: "property set name, e.g. Pset_WallCommon" },
      property: { type: "string", description: "property name inside that set" },
      value: SCALAR,
    }, required: ["ids", "set", "property", "value"] } },

  { name: "python query", tier: "python", icon: "terminal", syntax: "```python query",
    summary: "read the model; assign a JSON-serializable value to `result`",
    plain: "Answer a question with generated Python" },
  { name: "python edit", tier: "python", icon: "terminal", syntax: "```python edit",
    summary: 'define `def edit(model)` returning {"summary": str, "affected_guids": [...]}',
    plain: "Change the model with generated Python" },
];

export const TIER_TITLE: Record<ToolTier, string> = {
  viewer: "Viewer actions",
  edit: "Typed edits",
  python: "Generated Python",
};

/** Said to the user, so it says what happens, not what gets written. */
export const TIER_NOTE: Record<ToolTier, string> = {
  viewer: "Instant, and the model is never changed.",
  edit: "Staged for your approval before anything changes.",
  python: "Never run for the assistant. It writes the code, you read it, and the Python Console runs it if you say so. It runs in a sandbox: a WebAssembly runtime with no network and no access to your disk, on a copy of the model, so nothing changes until you apply it.",
};

/** Column width for the prompt table. Long rows keep their own two spaces. */
const PAD = 58;

/** The tool table as the model reads it: syntax, padded, then the summary. */
export function toolBlock(tier: ToolTier): string {
  return TOOLS.filter((tool) => tool.tier === tier)
    .map((tool) => `${tool.syntax.padEnd(PAD)}  ${tool.summary}`)
    .join("\n");
}

/**
 * What the optional local service adds. Listed next to the assistant's tools so
 * the absence of it is information rather than a gap, and worded to make the
 * honest point: none of it is a tool the assistant gets. Connecting changes
 * what the app can do, never what the assistant may do.
 */
export const LOCAL_EXTRAS: Array<{ capability: string; icon: string; plain: string }> = [
  { capability: "convert", icon: "refresh", plain: "Convert to .ifcx, so reopening is instant" },
  { capability: "python", icon: "terminal", plain: "Native Python in the console, no 30 MB download" },
  { capability: "mcp", icon: "plug", plain: "MCP bridge, so AI clients can read this viewer" },
  { capability: "llm", icon: "shield", plain: "Holds the assistant's API key off this page" },
];

/** What this session can actually run, decided once and shown in both places. */
export interface ToolAvailability {
  mode: AssistantMode;
  /** A model is open, so anything that reads it can answer. */
  model: boolean;
  /** An IDS document has been loaded, so `ids` has something to check. */
  ids: boolean;
  /** Capabilities the local service reports, or null when it is not connected. */
  localCaps: string[] | null;
}

/**
 * Why a tool is unavailable, or "" when it is live. One function, so the
 * settings list and any future gating read the same rules. The Python tier is
 * never live: the assistant writes that code, it never runs it, and nothing the
 * user connects changes that.
 */
export function toolBlocker(tool: ToolSpec, state: ToolAvailability): string {
  if (tool.tier === "python") return "Written for you, never run";
  if (!state.model) return "Open a model";
  if (tool.tier === "edit" && state.mode !== "edit") return "Edit mode only";
  if (tool.name === "ids") return state.ids ? "" : "Open IDS Studio and load an .ids file";
  return "";
}

/** A tool as a provider takes it, wire-agnostic. */
export interface NativeTool {
  name: string;
  description: string;
  schema: {
    type: "object";
    properties: Record<string, unknown>;
    required: string[];
    additionalProperties?: false;
  };
}

/**
 * The tools a provider is offered this turn. Python is never here: the
 * assistant writes that code and the user runs it, so handing it over as a
 * callable tool would be a promise the app does not keep.
 */
export function nativeTools(mode: AssistantMode): NativeTool[] {
  return TOOLS.filter((tool) => tool.params && (tool.tier === "viewer" || (tool.tier === "edit" && mode === "edit"))).map(
    (tool) => ({
      name: tool.name,
      description: tool.summary,
      schema: {
        type: "object" as const,
        properties: tool.params!.properties,
        required: tool.params!.required ?? [],
        additionalProperties: false as const,
      },
    }),
  );
}

/** Which tier a called tool belongs to, so the app knows how to run it. */
export function tierOf(name: string): ToolTier | null {
  return TOOLS.find((tool) => tool.name === name)?.tier ?? null;
}

/**
 * A native call rewritten as the JSON block the existing runner already takes.
 * Bridging here rather than duplicating the runner is what keeps the native and
 * fenced paths from ever disagreeing about what a tool does.
 */
export function callToBlock(name: string, input: Record<string, unknown>): { code: string; kind: "viewer" | "modelEdit" } | null {
  const tier = tierOf(name);
  if (tier === "viewer") return { code: JSON.stringify({ action: name, ...input }), kind: "viewer" };
  if (tier === "edit") return { code: JSON.stringify({ op: name, ...input }), kind: "modelEdit" };
  return null;
}

/** One tool call, as the transcript has to label it. */
export interface CallInfo {
  icon: string;
  /** The tool the model reached for, by name. */
  name: string;
  /** What that tool does, for the tooltip. */
  plain: string;
  /** The arguments, in one line, so the header says what was asked. */
  args: string;
}

const argText = (value: unknown): string => {
  if (Array.isArray(value)) return value.length > 3 ? `${value.length} items` : value.join(", ");
  if (value === null || typeof value === "object") return "";
  return String(value);
};

/**
 * Read a tool block well enough to title it. A call the user can recognise at a
 * glance beats the raw JSON, which stays one click away in the card body.
 */
export function describeCall(kind: string, code: string): CallInfo {
  if (kind === "query" || kind === "edit") {
    const python = TOOLS.find((tool) => tool.name === `python ${kind}`);
    return { icon: "terminal", name: `python ${kind}`, plain: python?.plain ?? "", args: "" };
  }
  try {
    const value = JSON.parse(code) as Record<string, unknown>;
    const name = String(value.action ?? value.op ?? kind.replace(/__/g, "."));
    const tool = TOOLS.find((entry) => entry.name === name);
    const args = Object.entries(value)
      .filter(([key]) => key !== "action" && key !== "op")
      .map(([key, raw]) => [key, argText(raw)] as const)
      .filter(([, text]) => text !== "")
      .map(([key, text]) => `${key} ${text}`)
      .join(" · ");
    return { icon: tool?.icon ?? "chip", name: name || "tool", plain: tool?.plain ?? "", args };
  } catch {
    return { icon: "chip", name: "tool", plain: "", args: "" };
  }
}

/** The one line a finished call earns in its header; the rest stays collapsed. */
export function summarizeReport(report: string): string {
  try {
    const value = JSON.parse(report) as Record<string, unknown> | unknown[];
    if (Array.isArray(value)) return `${value.length} rows`;
    const counts = ["matches", "total", "issues", "clashes", "failures", "intersectedElements", "pathCount"]
      .filter((key) => typeof value[key] === "number")
      .map((key) => `${String(value[key])} ${key}`);
    if (counts.length) return counts.join(" · ");
    const rows = value.rows;
    if (Array.isArray(rows)) return `${rows.length} rows`;
    return `${Object.keys(value).length} fields`;
  } catch {
    return report.split("\n")[0].slice(0, 80);
  }
}

/**
 * Reports arrive as compact JSON; a human reads the indented form. Arrays of
 * plain values stay on their line: `JSON.stringify` would spend forty rows on
 * one list of ids, which is the opposite of readable.
 */
function indented(value: unknown, pad: string): string {
  if (Array.isArray(value)) {
    if (value.every((item) => item === null || typeof item !== "object")) return JSON.stringify(value);
    const rows = value.map((item) => `${pad}  ${indented(item, `${pad}  `)}`);
    return `[\n${rows.join(",\n")}\n${pad}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return "{}";
    const rows = entries.map(([key, item]) => `${pad}  ${JSON.stringify(key)}: ${indented(item, `${pad}  `)}`);
    return `{\n${rows.join(",\n")}\n${pad}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function prettyJson(text: string): string {
  try {
    return indented(JSON.parse(text), "");
  } catch {
    return text;
  }
}
