import { h, icon, iconButton, lightDismiss } from "../../ui/kit.js";
import type { ExtensionPermission } from "../../sdk/contributions.js";
import type { ExtensionAuditEntry, ExtensionInstallCandidate } from "./types.js";

interface PermissionPresentation {
  title: string;
  detail: string;
  impact: "read" | "control" | "sensitive";
}

const PERMISSIONS: Record<ExtensionPermission, PermissionPresentation> = {
  "model.summary.read": { title: "Model summary", detail: "Names, schemas, and model counts", impact: "read" },
  "model.structure.read": { title: "Building structure", detail: "Spatial tree and placed element references", impact: "read" },
  "model.properties.read": { title: "Element properties", detail: "Attributes, property sets, and quantities", impact: "read" },
  "model.index.build": { title: "Whole-model index", detail: "Build a searchable index across every property", impact: "sensitive" },
  "geometry.query": { title: "Geometry queries", detail: "Run host distances, clashes, bounds, and sections", impact: "read" },
  "geometry.mesh.read": { title: "Raw geometry", detail: "Read triangle data. Installed extensions cannot receive this permission", impact: "sensitive" },
  "view.read": { title: "View state", detail: "Read selection, visibility, and section planes", impact: "read" },
  "view.control": { title: "Control the view", detail: "Select, isolate, hide, frame, section, and color elements", impact: "control" },
  "view.overlay": { title: "Draw review marks", detail: "Add host-owned lines and markers with quotas", impact: "control" },
  "review.issue.create": { title: "Create review issues", detail: "Add a BCF topic from the current view and chosen elements", impact: "sensitive" },
  "edit.propose": { title: "Propose model edits", detail: "Stage typed changes for your approval", impact: "sensitive" },
  "automation.python": { title: "Python execution", detail: "Run user-authored Python. Installed extensions cannot receive this permission", impact: "sensitive" },
  "file.open": { title: "Open chosen files", detail: "Ask you to select declared file types", impact: "sensitive" },
  "file.export": { title: "Export files", detail: "Create a download through the viewer", impact: "control" },
  "storage.extension": { title: "Save extension settings", detail: "Use quota-limited storage under this extension ID", impact: "read" },
  "assistant.contribute": { title: "Assistant tools", detail: "Offer tools that remain disabled until you approve them", impact: "sensitive" },
  "local.invoke": { title: "Local companion", detail: "Invoke a named Local Studio capability", impact: "sensitive" },
  "viewport.capture": { title: "Viewport capture", detail: "Capture the current rendered view", impact: "sensitive" },
};

export const permissionPresentation = (permission: ExtensionPermission): PermissionPresentation => PERMISSIONS[permission];

export function shortHash(hash: string): string {
  return `${hash.slice(0, 12)}...${hash.slice(-8)}`;
}

function permissionRow(permission: ExtensionPermission, added: boolean): HTMLElement {
  const presentation = PERMISSIONS[permission];
  return h("div", { class: `ext-access-row ${presentation.impact}` }, [
    h("span", { class: "ext-access-mark" }, [icon(presentation.impact === "read" ? "eye" : presentation.impact === "control" ? "focus" : "shield", 13)]),
    h("span", { class: "grow" }, [
      h("span", { class: "ext-access-title", text: presentation.title }),
      h("span", { class: "sub", text: presentation.detail }),
    ]),
    added ? h("span", { class: "pill warn", text: "new" }) : h("span"),
  ]);
}

