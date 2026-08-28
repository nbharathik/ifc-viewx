import { runViewerAction } from "../llm/actions.js";
import { TOOLS, type ToolSpec } from "../llm/tools.js";
import type { ResultStore } from "./results.js";
import { CapabilityRegistry } from "./registry.js";
import { definitionCapabilities } from "./definitions.js";
import { graphCapabilities } from "./graph.js";
import type { CapabilityCost, CapabilityDefinition, CapabilityEffect, JsonSchema, ViewerCapabilityContext } from "./types.js";

export type { ViewerCapabilityContext } from "./types.js";

const MCP_ACTIONS = new Set([
  "find", "search", "counts", "storeys", "selection", "visibility",
  "isolate", "hide", "unhide", "show", "categories", "color",
  "section", "sectionContours", "sectionBox", "camera", "clash", "check", "schedule", "ids",
  "distance", "laser",
]);

const VIEW_EFFECTS = new Set([
  "select", "fit", "isolate", "hide", "unhide", "show", "categories",
  "color", "section", "sectionContours", "sectionBox", "models", "camera", "distance", "laser",
]);

const LONG_ACTIONS = new Set(["check", "schedule", "ids", "clash"]);
const INTERACTIVE_ACTIONS = new Set(["distance", "laser", "sectionContours"]);

function inputSchema(tool: ToolSpec): JsonSchema {
  return {
    type: "object",
    properties: tool.params?.properties ?? {},
    required: tool.params?.required ?? [],
    additionalProperties: false,
  };
}

function definition(tool: ToolSpec): CapabilityDefinition<Record<string, unknown>, string, ViewerCapabilityContext> {
  const effect: CapabilityEffect = tool.tier === "edit" ? "propose" : VIEW_EFFECTS.has(tool.name) ? "view" : "read";
  const cost: CapabilityCost = LONG_ACTIONS.has(tool.name)
    ? "long"
    : INTERACTIVE_ACTIONS.has(tool.name) ? "interactive" : "instant";
  return {
    id: tool.name,
    title: tool.plain,
    description: tool.summary,
    input: inputSchema(tool),
    output: { type: "string", description: "Viewer action report" },
    effect,
    permissions: [],
    cost,
    parallelSafe: effect === "read" && cost === "instant",
    exposure: { assistant: true, mcp: tool.tier === "viewer" && MCP_ACTIONS.has(tool.name), sdk: tool.tier === "viewer" },
    source: "core",
    presentation: { icon: tool.icon, plain: tool.plain, legacySyntax: tool.syntax },
    execute: (input, context, signal) => {
      if (signal.aborted) throw new DOMException("Capability cancelled", "AbortError");
      if (tool.tier === "edit") {
        if (!context.stageEdit) throw new Error("Typed edit staging is unavailable");
        return context.stageEdit({ op: tool.name, ...input });
      }
      return runViewerAction(
        context.viewer,
        JSON.stringify({ action: tool.name, ...input }),
        context.semantic,
        signal,
      );
    },
  };
}

export function viewerCapabilityDefinitions(): Array<CapabilityDefinition<Record<string, unknown>, string, ViewerCapabilityContext>> {
  return TOOLS.filter((tool) => tool.tier === "viewer" || tool.tier === "edit").map(definition);
}

const RESULT_HANDLE = { type: "string", description: "result handle returned by an earlier capability" };

function requireResults(context: ViewerCapabilityContext): ResultStore {
  if (!context.results) throw new Error("Result handles are unavailable");
  return context.results;
}

function requireLiveResult(context: ViewerCapabilityContext, id: string): ResultStore {
  const store = requireResults(context);
  const handle = store.get(id);
  if (!handle) throw new Error(`Unknown or expired result: ${id}`);
  const revision = context.revision?.();
  if (handle.revision && revision && handle.revision !== revision) {
    throw new Error(`Result ${id} belongs to an earlier model revision. Run the source capability again.`);
  }
  return store;
}

function rowIds(value: unknown): number[] {
  if (!value || typeof value !== "object") return [];
  const row = value as Record<string, unknown>;
  const ids: unknown[] = [row.id, row.expressId, row.expressID];
  for (const side of [row.a, row.b]) {
    ids.push(side && typeof side === "object" ? (side as Record<string, unknown>).id : side);
  }
  return ids.filter((id): id is number => typeof id === "number" && Number.isFinite(id) && id > 0);
}

function resultRows(context: ViewerCapabilityContext, input: Record<string, unknown>): unknown[] {
  const handle = String(input.handle ?? "");
  const store = requireLiveResult(context, handle);
  const indexes = Array.isArray(input.rows) ? input.rows.map(Number) : null;
  if (indexes) return store.rows(handle, indexes);
  const page = store.page(handle, 0, 500);
  if (page.nextOffset !== null) throw new Error("Choose result rows or a group before changing the view");
  return [...page.items];
}

