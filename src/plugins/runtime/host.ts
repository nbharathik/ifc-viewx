// The panel every running plugin lives in.
//
// Nothing is on screen until a plugin is opened: the panel is the catalog when
// nothing runs, a strip of tabs when something does. Local Studio entries stay
// on the list, greyed, because hiding them would teach nobody that they exist,
// and tools the app already carries are a row of shortcuts rather than a
// second copy of themselves.
import { h, icon, iconButton, toast } from "../../ui/kit.js";
import { emptyState } from "../../ui/shell.js";
import { download, PropertyIndex } from "../../sdk/data.js";
import { createHostContext, type ContextDeps, type PythonRunner } from "./context.js";
import { CATALOG, findPlugin, isBuiltIn, isLive } from "../registry.js";
import type { CatalogPlugin } from "../registry.js";
import type {
  ExtensionCapabilities,
  ExtensionInstance,
  ExtensionIssueInput,
  ExtensionIssueResult,
  ExtensionModule,
} from "../../sdk/types.js";
import type { CommandContribution } from "../../sdk/contributions.js";
import { ExtensionContributionRegistry, ExtensionScope } from "../../extensions/contributions.js";
import { createExtensionContext } from "../../extensions/context.js";
import { ExtensionResultStore } from "../../extensions/results.js";
import type { ResultStore } from "../../capabilities/results.js";
import type { Viewer } from "../../viewer-core/viewer.js";
import type { ServiceClient } from "../../bridge/serviceClient.js";
import type { ColorRule } from "../../ui/colorBy.js";

/** About paragraph and does-list, shared by the panel entry and the browser card. */
export function pluginDetails(plugin: CatalogPlugin): HTMLElement {
  const body = h("div", { class: "plug-inline" }, [
    h("p", { class: "plug-about", text: plugin.about }),
    h("ul", { class: "plug-does" }, plugin.does.map((line) => h("li", { text: line }))),
  ]);
  if (plugin.author || plugin.url) {
    const by = plugin.author ? `By ${plugin.author}` : "";
    body.appendChild(h("div", { class: "plug-by" }, [
      ...(by ? [h("span", { text: by })] : []),
      ...(plugin.url
        ? [h("a", { class: "link", href: plugin.url, target: "_blank", rel: "noreferrer", text: "Source" })]
        : []),
    ]));
  }
  return body;
}

const EXTENSION_FILE_BYTES = 240 * 1024;

function openExtensionFile(accepts: readonly string[]): Promise<{ name: string; mimeType: string; text: string }> {
  return new Promise((resolve, reject) => {
    const input = h("input", { type: "file", accept: accepts.join(","), hidden: true }) as HTMLInputElement;
    let settled = false;
    const finish = (): void => input.remove();
    input.addEventListener("change", () => {
      const file = input.files?.[0];
      if (!file) return;
      settled = true;
      if (file.size > EXTENSION_FILE_BYTES) {
        finish();
        reject(new Error("Extension imports are limited to 240 KB"));
        return;
      }
      void file.text().then((text) => {
        finish();
        resolve({ name: file.name, mimeType: file.type || "text/plain", text });
      }, (error) => {
        finish();
        reject(error);
      });
    }, { once: true });
    window.addEventListener("focus", () => setTimeout(() => {
      if (settled || input.files?.length) return;
      finish();
      reject(new DOMException("File selection cancelled", "AbortError"));
    }), { once: true });
    document.body.appendChild(input);
    input.click();
  });
}

export interface HostActions {
  showPanel(): void;
  setPanelVisible(visible: boolean): void;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  registerCommand(contribution: CommandContribution, run: () => void): () => void;
  createIssue(input: ExtensionIssueInput): Promise<ExtensionIssueResult>;
  setActiveResult(id: string): void;
  modelKey(): string;
  modelName(): string;
  python: PythonRunner;
  /** Keep saved-view colour state synchronized with the core colour dock. */
  setColorRule(rule: ColorRule | null): Promise<void>;
  /** Something opened or closed; repaint the status toggle. */
  changed(): void;
}

