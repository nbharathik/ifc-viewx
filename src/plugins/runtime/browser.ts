// The plugin browser: search, filter, read what a plugin does, open it.
//
// One click on a card runs it. Details expand under the card instead of
// replacing the list, so reading about a tool never costs a second click to
// get back or a third to open it. Local Studio plugins are listed with
// everything else so the catalog is honest about what exists, and what the app
// already carries as a panel is a shortcut group rather than a second copy.
import { confirmAction, h, icon, iconButton, lightDismiss, toast } from "../../ui/kit.js";
import { INSTALL_CMD } from "../../ui/connection.js";
import { CATALOG, isBuiltIn, isLive } from "../registry.js";
import type { CatalogPlugin } from "../registry.js";
import { pluginDetails, type PluginHost } from "./host.js";
import type { ServiceClient } from "../../bridge/serviceClient.js";
import { InstalledExtensionManager, activeInstalledVersion } from "../../extensions/installed/manager.js";
import { permissionPresentation, reviewExtensionInstall, shortHash, showExtensionAudit } from "../../extensions/installed/ui.js";
import type { ExtensionInstallCandidate } from "../../extensions/installed/types.js";

export interface BrowserActions {
  runCommand(id: string): void;
  openConnection(): void;
}

export class PluginBrowser {
  private readonly dialog: HTMLDialogElement;
  private readonly search: HTMLInputElement;
  private readonly rail: HTMLElement;
  private readonly list: HTMLElement;
  private readonly installInput: HTMLInputElement;
  private filter = "All";
  private expanded = new Set<string>();

  constructor(
    private readonly host: PluginHost,
    private readonly service: ServiceClient,
    private readonly actions: BrowserActions,
    private readonly installed: InstalledExtensionManager,
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
    this.installInput = h("input", { type: "file", accept: ".ifcviewx-extension,.zip", class: "hidden" });
    this.installInput.addEventListener("change", () => {
      const file = this.installInput.files?.[0];
      this.installInput.value = "";
      if (file) void this.prepareInstall(file);
    });
    const install = h("button", { class: "btn sm ext-install", type: "button" }, [icon("upload", 12), h("span", { text: "Install file" })]);
    install.addEventListener("click", () => this.installInput.click());

    this.dialog = h("dialog", { id: "plugin-dialog" }, [
      h("div", { class: "dlg-head" }, [
        icon("blocks", 15),
        h("span", { text: "Plugins" }),
        h("span", { class: "plug-search" }, [icon("search", 13), this.search]),
        install,
        iconButton("x", "Close", () => this.dialog.close(), "icon-btn dlg-x"),
      ]),
      h("div", { class: "plug-browse" }, [this.rail, h("div", { class: "plug-pane" }, [this.list])]),
      this.installInput,
    ]) as HTMLDialogElement;
    document.body.appendChild(this.dialog);
    lightDismiss(this.dialog);
    installed.onInstallCandidate((candidate) => void this.reviewInstall(candidate));
  }

  refresh(): void {
    if (this.dialog.open) this.render();
  }

