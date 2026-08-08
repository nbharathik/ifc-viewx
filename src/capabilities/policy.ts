import { CapabilityError, type CapabilityCost, type CapabilityDefinition, type CapabilityEffect } from "./types.js";

const COST_RANK: Record<CapabilityCost, number> = {
  instant: 0,
  interactive: 1,
  long: 2,
};

export interface CapabilityPolicyOptions {
  effects?: Iterable<CapabilityEffect>;
  permissions?: Iterable<string>;
  maxCost?: CapabilityCost;
}

export class CapabilityPolicy {
  private readonly effects: ReadonlySet<CapabilityEffect>;
  private readonly permissions: ReadonlySet<string>;
  private readonly maxCost: CapabilityCost;

  constructor(options: CapabilityPolicyOptions = {}) {
    this.effects = new Set(options.effects ?? ["read", "view", "propose", "write", "external"]);
    this.permissions = new Set(options.permissions ?? []);
    this.maxCost = options.maxCost ?? "long";
  }

  assertAllowed(definition: CapabilityDefinition): void {
    if (!this.effects.has(definition.effect)) {
      throw new CapabilityError(
        `Capability ${definition.id} has effect ${definition.effect}, which is not allowed here`,
        "forbidden",
        definition.id,
      );
    }
    if (COST_RANK[definition.cost] > COST_RANK[this.maxCost]) {
      throw new CapabilityError(
        `Capability ${definition.id} has cost ${definition.cost}, above the ${this.maxCost} limit`,
        "forbidden",
        definition.id,
      );
    }
    for (const permission of definition.permissions) {
      if (!this.permissions.has(permission)) {
        throw new CapabilityError(
          `Capability ${definition.id} requires permission ${permission}`,
          "forbidden",
          definition.id,
        );
      }
    }
  }
}

export const VIEWER_POLICY = new CapabilityPolicy({ effects: ["read", "view"] });
