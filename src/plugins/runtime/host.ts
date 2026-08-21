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

export class PluginHost {
  private readonly container: HTMLElement;
  private readonly workspace: HTMLElement;
  private readonly strip: HTMLElement;
  private readonly body: HTMLElement;
  private readonly blank: HTMLElement;
  private readonly expanded: HTMLElement;
  private readonly expandedBody: HTMLElement;
  private readonly expandedTitle: HTMLElement;
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
    this.strip = h("div", { class: "plug-strip" });
    this.body = h("div", { class: "plug-body" });
    this.blank = h("div", { class: "page plug-page scroll" });
    this.workspace = h("div", { class: "plug-workspace" }, [this.strip, this.body, this.blank]);
    this.expandedBody = h("div", { class: "plug-expanded-body" });
    this.expandedTitle = h("div", { class: "plug-expanded-title" });
    this.expanded = h("div", {
      class: "plug-expanded hidden",
      role: "dialog",
      "aria-modal": "true",
      "aria-label": "Expanded plugin workspace",
    }, [
      h("div", { class: "plug-expanded-card" }, [
        h("div", { class: "plug-expanded-head" }, [
          this.expandedTitle,
          h("span", { class: "grow" }),
          h("kbd", { class: "plug-expanded-key", text: "Esc" }),
          iconButton("minimize", "Return plugin to the inspector  Esc", () => this.setExpanded(false), "icon-btn"),
        ]),
        this.expandedBody,
      ]),
    ]);
    this.expanded.addEventListener("click", (event) => {
      if (event.target === this.expanded) this.setExpanded(false);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || this.expanded.classList.contains("hidden")) return;
      // A plugin can open its own modal on top; that dialog owns Escape first.
      if (this.expanded.querySelector("dialog[open]") ?? document.querySelector("dialog[open]")) return;
      this.setExpanded(false);
    });
    container.appendChild(this.workspace);
    document.body.appendChild(this.expanded);
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
    const host = h("div", { class: "plug-host" });
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
  }

  contributionCount(owner?: string): number {
    return this.contributions.count(owner);
  }

  select(id: string): void {
    if (id && !this.running.has(id)) return;
    this.active = id;
    for (const [key, entry] of this.running) entry.host.classList.toggle("hidden", key !== id);
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
    if (this.running.size === 0) this.buildCatalog();
    this.emit("service");
  }

  catalogChanged(): void {
    if (this.running.size === 0) this.buildCatalog();
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
    localStorage.setItem(OPEN_KEY, JSON.stringify([...this.running.keys()]));
    this.actions.setPanelVisible(this.running.size > 0);
    this.actions.changed();
  }

  private paint(): void {
    this.strip.replaceChildren();
    this.blank.classList.toggle("hidden", this.running.size > 0);
    this.strip.classList.toggle("hidden", this.running.size === 0);
    // An empty body still claims its share of the panel, which on a tall screen
    // pushes the catalog to the middle. Nothing running, nothing reserved.
    this.body.classList.toggle("hidden", this.running.size === 0);
    if (this.running.size === 0) this.buildCatalog();
    for (const [id, entry] of this.running) {
      const tab = h("button", {
        class: `plug-tab${id === this.active ? " active" : ""}`,
        type: "button",
        title: entry.manifest.tagline,
      }, [icon(entry.manifest.icon, 13), h("span", { text: entry.manifest.name })]);
      tab.addEventListener("click", () => this.select(id));
      const shut = iconButton("x", `Close ${entry.manifest.name}`, () => this.close(id), "icon-btn sm");
      this.strip.appendChild(h("span", { class: "plug-tab-wrap" }, [tab, shut]));
    }
    const wide = !this.expanded.classList.contains("hidden");
    if (this.running.size > 0) {
      this.expandButton = iconButton(
        wide ? "minimize" : "maximize",
        wide ? "Return plugins to the inspector" : "Expand plugins to a wide workspace",
        () => this.setExpanded(!wide),
        "icon-btn sm",
      );
      this.expandButton.setAttribute("aria-pressed", String(wide));
      this.strip.append(
        h("span", { class: "grow" }),
        this.expandButton,
        iconButton("blocks", "Browse plugins", () => this.browse(), "icon-btn sm"),
      );
    } else this.expandButton = null;
    this.paintExpandedTitle();
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
    this.expanded.setAttribute("aria-label", manifest ? `${manifest.name} workspace` : "Expanded plugin workspace");
  }

  private setExpanded(open: boolean): void {
    if (open && this.running.size === 0) return;
    if (open === !this.expanded.classList.contains("hidden")) return;
    this.expanded.classList.toggle("hidden", !open);
    document.body.classList.toggle("plugin-expanded-open", open);
    if (open) this.expandedBody.appendChild(this.workspace);
    else this.container.appendChild(this.workspace);
    this.paint();
    // Focus follows the workspace, so closing never drops the caret on <body>.
    if (open) this.expanded.querySelector<HTMLButtonElement>(".plug-expanded-head .icon-btn")?.focus();
    else this.expandButton?.focus();
  }
}
