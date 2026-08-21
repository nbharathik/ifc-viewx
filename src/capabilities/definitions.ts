// What the assistant is allowed to author.
//
// The safest thing an assistant can produce is not code and not a click: it
// is a definition. "Show me every fire door without a rating, coloured by
// storey" becomes a saved View the user can read, edit, rename and share, and
// which does exactly what it says whatever model it is opened on. A view is
// reviewable in a way generated code never is, and it outlives the answer.
//
// Nothing here applies anything. Each capability returns a proposal; the app
// stages it, and the user decides.
import type { ColorRule } from "../ui/colorBy.js";
import type { RuleInstance, Ruleset } from "../rules/engine.js";
import { RULESET_FORMAT } from "../rules/engine.js";
import { describeSelector, selectorPortable, type Selector, type ViewDefinition } from "../views/definition.js";
import type { ComputedProperty } from "../data/computed.js";
import { checkFormula } from "../data/computed.js";
import type { CapabilityDefinition } from "./types.js";
import type { ViewerCapabilityContext } from "./viewer.js";

/** The selector language, as a schema the model can be held to. */
const SELECTOR_SCHEMA = {
  type: "object",
  description:
    "A query over the model. kind is one of all, class, storey, model, name, property, any, every, not. " +
    "class/storey/model take values (an array of names); name and property take op " +
    "(is, contains, starts, not, exists, missing) and value; property also takes set (blank searches every set). " +
    "any/every take of (an array of selectors); not takes of (one selector).",
  properties: {
    kind: { type: "string" },
    values: { type: "array", items: { type: "string" } },
    set: { type: "string" },
    name: { type: "string" },
    op: { type: "string" },
    value: { type: "string" },
    of: { type: "array", items: { type: "object" } },
  },
  required: ["kind"],
} as const;

const KINDS = new Set(["all", "class", "storey", "model", "name", "property", "ids", "any", "every", "not"]);
const OPS = new Set(["is", "contains", "starts", "not", "exists", "missing"]);

/** Validate a selector the model wrote, rather than trusting its shape. */
export function readSelector(raw: unknown, depth = 0): Selector {
  if (depth > 4) throw new Error("Selectors may not nest more than four deep");
  if (typeof raw !== "object" || raw === null) throw new Error("A selector must be an object");
  const value = raw as Record<string, unknown>;
  const kind = String(value.kind ?? "");
  if (!KINDS.has(kind)) throw new Error(`Unknown selector kind "${kind}"`);
  if (kind === "all") return { kind: "all" };
  if (kind === "ids") {
    const ids = Array.isArray(value.ids) ? value.ids.map(Number).filter(Number.isFinite) : [];
    return { kind: "ids", ids };
  }
  if (kind === "class" || kind === "storey" || kind === "model") {
    const values = Array.isArray(value.values) ? value.values.map(String).filter(Boolean) : [];
    if (values.length === 0) throw new Error(`A ${kind} selector needs at least one value`);
    return { kind, values };
  }
  if (kind === "name" || kind === "property") {
    const op = String(value.op ?? "is");
    if (!OPS.has(op)) throw new Error(`Unknown comparison "${op}"`);
    const text = String(value.value ?? "");
    if (kind === "name") return { kind: "name", op: op as Selector extends { op: infer O } ? O : never, value: text };
    const name = String(value.name ?? "");
    if (!name) throw new Error("A property selector needs a property name");
    return { kind: "property", set: String(value.set ?? ""), name, op: op as never, value: text };
  }
  if (kind === "not") return { kind: "not", of: readSelector(value.of, depth + 1) };
  const list = Array.isArray(value.of) ? value.of : [];
  if (list.length === 0) throw new Error(`An ${kind} selector needs at least one member`);
  return { kind: kind as "any" | "every", of: list.map((inner) => readSelector(inner, depth + 1)) };
}

