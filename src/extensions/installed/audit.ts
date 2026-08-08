import type { ExtensionAuditEntry } from "./types.js";

const KEY = "ifcviewx.extensions.audit.v1";
const LIMIT = 300;

export class ExtensionAuditLog {
  private readonly entries: ExtensionAuditEntry[];

  constructor() {
    try {
      const parsed: unknown = JSON.parse(typeof localStorage === "undefined" ? "[]" : localStorage.getItem(KEY) ?? "[]");
      this.entries = Array.isArray(parsed) ? parsed.filter((entry) => entry && typeof entry === "object").slice(-LIMIT) : [];
    } catch {
      this.entries = [];
    }
  }

  record(entry: Omit<ExtensionAuditEntry, "at">): void {
    this.entries.push({ at: Date.now(), ...entry });
    if (this.entries.length > LIMIT) this.entries.splice(0, this.entries.length - LIMIT);
    try {
      if (typeof localStorage !== "undefined") localStorage.setItem(KEY, JSON.stringify(this.entries));
    } catch {
      // Audit persistence is bounded and best effort.
    }
  }

  list(extensionId?: string): ExtensionAuditEntry[] {
    return this.entries
      .filter((entry) => extensionId === undefined || entry.extensionId === extensionId)
      .map((entry) => ({ ...entry }));
  }
}
