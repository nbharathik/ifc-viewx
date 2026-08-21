// Computed properties: derived data the model authors never wrote.
//
// Federated models disagree about where a value lives and what it is called,
// and nobody is remodelling this week. A computed property normalizes that
// once, in a definition everyone shares, and then behaves like any other
// property: it filters, colours, groups, schedules and reports.
//
// Keys land under "Computed.<name>", so every existing property picker finds
// them without knowing they are derived.
import type { ElementRow, Value } from "../sdk/data.js";

export const COMPUTED_SET = "Computed";
export const computedKey = (name: string): string => `${COMPUTED_SET}.${name}`;

export type GeometryMeasure =
  | "boxVolume"
  | "boxArea"
  | "footprint"
  | "height"
  | "width"
  | "depth"
  | "longest";

export type ComputedKind = "formula" | "coalesce" | "concat" | "map" | "convert" | "geometry" | "classification";

export interface ComputedProperty {
  id: string;
  name: string;
  kind: ComputedKind;
  description?: string;
  /** formula */
  expression?: string;
  /** coalesce: first non-empty wins. concat: joined in order. */
  sources?: string[];
  /** concat separator, map/convert source key. */
  separator?: string;
  source?: string;
  /** map: exact, case-insensitive lookup table. */
  table?: Array<[string, string]>;
  fallback?: string;
  /** convert: value * factor + offset. */
  factor?: number;
  offset?: number;
  /** geometry: which bounding measure. */
  measure?: GeometryMeasure;
  /** classification: which system to prefer, blank takes the first. */
  system?: string;
}

export interface ElementGeometry {
  min: [number, number, number];
  max: [number, number, number];
}

export interface ComputeContext {
  /** World bounds of the element, when it has geometry. */
  geometry(id: number): ElementGeometry | null;
}

// -- formula language -------------------------------------------------------

type Node =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; key: string }
  | { t: "bin"; op: string; a: Node; b: Node }
  | { t: "neg"; a: Node }
  | { t: "call"; name: string; args: Node[] };

interface Token {
  kind: "num" | "str" | "ref" | "name" | "op";
  value: string;
}

const OPS = ["<>", "<=", ">=", "+", "-", "*", "/", "%", "^", "&", "=", "<", ">", "(", ")", ","];

export class FormulaError extends Error {}

function lex(source: string): Token[] {
  const tokens: Token[] = [];
  let at = 0;
  while (at < source.length) {
    const ch = source[at];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      at++;
      continue;
    }
    if (ch === "[") {
      const end = source.indexOf("]", at);
      if (end < 0) throw new FormulaError("Unclosed [property reference]");
      tokens.push({ kind: "ref", value: source.slice(at + 1, end).trim() });
      at = end + 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = source.indexOf(ch, at + 1);
      if (end < 0) throw new FormulaError("Unclosed text literal");
      tokens.push({ kind: "str", value: source.slice(at + 1, end) });
      at = end + 1;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(source[at + 1] ?? ""))) {
      const match = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/.exec(source.slice(at));
      if (!match || !Number.isFinite(Number(match[0]))) throw new FormulaError("Invalid number");
      tokens.push({ kind: "num", value: match[0] });
      at += match[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let end = at;
      while (end < source.length && /[A-Za-z0-9_.]/.test(source[end])) end++;
      tokens.push({ kind: "name", value: source.slice(at, end) });
      at = end;
      continue;
    }
    const op = OPS.find((candidate) => source.startsWith(candidate, at));
    if (!op) throw new FormulaError(`Unexpected character "${ch}"`);
    tokens.push({ kind: "op", value: op });
    at += op.length;
  }
  return tokens;
}

/** Precedence climbing: comparisons bind loosest, then &, then arithmetic. */
const BINDING: Record<string, number> = {
  "=": 1, "<>": 1, "<": 1, "<=": 1, ">": 1, ">=": 1,
  "&": 2,
  "+": 3, "-": 3,
  "*": 4, "/": 4, "%": 4,
  "^": 5,
};