function readColorRule(raw: unknown): ColorRule | null {
  if (raw === undefined || raw === null || raw === "") return null;
  const text = typeof raw === "string" ? raw : String((raw as { kind?: unknown }).kind ?? "");
  if (["none", "class", "storey", "model", "random", "material"].includes(text)) {
    return { kind: text as Exclude<ColorRule["kind"], "property"> };
  }
  if (text === "property") {
    const key = typeof raw === "object" && raw !== null ? String((raw as { key?: unknown }).key ?? "") : "";
    if (!key) throw new Error("Colouring by property needs the property key");
    return { kind: "property", key };
  }
  // A bare property key is what a model most often writes; accept it.
  return { kind: "property", key: text };
}

export interface StagedView {
  staged: "view";
  view: Omit<ViewDefinition, "id" | "updatedAt" | "thumbnail">;
  /** What each rule picks, in words, so the user can check it before applying. */
  explains: string[];
  portable: boolean;
}

export interface StagedProperty {
  staged: "property";
  property: Omit<ComputedProperty, "id">;
}

export interface StagedRuleset {
  staged: "ruleset";
  ruleset: Ruleset;
}

export function definitionCapabilities(): Array<CapabilityDefinition<Record<string, unknown>, unknown, ViewerCapabilityContext>> {
  return [
    {
      id: "definition.view",
      title: "Author a saved view",
      description:
        "Turn a request into a saved View: named filter rules written as queries, a colour rule and a description. " +
        "Nothing is applied; the user reviews and saves it. Prefer this over changing the view directly when the " +
        "user is describing a way of looking at the model rather than a one-off question.",
      input: {
        type: "object",
        properties: {
          name: { type: "string", description: "What this view is called" },
          description: { type: "string" },
          folder: { type: "string" },
          filters: {
            type: "array",
            description: "Visibility rules. Show rules add up; hide rules cut into the result.",
            items: {
              type: "object",
              properties: {
                label: { type: "string" },
                mode: { type: "string", description: "keep or hide" },
                selector: SELECTOR_SCHEMA,
              },
              required: ["label", "selector"],
            },
          },
          color: { type: "string", description: "class, storey, model, random, material, or a property key" },
        },
        required: ["name"],
        additionalProperties: false,
      },
      effect: "propose",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: false, sdk: false },
      source: "core",
      presentation: { icon: "bookmark", plain: "Author a saved view" },
      execute: (input): StagedView => {
        const filters = (Array.isArray(input.filters) ? input.filters : []).map((raw) => {
          const entry = raw as Record<string, unknown>;
          const selector = readSelector(entry.selector);
          return {
            label: String(entry.label ?? describeSelector(selector)),
            mode: entry.mode === "hide" ? ("hide" as const) : ("keep" as const),
            selector,
          };
        });
        const view: StagedView["view"] = {
          name: String(input.name),
          folder: String(input.folder ?? ""),
          description: String(input.description ?? ""),
          filters,
          color: readColorRule(input.color),
          camera: null,
          projection: null,
          sections: [],
          box: null,
          xray: null,
          hidden: null,
          offsets: [],
          annotations: [],
          measurements: [],
          categories: { spaces: false, openings: false },
          ghostHidden: false,
        };
        return {
          staged: "view",
          view,
          explains: filters.map((filter) =>
            `${filter.mode === "hide" ? "Hides" : "Shows"} ${describeSelector(filter.selector)}`),
          portable: filters.every((filter) => selectorPortable(filter.selector)),
        };
      },
    },
    {
      id: "definition.property",
      title: "Author a computed property",
      description:
        "Define a derived property the whole app can then use: a fallback chain across property sets, a formula, " +
        "a mapping table, a unit conversion or a geometry quantity. Nothing is saved; the user reviews it.",
      input: {
        type: "object",
        properties: {
          name: { type: "string" },
          kind: { type: "string", description: "coalesce, formula, concat, map, convert, geometry or classification" },
          expression: { type: "string", description: "For kind formula. [Set.Property] or [Property] reads the model." },
          sources: { type: "array", items: { type: "string" }, description: "For coalesce and concat, in order" },
          separator: { type: "string" },
          source: { type: "string", description: "For map and convert" },
          table: { type: "array", items: { type: "array", items: { type: "string" } } },
          factor: { type: "number" },
          offset: { type: "number" },
          measure: { type: "string" },
          fallback: { type: "string" },
          description: { type: "string" },
        },
        required: ["name", "kind"],
        additionalProperties: false,
      },
      effect: "propose",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: false, sdk: false },
      source: "core",
      presentation: { icon: "sliders", plain: "Author a computed property" },
      execute: (input): StagedProperty => {
        const kind = String(input.kind) as ComputedProperty["kind"];
        if (!["formula", "coalesce", "concat", "map", "convert", "geometry", "classification"].includes(kind)) {
          throw new Error(`Unknown computed property kind "${kind}"`);
        }
        if (kind === "formula") {
          const problem = checkFormula(String(input.expression ?? ""));
          if (problem) throw new Error(problem);
        }
        return {
          staged: "property",
          property: {
            name: String(input.name),
            kind,
            description: input.description === undefined ? undefined : String(input.description),
            expression: input.expression === undefined ? undefined : String(input.expression),
            sources: Array.isArray(input.sources) ? input.sources.map(String) : undefined,
            separator: input.separator === undefined ? undefined : String(input.separator),
            source: input.source === undefined ? undefined : String(input.source),
            table: Array.isArray(input.table)
              ? input.table
                  .filter((row): row is unknown[] => Array.isArray(row) && row.length >= 2)
                  .map((row) => [String(row[0]), String(row[1])] as [string, string])
              : undefined,
            factor: input.factor === undefined ? undefined : Number(input.factor),
            offset: input.offset === undefined ? undefined : Number(input.offset),
            measure: input.measure === undefined ? undefined : (String(input.measure) as ComputedProperty["measure"]),
            fallback: input.fallback === undefined ? undefined : String(input.fallback),
          },
        };
      },
    },
    {
      id: "definition.ruleset",
      title: "Author a ruleset",
      description:
        "Assemble the shipped model rules into a named ruleset with the severities and tolerances a project wants, " +
        "each optionally scoped by a query. Nothing runs; the user reviews it in Rule Studio.",
      input: {
        type: "object",
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          rules: {
            type: "array",
            items: {
              type: "object",
              properties: {
                ruleId: { type: "string" },
                title: { type: "string" },
                severity: { type: "string", description: "error, warning or info" },
                scope: SELECTOR_SCHEMA,
                params: { type: "object" },
              },
              required: ["ruleId"],
            },
          },
        },
        required: ["name", "rules"],
        additionalProperties: false,
      },
      effect: "propose",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: false, sdk: false },
      source: "core",
      presentation: { icon: "shield", plain: "Author a ruleset" },
      execute: (input): StagedRuleset => {
        const rules: RuleInstance[] = (Array.isArray(input.rules) ? input.rules : []).map((raw, index) => {
          const entry = raw as Record<string, unknown>;
          const ruleId = String(entry.ruleId ?? "");
          if (!ruleId) throw new Error("Every rule needs a ruleId");
          const severity = String(entry.severity ?? "");
          return {
            id: `${ruleId}-${index + 1}`,
            ruleId,
            title: entry.title === undefined ? undefined : String(entry.title),
            severity: severity === "error" || severity === "warning" || severity === "info" ? severity : undefined,
            enabled: true,
            scope: entry.scope === undefined ? null : readSelector(entry.scope),
            params: typeof entry.params === "object" && entry.params !== null
              ? (entry.params as Record<string, never>)
              : {},
          };
        });
        if (rules.length === 0) throw new Error("A ruleset needs at least one rule");
        return {
          staged: "ruleset",
          ruleset: {
            format: RULESET_FORMAT,
            version: 1,
            name: String(input.name),
            description: String(input.description ?? ""),
            rules,
          },
        };
      },
    },
  ];
}
