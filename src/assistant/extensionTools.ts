import type { RegisteredContribution } from "../extensions/contributions.js";
import type { AssistantToolApproval } from "./capabilityAdapter.js";

const STORAGE_KEY = "ifcviewx.assistant.extension-tools";

function key(owner: string, id: string): string {
  return `${owner}:${id}`;
}

export class ExtensionToolApprovals {
  private readonly enabled = new Set<string>();

  constructor() {
    try {
      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as unknown;
      if (Array.isArray(stored)) {
        for (const entry of stored) if (typeof entry === "string") this.enabled.add(entry);
      }
    } catch {
      this.enabled.clear();
    }
  }

  list(contributions: Array<RegisteredContribution<"assistantTools">>): AssistantToolApproval[] {
    return contributions.map(({ owner, contribution }) => ({
      owner,
      capability: contribution.capability,
      enabled: this.enabled.has(key(owner, contribution.id)),
    }));
  }

  isEnabled(owner: string, id: string): boolean {
    return this.enabled.has(key(owner, id));
  }

  set(owner: string, id: string, enabled: boolean): void {
    const entry = key(owner, id);
    if (enabled) this.enabled.add(entry);
    else this.enabled.delete(entry);
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...this.enabled].sort()));
  }
}
