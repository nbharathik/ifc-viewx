import type { ExtensionModule } from "../api.js";
import type { ExtensionPermission } from "../../sdk/contributions.js";
import { validateManifest } from "../manifest.js";
import { ExtensionAuditLog } from "./audit.js";
import {
  browserExtensionStore,
  MemoryExtensionStore,
  type InstalledExtensionStore,
} from "./store.js";
import type {
  ExtensionInstallCandidate,
  InstalledExtensionChange,
  InstalledExtensionRecord,
  InstalledExtensionView,
  InstalledVersionRecord,
} from "./types.js";

type ChangeListener = (change: InstalledExtensionChange) => void;
type CandidateListener = (candidate: ExtensionInstallCandidate) => void;

function active(record: InstalledExtensionRecord): InstalledVersionRecord {
  const version = record.versions.find((entry) => entry.hash === record.activeHash);
  if (!version) throw new Error(`${record.id} has no active installed version`);
  return version;
}

interface VersionPrecedence {
  core: [string, string, string];
  prerelease: string[];
}

function versionPrecedence(value: string): VersionPrecedence {
  const withoutBuild = value.split("+", 1)[0];
  const separator = withoutBuild.indexOf("-");
  const core = (separator < 0 ? withoutBuild : withoutBuild.slice(0, separator)).split(".") as [string, string, string];
  const prerelease = separator < 0 ? [] : withoutBuild.slice(separator + 1).split(".");
  return { core, prerelease };
}

function compareNumericIdentifiers(a: string, b: string): number {
  return a.length - b.length || (a < b ? -1 : a > b ? 1 : 0);
}

/** SemVer 2.0 precedence; build metadata deliberately has no ordering weight. */
function compareVersions(a: string, b: string): number {
  const left = versionPrecedence(a);
  const right = versionPrecedence(b);
  for (let index = 0; index < left.core.length; index++) {
    const relation = compareNumericIdentifiers(left.core[index], right.core[index]);
    if (relation) return relation;
  }
  if (left.prerelease.length === 0 || right.prerelease.length === 0) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length === 0 ? 1 : -1;
  }
  const identifiers = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < identifiers; index++) {
    const l = left.prerelease[index];
    const r = right.prerelease[index];
    if (l === undefined || r === undefined) return l === r ? 0 : l === undefined ? -1 : 1;
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric && rNumeric) return compareNumericIdentifiers(l, r);
    if (lNumeric !== rNumeric) return lNumeric ? -1 : 1;
    return l < r ? -1 : 1;
  }
  return 0;
}

function permissionDiff(
  next: ExtensionPermission[],
  previous: ExtensionPermission[],
): { added: ExtensionPermission[]; removed: ExtensionPermission[] } {
  const before = new Set(previous);
  const after = new Set(next);
  return {
    added: next.filter((permission) => !before.has(permission)),
    removed: previous.filter((permission) => !after.has(permission)),
  };
}

function clearExtensionStorage(id: string): void {
  if (typeof localStorage === "undefined") return;
  const prefix = `ifcviewx.plug.${id}.`;
  const keys: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const key = localStorage.key(index);
    if (key?.startsWith(prefix)) keys.push(key);
  }
  for (const key of keys) localStorage.removeItem(key);
}

export class InstalledExtensionManager {
  readonly audit = new ExtensionAuditLog();
  private readonly records = new Map<string, InstalledExtensionRecord>();
  private readonly sessionDisabled = new Map<string, string>();
  private readonly listeners = new Set<ChangeListener>();
  private readonly candidateListeners = new Set<CandidateListener>();
  private readonly reservedIds = new Set<string>();
  private store: InstalledExtensionStore;
  private devEvents: EventSource | null = null;

  constructor(store: InstalledExtensionStore = browserExtensionStore()) {
    this.store = store;
  }

  reserve(ids: Iterable<string>): void {
    this.reservedIds.clear();
    for (const id of ids) this.reservedIds.add(id);
  }