function parse(source: string): Node {
  const tokens = lex(source);
  let at = 0;
  const peek = (): Token | undefined => tokens[at];
  const eat = (value: string): void => {
    const token = tokens[at];
    if (!token || token.value !== value) throw new FormulaError(`Expected "${value}"`);
    at++;
  };

  const primary = (): Node => {
    const token = tokens[at];
    if (!token) throw new FormulaError("The formula ends early");
    at++;
    if (token.kind === "num") return { t: "num", v: Number(token.value) };
    if (token.kind === "str") return { t: "str", v: token.value };
    if (token.kind === "ref") return { t: "ref", key: token.value };
    if (token.kind === "name") {
      if (peek()?.value === "(") {
        at++;
        const args: Node[] = [];
        if (peek()?.value !== ")") {
          for (;;) {
            args.push(expression(0));
            if (peek()?.value === ",") {
              at++;
              continue;
            }
            break;
          }
        }
        eat(")");
        return { t: "call", name: token.value.toUpperCase(), args };
      }
      const upper = token.value.toUpperCase();
      if (upper === "TRUE") return { t: "num", v: 1 };
      if (upper === "FALSE") return { t: "num", v: 0 };
      return { t: "ref", key: token.value };
    }
    if (token.value === "(") {
      const inner = expression(0);
      eat(")");
      return inner;
    }
    if (token.value === "-") return { t: "neg", a: primary() };
    throw new FormulaError(`Unexpected "${token.value}"`);
  };

  const expression = (min: number): Node => {
    let left = primary();
    for (;;) {
      const token = peek();
      if (!token || token.kind !== "op") break;
      const power = BINDING[token.value];
      if (power === undefined || power < min) break;
      at++;
      // Exponentiation is the one right-associative binary operator.
      const right = expression(token.value === "^" ? power : power + 1);
      left = { t: "bin", op: token.value, a: left, b: right };
    }
    return left;
  };

  const tree = expression(0);
  if (at !== tokens.length) throw new FormulaError(`Unexpected "${tokens[at].value}"`);
  return tree;
}

const asText = (value: Value): string => (value === null || value === undefined ? "" : String(value));

const asNumber = (value: Value): number | null => {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value === null || value === undefined || value === "") return null;
  // Model data is written by many tools: "12,5 m" has to read as 12.5.
  const cleaned = String(value).replace(/,(?=\d{1,2}(?:\D|$))/, ".").replace(/[^0-9.eE+-]/g, "");
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
};

const truthy = (value: Value): boolean => {
  if (typeof value === "boolean") return value;
  const number = asNumber(value);
  if (number !== null) return number !== 0;
  return asText(value) !== "";
};

type Lookup = (key: string) => Value;

function evaluate(node: Node, lookup: Lookup): Value {
  switch (node.t) {
    case "num":
      return node.v;
    case "str":
      return node.v;
    case "ref":
      return lookup(node.key);
    case "neg": {
      const value = asNumber(evaluate(node.a, lookup));
      return value === null ? null : -value;
    }
    case "bin":
      return binary(node, lookup);
    case "call":
      return call(node, lookup);
  }
}

function binary(node: Extract<Node, { t: "bin" }>, lookup: Lookup): Value {
  const a = evaluate(node.a, lookup);
  const b = evaluate(node.b, lookup);
  if (node.op === "&") return asText(a) + asText(b);
  if (node.op === "=" || node.op === "<>") {
    const numA = asNumber(a);
    const numB = asNumber(b);
    const same = numA !== null && numB !== null
      ? numA === numB
      : asText(a).trim().toLowerCase() === asText(b).trim().toLowerCase();
    return node.op === "=" ? same : !same;
  }
  const left = asNumber(a);
  const right = asNumber(b);
  if (left === null || right === null) {
    if (node.op === "<" || node.op === ">" || node.op === "<=" || node.op === ">=") {
      const textA = asText(a);
      const textB = asText(b);
      const order = textA.localeCompare(textB);
      return node.op === "<" ? order < 0 : node.op === ">" ? order > 0 : node.op === "<=" ? order <= 0 : order >= 0;
    }
    return null;
  }
  switch (node.op) {
    case "+": return left + right;
    case "-": return left - right;
    case "*": return left * right;
    case "/": return right === 0 ? null : left / right;
    case "%": return right === 0 ? null : left % right;
    case "^": return Math.pow(left, right);
    case "<": return left < right;
    case ">": return left > right;
    case "<=": return left <= right;
    case ">=": return left >= right;
  }
  return null;
}

