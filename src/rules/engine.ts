// Rules beyond IDS.
//
// IDS answers "is the information there?". This answers "is the model
// actually right?", which needs geometry: overlaps, placements, hosts,
// clearances, quantities that disagree with the mesh.
//
// The engine reads a `RuleModel` rather than the viewer, so the same twelve
// rules run against fixtures in a test and against the real BVH in a tab.
import type { ElementRow } from "../sdk/data.js";
import { normalizeSelector, type Selector } from "../views/definition.js";

export type RuleSeverity = "error" | "warning" | "info";

export type ParamValue = string | number | boolean | string[];

export interface RuleParam {
  key: string;
  label: string;
  kind: "number" | "text" | "classes" | "boolean";
  value: ParamValue;
  hint?: string;
}

/** One rule as configured in a ruleset: which rule, how hard, over what. */
export interface RuleInstance {
  id: string;
  ruleId: string;
  title?: string;
  severity?: RuleSeverity;
  enabled?: boolean;
  /** Limits the elements tested. Null tests everything the rule looks at. */
  scope?: Selector | null;
  params?: Record<string, ParamValue>;
}

export const RULESET_FORMAT = "ifcviewx.rules";

export interface Ruleset {
  format: typeof RULESET_FORMAT;
  version: 1;
  name: string;
  description: string;
  rules: RuleInstance[];
}

export interface RuleFinding {
  ruleId: string;
  ruleTitle: string;
  severity: RuleSeverity;
  /** What is wrong with these elements, in one line. */
  title: string;
  ids: number[];
  detail?: string;
  point?: [number, number, number];
}

export interface Box {
  min: [number, number, number];
  max: [number, number, number];
}

export interface StoreyInfo {
  id: number;
  name: string;
  elevation: number | null;
}

export interface ClashHit {
  a: number;
  b: number;
  distance: number;
  point: [number, number, number];
}

/**
 * Everything a rule may read. The browser adapter answers from the viewer and
 * the geometry worker; a test answers from literals.
 */
export interface RuleModel {
  elements(): ElementRow[];
  select(scope: Selector): number[];
  bounds(id: number): Box | null;
  modelBox(): Box | null;
  storeys(): Promise<StoreyInfo[]>;
  clash(a: number[], b: number[], toleranceMm: number, signal?: AbortSignal): Promise<ClashHit[]>;
  volumes(ids: number[], signal?: AbortSignal): Promise<Map<number, { volume: number; closed: boolean }>>;
  signatures(ids: number[], signal?: AbortSignal): Promise<Map<number, { hash: string; translation: [number, number, number] }>>;
}

export interface RuleRunContext {
  model: RuleModel;
  signal?: AbortSignal;
  progress?(done: number, total: number, label: string): void;
}

export interface RuleDefinition {
  id: string;
  title: string;
  description: string;
  category: string;
  severity: RuleSeverity;
  params: RuleParam[];
  /** True when the rule reads geometry, so the UI can warn about cost. */
  geometric?: boolean;
  run(instance: ResolvedRule, context: RuleRunContext): Promise<RuleFinding[]>;
}

/** A rule instance with its defaults filled in, which is what a rule sees. */
export interface ResolvedRule {
  id: string;
  definition: RuleDefinition;
  title: string;
  severity: RuleSeverity;
  scope: Selector | null;
  params: Record<string, ParamValue>;
}

export interface RuleReport {
  ruleset: string;
  findings: RuleFinding[];
  counts: Record<RuleSeverity, number>;
  ran: Array<{ id: string; title: string; findings: number; elapsedMs: number; error?: string }>;
  elapsedMs: number;
}

const REGISTRY = new Map<string, RuleDefinition>();

export function registerRule(definition: RuleDefinition): void {
  REGISTRY.set(definition.id, definition);
}

export function ruleDefinitions(): RuleDefinition[] {
  return [...REGISTRY.values()];
}

export function findRule(id: string): RuleDefinition | undefined {
  return REGISTRY.get(id);
}

export function resolveRule(instance: RuleInstance): ResolvedRule | null {
  const definition = REGISTRY.get(instance.ruleId);
  if (!definition) return null;
  const params: Record<string, ParamValue> = {};
  for (const param of definition.params) {
    const candidate = instance.params?.[param.key];
    const valid = param.kind === "number"
      ? typeof candidate === "number" && Number.isFinite(candidate)
      : param.kind === "boolean"
        ? typeof candidate === "boolean"
        : param.kind === "classes"
          ? Array.isArray(candidate) && candidate.every((entry) => typeof entry === "string")
          : typeof candidate === "string";
    params[param.key] = valid ? candidate as ParamValue : param.value;
  }
  return {
    id: instance.id,
    definition,
    title: instance.title?.trim() || definition.title,
    severity: instance.severity ?? definition.severity,
    scope: instance.scope ?? null,
    params,
  };
}

