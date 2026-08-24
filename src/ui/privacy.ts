// What this viewer has kept, where it kept it, and one button per thing to
// take it back. Privacy is the product's first claim, and a claim nobody can
// audit is just a slogan: this panel names every store by the name the browser
// or the operating system knows it by, so the user can go and check.
//
// Nothing here is a promise about the future. Each row measures what is on the
// machine right now, and each delete uses the same API a browser's own site
// settings would.
import { confirmAction, h, icon, toast } from "./kit.js";
import { SETTINGS_KEY } from "../llm/llmClient.js";

/** The localStorage key the assistant writes its provider settings into. */
export const LLM_SETTINGS_KEY = SETTINGS_KEY;
/** Everything else the viewer writes is namespaced. */
export const APP_PREFIX = "ifcviewx.";
const CHAT_KEY = "ifcviewx.chats";
const OPFS_DIR = "ifcviewx-cache";

export interface StorageArea {
  id: string;
  label: string;
  /** Where a curious user should go to see it for themselves. */
  where: string;
  detail: string;
  bytes: number;
  items: number;
  /** True when there is something to delete. */
  present: boolean;
  sensitive?: boolean;
  clear(): Promise<void>;
}

/** Local Studio's own paths, read from the service rather than guessed. */
export interface StudioPaths {
  store?: string;
  state?: string;
  audit?: string;
  keySource?: string;
}

const bytesOf = (value: string): number => value.length * 2;

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return "empty";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

function localKeys(match: (key: string) => boolean): string[] {
  const keys: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && match(key)) keys.push(key);
    }
  } catch {
    // A browser with site data blocked throws on access; nothing is stored.
  }
  return keys;
}

function measure(keys: string[]): number {
  let total = 0;
  for (const key of keys) {
    try {
      total += bytesOf(localStorage.getItem(key) ?? "") + bytesOf(key);
    } catch {
      // Skip a key that cannot be read rather than abandoning the count.
    }
  }
  return total;
}

function dropKeys(keys: string[]): void {
  for (const key of keys) {
    try {
      localStorage.removeItem(key);
    } catch {
      // Nothing to do: the value the user asked to remove is unreachable.
    }
  }
}