function call(node: Extract<Node, { t: "call" }>, lookup: Lookup): Value {
  const args = (): Value[] => node.args.map((arg) => evaluate(arg, lookup));
  const num = (index: number): number | null => asNumber(evaluate(node.args[index], lookup));
  const str = (index: number): string => asText(evaluate(node.args[index], lookup));
  switch (node.name) {
    case "IF":
      return truthy(evaluate(node.args[0], lookup))
        ? evaluate(node.args[1], lookup)
        : node.args[2] !== undefined ? evaluate(node.args[2], lookup) : null;
    case "AND":
      return args().every(truthy);
    case "OR":
      return args().some(truthy);
    case "NOT":
      return !truthy(evaluate(node.args[0], lookup));
    case "COALESCE": {
      for (const value of args()) {
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return null;
    }
    case "ROUND": {
      const value = num(0);
      const requested = node.args.length > 1 ? (num(1) ?? 0) : 0;
      const digits = Math.max(-12, Math.min(12, Math.trunc(requested)));
      if (value === null) return null;
      const scale = Math.pow(10, digits);
      return Math.round(value * scale) / scale;
    }
    case "FLOOR": { const value = num(0); return value === null ? null : Math.floor(value); }
    case "CEIL": { const value = num(0); return value === null ? null : Math.ceil(value); }
    case "ABS": { const value = num(0); return value === null ? null : Math.abs(value); }
    case "SQRT": { const value = num(0); return value === null || value < 0 ? null : Math.sqrt(value); }
    case "MIN": {
      const values = args().map(asNumber).filter((value): value is number => value !== null);
      return values.length ? values.reduce((lowest, value) => Math.min(lowest, value), Infinity) : null;
    }
    case "MAX": {
      const values = args().map(asNumber).filter((value): value is number => value !== null);
      return values.length ? values.reduce((highest, value) => Math.max(highest, value), -Infinity) : null;
    }
    case "SUM": {
      const values = args().map(asNumber).filter((value): value is number => value !== null);
      return values.length ? values.reduce((total, value) => total + value, 0) : null;
    }
    case "NUMBER": return num(0);
    case "TEXT": return str(0);
    case "UPPER": return str(0).toUpperCase();
    case "LOWER": return str(0).toLowerCase();
    case "TRIM": return str(0).trim();
    case "LEN": return str(0).length;
    case "LEFT": return str(0).slice(0, Math.max(0, num(1) ?? 0));
    case "RIGHT": {
      const count = Math.max(0, num(1) ?? 0);
      return count === 0 ? "" : str(0).slice(-count);
    }
    case "MID": return str(0).substr(Math.max(0, (num(1) ?? 1) - 1), Math.max(0, num(2) ?? 0));
    case "CONTAINS": return str(0).toLowerCase().includes(str(1).toLowerCase());
    case "STARTSWITH": return str(0).toLowerCase().startsWith(str(1).toLowerCase());
    case "ENDSWITH": return str(0).toLowerCase().endsWith(str(1).toLowerCase());
    case "REPLACE": return str(0).split(str(1)).join(str(2));
    case "SPLIT": {
      const parts = str(0).split(str(1));
      const index = Math.max(1, num(2) ?? 1);
      return parts[index - 1] ?? "";
    }
    case "CONCAT": return args().map(asText).join("");
    case "ISBLANK": {
      const value = evaluate(node.args[0], lookup);
      return value === null || value === undefined || value === "";
    }
    default:
      throw new FormulaError(`Unknown function ${node.name}()`);
  }
}

/** Parse a formula, returning the message instead of throwing on bad input. */
export function checkFormula(expression: string): string | null {
  try {
    parse(expression);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : "The formula could not be read";
  }
}

/** Property keys a formula reads, so dependencies can be ordered. */
export function formulaRefs(expression: string): string[] {
  const refs: string[] = [];
  const visit = (node: Node): void => {
    if (node.t === "ref") refs.push(node.key);
    else if (node.t === "bin") { visit(node.a); visit(node.b); }
    else if (node.t === "neg") visit(node.a);
    else if (node.t === "call") node.args.forEach(visit);
  };
  try {
    visit(parse(expression));
  } catch {
    return [];
  }
  return refs;
}

// -- the set ----------------------------------------------------------------

/**
 * A lookup that answers every way a value can be named: the exact
 * "Set.Property" key, a bare property name from any set, a direct attribute,
 * or one of the model facts (Type, Name, Storey, GlobalId).
 */
function rowLookup(row: ElementRow, extra: Record<string, Value>, context: ComputeContext | null): Lookup {
  return (key: string): Value => {
    if (key in extra) return extra[key];
    if (key in row.props) return row.props[key];
    const lower = key.toLowerCase();
    if (lower === "type" || lower === "class") return row.type;
    if (lower === "name") return row.name || (row.attrs.Name ?? null);
    if (lower === "storey" || lower === "level") return row.storey;
    if (lower === "globalid") return row.globalId;
    if (lower === "id") return row.id;
    if (lower.startsWith("geometry.") && context) {
      const box = context.geometry(row.id);
      if (!box) return null;
      return geometryMeasure(box, normalizeMeasure(lower.slice("geometry.".length)));
    }
    for (const [attribute, value] of Object.entries(row.attrs)) {
      if (attribute.toLowerCase() === lower) return value;
    }
    // A bare property name matches whichever set carries it, which is what
    // makes one definition work across models that disagree on set names.
    for (const [propertyKey, value] of Object.entries(row.props)) {
      const dot = propertyKey.lastIndexOf(".");
      if ((dot < 0 ? propertyKey : propertyKey.slice(dot + 1)).toLowerCase() === lower) return value;
    }
    return null;
  };
}

const MEASURES: GeometryMeasure[] = ["boxVolume", "boxArea", "footprint", "height", "width", "depth", "longest"];

/** A formula is written by hand, so the measure name is matched loosely. */
function normalizeMeasure(name: string): GeometryMeasure {
  return MEASURES.find((measure) => measure.toLowerCase() === name.toLowerCase()) ?? "boxVolume";
}

export function geometryMeasure(box: ElementGeometry, measure: GeometryMeasure): number | null {
  const dx = Math.max(0, box.max[0] - box.min[0]);
  const dy = Math.max(0, box.max[1] - box.min[1]);
  const dz = Math.max(0, box.max[2] - box.min[2]);
  const sorted = [dx, dy, dz].sort((a, b) => b - a);
  switch (measure) {
    case "boxVolume": return round(dx * dy * dz);
    case "boxArea": return round(2 * (dx * dy + dy * dz + dz * dx));
    // The viewer is Y-up: footprint, width and depth are horizontal X/Z
    // measures, never a wall or column's elevation area.
    case "footprint": return round(dx * dz);
    case "height": return round(dy);
    case "width": return round(Math.max(dx, dz));
    case "depth": return round(Math.min(dx, dz));
    case "longest": return round(sorted[0]);
    default: return null;
  }
}

const round = (value: number): number => Math.round(value * 1e6) / 1e6;

const CLASSIFICATION_KEYS = ["classification", "uniclass", "omniclass", "assembly code", "assemblycode", "classificationcode"];

/** Evaluate one definition for one element. Returns null when it cannot. */
export function evaluateProperty(
  definition: ComputedProperty,
  row: ElementRow,
  extra: Record<string, Value>,
  context: ComputeContext | null,
): Value {
  const lookup = rowLookup(row, extra, context);
  switch (definition.kind) {
    case "formula": {
      if (!definition.expression) return null;
      try {
        return evaluate(parse(definition.expression), lookup);
      } catch {
        return null;
      }
    }
    case "coalesce": {
      for (const source of definition.sources ?? []) {
        const value = lookup(source);
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return definition.fallback ?? null;
    }
    case "concat": {
      const parts = (definition.sources ?? []).map((source) => {
        // A quoted entry is a literal, so a separator can differ per position.
        if (/^(['"]).*\1$/.test(source)) return source.slice(1, -1);
        return asText(lookup(source));
      });
      const joined = parts.filter((part) => part !== "").join(definition.separator ?? "");
      return joined === "" ? (definition.fallback ?? null) : joined;
    }
    case "map": {
      const value = asText(lookup(definition.source ?? "")).trim().toLowerCase();
      for (const [from, to] of definition.table ?? []) {
        if (from.trim().toLowerCase() === value) return to;
      }
      return definition.fallback ?? null;
    }
    case "convert": {
      const value = asNumber(lookup(definition.source ?? ""));
      if (value === null) return definition.fallback === undefined ? null : Number(definition.fallback);
      return round(value * (definition.factor ?? 1) + (definition.offset ?? 0));
    }
    case "geometry": {
      if (!context) return null;
      const box = context.geometry(row.id);
      return box ? geometryMeasure(box, definition.measure ?? "boxVolume") : null;
    }
    case "classification": {
      const wanted = (definition.system ?? "").trim().toLowerCase();
      for (const [key, value] of Object.entries(row.props)) {
        const lower = key.toLowerCase();
        if (wanted && !lower.includes(wanted)) continue;
        if (!CLASSIFICATION_KEYS.some((candidate) => lower.includes(candidate))) continue;
        if (value !== null && value !== undefined && value !== "") return value;
      }
      return definition.fallback ?? null;
    }
  }
  return null;
}

/**
 * The active definitions, ordered so a property that reads another computed
 * property sees it. A cycle is broken by leaving the later member unresolved
 * rather than looping.
 */
export class ComputedSet {
  private ordered: ComputedProperty[] = [];

  constructor(definitions: ComputedProperty[] = []) {
    this.set(definitions);
  }

  set(definitions: ComputedProperty[]): void {
    this.ordered = order(definitions.filter((definition) => definition.name.trim() !== ""));
  }

  list(): ComputedProperty[] {
    return [...this.ordered];
  }

  keys(): string[] {
    return this.ordered.map((definition) => computedKey(definition.name));
  }

  isEmpty(): boolean {
    return this.ordered.length === 0;
  }

  /** Values for one element, keyed the way every picker expects them. */
  evaluate(row: ElementRow, context: ComputeContext | null): Record<string, Value> {
    const out: Record<string, Value> = {};
    for (const definition of this.ordered) {
      out[computedKey(definition.name)] = evaluateProperty(definition, row, out, context);
    }
    return out;
  }

  /** Write the values onto the row in place, replacing any earlier pass. */
  applyTo(row: ElementRow, context: ComputeContext | null): void {
    for (const key of Object.keys(row.props)) {
      if (key.startsWith(`${COMPUTED_SET}.`)) delete row.props[key];
    }
    Object.assign(row.props, this.evaluate(row, context));
  }
}

/** Definitions sorted so dependencies come first; cycles keep input order. */
function order(definitions: ComputedProperty[]): ComputedProperty[] {
  const byKey = new Map(definitions.map((definition) => [computedKey(definition.name).toLowerCase(), definition]));
  const out: ComputedProperty[] = [];
  const state = new Map<ComputedProperty, "open" | "done">();
  const visit = (definition: ComputedProperty): void => {
    const mark = state.get(definition);
    if (mark) return;
    state.set(definition, "open");
    for (const reference of referencesOf(definition)) {
      const dependency = byKey.get(reference.toLowerCase());
      if (dependency && dependency !== definition && state.get(dependency) !== "open") visit(dependency);
    }
    state.set(definition, "done");
    out.push(definition);
  };
  for (const definition of definitions) visit(definition);
  return out;
}

function referencesOf(definition: ComputedProperty): string[] {
  if (definition.kind === "formula") return formulaRefs(definition.expression ?? "");
  if (definition.kind === "coalesce" || definition.kind === "concat") return definition.sources ?? [];
  if (definition.kind === "map" || definition.kind === "convert") return definition.source ? [definition.source] : [];
  return [];
}

// -- storage ----------------------------------------------------------------

const STORE_KEY = "ifcviewx.computed.v1";
export const COMPUTED_FILE_FORMAT = "ifcviewx.computed";

export interface ComputedFile {
  format: typeof COMPUTED_FILE_FORMAT;
  version: 1;
  properties: ComputedProperty[];
}

export function serializeComputed(definitions: ComputedProperty[]): string {
  if (definitions.length > 256) throw new Error("A computed-property file may contain at most 256 definitions");
  const properties = definitions.map(normalizeDefinition);
  if (properties.some((definition) => definition === null)) {
    throw new Error("A computed-property definition is invalid");
  }
  const file: ComputedFile = {
    format: COMPUTED_FILE_FORMAT,
    version: 1,
    properties: properties as ComputedProperty[],
  };
  return JSON.stringify(file, null, 2);
}

export function parseComputedFile(source: string): ComputedProperty[] {
  if (source.length > 2_000_000) throw new Error("That computed-property file is too large");
  const parsed: unknown = JSON.parse(source);
  let list: unknown;
  if (Array.isArray(parsed)) {
    // Early builds stored the array directly. Keep reading that local format,
    // while all exported files use the versioned envelope below.
    list = parsed;
  } else {
    if (!parsed || typeof parsed !== "object") throw new Error("That file is not a computed-property definition file");
    const file = parsed as Partial<ComputedFile>;
    if (file.format !== COMPUTED_FILE_FORMAT) throw new Error("That file was written by something else");
    if (file.version !== 1) throw new Error("That computed-property file version is not supported");
    list = file.properties;
  }
  if (!Array.isArray(list)) throw new Error("The computed-property file has no property definitions");
  if (list.length > 256) throw new Error("The computed-property file contains too many definitions");
  return list.map(normalizeDefinition).filter((value): value is ComputedProperty => value !== null);
}

const COMPUTED_KINDS: readonly ComputedKind[] = [
  "formula", "coalesce", "concat", "map", "convert", "geometry", "classification",
];

const cleanString = (value: unknown, limit = 8_192): string | undefined =>
  typeof value === "string" ? value.slice(0, limit) : undefined;

const cleanSources = (value: unknown): string[] | undefined => {
  if (!Array.isArray(value)) return undefined;
  const sources = value.slice(0, 256)
    .filter((source): source is string => typeof source === "string")
    .map((source) => source.trim().slice(0, 512))
    .filter(Boolean);
  return sources.length ? sources : undefined;
};

/** Turn untrusted imported JSON into the small definition shape the evaluator accepts. */
function normalizeDefinition(raw: unknown): ComputedProperty | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const value = raw as Record<string, unknown>;
  const name = cleanString(value.name, 128)?.trim();
  if (!name) return null;
  const kind = value.kind === undefined ? "formula"
    : COMPUTED_KINDS.includes(value.kind as ComputedKind) ? value.kind as ComputedKind
      : null;
  if (!kind) return null;
  const definition: ComputedProperty = {
    id: cleanString(value.id, 128)?.trim() || `cp-${Math.random().toString(36).slice(2, 9)}`,
    name,
    kind,
  };
  const description = cleanString(value.description);
  const fallback = cleanString(value.fallback);
  if (description !== undefined) definition.description = description;
  if (fallback !== undefined) definition.fallback = fallback;

  if (kind === "formula") {
    const expression = cleanString(value.expression, 32_768)?.trim();
    if (!expression || checkFormula(expression)) return null;
    definition.expression = expression;
  } else if (kind === "coalesce" || kind === "concat") {
    const sources = cleanSources(value.sources);
    if (!sources) return null;
    definition.sources = sources;
    if (kind === "concat") {
      const separator = cleanString(value.separator, 128);
      if (separator !== undefined) definition.separator = separator;
    }
  } else if (kind === "map") {
    const sourceKey = cleanString(value.source, 512)?.trim();
    if (!sourceKey || !Array.isArray(value.table)) return null;
    const table = value.table.slice(0, 512)
      .filter((row): row is [string, string] => Array.isArray(row) && row.length === 2 &&
        typeof row[0] === "string" && typeof row[1] === "string")
      .map(([from, to]): [string, string] => [from.slice(0, 2_048), to.slice(0, 2_048)]);
    if (!table.length) return null;
    definition.source = sourceKey;
    definition.table = table;
  } else if (kind === "convert") {
    const sourceKey = cleanString(value.source, 512)?.trim();
    if (!sourceKey) return null;
    definition.source = sourceKey;
    if (value.factor !== undefined) {
      if (typeof value.factor !== "number" || !Number.isFinite(value.factor)) return null;
      definition.factor = value.factor;
    }
    if (value.offset !== undefined) {
      if (typeof value.offset !== "number" || !Number.isFinite(value.offset)) return null;
      definition.offset = value.offset;
    }
  } else if (kind === "geometry") {
    definition.measure = MEASURES.includes(value.measure as GeometryMeasure)
      ? value.measure as GeometryMeasure
      : "boxVolume";
  } else {
    const system = cleanString(value.system, 512);
    if (system !== undefined) definition.system = system;
  }
  return definition;
}

export class ComputedStore {
  private definitions: ComputedProperty[] = [];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly storage: Storage | null = safeStorage()) {
    try {
      const raw = this.storage?.getItem(STORE_KEY);
      if (raw) this.definitions = parseComputedFile(raw);
    } catch {
      this.definitions = [];
    }
  }

  list(): ComputedProperty[] {
    return [...this.definitions];
  }

  save(definition: ComputedProperty): boolean {
    const normalized = normalizeDefinition(definition);
    if (!normalized) return false;
    // A computed key is its name. Keeping two definitions with the same name
    // would make evaluation order decide which value silently wins.
    this.definitions = this.definitions.filter((existing) =>
      existing.id === normalized.id || existing.name.toLowerCase() !== normalized.name.toLowerCase());
    const at = this.definitions.findIndex((existing) => existing.id === normalized.id);
    if (at >= 0) this.definitions[at] = normalized;
    else {
      if (this.definitions.length >= 256) return false;
      this.definitions.push(normalized);
    }
    this.write();
    return true;
  }

  remove(id: string): void {
    this.definitions = this.definitions.filter((definition) => definition.id !== id);
    this.write();
  }

  merge(definitions: ComputedProperty[]): number {
    let merged = 0;
    for (const definition of definitions.slice(0, 256)) {
      const normalized = normalizeDefinition(definition);
      if (!normalized) continue;
      this.definitions = this.definitions.filter((entry) =>
        entry.id !== normalized.id && entry.name.toLowerCase() !== normalized.name.toLowerCase());
      if (this.definitions.length >= 256) break;
      this.definitions.push(normalized);
      merged++;
    }
    this.write();
    return merged;
  }

  clear(): void {
    this.definitions = [];
    this.write();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private write(): void {
    try {
      this.storage?.setItem(STORE_KEY, serializeComputed(this.definitions));
    } catch {
      // A full quota must not lose the definitions the session is using.
    }
    for (const listener of this.listeners) listener();
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
}

/** Starting points that are useful on a real federated model. */
export const COMPUTED_TEMPLATES: Array<{ label: string; hint: string; definition: Omit<ComputedProperty, "id"> }> = [
  {
    label: "Fire rating, wherever it lives",
    hint: "First non-empty value across the sets four disciplines each use.",
    definition: {
      name: "Fire rating",
      kind: "coalesce",
      sources: ["Pset_WallCommon.FireRating", "Pset_DoorCommon.FireRating", "FireRating", "Fire_Rating"],
      fallback: "",
      description: "Normalizes FireRating across property sets.",
    },
  },
  {
    label: "Cost code",
    hint: "Classification joined to the type name, the way an estimator groups.",
    definition: {
      name: "Cost code",
      kind: "concat",
      sources: ["Classification", "Type"],
      separator: "-",
      description: "Classification and class as one grouping key.",
    },
  },
  {
    label: "Net area from geometry",
    hint: "Falls back to the bounding footprint where no quantity was authored.",
    definition: {
      name: "Net area",
      kind: "formula",
      expression: "COALESCE([NetArea], [GrossArea], [Geometry.footprint])",
      description: "Authored area first, measured footprint second.",
    },
  },
  {
    label: "Discipline",
    hint: "One tag derived from the IFC class, so one filter spans a federation.",
    definition: {
      name: "Discipline",
      kind: "formula",
      expression:
        "IF(OR(CONTAINS([Type],'Duct'),CONTAINS([Type],'Pipe'),CONTAINS([Type],'Cable'),CONTAINS([Type],'Flow')),'MEP'," +
        "IF(OR(CONTAINS([Type],'Beam'),CONTAINS([Type],'Column'),CONTAINS([Type],'Footing'),CONTAINS([Type],'Slab')),'Structure','Architecture'))",
      description: "MEP, Structure or Architecture from the class name.",
    },
  },
  {
    label: "Volume in cubic metres",
    hint: "A unit conversion, for a model authored in millimetres.",
    definition: {
      name: "Volume m3",
      kind: "convert",
      source: "NetVolume",
      factor: 1,
      offset: 0,
      description: "Scale an authored volume into the reporting unit.",
    },
  },
  {
    label: "Missing classification",
    hint: "A yes/no flag a view can filter on directly.",
    definition: {
      name: "Unclassified",
      kind: "formula",
      expression: "IF(ISBLANK([Classification]),'Yes','No')",
      description: "Yes when no classification reference is present.",
    },
  },
];