export const numberParam = (rule: ResolvedRule, key: string, fallback: number): number => {
  const value = Number(rule.params[key]);
  return Number.isFinite(value) ? value : fallback;
};

export const textParam = (rule: ResolvedRule, key: string, fallback = ""): string => {
  const value = rule.params[key];
  return typeof value === "string" ? value : fallback;
};

export const listParam = (rule: ResolvedRule, key: string): string[] => {
  const value = rule.params[key];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((part) => part.trim()).filter(Boolean);
  return [];
};

export const boolParam = (rule: ResolvedRule, key: string, fallback = false): boolean => {
  const value = rule.params[key];
  return typeof value === "boolean" ? value : fallback;
};

/** Rows in scope, or every row when the rule was not narrowed. */
export function scopedRows(rule: ResolvedRule, model: RuleModel): ElementRow[] {
  const rows = model.elements();
  if (!rule.scope) return rows;
  const kept = new Set(model.select(rule.scope));
  return rows.filter((row) => kept.has(row.id));
}

/** Rows whose class is in the list, on top of the rule's own scope. */
export function rowsOfClasses(rule: ResolvedRule, model: RuleModel, classes: string[]): ElementRow[] {
  if (classes.length === 0) return scopedRows(rule, model);
  const wanted = new Set(classes.map((name) => name.toLowerCase().replace(/^ifc/, "")));
  return scopedRows(rule, model).filter((row) => wanted.has(row.type.toLowerCase().replace(/^ifc/, "")));
}

export const centreOf = (box: Box): [number, number, number] => [
  (box.min[0] + box.max[0]) / 2,
  (box.min[1] + box.max[1]) / 2,
  (box.min[2] + box.max[2]) / 2,
];

export const sizeOf = (box: Box): [number, number, number] => [
  Math.max(0, box.max[0] - box.min[0]),
  Math.max(0, box.max[1] - box.min[1]),
  Math.max(0, box.max[2] - box.min[2]),
];

export const boxesOverlap = (a: Box, b: Box, slack = 0): boolean =>
  a.min[0] - slack <= b.max[0] && a.max[0] + slack >= b.min[0] &&
  a.min[1] - slack <= b.max[1] && a.max[1] + slack >= b.min[1] &&
  a.min[2] - slack <= b.max[2] && a.max[2] + slack >= b.min[2];

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

const throwIfAborted = (signal?: AbortSignal): void => {
  if (!signal?.aborted) return;
  if (typeof signal.throwIfAborted === "function") signal.throwIfAborted();
  // `throwIfAborted` is part of the AbortSignal contract, but keep a named
  // fallback for incomplete DOM implementations.
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  throw error;
};

/**
 * Run a ruleset. An ordinary rule failure is reported against its own row so
 * one bad parameter does not lose the other results. Cancellation is different:
 * it rejects the whole run, leaving callers with no partial report to publish.
 */