interface Running {
  manifest: CatalogPlugin;
  host: HTMLElement;
  instance: ExtensionInstance | null;
  release: () => void;
  /** Handed to mount() when the payload arrived before the module did. */
  pending?: unknown;
}

const OPEN_KEY = "ifcviewx.plugins.open";
let hostSequence = 0;

export class PluginHost {
  private readonly domId = `plugin-host-${++hostSequence}`;
  private readonly container: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly tabList: HTMLElement;
  private readonly body: HTMLElement;
  private readonly blank: HTMLElement;
  private readonly expanded: HTMLDialogElement;
  private readonly expandedBody: HTMLElement;
  private readonly expandedTitle: HTMLElement;
  private readonly expandedClose: HTMLButtonElement;
  private readonly backgroundRoot: HTMLElement;
  private backgroundWasInert = false;
  private restoreFocus: HTMLElement | null = null;
  private expandButton: HTMLButtonElement | null = null;
  private readonly running = new Map<string, Running>();
  private readonly propertyIndex: PropertyIndex;
  private readonly contributions = new ExtensionContributionRegistry();
  private readonly results: ExtensionResultStore;
  private readonly watchers: Record<"model" | "service", Set<() => void>> = {
    model: new Set(),
    service: new Set(),
  };
  private active = "";

  activeId(): string {
    return this.active;
  }

