// The tool catalog, in one place.
//
// The block the model reads in its system prompt and the list the user sees in
// assistant settings are both rendered from this array, so what the assistant
// is told it has and what the app claims it has cannot drift apart. A new tool
// is one row here plus one case in actions.ts.
import type { AssistantMode } from "./llmClient.js";

export type ToolTier = "viewer" | "edit" | "python";

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
}

export const TOOLS: ToolSpec[] = [
  { name: "find", tier: "viewer", icon: "search", syntax: '{"action":"find","type":"door","name":"","storey":""}',
    summary: "substring filters; lists elements (id, type, name, storey)",
    plain: "Find elements by type, name or storey" },
  { name: "counts", tier: "viewer", icon: "calculator", syntax: '{"action":"counts"}',
    summary: "element counts per IFC class",
    plain: "Count elements by IFC class" },
  { name: "storeys", tier: "viewer", icon: "layers", syntax: '{"action":"storeys"}',
    summary: "storeys with element summaries",
    plain: "List storeys and what is on them" },
  { name: "properties", tier: "viewer", icon: "list", syntax: '{"action":"properties","id":123}',
    summary: "attributes, psets, quantities of one element",
    plain: "Read one element in full" },
  { name: "select", tier: "viewer", icon: "focus", syntax: '{"action":"select","id":123}',
    summary: "highlight and frame an element in 3D",
    plain: "Select and frame an element" },
  { name: "fit", tier: "viewer", icon: "frame", syntax: '{"action":"fit","id":123}',
    summary: "frame an element; omit id for the whole model",
    plain: "Frame an element, or the whole model" },
  { name: "isolate", tier: "viewer", icon: "eye", syntax: '{"action":"isolate","ids":[1,2]}',
    summary: "show only these elements",
    plain: "Show only the chosen elements" },
  { name: "hide", tier: "viewer", icon: "eye-off", syntax: '{"action":"hide","ids":[1,2]}',
    summary: "hide these elements",
    plain: "Hide the chosen elements" },
  { name: "show", tier: "viewer", icon: "eye", syntax: '{"action":"show"}',
    summary: "make everything visible again",
    plain: "Show everything again" },
  { name: "check", tier: "viewer", icon: "shield", syntax: '{"action":"check"}',
    summary: "structural QA: identity, containment, placement, units, naming",
    plain: "Run the model quality checks" },
  { name: "schedule", tier: "viewer", icon: "table", syntax: '{"action":"schedule","type":"IfcDoor","properties":["Pset_DoorCommon.FireRating"]}',
    summary: "table of a class; omit properties to list what is available",
    plain: "Build a schedule table for a class" },
  { name: "ids", tier: "viewer", icon: "clipboard", syntax: '{"action":"ids"}',
    summary: "validate against the IDS the user loaded; pass/fail per specification",
    plain: "Validate against your loaded IDS" },
  { name: "clash", tier: "viewer", icon: "compare", syntax: '{"action":"clash","a":["IfcWall"],"b":["IfcDuctSegment"],"tolerance":10}',
    summary: "bounding-box clash sweep between two class sets; omit a/b for structure vs services",
    plain: "Clash sweep between two sets of classes" },

  { name: "setAttribute", tier: "edit", icon: "edit", syntax: '{"op":"setAttribute","ids":[1,2],"attribute":"Name","value":"Level 1 Door"}',
    summary: "attribute is one of Name, Description, ObjectType, Tag, LongName",
    plain: "Change a name, description, type or tag" },
  { name: "renameByPattern", tier: "edit", icon: "search", syntax: '{"op":"renameByPattern","ids":[1,2],"find":"Basic Wall","replace":"Wall"}',
    summary: "substring replace inside each element's existing name",
    plain: "Find and replace inside names" },
  { name: "setProperty", tier: "edit", icon: "sliders", syntax: '{"op":"setProperty","ids":[1],"set":"Pset_WallCommon","property":"IsExternal","value":true}',
    summary: "only writes a property that already exists on that element",
    plain: "Change a property that already exists" },

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
  if (tool.name === "ids") return state.ids ? "" : "Load an .ids file";
  return "";
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
    const name = String(value.action ?? value.op ?? "");
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
    const counts = ["matches", "total", "issues", "clashes", "failures"]
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
