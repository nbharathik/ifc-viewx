import { CapabilityError, type CapabilityDefinition, type CapabilityExecutionOptions, type CapabilitySummary, type JsonSchema } from "./types.js";
import type { CapabilityPolicy } from "./policy.js";

export interface RegistryExecutionOptions extends CapabilityExecutionOptions {
  policy?: CapabilityPolicy;
}

export function normalizeCapabilityOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  try {
    return JSON.parse(output) as unknown;
  } catch {
    return output;
  }
}

const ID = /^[A-Za-z][A-Za-z0-9]*(?:[._-][A-Za-z0-9]+)*$/;

function typeMatches(value: unknown, expected: unknown): boolean {
  const types = Array.isArray(expected) ? expected : [expected];
  return types.some((type) => {
    if (type === "null") return value === null;
    if (type === "array") return Array.isArray(value);
    if (type === "object") return typeof value === "object" && value !== null && !Array.isArray(value);
    if (type === "integer") return Number.isInteger(value);
    return typeof value === type;
  });
}

function validate(value: unknown, schema: JsonSchema, path: string): string | null {
  if (schema.type !== undefined && !typeMatches(value, schema.type)) {
    return `${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : String(schema.type)}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => Object.is(entry, value))) {
    return `${path} must be one of ${schema.enum.map(String).join(", ")}`;
  }
  if (Array.isArray(value)) {
    const itemSchema = schema.items;
    if (itemSchema && typeof itemSchema === "object" && !Array.isArray(itemSchema)) {
      for (let i = 0; i < value.length; i++) {
        const error = validate(value[i], itemSchema as JsonSchema, `${path}[${i}]`);
        if (error) return error;
      }
    }
  }
  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    const properties = schema.properties && typeof schema.properties === "object"
      ? schema.properties as Record<string, JsonSchema>
      : {};
    const required = Array.isArray(schema.required) ? schema.required.map(String) : [];
    for (const key of required) {
      if (!(key in record)) return `${path}.${key} is required`;
    }
    if (schema.additionalProperties === false) {
      const extra = Object.keys(record).find((key) => !(key in properties));
      if (extra) return `${path}.${extra} is not supported`;
    }
    for (const [key, child] of Object.entries(properties)) {
      if (!(key in record)) continue;
      const error = validate(record[key], child, `${path}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

function summary(definition: CapabilityDefinition): CapabilitySummary {
  return {
    id: definition.id,
    title: definition.title,
    description: definition.description,
    input: definition.input,
    output: definition.output,
    effect: definition.effect,
    permissions: definition.permissions,
    cost: definition.cost,
    parallelSafe: definition.parallelSafe,
    exposure: definition.exposure,
    source: definition.source,
    presentation: definition.presentation,
  };
}

export class CapabilityRegistry<Context> {
  private readonly definitions = new Map<string, CapabilityDefinition<unknown, unknown, Context>>();

  register<Input, Output>(definition: CapabilityDefinition<Input, Output, Context>): () => void {
    if (!ID.test(definition.id)) throw new Error(`Invalid capability id: ${definition.id}`);
    if (this.definitions.has(definition.id)) throw new Error(`Capability already registered: ${definition.id}`);
    this.definitions.set(
      definition.id,
      definition as CapabilityDefinition<unknown, unknown, Context>,
    );
    return () => {
      if (this.definitions.get(definition.id) === definition) this.definitions.delete(definition.id);
    };
  }

  has(id: string): boolean {
    return this.definitions.has(id);
  }

  get(id: string): CapabilitySummary | null {
    const definition = this.definitions.get(id);
    return definition ? summary(definition) : null;
  }

  list(predicate?: (capability: CapabilitySummary) => boolean): CapabilitySummary[] {
    const entries = [...this.definitions.values()].map(summary);
    return predicate ? entries.filter(predicate) : entries;
  }

  async execute<Output = unknown>(
    id: string,
    input: unknown,
    context: Context,
    options: RegistryExecutionOptions = {},
  ): Promise<Output> {
    const definition = this.definitions.get(id);
    if (!definition) throw new CapabilityError(`Unknown capability: ${id}`, "not_found", id);
    options.policy?.assertAllowed(definition);
    const availability = await definition.available?.(context);
    if (availability && !availability.available) {
      throw new CapabilityError(
        availability.reason || `Capability ${id} is unavailable`,
        "unavailable",
        id,
      );
    }
    const error = validate(input, definition.input, "input");
    if (error) throw new CapabilityError(error, "invalid_input", id);
    const signal = options.signal ?? new AbortController().signal;
    if (signal.aborted) throw new CapabilityError(`Capability ${id} was cancelled`, "aborted", id);
    const output = await definition.execute(input, context, signal, options.onProgress ?? (() => undefined));
    if (signal.aborted) throw new CapabilityError(`Capability ${id} was cancelled`, "aborted", id);
    if (definition.output) {
      const outputError = validate(output, definition.output, "output");
      if (outputError) throw new CapabilityError(outputError, "invalid_output", id);
    }
    return output as Output;
  }

  async executeValue<Output = unknown>(
    id: string,
    input: unknown,
    context: Context,
    options: RegistryExecutionOptions = {},
  ): Promise<Output> {
    return normalizeCapabilityOutput(await this.execute(id, input, context, options)) as Output;
  }
}