  assistantToolContributions() {
    return this.contributions.list("assistantTools");
  }

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly service: ServiceClient,
    private readonly capabilities: ExtensionCapabilities,
    private readonly actions: HostActions,
    private readonly browse: (id?: string) => void,
    sharedResults?: ResultStore,
  ) {
    this.container = container;
    this.results = new ExtensionResultStore(sharedResults);
    this.propertyIndex = new PropertyIndex(viewer, () => actions.modelKey());
    this.tabList = h("div", {
      class: "plug-tabs",
      role: "tablist",
      "aria-label": "Open plugins",
      "aria-orientation": "horizontal",
    });
    this.tabList.addEventListener("keydown", (event) => this.moveTabFocus(event));
    this.strip = h("div", { class: "plug-strip" }, [this.tabList]);
    this.body = h("div", { class: "plug-body" });
    this.blank = h("div", { class: "page plug-page scroll" });
    this.workspace = h("div", { class: "plug-workspace" }, [this.strip, this.body, this.blank]);
    this.expandedBody = h("div", { class: "plug-expanded-body" });
    this.expandedTitle = h("div", { class: "plug-expanded-title", id: `${this.domId}-expanded-title` });
    this.expandedClose = iconButton(
      "minimize",
      "Return plugin to the inspector",
      () => this.setExpanded(false),
      "icon-btn",
    );
    this.expanded = h("dialog", {
      id: `${this.domId}-expanded`,
      class: "plug-expanded hidden",
      "aria-modal": "true",
      "aria-labelledby": this.expandedTitle.id,
    }, [
      h("div", { class: "plug-expanded-card" }, [
        h("div", { class: "plug-expanded-head" }, [
          this.expandedTitle,
          h("span", { class: "grow" }),
          h("kbd", { class: "plug-expanded-key", text: "Esc" }),
          this.expandedClose,
        ]),
        this.expandedBody,
      ]),
    ]) as HTMLDialogElement;
    this.expanded.addEventListener("click", (event) => {
      if (event.target === this.expanded) this.setExpanded(false);
    });
    this.expanded.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.setExpanded(false);
    });
    this.expanded.addEventListener("keydown", (event) => {
      if (event.key === "Tab") return this.trapExpandedFocus(event);
      if (event.key !== "Escape") return;
      // A plugin can open its own modal on top; that dialog owns Escape first.
      const dialog = (event.target as Element | null)?.closest<HTMLDialogElement>("dialog[open]");
      if (dialog && dialog !== this.expanded) return;
      event.preventDefault();
      this.setExpanded(false);
    });
    container.appendChild(this.workspace);
    document.body.appendChild(this.expanded);
    this.backgroundRoot = container.closest<HTMLElement>("#app") ?? container;
    this.buildCatalog();
    this.paint();
  }

  private buildCatalog(): void {
    const browse = h("button", { class: "link-btn", type: "button", text: "Browse all" });
    browse.addEventListener("click", () => this.browse());
    const shortcuts = CATALOG.filter(isBuiltIn).map((plugin) => {
      const chip = h("button", { class: "chip", type: "button", title: plugin.tagline }, [
        icon(plugin.icon, 13),
        h("span", { text: plugin.name }),
      ]);
      chip.addEventListener("click", () => plugin.command && this.actions.runCommand(plugin.command));
      return chip;
    });
    this.blank.replaceChildren(
      h("div", { class: "group-title" }, [h("span", { text: "In this browser" }), browse]),
      ...CATALOG.filter((plugin) => plugin.tier === "web").map((plugin) => this.entry(plugin)),
      h("div", { class: "tier-split" }, [
        h("span", { class: "tier-title", text: "Local Studio" }),
        h("span", { class: "tier-note", text: "These need the local service. Everything above runs in this tab." }),
      ]),
      ...CATALOG.filter((plugin) => plugin.tier === "local").map((plugin) => this.entry(plugin)),
      h("div", { class: "tier-split" }, [
        h("span", { class: "tier-title", text: "Already in this app" }),
        h("span", { class: "tier-note", text: "These have their own panel on the rail. The catalog points at them rather than repeating them." }),
      ]),
      h("div", { class: "chips" }, shortcuts),
    );
  }

  /** One click runs it; the info toggle explains it without leaving the list. */
  private entry(plugin: CatalogPlugin): HTMLElement {
    const live = isLive(plugin, this.service);
    const off = plugin.soon || !live;
    const row = h("button", {
      class: `plug-entry${off ? " off" : ""}`,
      type: "button",
      title: plugin.soon
        ? `${plugin.name}: planned for Local Studio`
        : live
          ? `Open ${plugin.name}`
          : `${plugin.name} needs Local Studio`,
    }, [
      h("span", { class: `plug-icon sm ${plugin.tier}` }, [icon(plugin.icon, 14)]),
      h("span", { class: "grow" }, [
        h("span", { class: "nm" }, [
          h("b", { text: plugin.name }),
          ...(plugin.soon ? [h("span", { class: "pill", text: "planned" })] : []),
        ]),
        h("span", { class: "sub", text: plugin.tagline }),
      ]),
    ]);
    row.addEventListener("click", () => this.launch(plugin, live));

    const details = pluginDetails(plugin);
    details.classList.add("hidden");
    const info = iconButton("info", `What ${plugin.name} does`, () => {
      const hidden = details.classList.toggle("hidden");
      info.setAttribute("aria-expanded", String(!hidden));
    }, "icon-btn sm plug-entry-info");
    info.setAttribute("aria-expanded", "false");
    return h("div", { class: "plug-entry-wrap" }, [
      h("div", { class: "plug-entry-row" }, [row, info]),
      details,
    ]);
  }

  /** Every surface launches the same way: mount it, run it, or say what it needs. */
  private launch(plugin: CatalogPlugin, live: boolean): void {
    if (plugin.soon) return void toast(`${plugin.name} is not built yet`, "info");
    if (!live) return this.browse(plugin.id);
    if (plugin.load) return void this.open(plugin.id);
    if (plugin.command) this.actions.runCommand(plugin.command);
  }

  index(): PropertyIndex {
    return this.propertyIndex;
  }

  count(): number {
    return this.running.size;
  }

  isOpen(id: string): boolean {
    return this.running.has(id);
  }

  /** Reopen whatever was running when the tab was last closed. */
  restore(): void {
    let ids: string[] = [];
    try {
      const stored: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]");
      // Anything but an array of ids would throw out of startup on the for-of.
      ids = Array.isArray(stored) ? stored.filter((id): id is string => typeof id === "string") : [];
    } catch {
      ids = [];
    }
    for (const id of ids) void this.open(id, false);
  }

  async open(id: string, reveal = true, payload?: unknown): Promise<void> {
    const manifest = findPlugin(id);
    if (!manifest?.load) return;
    const companion = manifest.extension?.localCompanion;
    if (companion?.required && this.service.matchCompanion(companion.id, companion.version).status !== "available") {
      this.actions.log(`${manifest.name} requires Local Studio companion ${companion.id} ${companion.version}`, "error");
      if (reveal) this.browse(id);
      return;
    }
    const live = this.running.get(id);
    if (live) {
      this.select(id);
      if (reveal) this.actions.showPanel();
      // Its module may still be importing, in which case there is nothing to
      // hand the payload to yet; mount() takes it instead.
      if (live.instance) live.instance.receive?.(payload);
      else live.pending = payload;
      return;
    }
    const host = h("div", {
      class: "plug-host",
      id: this.panelId(id),
      role: "tabpanel",
      tabindex: "0",
      "aria-labelledby": this.tabId(id),
    });
    const scoped = createHostContext(manifest, this.deps());
    const extensionScope = manifest.extension
      ? new ExtensionScope(manifest.id, this.contributions)
      : null;
    extensionScope?.registerManifest(manifest.extension!.contributes);
    const release = (): void => {
      extensionScope?.dispose();
      if (manifest.extension) this.results.disposeOwner(manifest.id);
      scoped.release();
    };
    const entry: Running = { manifest, host, instance: null, release };
    this.running.set(id, entry);
    this.body.appendChild(host);
    this.select(id);
    if (reveal) this.actions.showPanel();
    this.persist();
    try {
      const module = await manifest.load();
      // Closed and reopened while the module was importing: this entry is the
      // old one, and mounting into its detached host would be invisible.
      if (this.running.get(id) !== entry) return void entry.release();
      if (!manifest.extension || !extensionScope) throw new Error(`${manifest.name} has no extension manifest`);
      const context = createExtensionContext(manifest.extension, scoped.ctx, extensionScope, {
        registerCommand: (contribution, run) => this.actions.registerCommand(contribution, run),
        results: this.results,
        onResult: (handle) => this.actions.setActiveResult(handle.id),
        addOverlayLine: (a, b) => this.viewer.addMeasurement(a, b).id,
        removeOverlayLine: (measurementId) => this.viewer.removeMeasurement(measurementId),
        openFile: (accepts) => openExtensionFile(accepts),
        exportFile: (name, data, mimeType) => download(name, data, mimeType),
        createIssue: (input) => this.actions.createIssue(input),
      });
      entry.instance = (module as ExtensionModule).mount(host, context, entry.pending ?? payload) ?? null;
      entry.pending = undefined;
    } catch (err) {
      if (this.running.get(id) !== entry) return void entry.release();
      entry.release();
      host.replaceChildren(
        emptyState("alert", `${manifest.name} failed to start`, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  close(id: string): void {
    const entry = this.running.get(id);
    if (!entry) return;
    const focused = this.container.ownerDocument.activeElement;
    entry.release();
    try {
      entry.instance?.dispose?.();
    } catch {
      // a plugin that throws on the way out must not keep its panel alive
    }
    entry.host.remove();
    this.running.delete(id);
    if (this.active === id) this.active = [...this.running.keys()][0] ?? "";
    this.select(this.active);
    this.persist();
    if (this.running.size === 0) this.setExpanded(false);
    // Closing can originate inside the plugin through ctx.close(), not only
    // through host chrome. If the close removed the focused node, leave a
    // useful tab or catalog action focused instead of dropping to <body>.
    if (focused instanceof HTMLElement && !focused.isConnected) {
      if (this.active) this.focusTab(this.active);
      else this.focusWorkspaceFallback();
    }
  }

  contributionCount(owner?: string): number {
    return this.contributions.count(owner);
  }

  select(id: string): void {
    if (id && !this.running.has(id)) return;
    this.active = id;
    for (const [key, entry] of this.running) {
      const hidden = key !== id;
      entry.host.classList.toggle("hidden", hidden);
      entry.host.toggleAttribute("hidden", hidden);
    }
    this.paint();
  }

  /** Called after a load, an edit or an undo. */
  modelChanged(): void {
    this.propertyIndex.invalidate();
    this.emit("model");
    for (const plugin of CATALOG) {
      if (!plugin.installation || !isLive(plugin, this.service) || this.running.has(plugin.id)) continue;
      if (plugin.extension?.activationEvents.includes("onModel")) {
        void this.open(plugin.id, false, { type: "event", name: "model" });
      }
    }
  }

  /** Repaint what the service can offer; called after every connection probe. */
  refresh(): void {
    if (this.running.size === 0) this.paint();
    this.emit("service");
  }

  catalogChanged(): void {
    this.paint();
  }

  private emit(event: "model" | "service"): void {
    for (const handler of [...this.watchers[event]]) {
      try {
        handler();
      } catch (err) {
        console.error(`A plugin threw handling "${event}"`, err);
      }
    }
  }

  private deps(): ContextDeps {
    return {
      viewer: this.viewer,
      service: this.service,
      python: this.actions.python,
      capabilities: this.capabilities,
      index: () => this.propertyIndex,
      setColorRule: (rule) => this.actions.setColorRule(rule),
      modelKey: () => this.actions.modelKey(),
      modelName: () => this.actions.modelName(),
      log: (text, kind) => this.actions.log(text, kind),
      runCommand: (id) => this.actions.runCommand(id),
      close: (id) => this.close(id),
      hostEvent: (event, handler) => {
        this.watchers[event].add(handler);
        return () => this.watchers[event].delete(handler);
      },
    };
  }

  private persist(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(OPEN_KEY, JSON.stringify([...this.running.keys()]));
      }
    } catch (error) {
      // A full or blocked storage area must not interrupt opening or closing a
      // plugin. The live workspace remains authoritative for this session.
      console.warn("Plugin workspace state could not be saved", error);
    }
    this.actions.setPanelVisible(this.running.size > 0);
    this.actions.changed();
  }

  private paint(): void {
    const focused = this.container.ownerDocument.activeElement;
    const focusWasInWorkspace = focused instanceof HTMLElement && this.workspace.contains(focused);
    this.tabList.replaceChildren();
    this.strip.replaceChildren(this.tabList);
    this.blank.classList.toggle("hidden", this.running.size > 0);
    this.strip.classList.toggle("hidden", this.running.size === 0);
    // An empty body still claims its share of the panel, which on a tall screen
    // pushes the catalog to the middle. Nothing running, nothing reserved.
    this.body.classList.toggle("hidden", this.running.size === 0);
    if (this.running.size === 0) this.buildCatalog();
    for (const [id, entry] of this.running) {
      const tab = h("button", {
        class: `plug-tab${id === this.active ? " active" : ""}`,
        id: this.tabId(id),
        type: "button",
        role: "tab",
        tabindex: id === this.active ? "0" : "-1",
        "aria-selected": String(id === this.active),
        "aria-controls": this.panelId(id),
        "data-plugin-id": id,
        title: entry.manifest.tagline,
      }, [icon(entry.manifest.icon, 13), h("span", { text: entry.manifest.name })]);
      tab.addEventListener("click", () => this.select(id));
      this.tabList.appendChild(tab);
    }
    const wide = !this.expanded.classList.contains("hidden");
    if (this.running.size > 0) {
      const active = this.running.get(this.active);
      this.expandButton = iconButton(
        wide ? "minimize" : "maximize",
        wide ? "Return plugins to the inspector" : "Expand plugins to a wide workspace",
        () => this.setExpanded(!wide),
        "icon-btn sm",
      );
      this.expandButton.setAttribute("aria-expanded", String(wide));
      this.expandButton.setAttribute("aria-controls", this.expanded.id);
      this.expandButton.setAttribute("aria-haspopup", "dialog");
      this.strip.append(
        h("span", { class: "grow" }),
        iconButton("x", `Close ${active?.manifest.name ?? "plugin"}`, () => {
          if (this.active) this.close(this.active);
        }, "icon-btn sm"),
        this.expandButton,
        iconButton("blocks", "Browse plugins", () => this.browse(), "icon-btn sm"),
      );
    } else this.expandButton = null;
    this.paintExpandedTitle();
    if (focusWasInWorkspace &&
      (!focused.isConnected || focused.closest(".hidden, [hidden], [inert]"))) {
      if (this.active) this.focusTab(this.active);
      else this.focusWorkspaceFallback();
    }
  }

  /** The wide workspace names the plugin it is showing, not itself. */
  private paintExpandedTitle(): void {
    const manifest = this.running.get(this.active)?.manifest;
    this.expandedTitle.replaceChildren(
      h("span", { class: `plug-icon sm ${manifest?.tier ?? "web"}` }, [icon(manifest?.icon ?? "blocks", 14)]),
      h("span", { class: "grow" }, [
        h("b", { text: manifest?.name ?? "Plugin workspace" }),
        h("small", { text: manifest?.tagline ?? "" }),
      ]),
    );
  }

  private setExpanded(open: boolean): void {
    if (open && this.running.size === 0) return;
    if (open === this.isExpanded()) return;
    if (open) {
      const active = document.activeElement;
      this.restoreFocus = active instanceof HTMLElement && active !== document.body ? active : null;
      this.expandedBody.appendChild(this.workspace);
      this.backgroundWasInert = this.backgroundRoot.hasAttribute("inert");
      this.backgroundRoot.toggleAttribute("inert", true);
      this.expanded.classList.remove("hidden");
      try {
        this.expanded.showModal();
      } catch {
        // jsdom and older embedded webviews do not implement the top layer.
        this.expanded.setAttribute("open", "");
      }
    } else {
      if (this.expanded.open && typeof this.expanded.close === "function") this.expanded.close();
      else this.expanded.removeAttribute("open");
      this.expanded.classList.add("hidden");
      this.container.appendChild(this.workspace);
      this.backgroundRoot.toggleAttribute("inert", this.backgroundWasInert);
    }
    document.body.classList.toggle("plugin-expanded-open", open);
    this.paint();
    if (open) this.expandedClose.focus();
    else {
      // Repainting replaces the opener, so use it only while it is connected
      // and otherwise focus the equivalent new control.
      const target = this.restoreFocus?.isConnected
        ? this.restoreFocus
        : this.expandButton ?? this.container.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])');
      target?.focus();
      this.restoreFocus = null;
    }
  }

  private isExpanded(): boolean {
    return this.expanded.open || !this.expanded.classList.contains("hidden");
  }

  private tabId(id: string): string {
    return `${this.domId}-tab-${encodeURIComponent(id).replaceAll("%", "_")}`;
  }

  private panelId(id: string): string {
    return `${this.domId}-panel-${encodeURIComponent(id).replaceAll("%", "_")}`;
  }

  private focusTab(id: string): void {
    for (const tab of this.tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')) {
      if (tab.dataset.pluginId === id) {
        tab.focus();
        return;
      }
    }
  }

  private moveTabFocus(event: KeyboardEvent): void {
    const target = (event.target as Element | null)?.closest<HTMLButtonElement>('[role="tab"]');
    if (!target || !this.tabList.contains(target)) return;
    if (event.key === "Delete") {
      event.preventDefault();
      const id = target.dataset.pluginId;
      if (!id) return;
      this.close(id);
      return;
    }
    const tabs = [...this.tabList.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const at = tabs.indexOf(target);
    let next = -1;
    if (event.key === "ArrowRight") next = (at + 1) % tabs.length;
    else if (event.key === "ArrowLeft") next = (at - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    const id = tabs[next].dataset.pluginId;
    if (!id) return;
    this.select(id);
  }

  private trapExpandedFocus(event: KeyboardEvent): void {
    const nested = (event.target as Element | null)?.closest<HTMLDialogElement>("dialog[open]");
    if (nested && nested !== this.expanded) return;
    const focusable = [...this.expanded.querySelectorAll<HTMLElement>(
      'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )].filter((node) => !node.closest("[hidden], .hidden, [inert]") && node.getAttribute("aria-hidden") !== "true");
    if (focusable.length === 0) {
      event.preventDefault();
      this.expanded.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !this.expanded.contains(document.activeElement))) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (document.activeElement === last || !this.expanded.contains(document.activeElement))) {
      event.preventDefault();
      first.focus();
    }
  }

  private focusWorkspaceFallback(): void {
    this.container.querySelector<HTMLElement>('button, a[href], [tabindex]:not([tabindex="-1"])')?.focus();
  }
}