export function reviewExtensionInstall(candidate: ExtensionInstallCandidate): Promise<boolean> {
  return new Promise((resolve) => {
    const { manifest, hash, bytes } = candidate.prepared;
    const added = new Set(candidate.addedPermissions);
    const dialog = h("dialog", { class: "extension-review", "aria-labelledby": "extension-review-title" }) as HTMLDialogElement;
    const cancel = h("button", { class: "btn", type: "button", text: "Cancel" });
    const actionLabel = candidate.kind === "install" ? "Install extension" : candidate.kind === "downgrade" ? "Install older version" : "Update extension";
    const confirm = h("button", { class: "btn primary", type: "button", text: actionLabel });
    let decided = false;
    const decide = (accepted: boolean): void => {
      if (decided) return;
      decided = true;
      resolve(accepted);
      dialog.close();
    };
    cancel.addEventListener("click", () => decide(false));
    confirm.addEventListener("click", () => decide(true));
    dialog.addEventListener("close", () => {
      if (!decided) {
        decided = true;
        resolve(false);
      }
      dialog.remove();
    });

    const identity = h("div", { class: "ext-permit" }, [
      h("div", { class: "ext-permit-id" }, [
        h("span", { class: "plug-icon lg" }, [icon(manifest.catalog.icon || "blocks", 20)]),
        h("span", { class: "grow" }, [
          h("h2", { id: "extension-review-title", text: manifest.name }),
          h("span", { class: "sub", text: `${manifest.publisher?.name ?? "Unknown publisher"} | version ${manifest.version}` }),
        ]),
      ]),
      h("p", { class: "note", text: manifest.description }),
      h("div", { class: "ext-package-facts" }, [
        h("span", {}, [h("b", { text: "Package" }), h("code", { text: `${Math.ceil(bytes.byteLength / 1024).toLocaleString()} KB` })]),
        h("span", {}, [h("b", { text: "SHA-256" }), h("code", { text: shortHash(hash) })]),
        h("span", {}, [h("b", { text: "Runtime" }), h("code", { text: "isolated frame" })]),
      ]),
    ]);

    const access = h("section", { class: "ext-access" }, [
      h("div", { class: "group-title" }, [
        h("span", { text: candidate.addedPermissions.length ? "Access requested" : "Access unchanged" }),
        h("span", { class: "n", text: String(manifest.permissions.length) }),
      ]),
      ...(manifest.permissions.length
        ? manifest.permissions.map((permission) => permissionRow(permission, added.has(permission)))
        : [h("div", { class: "empty compact", text: "This extension requests no model or view access." })]),
    ]);

    const isolation = h("div", { class: "ext-isolation" }, [
      icon("shield", 14),
      h("span", { text: "Runs without parent-page access, host storage, service credentials, model bytes, direct downloads, or network access. Every viewer call is checked again while it runs." }),
    ]);
    const assistantDisclosure = manifest.permissions.includes("assistant.contribute")
      ? h("div", { class: "note", text: "This extension declares assistant tools. If you enable one in a future assistant integration, its arguments may reach your configured AI provider after a separate approval." })
      : null;
    const companion = manifest.localCompanion
      ? h("div", { class: "note", text: `${manifest.localCompanion.required ? "Requires" : "Can use"} Local Studio companion ${manifest.localCompanion.id} ${manifest.localCompanion.version}. A companion is separate trusted native software and is not installed by this browser package.` })
      : null;
    dialog.append(
      h("div", { class: "dlg-head" }, [icon("shield", 15), h("span", { text: candidate.kind === "install" ? "Review extension access" : "Review extension update" }), iconButton("x", "Close", () => decide(false), "icon-btn dlg-x")]),
      h("div", { class: "dlg-body extension-review-body" }, [
        identity,
        access,
        isolation,
        ...(assistantDisclosure ? [assistantDisclosure] : []),
        ...(companion ? [companion] : []),
      ]),
      h("div", { class: "dlg-foot" }, [cancel, confirm]),
    );
    lightDismiss(dialog);
    document.body.appendChild(dialog);
    dialog.showModal();
    confirm.focus();
  });
}

export function showExtensionAudit(name: string, entries: ExtensionAuditEntry[]): void {
  const dialog = h("dialog", { class: "form-dialog extension-audit", "aria-label": `${name} audit` }) as HTMLDialogElement;
  const close = h("button", { class: "btn primary", type: "button", text: "Done" });
  close.addEventListener("click", () => dialog.close());
  const list = h("div", { class: "ext-audit-list" }, entries.length
    ? entries.slice().reverse().map((entry) => h("div", { class: `ext-audit-row ${entry.outcome}` }, [
      h("time", { text: new Date(entry.at).toLocaleString() }),
      h("b", { text: entry.action }),
      h("span", { text: entry.detail ?? entry.outcome }),
    ]))
    : [h("div", { class: "empty compact", text: "No security-relevant activity has been recorded." })]);
  dialog.append(
    h("div", { class: "dlg-head" }, [icon("clipboard", 14), h("span", { text: `${name} audit` }), iconButton("x", "Close", () => dialog.close(), "icon-btn dlg-x")]),
    h("div", { class: "dlg-body" }, [list]),
    h("div", { class: "dlg-foot" }, [close]),
  );
  dialog.addEventListener("close", () => dialog.remove());
  lightDismiss(dialog);
  document.body.appendChild(dialog);
  dialog.showModal();
}
