// The plugin browser: search, filter, read what a plugin does, open it.
//
// One click on a card runs it. Details expand under the card instead of
// replacing the list, so reading about a tool never costs a second click to
// get back or a third to open it. Local Studio plugins are listed with
// everything else so the catalog is honest about what exists, and what the app
// already carries as a panel is a shortcut group rather than a second copy.
import { h, icon, iconButton, lightDismiss, toast } from "../ui/kit.js";
import { CATALOG, isBuiltIn, isLive, pluginDetails, type PluginHost, type PluginManifest } from "./host.js";
import { INSTALL_CMD } from "../ui/connection.js";
import type { ServiceClient } from "../bridge/serviceClient.js";

export interface BrowserActions {
  runCommand(id: string): void;
  openConnection(): void;
}

export class PluginBrowser {
  private readonly dialog: HTMLDialogElement;
  private readonly search: HTMLInputElement;
  private readonly rail: HTMLElement;
  private readonly list: HTMLElement;
  private filter = "All";
  private expanded = new Set<string>();

  constructor(
    private readonly host: PluginHost,
    private readonly service: ServiceClient,
    private readonly actions: BrowserActions,
  ) {
    this.search = h("input", { type: "search", placeholder: "Search plugins", spellcheck: "false" });
    this.search.addEventListener("input", () => this.render());
    this.search.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        const first = this.matches()[0];
        if (first) this.launch(first);
      } else if (e.key === "ArrowDown") {
        e.preventDefault();
        this.list.querySelector<HTMLButtonElement>(".plug-card")?.focus();
      }
    });

    this.rail = h("nav", { class: "plug-cats" });
    this.list = h("div", { class: "plug-list" });

    this.dialog = h("dialog", { id: "plugin-dialog" }, [
      h("div", { class: "dlg-head" }, [
        icon("blocks", 15),
        h("span", { text: "Plugins" }),
        h("span", { class: "plug-search" }, [icon("search", 13), this.search]),
        iconButton("x", "Close", () => this.dialog.close(), "icon-btn dlg-x"),
      ]),
      h("div", { class: "plug-browse" }, [this.rail, h("div", { class: "plug-pane" }, [this.list])]),
    ]) as HTMLDialogElement;
    document.body.appendChild(this.dialog);
    lightDismiss(this.dialog);
  }

  /** With an id, open on that plugin with its details already unfolded. */
  open(id?: string): void {
    if (id) {
      this.filter = "All";
      this.search.value = "";
      this.expanded.add(id);
    }
    this.render();
    if (!this.dialog.open) this.dialog.showModal();
    if (id) {
      this.list.querySelector(`[data-plugin="${id}"]`)?.scrollIntoView({ block: "center" });
    } else {
      this.search.focus();
    }
  }

  private matches(): PluginManifest[] {
    const query = this.search.value.trim().toLowerCase();
    return CATALOG.filter((plugin) => {
      if (this.filter === "Running" && !this.host.isOpen(plugin.id)) return false;
      if (this.filter === "In this browser" && plugin.tier !== "web") return false;
      if (this.filter === "Local Studio" && plugin.tier !== "local") return false;
      if (!query) return true;
      const hay = `${plugin.name} ${plugin.tagline} ${plugin.category} ${plugin.keywords} ${plugin.about}`;
      return query.split(/\s+/).every((word) => hay.toLowerCase().includes(word));
    });
  }

  private render(): void {
    this.renderRail();
    this.renderList();
  }

  /**
   * Where a plugin runs is the only filter worth a rail: the category is on
   * every card already, and one row per category cost more width than it paid.
   */
  private renderRail(): void {
    const running = this.host.count();
    const entries = ["All", "In this browser", "Local Studio"];
    if (running) entries.splice(1, 0, "Running");
    this.rail.replaceChildren();
    for (const entry of entries) {
      const count =
        entry === "Running"
          ? running
          : CATALOG.filter((p) =>
              entry === "All"
                ? true
                : entry === "In this browser"
                  ? p.tier === "web"
                  : p.tier === "local",
            ).length;
      const button = h("button", {
        class: "plug-cat",
        type: "button",
        "aria-pressed": String(entry === this.filter),
      }, [h("span", { class: "grow", text: entry }), h("span", { class: "n", text: String(count) })]);
      button.addEventListener("click", () => {
        this.filter = entry;
        this.render();
      });
      this.rail.appendChild(button);
    }
  }

  private renderList(): void {
    const found = this.matches();
    this.list.replaceChildren();
    if (found.length === 0) {
      this.list.appendChild(h("div", { class: "empty" }, [
        icon("search", 20),
        h("div", { text: "Nothing matches that" }),
        h("div", { class: "sub", text: "Try a tool name, a format, or what you want to do." }),
      ]));
      return;
    }
    // Three groups, always in this order, so where a tool lives is structural
    // rather than something you have to read off a badge.
    const web = found.filter((plugin) => plugin.tier === "web" && !isBuiltIn(plugin));
    const local = found.filter((plugin) => plugin.tier === "local");
    const builtIn = found.filter(isBuiltIn);
    if (web.length) {
      this.list.append(
        h("div", { class: "plug-group", text: "In this browser" }),
        ...web.map((plugin) => this.card(plugin)),
      );
    }
    if (local.length) {
      this.list.append(
        h("div", { class: "plug-group tier" }, [
          h("span", { class: "tier-title", text: "Local Studio" }),
          h("span", { class: "tier-note", text: "Needs the local service; everything above runs in this tab." }),
        ]),
        ...local.map((plugin) => this.card(plugin)),
      );
    }
    if (builtIn.length) {
      this.list.append(
        h("div", { class: "plug-group tier" }, [
          h("span", { class: "tier-title", text: "Already in this app" }),
          h("span", { class: "tier-note", text: "These have their own panel on the rail; this takes you straight there." }),
        ]),
        ...builtIn.map((plugin) => this.card(plugin)),
      );
    }
  }

  private card(plugin: PluginManifest): HTMLElement {
    const running = this.host.isOpen(plugin.id);
    const live = isLive(plugin, this.service);
    const built = isBuiltIn(plugin);
    const open = this.expanded.has(plugin.id);
    const wrap = h("div", {
      class: `plug-card-wrap${open ? " open" : ""}`,
      "data-plugin": plugin.id,
    });

    const card = h("button", {
      class: `plug-card${live && !plugin.soon ? "" : " off"}`,
      type: "button",
      title: plugin.soon
        ? "Not built yet"
        : built
          ? `Go to ${plugin.name}`
          : live
            ? `${running ? "Show" : "Open"} ${plugin.name}`
            : `${plugin.name} needs Local Studio`,
    }, [
      h("span", { class: `plug-icon ${plugin.tier}` }, [icon(plugin.icon, 17)]),
      h("span", { class: "plug-card-text" }, [
        h("span", { class: "plug-card-head" }, [
          h("b", { text: plugin.name }),
          running
            ? h("span", { class: "pill on", text: "open" })
            : plugin.soon
              ? h("span", { class: "pill", text: "planned" })
              : h("span", {}),
        ]),
        h("span", { class: "sub", text: plugin.tagline }),
        h("span", { class: "plug-meta" }, [
          h("span", { class: `plug-tier ${built ? "built" : plugin.tier}` }, [
            icon(built ? "panel-right-close" : plugin.tier === "web" ? "globe" : "server", 11),
            h("span", {
              text: built
                ? "Its own panel"
                : plugin.tier === "web"
                  ? "In this browser"
                  : live
                    ? "Local Studio"
                    : "Needs Local Studio",
            }),
          ]),
          h("span", { class: "dot-sep" }),
          h("span", { text: plugin.category }),
        ]),
      ]),
    ]);
    card.addEventListener("click", () => this.launch(plugin));

    const info = iconButton("info", `What ${plugin.name} does`, () => {
      if (this.expanded.has(plugin.id)) this.expanded.delete(plugin.id);
      else this.expanded.add(plugin.id);
      this.renderList();
      this.list.querySelector(`[data-plugin="${plugin.id}"]`)?.scrollIntoView({ block: "nearest" });
    }, "icon-btn sm plug-info");
    info.setAttribute("aria-pressed", String(open));

    wrap.append(card, info);
    if (open) wrap.appendChild(this.details(plugin, live, running));
    return wrap;
  }

  /** About text, does-list and local-tier actions, folded out under the card. */
  private details(plugin: PluginManifest, live: boolean, running: boolean): HTMLElement {
    const body = pluginDetails(plugin);
    if (plugin.tier === "local") for (const node of this.localSection(live, plugin.soon)) body.appendChild(node);
    if (running) {
      const stop = h("button", { class: "btn sm", type: "button", text: "Close this plugin" });
      stop.addEventListener("click", () => {
        this.host.close(plugin.id);
        this.renderList();
      });
      body.appendChild(h("div", { class: "row" }, [stop]));
    }
    return body;
  }

  private localSection(live: boolean, soon = false): Node[] {
    if (soon) {
      return [
        h("div", { class: "note", text: "Listed so the shape of Local Studio is visible. It needs the local service when it lands; nothing here pretends to run today." }),
      ];
    }
    if (live) {
      return [
        h("div", { class: "plug-ready" }, [
          icon("check", 13),
          h("span", { text: "This is Local Studio, so it runs natively." }),
        ]),
      ];
    }
    const copy = h("button", { class: "btn sm", type: "button", text: "Copy command" });
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(INSTALL_CMD).then(() => toast("Command copied", "success"));
    });
    const connect = h("button", { class: "btn sm accent", type: "button", text: "What's the difference?" });
    connect.addEventListener("click", () => {
      this.dialog.close();
      this.actions.openConnection();
    });
    return [
      h("div", { class: "group-title", text: "Only in Local Studio" }),
      h("p", { class: "note", text: "Local Studio is a separate app, one pip install away. Run it and it opens its own copy of this viewer from your machine, with this already on. Nothing connects to this tab, and your files stay on your machine either way." }),
      h("pre", { class: "shell", text: INSTALL_CMD }),
      h("div", { class: "row" }, [copy, connect]),
    ];
  }

  /** One step from the card: mount it, run it, or say what it needs. */
  private launch(plugin: PluginManifest): void {
    if (plugin.soon) return void toast(`${plugin.name} is not built yet`, "info");
    const live = isLive(plugin, this.service);
    if (!live) {
      this.expanded.add(plugin.id);
      this.renderList();
      this.list.querySelector(`[data-plugin="${plugin.id}"]`)?.scrollIntoView({ block: "center" });
      return;
    }
    this.dialog.close();
    // Plugins with a module get their own panel; the rest point at a tool the
    // app already carries, which is what keeps one catalog honest.
    if (plugin.load) return void this.host.open(plugin.id);
    if (plugin.command) this.actions.runCommand(plugin.command);
  }
}