function resultDefinitions(): Array<CapabilityDefinition<Record<string, unknown>, unknown, ViewerCapabilityContext>> {
  return [
    {
      id: "result.page",
      title: "Read result rows",
      description: "Read a bounded page from a prior result without rerunning its analysis",
      input: { type: "object", properties: { handle: RESULT_HANDLE, offset: { type: "integer" }, limit: { type: "integer" } }, required: ["handle"], additionalProperties: false },
      effect: "read", permissions: [], cost: "instant", parallelSafe: true,
      exposure: { assistant: true, mcp: true, sdk: true }, source: "core",
      presentation: { icon: "table", plain: "Read rows from a prior result" },
      execute: (input, context) => requireLiveResult(context, String(input.handle)).page(String(input.handle), Number(input.offset) || 0, Number(input.limit) || 40),
    },
    {
      id: "result.group",
      title: "Group a result",
      description: "Group prior result rows by a field such as storey, type or kind without rerunning the source capability",
      input: { type: "object", properties: { handle: RESULT_HANDLE, field: { type: "string" } }, required: ["handle", "field"], additionalProperties: false },
      effect: "read", permissions: [], cost: "instant", parallelSafe: true,
      exposure: { assistant: true, mcp: true, sdk: true }, source: "core",
      presentation: { icon: "layers", plain: "Group a prior result" },
      execute: (input, context) => ({ handle: String(input.handle), field: String(input.field), groups: requireLiveResult(context, String(input.handle)).group(String(input.handle), String(input.field)) }),
    },
    {
      id: "result.open",
      title: "Open a result",
      description: "Make a prior result active and return its first page",
      input: { type: "object", properties: { handle: RESULT_HANDLE, row: { type: "integer" } }, required: ["handle"], additionalProperties: false },
      effect: "view", permissions: [], cost: "instant", parallelSafe: false,
      exposure: { assistant: true, mcp: true, sdk: true }, source: "core",
      presentation: { icon: "table", plain: "Open an analysis result" },
      execute: (input, context) => {
        const handle = String(input.handle);
        const row = input.row === undefined ? undefined : Number(input.row);
        const store = requireLiveResult(context, handle);
        context.setActiveResult?.(handle, row);
        return store.page(handle, row ?? 0, 40);
      },
    },
    ...([
      { action: "select", id: "result.select" },
      { action: "isolate", id: "result.isolate" },
    ] as const).map(({ action, id }) => ({
      id,
      title: `${action === "select" ? "Select" : "Isolate"} result rows`,
      description: `${action === "select" ? "Select" : "Isolate"} elements referenced by prior result rows`,
      input: { type: "object", properties: { handle: RESULT_HANDLE, rows: { type: "array", items: { type: "integer" } } }, required: ["handle"], additionalProperties: false },
      effect: "view" as const, permissions: [], cost: "instant" as const, parallelSafe: false,
      exposure: { assistant: true, mcp: true, sdk: true }, source: "core",
      presentation: { icon: action === "select" ? "focus" : "eye", plain: `${action} elements from a result` },
      execute: (input: Record<string, unknown>, context: ViewerCapabilityContext) => {
        const ids = [...new Set(resultRows(context, input).flatMap(rowIds))];
        if (ids.length === 0) throw new Error("Those result rows reference no elements");
        if (action === "select") {
          context.viewer.selectMany(ids, "replace");
          const box = context.viewer.boxAround(ids, 0.15);
          if (box) context.viewer.fitToPoint([
            (box.min[0] + box.max[0]) / 2,
            (box.min[1] + box.max[1]) / 2,
            (box.min[2] + box.max[2]) / 2,
          ]);
        } else context.viewer.isolate(ids, `Result ${String(input.handle)}`);
        return { handle: String(input.handle), rows: Array.isArray(input.rows) ? input.rows : "all", ids };
      },
    })),
    {
      id: "issue.stage",
      title: "Stage an issue",
      description: "Create an issue payload from a result for the user to review before it is added to BCF",
      input: {
        type: "object",
        properties: {
          title: { type: "string" },
          description: { type: "string" },
          handle: RESULT_HANDLE,
          rows: { type: "array", items: { type: "integer" } },
        },
        required: ["title", "handle"],
        additionalProperties: false,
      },
      effect: "propose", permissions: [], cost: "instant", parallelSafe: false,
      exposure: { assistant: true, mcp: false, sdk: false }, source: "core",
      presentation: { icon: "flag", plain: "Stage a BCF issue from evidence" },
      execute: (input, context) => ({
        staged: true,
        title: String(input.title),
        description: String(input.description ?? ""),
        result: String(input.handle),
        rows: Array.isArray(input.rows) ? input.rows : [],
        elementIds: [...new Set(resultRows(context, input).flatMap(rowIds))],
      }),
    },
    {
      id: "view.pickAt",
      title: "Pick the attached view",
      description: "Resolve normalized coordinates in the explicitly attached viewport image to a model element and surface point",
      input: {
        type: "object",
        properties: { x: { type: "number", description: "0 to 1 from the image left" }, y: { type: "number", description: "0 to 1 from the image top" } },
        required: ["x", "y"],
        additionalProperties: false,
      },
      effect: "read", permissions: [], cost: "instant", parallelSafe: true,
      exposure: { assistant: true, mcp: false, sdk: false }, source: "core",
      presentation: { icon: "focus", plain: "Identify a point in the attached view" },
      available: (context) => ({ available: Boolean(context.viewport), reason: "The viewport is unavailable" }),
      execute: (input, context) => {
        const x = Number(input.x);
        const y = Number(input.y);
        if (x < 0 || x > 1 || y < 0 || y > 1) throw new Error("x and y must be between 0 and 1");
        const rect = context.viewport!.getBoundingClientRect();
        const pick = context.viewer.pickAt(rect.left + rect.width * x, rect.top + rect.height * y);
        return pick ? { hit: true, expressId: pick.expressID, point: pick.point } : { hit: false };
      },
    },
  ];
}

export function createViewerCapabilityRegistry(): CapabilityRegistry<ViewerCapabilityContext> {
  const registry = new CapabilityRegistry<ViewerCapabilityContext>();
  for (const capability of viewerCapabilityDefinitions()) registry.register(capability);
  for (const capability of resultDefinitions()) registry.register(capability);
  // The definitions layer: what the assistant authors instead of code.
  for (const capability of definitionCapabilities()) registry.register(capability);
  for (const capability of graphCapabilities()) registry.register(capability);
  return registry;
}