/** Does the stored assistant record actually carry a key right now. */
export function hasStoredKey(): boolean {
  try {
    const raw = localStorage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return false;
    const parsed: unknown = JSON.parse(raw);
    const key = (parsed as { apiKey?: unknown } | null)?.apiKey;
    return typeof key === "string" && key.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Remove only the secret, leaving the provider and model choice behind. A
 * user clearing a key is usually swapping it, not abandoning the assistant.
 */
export function forgetApiKey(): void {
  try {
    const raw = localStorage.getItem(LLM_SETTINGS_KEY);
    if (!raw) return;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete parsed.apiKey;
    localStorage.setItem(LLM_SETTINGS_KEY, JSON.stringify({ ...parsed, apiKey: "" }));
  } catch {
    dropKeys([LLM_SETTINGS_KEY]);
  }
}

async function opfsSize(): Promise<{ bytes: number; items: number }> {
  try {
    if (!navigator.storage?.getDirectory) return { bytes: 0, items: 0 };
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(OPFS_DIR, { create: false });
    let bytes = 0;
    let items = 0;
    // values() is async-iterable on every engine that ships OPFS at all.
    for await (const entry of (dir as unknown as AsyncIterable<FileSystemHandle>)) {
      if (entry.kind !== "file") continue;
      items += 1;
      bytes += (await (entry as FileSystemFileHandle).getFile()).size;
    }
    return { bytes, items };
  } catch {
    return { bytes: 0, items: 0 };
  }
}

async function clearOpfs(): Promise<void> {
  if (!navigator.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  await root.removeEntry(OPFS_DIR, { recursive: true }).catch(() => undefined);
}

async function cacheSize(): Promise<{ bytes: number; items: number; names: string[] }> {
  try {
    if (!globalThis.caches) return { bytes: 0, items: 0, names: [] };
    const names = (await caches.keys()).filter((name) => name.startsWith("ifcviewx"));
    let bytes = 0;
    let items = 0;
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) {
        items += 1;
        const response = await cache.match(request);
        const blob = await response?.blob();
        bytes += blob?.size ?? 0;
      }
    }
    return { bytes, items, names };
  } catch {
    return { bytes: 0, items: 0, names: [] };
  }
}

/**
 * Every store this viewer writes to, measured now. The assistant key is listed
 * first and on its own, because it is the only value here that would matter to
 * somebody else.
 */
export async function storageInventory(): Promise<StorageArea[]> {
  const settingsKeys = localKeys((key) => key === LLM_SETTINGS_KEY);
  const chatKeys = localKeys((key) => key === CHAT_KEY || key.startsWith(`${CHAT_KEY}.`));
  const appKeys = localKeys(
    (key) => key.startsWith(APP_PREFIX) && key !== CHAT_KEY && !key.startsWith(`${CHAT_KEY}.`),
  );
  const opfs = await opfsSize();
  const shell = await cacheSize();
  const keyed = hasStoredKey();

  return [
    {
      id: "key",
      label: "Assistant API key",
      where: `Browser local storage · ${LLM_SETTINGS_KEY}`,
      detail: keyed
        ? "Held in this browser, for this site only. It is sent to the provider you chose and to nobody else."
        : "No key stored. Local Studio holds its key in the service, so this stays empty when you use it.",
      bytes: measure(settingsKeys),
      items: keyed ? 1 : 0,
      present: keyed,
      sensitive: true,
      clear: async () => forgetApiKey(),
    },
    {
      id: "chats",
      label: "Assistant conversations",
      where: `Browser local storage · ${CHAT_KEY}`,
      detail: "Questions, replies and the tool calls behind them.",
      bytes: measure(chatKeys),
      items: chatKeys.length,
      present: chatKeys.length > 0,
      clear: async () => dropKeys(chatKeys),
    },
    {
      id: "work",
      label: "Views, issues, notes and tool settings",
      where: `Browser local storage · ${APP_PREFIX}*`,
      detail: `${appKeys.length} entries: saved views, filters, selection sets, viewpoints, annotations, issues, computed properties, rulesets and per-plugin settings.`,
      bytes: measure(appKeys),
      items: appKeys.length,
      present: appKeys.length > 0,
      clear: async () => dropKeys(appKeys),
    },
    {
      id: "models",
      label: "Converted model cache",
      where: `Private file system · ${OPFS_DIR}`,
      detail: "Geometry from models you opened, so reopening one is instant. The original IFC files are never copied here.",
      bytes: opfs.bytes,
      items: opfs.items,
      present: opfs.items > 0,
      clear: clearOpfs,
    },
    {
      id: "shell",
      label: "Offline app files",
      where: shell.names.length ? `Cache storage · ${shell.names.join(", ")}` : "Cache storage",
      detail: "The viewer itself, kept so it opens with no network. Contains no model data.",
      bytes: shell.bytes,
      items: shell.items,
      present: shell.items > 0,
      clear: async () => {
        for (const name of shell.names) await caches.delete(name);
      },
    },
  ];
}

export interface PrivacyActions {
  /** Local Studio's paths, when a service is connected. */
  paths(): StudioPaths | null;
  /** Ask the service to open one of its own folders in the file manager. */
  reveal?(which: "store" | "state"): Promise<void>;
  /** Called after anything is deleted, so the app can resync. */
  changed?(): void;
}

/**
 * The "Your data" block of the Settings dialog. Rebuilt on open rather than
 * kept live: these numbers are read off the disk and the panel is not worth a
 * background poll.
 */
export class PrivacyPanel {
  readonly root = h("div", { class: "privacy" });
  private busy = false;

  constructor(private readonly actions: PrivacyActions) {}

  async refresh(): Promise<void> {
    const areas = await storageInventory();
    const rows = areas.map((area) => this.row(area));
    const total = areas.reduce((sum, area) => sum + area.bytes, 0);

    const wipe = h("button", { class: "btn danger", type: "button" }, [
      icon("trash", 13),
      h("span", { text: "Delete everything" }),
    ]);
    wipe.addEventListener("click", () => this.wipe(areas));

    this.root.replaceChildren(
      h("p", { class: "note" }, [
        h("span", {
          text: "Your models are never uploaded. What the viewer does keep, it keeps on this machine, and every line below can be deleted from here. ",
        }),
        h("b", { text: formatBytes(total) }),
        h("span", { text: " stored in total." }),
      ]),
      h("div", { class: "privacy-list" }, rows),
      ...this.studio(),
      h("div", { class: "privacy-foot" }, [
        h("span", { class: "note grow", text: "Deleting everything also signs the assistant out and empties the model cache. It cannot be undone." }),
        wipe,
      ]),
    );
  }

  private row(area: StorageArea): HTMLElement {
    const size = h("span", {
      class: "privacy-size",
      text: area.present ? `${formatBytes(area.bytes)}${area.items > 1 ? ` · ${area.items} items` : ""}` : "Nothing stored",
    });
    const remove = h("button", {
      class: "btn sm",
      type: "button",
      text: area.id === "key" ? "Delete key" : "Delete",
    }) as HTMLButtonElement;
    remove.disabled = !area.present;
    remove.addEventListener("click", () => this.clearOne(area));
    return h("div", { class: `privacy-row${area.sensitive ? " sensitive" : ""}` }, [
      h("div", { class: "privacy-main" }, [
        h("div", { class: "privacy-label" }, [
          h("span", { text: area.label }),
          ...(area.sensitive && area.present ? [h("span", { class: "privacy-tag", text: "secret" })] : []),
        ]),
        h("div", { class: "privacy-where", text: area.where }),
        h("div", { class: "note", text: area.detail }),
      ]),
      h("div", { class: "privacy-actions" }, [size, remove]),
    ]);
  }

  /** Local Studio keeps its own files, so it gets its own paths and buttons. */
  private studio(): HTMLElement[] {
    const paths = this.actions.paths();
    if (!paths) return [];
    const rows: HTMLElement[] = [];
    const line = (label: string, path: string, which?: "store" | "state"): HTMLElement => {
      const copy = h("button", { class: "btn sm", type: "button", text: "Copy path" });
      copy.addEventListener("click", () => {
        void navigator.clipboard
          ?.writeText(path)
          .then(() => toast("Path copied", "success"))
          .catch(() => toast("The browser blocked the clipboard", "error"));
      });
      const open = h("button", { class: "btn sm", type: "button", text: "Open folder" });
      open.addEventListener("click", () => {
        void this.actions
          .reveal?.(which ?? "state")
          .then(() => toast("Opened in your file manager", "success"))
          .catch(() => toast("Local Studio could not open that folder", "error"));
      });
      return h("div", { class: "privacy-row" }, [
        h("div", { class: "privacy-main" }, [
          h("div", { class: "privacy-label" }, [h("span", { text: label })]),
          h("code", { class: "privacy-path", text: path }),
        ]),
        h("div", { class: "privacy-actions" }, [copy, ...(which && this.actions.reveal ? [open] : [])]),
      ]);
    };
    if (paths.store) rows.push(line("Model cache on disk", paths.store, "store"));
    if (paths.state) rows.push(line("Service state and audit log", paths.state, "state"));
    return [
      h("div", { class: "group-title", text: "Local Studio, on this computer" }),
      h("p", { class: "note", text: paths.keySource ?? "Local Studio holds the assistant key in the service process, so this page never sees it." }),
      h("div", { class: "privacy-list" }, rows),
    ];
  }

  private clearOne(area: StorageArea): void {
    if (this.busy) return;
    confirmAction(`Delete ${area.label.toLowerCase()}?`, area.where, "Delete", () => {
      void this.run(area.label, () => area.clear());
    });
  }

  private wipe(areas: StorageArea[]): void {
    if (this.busy) return;
    confirmAction(
      "Delete everything this viewer stored?",
      "The assistant key, conversations, saved views, issues, notes and the model cache all go. Open models stay open until you reload.",
      "Delete everything",
      () => {
        void this.run("Everything stored by this viewer", async () => {
          for (const area of areas) await area.clear().catch(() => undefined);
          // Anything written between the inventory and this click would
          // otherwise survive a delete the user was told was total.
          dropKeys(localKeys((key) => key.startsWith(APP_PREFIX) || key === LLM_SETTINGS_KEY));
        });
      },
    );
  }

  private async run(what: string, job: () => Promise<void>): Promise<void> {
    this.busy = true;
    try {
      await job();
      toast(`${what} deleted`, "success");
      this.actions.changed?.();
      await this.refresh();
    } catch {
      toast(`${what} could not be deleted`, "error");
    } finally {
      this.busy = false;
    }
  }
}