  async reviewInstall(candidate: ExtensionInstallCandidate): Promise<void> {
    if (!await reviewExtensionInstall(candidate)) return;
    try {
      await this.installed.install(candidate);
      toast(`${candidate.prepared.manifest.name} ${candidate.kind === "install" ? "installed" : "updated"}`, "success");
      this.refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
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

  private inFilter(plugin: CatalogPlugin, filter: string): boolean {
    if (filter === "All") return true;
    if (filter === "Running") return this.host.isOpen(plugin.id);
    if (filter === "Installed") return plugin.installation !== undefined;
    if (filter === "In this browser") return plugin.tier !== "local" && !plugin.installation;
    return plugin.tier === "local";
  }

  private matches(): CatalogPlugin[] {
    const query = this.search.value.trim().toLowerCase();
    return CATALOG.filter((plugin) => {
      if (!this.inFilter(plugin, this.filter)) return false;
      if (!query) return true;
      const hay = `${plugin.name} ${plugin.tagline} ${plugin.category} ${plugin.keywords} ${plugin.about} ${plugin.author ?? ""}`;
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
    const entries = ["All", "Installed", "In this browser", "Local Studio"];
    if (running) entries.splice(1, 0, "Running");
    this.rail.replaceChildren();
    for (const entry of entries) {
      const count = CATALOG.filter((plugin) => this.inFilter(plugin, entry)).length;
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
    const installed = found.filter((plugin) => plugin.installation);
    const web = found.filter((plugin) => plugin.tier === "web" && !plugin.installation);
    const local = found.filter((plugin) => plugin.tier === "local");
    const builtIn = found.filter(isBuiltIn);
    if (installed.length) {
      this.list.append(
        h("div", { class: "plug-group tier" }, [
          h("span", { class: "tier-title", text: "Installed here" }),
          h("span", { class: "tier-note", text: "Local packages. Disabled entries do not load their panel code." }),
        ]),
        ...installed.map((plugin) => this.card(plugin)),
      );
    }
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

  private card(plugin: CatalogPlugin): HTMLElement {
    const running = this.host.isOpen(plugin.id);
    const live = isLive(plugin, this.service);
    const built = isBuiltIn(plugin);
    const installation = plugin.installation;
    const companion = plugin.extension?.localCompanion;
    const companionMatch = companion
      ? this.service.matchCompanion(companion.id, companion.version)
      : null;
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
            : installation
              ? installation.sessionDisabled
                ? `${plugin.name} is disabled for this session`
                : !installation.enabled
                  ? `${plugin.name} is disabled`
                  : companion?.required && companionMatch?.status !== "available"
                    ? `${plugin.name} needs Local Studio companion ${companion.id} ${companion.version}`
                    : `${plugin.name} is unavailable`
              : `${plugin.name} needs Local Studio`,
    }, [
      h("span", { class: `plug-icon ${installation ? "installed" : plugin.tier}` }, [icon(plugin.icon, 17)]),
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
          h("span", { class: `plug-tier ${installation ? "installed" : built ? "built" : plugin.tier}` }, [
            icon(installation ? "shield" : built ? "panel-right-close" : plugin.tier === "web" ? "globe" : "server", 11),
            h("span", {
              text: installation
                ? installation.sessionDisabled ? "Session blocked" : installation.enabled ? `Installed ${activeInstalledVersion(installation).version}` : "Installed, disabled"
                : built
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
      const next = this.list.querySelector<HTMLElement>(`[data-plugin="${plugin.id}"]`);
      next?.scrollIntoView({ block: "nearest" });
      next?.querySelector<HTMLButtonElement>(".plug-info")?.focus();
    }, "icon-btn sm plug-info");
    info.setAttribute("aria-expanded", String(open));

    wrap.append(card, info);
    if (open) wrap.appendChild(this.details(plugin, live, running));
    return wrap;
  }

  /** About text, does-list and local-tier actions, folded out under the card. */
  private details(plugin: CatalogPlugin, live: boolean, running: boolean): HTMLElement {
    const body = pluginDetails(plugin);
    if (plugin.installation) body.appendChild(this.installedSection(plugin));
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

  private installedSection(plugin: CatalogPlugin): HTMLElement {
    const installation = plugin.installation!;
    const current = activeInstalledVersion(installation);
    const state = installation.sessionDisabled
      ? h("div", { class: "note ext-blocked", text: installation.sessionDisabled })
      : h("div", { class: `plug-ready${installation.enabled ? "" : " muted"}` }, [
        icon(installation.enabled ? "check" : "eye-off", 13),
        h("span", { text: installation.enabled ? "Enabled. Code loads only when you open it or run one of its commands." : "Disabled. No frame, worker, timer, or package code is active." }),
      ]);
    const facts = h("div", { class: "ext-manage-facts" }, [
      h("span", {}, [h("b", { text: "Version" }), h("code", { text: current.version })]),
      h("span", {}, [h("b", { text: "SHA-256" }), h("code", { text: shortHash(current.hash) })]),
      h("span", {}, [h("b", { text: "Size" }), h("code", { text: `${Math.ceil(current.packageSize / 1024).toLocaleString()} KB` })]),
    ]);
    const access = h("div", { class: "ext-access compact" }, [
      h("div", { class: "group-title", text: "Granted access" }),
      ...(current.grantedPermissions.length
        ? current.grantedPermissions.map((permission) => h("div", { class: "ext-access-mini" }, [
          icon("check", 11), h("span", { text: permissionPresentation(permission).title }),
        ]))
        : [h("span", { class: "note", text: "No model or view permissions." })]),
    ]);
    const companion = current.manifest.localCompanion;
    const companionNode = companion ? this.companionState(companion) : null;
    const toggle = h("button", { class: "btn sm", type: "button", text: installation.enabled && !installation.sessionDisabled ? "Disable" : "Enable" });
    const activeNow = installation.enabled && !installation.sessionDisabled;
    toggle.addEventListener("click", () => void this.manage(async () => {
      this.host.close(plugin.id);
      await this.installed.setEnabled(plugin.id, !activeNow);
    }, activeNow ? "Extension disabled" : "Extension enabled"));
    const rollback = h("button", { class: "btn sm", type: "button", text: "Roll back", disabled: installation.versions.length < 2 });
    rollback.addEventListener("click", () => void this.manage(async () => {
      this.host.close(plugin.id);
      await this.installed.rollback(plugin.id);
    }, "Previous version restored"));
    const audit = h("button", { class: "btn sm", type: "button", text: "Audit" });
    audit.addEventListener("click", () => showExtensionAudit(plugin.name, this.installed.audit.list(plugin.id)));
    const uninstall = h("button", { class: "btn sm danger", type: "button", text: "Uninstall" });
    uninstall.addEventListener("click", () => confirmAction(
      `Uninstall ${plugin.name}?`,
      "The installed package, previous version, saved settings, and active sandbox will be removed from this browser.",
      "Uninstall",
      () => void this.manage(async () => {
        this.host.close(plugin.id);
        await this.installed.uninstall(plugin.id);
      }, "Extension uninstalled"),
    ));
    return h("section", { class: "ext-manage" }, [
      state,
      facts,
      access,
      ...(companionNode ? [companionNode] : []),
      h("div", { class: "row" }, [toggle, rollback, audit, uninstall]),
    ]);
  }

  private companionState(companion: { id: string; version: string; required?: boolean }): HTMLElement {
    const match = this.service.matchCompanion(companion.id, companion.version);
    const prefix = companion.required ? "Required companion" : "Optional companion";
    if (match.status === "available") {
      return h("div", { class: "plug-ready" }, [
        icon("check", 13),
        h("span", { text: `${prefix} ${companion.id} ${match.provider.version} is available. It is separately installed trusted native software.` }),
      ]);
    }
    const detail = match.status === "incompatible"
      ? `Installed version ${match.provider?.version ?? "unknown"} does not match ${companion.version}.`
      : match.status === "missing"
        ? `Local Studio is running, but ${companion.id} is not installed.`
        : "Open this extension in Local Studio to discover its native companion.";
    return h("div", { class: "note ext-blocked", text: `${prefix} ${companion.id} ${companion.version}. ${detail} Native providers are installed outside the browser extension flow.` });
  }

  private async manage(action: () => Promise<void>, success: string): Promise<void> {
    try {
      await action();
      toast(success, "success");
      this.refresh();
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
  }

  private async prepareInstall(file: File): Promise<void> {
    try {
      await this.reviewInstall(await this.installed.prepare(file));
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), "error");
    }
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
  private launch(plugin: CatalogPlugin): void {
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