  async initialize(): Promise<void> {
    let stored: InstalledExtensionRecord[];
    try {
      stored = await this.store.list();
    } catch (error) {
      this.store = new MemoryExtensionStore();
      stored = [];
      this.audit.record({
        extensionId: "host",
        action: "storage.initialize",
        outcome: "failed",
        detail: `Installed extensions are session-only: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    for (const record of stored) {
      try {
        if (this.reservedIds.has(record.id)) throw new Error("id conflicts with a bundled extension");
        const current = active(record);
        const validation = validateManifest(current.manifest, { runtime: "sandboxed" });
        if (!validation.valid || validation.manifest?.id !== record.id) throw new Error("stored manifest is invalid");
        this.records.set(record.id, record);
      } catch (error) {
        this.audit.record({
          extensionId: record.id,
          action: "load",
          outcome: "failed",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }
    this.emit({ id: "*", kind: "initialized" });
  }

  list(): InstalledExtensionView[] {
    return [...this.records.values()]
      .map((record) => ({ ...structuredClone(record), sessionDisabled: this.sessionDisabled.get(record.id) }))
      .sort((a, b) => active(a).manifest.name.localeCompare(active(b).manifest.name));
  }

  get(id: string): InstalledExtensionView | null {
    const record = this.records.get(id);
    return record ? { ...structuredClone(record), sessionDisabled: this.sessionDisabled.get(id) } : null;
  }

  current(id: string): InstalledVersionRecord | null {
    const record = this.records.get(id);
    return record ? structuredClone(active(record)) : null;
  }

  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onInstallCandidate(listener: CandidateListener): () => void {
    this.candidateListeners.add(listener);
    return () => this.candidateListeners.delete(listener);
  }

  async prepare(input: File | Uint8Array): Promise<ExtensionInstallCandidate> {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(await input.arrayBuffer());
    const { prepareExtensionPackage } = await import("./package.js");
    const prepared = await prepareExtensionPackage(bytes);
    if (this.reservedIds.has(prepared.manifest.id) && !this.records.has(prepared.manifest.id)) {
      throw new Error(`${prepared.manifest.id} conflicts with an extension bundled into this viewer`);
    }
    const existing = this.records.get(prepared.manifest.id);
    const current = existing ? active(existing) : undefined;
    const diff = permissionDiff(prepared.manifest.permissions, current?.manifest.permissions ?? []);
    const comparison = current ? compareVersions(prepared.manifest.version, current.version) : 1;
    return {
      prepared,
      current: current ? structuredClone(current) : undefined,
      addedPermissions: diff.added,
      removedPermissions: diff.removed,
      kind: !current ? "install" : current.hash === prepared.hash ? "reinstall" : comparison < 0 ? "downgrade" : "update",
    };
  }

  async install(candidate: ExtensionInstallCandidate): Promise<InstalledExtensionView> {
    const { prepared } = candidate;
    const existing = this.records.get(prepared.manifest.id);
    if (candidate.current?.hash !== existing?.activeHash) {
      throw new Error(`${prepared.manifest.id} changed after its access review; review the package again`);
    }
    const version: InstalledVersionRecord = {
      version: prepared.manifest.version,
      hash: prepared.hash,
      packageFile: `${prepared.hash}.ifcviewx-extension`,
      packageSize: prepared.bytes.byteLength,
      installedAt: Date.now(),
      manifest: structuredClone(prepared.manifest),
      grantedPermissions: [...prepared.manifest.permissions],
    };
    const prior = existing?.versions.filter((entry) => entry.hash !== version.hash) ?? [];
    const record: InstalledExtensionRecord = {
      id: prepared.manifest.id,
      enabled: existing?.enabled ?? true,
      activeHash: version.hash,
      versions: [version, ...prior].slice(0, 2),
    };
    await this.store.save(record, version.packageFile, prepared.bytes);
    this.records.set(record.id, record);
    this.sessionDisabled.delete(record.id);
    const kind = existing ? "updated" : "installed";
    this.audit.record({ extensionId: record.id, action: kind, outcome: "allowed", detail: `${version.version} ${version.hash}` });
    this.emit({ id: record.id, kind });
    return this.get(record.id)!;
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown installed extension ${id}`);
    const next = { ...record, enabled };
    await this.store.writeState(next);
    this.records.set(id, next);
    if (enabled) this.sessionDisabled.delete(id);
    const kind = enabled ? "enabled" : "disabled";
    this.audit.record({ extensionId: id, action: kind, outcome: "allowed" });
    this.emit({ id, kind });
  }

  async rollback(id: string): Promise<void> {
    const record = this.records.get(id);
    if (!record) throw new Error(`Unknown installed extension ${id}`);
    const previous = record.versions.find((entry) => entry.hash !== record.activeHash);
    if (!previous) throw new Error(`${id} has no previous installed version`);
    const next: InstalledExtensionRecord = {
      ...record,
      activeHash: previous.hash,
      versions: [previous, ...record.versions.filter((entry) => entry.hash !== previous.hash)],
    };
    await this.store.writeState(next);
    this.records.set(id, next);
    this.sessionDisabled.delete(id);
    this.audit.record({ extensionId: id, action: "rollback", outcome: "allowed", detail: previous.version });
    this.emit({ id, kind: "rolled-back" });
  }

  async uninstall(id: string): Promise<void> {
    if (!this.records.has(id)) return;
    await this.store.remove(id);
    this.records.delete(id);
    this.sessionDisabled.delete(id);
    try {
      clearExtensionStorage(id);
    } catch (error) {
      this.audit.record({
        extensionId: id,
        action: "storage.remove",
        outcome: "failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    this.audit.record({ extensionId: id, action: "uninstall", outcome: "allowed" });
    this.emit({ id, kind: "uninstalled" });
  }

  disableForSession(id: string, reason: string): void {
    if (!this.records.has(id)) return;
    this.sessionDisabled.set(id, reason);
    this.emit({ id, kind: "session-disabled" });
  }

  async loadModule(id: string): Promise<ExtensionModule> {
    const record = this.records.get(id);
    if (!record || !record.enabled) throw new Error(`${id} is disabled`);
    const sessionReason = this.sessionDisabled.get(id);
    if (sessionReason) throw new Error(`${id} is disabled for this session: ${sessionReason}`);
    const version = active(record);
    const bytes = await this.store.readPackage(id, version.packageFile);
    const [{ prepareExtensionPackage }, { sandboxExtensionModule }] = await Promise.all([
      import("./package.js"),
      import("./sandbox.js"),
    ]);
    const prepared = await prepareExtensionPackage(bytes);
    if (prepared.hash !== version.hash || prepared.manifest.id !== id) {
      const reason = "The stored package failed its integrity check";
      this.disableForSession(id, reason);
      throw new Error(reason);
    }
    return sandboxExtensionModule(prepared.entryHtml, prepared.manifest, {
      audit: this.audit,
      onCrash: (extensionId, reason) => this.disableForSession(extensionId, reason),
    });
  }

  async connectDevelopment(url: string): Promise<() => void> {
    const base = new URL(url);
    if (base.protocol !== "http:" || (base.hostname !== "127.0.0.1" && base.hostname !== "localhost")) {
      throw new Error("The extension development server must use localhost over HTTP");
    }
    base.pathname = base.pathname.endsWith("/") ? base.pathname : `${base.pathname}/`;
    const refresh = async (): Promise<void> => {
      const response = await fetch(new URL("extension.ifcviewx-extension", base));
      if (!response.ok) throw new Error(`Development package request failed with ${response.status}`);
      const candidate = await this.prepare(new Uint8Array(await response.arrayBuffer()));
      const current = this.records.get(candidate.prepared.manifest.id);
      if (current && candidate.addedPermissions.length === 0) await this.install(candidate);
      else for (const listener of this.candidateListeners) listener(candidate);
    };
    await refresh();
    this.devEvents?.close();
    const events = new EventSource(new URL("events", base));
    events.addEventListener("change", () => void refresh().catch((error) => {
      this.audit.record({ extensionId: "dev", action: "reload", outcome: "failed", detail: error instanceof Error ? error.message : String(error) });
    }));
    this.devEvents = events;
    return () => {
      events.close();
      if (this.devEvents === events) this.devEvents = null;
    };
  }

  private emit(change: InstalledExtensionChange): void {
    for (const listener of this.listeners) listener(change);
  }
}

export function activeInstalledVersion(record: InstalledExtensionView): InstalledVersionRecord {
  return active(record);
}
