import type { ExtensionManifest, ExtensionPermission } from "../../sdk/contributions.js";

export interface InstalledVersionRecord {
  version: string;
  hash: string;
  packageFile: string;
  packageSize: number;
  installedAt: number;
  manifest: ExtensionManifest;
  grantedPermissions: ExtensionPermission[];
}

export interface InstalledExtensionRecord {
  id: string;
  enabled: boolean;
  activeHash: string;
  versions: InstalledVersionRecord[];
}

export interface InstalledExtensionView extends InstalledExtensionRecord {
  sessionDisabled?: string;
}

export interface PreparedExtensionPackage {
  manifest: ExtensionManifest;
  hash: string;
  bytes: Uint8Array;
  files: ReadonlyMap<string, Uint8Array>;
  entryHtml: string;
}

export interface ExtensionInstallCandidate {
  prepared: PreparedExtensionPackage;
  current?: InstalledVersionRecord;
  addedPermissions: ExtensionPermission[];
  removedPermissions: ExtensionPermission[];
  kind: "install" | "update" | "reinstall" | "downgrade";
}

export interface InstalledExtensionChange {
  id: string;
  kind: "initialized" | "installed" | "updated" | "enabled" | "disabled" | "uninstalled" | "rolled-back" | "session-disabled";
}

export interface ExtensionAuditEntry {
  at: number;
  extensionId: string;
  action: string;
  outcome: "allowed" | "denied" | "failed";
  detail?: string;
}
