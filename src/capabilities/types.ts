import type { SemanticActions } from "../llm/actions.js";
import type { Viewer } from "../viewer-core/viewer.js";
import type { ResultStore } from "./results.js";

export type CapabilityEffect = "read" | "view" | "propose" | "write" | "external";

export type CapabilityCost = "instant" | "interactive" | "long";

export type JsonSchema = Record<string, unknown>;

export interface ViewerCapabilityContext {
  viewer: Viewer;
  semantic?: SemanticActions;
  stageEdit?(input: Record<string, unknown>): Promise<string>;
  results?: ResultStore;
  revision?(): string;
  setActiveResult?(id: string, row?: number): void;
  viewport?: HTMLElement;
}

export interface CapabilityExposure {
  assistant?: boolean;
  mcp?: boolean;
  sdk?: boolean;
}

export interface CapabilityAvailability {
  available: boolean;
  reason?: string;
}

export interface CapabilityProgress {
  phase?: string;
  done?: number;
  total?: number;
  message?: string;
}

export interface CapabilityDefinition<
  Input = Record<string, unknown>,
  Output = unknown,
  Context = unknown,
> {
  id: string;
  title: string;
  description: string;
  input: JsonSchema;
  output?: JsonSchema;
  effect: CapabilityEffect;
  permissions: readonly string[];
  cost: CapabilityCost;
  parallelSafe: boolean;
  exposure: CapabilityExposure;
  source?: string;
  presentation?: {
    icon?: string;
    plain?: string;
    legacySyntax?: string;
  };
  available?(context: Context): CapabilityAvailability | Promise<CapabilityAvailability>;
  execute(
    input: Input,
    context: Context,
    signal: AbortSignal,
    reportProgress: (progress: CapabilityProgress) => void,
  ): Output | Promise<Output>;
}

export interface CapabilitySummary {
  id: string;
  title: string;
  description: string;
  input: JsonSchema;
  output?: JsonSchema;
  effect: CapabilityEffect;
  permissions: readonly string[];
  cost: CapabilityCost;
  parallelSafe: boolean;
  exposure: CapabilityExposure;
  source?: string;
  presentation?: {
    icon?: string;
    plain?: string;
    legacySyntax?: string;
  };
}

export interface CapabilityExecutionOptions {
  signal?: AbortSignal;
  onProgress?(progress: CapabilityProgress): void;
}

export class CapabilityError extends Error {
  constructor(
    message: string,
    readonly code:
      | "not_found"
      | "unavailable"
      | "forbidden"
      | "invalid_input"
      | "invalid_output"
      | "aborted",
    readonly capabilityId?: string,
  ) {
    super(message);
    this.name = "CapabilityError";
  }
}
