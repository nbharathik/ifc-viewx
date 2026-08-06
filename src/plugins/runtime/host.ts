// The panel every running plugin lives in.
//
// Nothing is on screen until a plugin is opened: the panel is the catalog when
// nothing runs, a strip of tabs when something does. Local Studio entries stay
// on the list, greyed, because hiding them would teach nobody that they exist,
// and tools the app already carries are a row of shortcuts rather than a
// second copy of themselves.
import { h, icon, iconButton, toast } from "../../ui/kit.js";
import { emptyState } from "../../ui/shell.js";
import { PropertyIndex } from "../../sdk/data.js";
import { createContext, type ContextDeps } from "./context.js";
import { CATALOG, findPlugin, isBuiltIn, isLive } from "../registry.js";
import type { PluginInstance, PluginManifest, PluginPython } from "../../sdk/types.js";
import type { Viewer } from "../../viewer-core/viewer.js";
import type { ServiceClient } from "../../bridge/serviceClient.js";

/** About paragraph and does-list, shared by the panel entry and the browser card. */
export function pluginDetails(plugin: PluginManifest): HTMLElement {
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

export interface HostActions {
  showPanel(): void;
  setPanelVisible(visible: boolean): void;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  modelKey(): string;
  modelName(): string;
  python: PluginPython;
  /** Something opened or closed; repaint the status toggle. */
  changed(): void;
}

interface Running {
  manifest: PluginManifest;
  host: HTMLElement;
  instance: PluginInstance | null;
  release: () => void;
  /** Handed to mount() when the payload arrived before the module did. */
  pending?: unknown;
}

const OPEN_KEY = "ifcviewx.plugins.open";

export class PluginHost {
  private readonly strip: HTMLElement;
  private readonly body: HTMLElement;
  private readonly blank: HTMLElement;
  private readonly running = new Map<string, Running>();
  private readonly propertyIndex: PropertyIndex;
  private readonly watchers: Record<"model" | "service", Set<() => void>> = {
    model: new Set(),
    service: new Set(),
  };
  private active = "";

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly service: ServiceClient,
    private readonly actions: HostActions,
    private readonly browse: (id?: string) => void,
  ) {
    this.propertyIndex = new PropertyIndex(viewer, () => actions.modelKey());
    this.strip = h("div", { class: "plug-strip" });
    this.body = h("div", { class: "plug-body" });
    this.blank = h("div", { class: "page plug-page scroll" });
    container.append(this.strip, this.body, this.blank);
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
  private entry(plugin: PluginManifest): HTMLElement {
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
      const open = details.classList.toggle("hidden");
      info.setAttribute("aria-pressed", String(!open));
    }, "icon-btn sm");
    info.setAttribute("aria-pressed", "false");
    return h("div", { class: "plug-entry-wrap" }, [
      h("div", { class: "plug-entry-row" }, [row, info]),
      details,
    ]);
  }

  /** Every surface launches the same way: mount it, run it, or say what it needs. */
  private launch(plugin: PluginManifest, live: boolean): void {
    if (plugin.soon) return void toast(`${plugin.name} is not built yet`, "info");
    if (plugin.load) return void this.open(plugin.id);
    if (!live) return this.browse(plugin.id);
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
    const scoped = createContext(manifest, this.deps());
    const entry: Running = { manifest, host, instance: null, release: scoped.release };
    this.running.set(id, entry);
    this.body.appendChild(host);
    this.select(id);
    if (reveal) this.actions.showPanel();
    this.persist();
    try {
      const module = await manifest.load();
      // Closed and reopened while the module was importing: this entry is the
      // old one, and mounting into its detached host would be invisible.
      if (this.running.get(id) !== entry) return void scoped.release();
      entry.instance = module.mount(host, scoped.ctx, entry.pending ?? payload) ?? null;
      entry.pending = undefined;
    } catch (err) {
      if (this.running.get(id) !== entry) return void scoped.release();
      host.replaceChildren(
        emptyState("alert", `${manifest.name} failed to start`, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  close(id: string): void {
    const entry = this.running.get(id);
    if (!entry) return;
    try {
      entry.instance?.dispose?.();
    } catch {
      // a plugin that throws on the way out must not keep its panel alive
    }
    entry.release();
    entry.host.remove();
    this.running.delete(id);
    if (this.active === id) this.active = [...this.running.keys()][0] ?? "";
    this.select(this.active);
    this.persist();
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
  }

  /** Repaint what the service can offer; called after every connection probe. */
  refresh(): void {
    if (this.running.size === 0) this.buildCatalog();
    this.emit("service");
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
      index: () => this.propertyIndex,
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
    if (this.running.size > 0) {
      this.strip.append(
        h("span", { class: "grow" }),
        iconButton("blocks", "Browse plugins", () => this.browse(), "icon-btn sm"),
      );
    }
  }
}
