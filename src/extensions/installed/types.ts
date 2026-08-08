import type { ExtensionManifestV2, ExtensionPermission } from "../../sdk/v2/contributions.js";

export interface InstalledVersionRecord {
  version: string;
  hash: string;
  packageFile: string;
  packageSize: number;
  installedAt: number;
  manifest: ExtensionManifestV2;
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
  manifest: ExtensionManifestV2;
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