export async function runRuleset(
  ruleset: Ruleset,
  context: RuleRunContext,
): Promise<RuleReport> {
  throwIfAborted(context.signal);
  const started = Date.now();
  const findings: RuleFinding[] = [];
  const ran: RuleReport["ran"] = [];
  const active = ruleset.rules.filter((rule) => rule.enabled !== false);
  let done = 0;
  for (const instance of active) {
    throwIfAborted(context.signal);
    const rule = resolveRule(instance);
    if (!rule) {
      ran.push({ id: instance.id, title: instance.ruleId, findings: 0, elapsedMs: 0, error: "Unknown rule" });
      continue;
    }
    context.progress?.(done, active.length, rule.title);
    throwIfAborted(context.signal);
    const at = Date.now();
    try {
      const found = await rule.definition.run(rule, context);
      throwIfAborted(context.signal);
      for (const finding of found) findings.push(finding);
      ran.push({ id: rule.id, title: rule.title, findings: found.length, elapsedMs: Date.now() - at });
    } catch (error) {
      if (isAbortError(error)) throw error;
      throwIfAborted(context.signal);
      ran.push({
        id: rule.id,
        title: rule.title,
        findings: 0,
        elapsedMs: Date.now() - at,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    done++;
  }
  throwIfAborted(context.signal);
  context.progress?.(active.length, active.length, "Done");
  const counts: Record<RuleSeverity, number> = { error: 0, warning: 0, info: 0 };
  for (const finding of findings) counts[finding.severity]++;
  return { ruleset: ruleset.name, findings, counts, ran, elapsedMs: Date.now() - started };
}

// -- ruleset files ----------------------------------------------------------

export function serializeRuleset(ruleset: Ruleset): string {
  const normalized = parseRuleset(JSON.stringify(ruleset));
  return JSON.stringify({ ...normalized, format: RULESET_FORMAT, version: 1 }, null, 2);
}

const MAX_RULESET_SOURCE = 1_000_000;
const MAX_RULES = 256;
const MAX_RULESET_NAME = 500;
const MAX_RULESET_DESCRIPTION = 10_000;
const MAX_RULE_TEXT = 500;
const MAX_PARAMS = 64;
const MAX_PARAM_TEXT = 2_000;
const MAX_PARAM_LIST = 256;

const boundedText = (value: unknown, max: number): string | null =>
  typeof value === "string" && value.length <= max ? value : null;

function normalizedParams(value: unknown): Record<string, ParamValue> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  const out: Record<string, ParamValue> = {};
  for (const [key, raw] of Object.entries(value).slice(0, MAX_PARAMS)) {
    if (!key || key.length > 100 || key === "__proto__" || key === "prototype" || key === "constructor") continue;
    if (typeof raw === "boolean" || (typeof raw === "number" && Number.isFinite(raw))) {
      out[key] = raw;
    } else if (typeof raw === "string" && raw.length <= MAX_PARAM_TEXT) {
      out[key] = raw;
    } else if (Array.isArray(raw) && raw.length <= MAX_PARAM_LIST &&
      raw.every((entry) => typeof entry === "string" && entry.length <= MAX_PARAM_TEXT)) {
      out[key] = raw.slice();
    }
  }
  return out;
}

export function parseRuleset(source: string): Ruleset {
  if (source.length > MAX_RULESET_SOURCE) throw new Error("That ruleset is too large");
  const parsed: unknown = JSON.parse(source);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("That file is not a ruleset");
  const value = parsed as Partial<Ruleset>;
  if ((value.format !== undefined && value.format !== RULESET_FORMAT) ||
    (value.version !== undefined && value.version !== 1)) throw new Error("That ruleset format or version is not supported");
  if (!Array.isArray(value.rules)) throw new Error("That ruleset carries no rules");
  if (value.rules.length > MAX_RULES) throw new Error(`A ruleset may contain at most ${MAX_RULES} rules`);
  const rules: RuleInstance[] = [];
  const usedIds = new Set<string>();
  for (const raw of value.rules) {
    if (typeof raw !== "object" || raw === null) continue;
    const rule = raw as RuleInstance;
    const ruleId = boundedText(rule.ruleId, MAX_RULE_TEXT);
    if (!ruleId?.trim()) continue;
    const title = rule.title === undefined ? null : boundedText(rule.title, MAX_RULE_TEXT);
    if (rule.title !== undefined && title === null) throw new Error(`Rule ${ruleId} has an invalid title`);
    let scope: Selector | null = null;
    if (rule.scope !== undefined && rule.scope !== null) {
      scope = normalizeSelector(rule.scope);
      if (!scope) throw new Error(`Rule ${ruleId} has an invalid scope`);
    }
    const requestedId = boundedText(rule.id, MAX_RULE_TEXT)?.trim() || `${ruleId}-${rules.length + 1}`;
    let id = requestedId;
    for (let suffix = 2; usedIds.has(id); suffix++) id = `${requestedId}-${suffix}`;
    usedIds.add(id);
    rules.push({
      id,
      ruleId,
      title: title ?? undefined,
      severity: rule.severity === "error" || rule.severity === "warning" || rule.severity === "info" ? rule.severity : undefined,
      enabled: rule.enabled !== false,
      scope,
      params: normalizedParams(rule.params),
    });
  }
  const name = value.name === undefined ? "Ruleset" : boundedText(value.name, MAX_RULESET_NAME);
  const description = value.description === undefined ? "" : boundedText(value.description, MAX_RULESET_DESCRIPTION);
  if (name === null || !name.trim() || description === null) throw new Error("That ruleset has invalid text fields");
  return {
    format: RULESET_FORMAT,
    version: 1,
    name,
    description,
    rules,
  };
}

/** Every registered rule at its defaults: the starting ruleset. */
export function defaultRuleset(name = "Model receipt"): Ruleset {
  return {
    format: RULESET_FORMAT,
    version: 1,
    name,
    description: "Every shipped rule at its default severity and tolerance.",
    rules: ruleDefinitions().map((definition, index) => ({
      id: `${definition.id}-${index + 1}`,
      ruleId: definition.id,
      enabled: true,
      scope: null,
      params: {},
    })),
  };
}
