// Web Studio and Local Studio, and the fact that they are two apps.
//
// Web Studio is this browser tab, and it is the whole product for almost
// everyone: viewing, QA, schedules, filters, IDS, issues and edits all run
// here. Local Studio is a separate app you install and run yourself. It serves
// its own copy of this viewer from your machine and adds the four things a
// page genuinely cannot do, which is conversion, native Python, an inbound MCP
// connection and holding a key off the page.
//
// They never talk to each other. A hosted tab does not reach your machine and
// has nothing to pair, so the badge in the top bar is a statement of where you
// are, not a switch. It opens a popover with the one action that state needs:
// how to get Local Studio, or what this Local Studio is doing.
import { closeLayer, h, icon, iconButton, lightDismiss, openLayer, toast } from "./kit.js";
import type { ServiceClient, ServiceMode } from "../bridge/serviceClient.js";

/** Until the package is on PyPI, the install is the release wheel by URL. */
export const INSTALL_CMD =
  "pip install https://github.com/nbharathik/ifc-viewx/releases/latest/download/ifcviewx-0.1.0-py3-none-any.whl\nifcviewx";

interface Feature {
  id: string;
  label: string;
  note: string;
  /** Available without the local service. */
  web: boolean;
}

const FEATURES: Feature[] = [
  { id: "core", label: "Viewing, tree, properties, measure, export", note: "always on", web: true },
  { id: "inspect", label: "Model checks, schedules, filters, IDS, issues", note: "runs in this tab", web: true },
  { id: "edits", label: "Rename, set properties, delete, with a measured diff", note: "staged for approval", web: true },
  { id: "assistant", label: "Assistant with viewer, QA, clash and edit tools", note: "your key, this browser", web: true },
  { id: "browser-python", label: "Python console in this tab", note: "first run downloads ~30 MB", web: true },
  { id: "convert", label: "Convert to .ifcx for instant reopen", note: "IfcOpenShell", web: false },
  { id: "python", label: "Native Python, no runtime download", note: "IfcOpenShell", web: false },
  { id: "mcp", label: "MCP bridge for AI clients", note: "Claude Desktop, Claude Code", web: false },
  { id: "llm", label: "Assistant key stays on this machine", note: "service-side proxy", web: false },
];

const TITLE: Record<ServiceMode, string> = {
  web: "Web Studio: everything runs in this tab. Click for details.",
  local: "Local Studio: served from your machine. Click for details.",
};

export interface ConnectionActions {
  refresh(): Promise<void>;
}

export class Connection {
  readonly chip: HTMLElement;
  private readonly badge: HTMLButtonElement;
  private readonly dialog: HTMLDialogElement;
  private readonly body: HTMLElement;
  private pop: HTMLElement | null = null;

  constructor(
    private readonly service: ServiceClient,
    private readonly actions: ConnectionActions,
  ) {
    this.badge = h("button", { class: "studio-badge", type: "button" }, [
      icon("globe", 12),
      h("span", { class: "studio-name", text: "Web Studio" }),
    ]);
    this.badge.addEventListener("click", () => this.togglePop());
    this.chip = h("div", { class: "studio-chip" }, [this.badge]);

    this.body = h("div", { class: "dlg-body" });
    const close = iconButton("x", "Close", () => this.dialog.close(), "icon-btn dlg-x");
    this.dialog = h("dialog", { id: "connection-dialog" }, [
      h("div", { class: "dlg-head" }, [h("span", { text: "Studio" }), close]),
      this.body,
      h("div", { class: "dlg-foot" }, [
        (() => {
          const done = h("button", { class: "btn primary", type: "button", text: "Done" });
          done.addEventListener("click", () => this.dialog.close());
          return done;
        })(),
      ]),
    ]) as HTMLDialogElement;
    document.body.appendChild(this.dialog);
    lightDismiss(this.dialog);
    this.render();
    this.renderBody(service.mode(), service.getHealth());
  }

  /** The full comparison. Reached from the popover, a refused command, or the ribbon. */
  open(): void {
    closeLayer();
    this.renderBody(this.service.mode(), this.service.getHealth());
    if (!this.dialog.open) this.dialog.showModal();
    void this.actions.refresh().then(() => {
      if (this.dialog.open) this.renderBody(this.service.mode(), this.service.getHealth());
    });
  }

  /** Repaint the badge, and whichever surface is currently on screen. */
  render(): void {
    const mode = this.service.mode();
    const local = mode === "local";
    this.chip.dataset.mode = mode;
    this.badge.title = TITLE[mode];
    this.badge.replaceChildren(
      icon(local ? "server" : "globe", 12),
      h("span", { class: "studio-name", text: local ? "Local Studio" : "Web Studio" }),
    );
    if (this.pop) this.renderPop(this.pop);
    if (this.dialog.open) this.renderBody(mode, this.service.getHealth());
  }

  // -- popover ---------------------------------------------------------------

  private togglePop(): void {
    if (this.pop) return closeLayer();
    const pop = h("div", { class: "mode-pop", role: "dialog", "aria-label": "Studio" });
    this.pop = pop;
    this.renderPop(pop);
    this.chip.appendChild(pop);
    openLayer([pop, this.chip], () => {
      pop.remove();
      this.pop = null;
    });
    void this.actions.refresh().then(() => {
      if (this.pop === pop) this.renderPop(pop);
    });
  }

  private renderPop(pop: HTMLElement): void {
    const health = this.service.getHealth();
    const rows: (Node | string)[] = [];

    if (this.service.mode() === "local") {
      rows.push(
        h("div", { class: "pop-title", text: "Local Studio" }),
        h("p", { class: "note", text: `Served from ${this.service.origin} · ${health?.capabilities.join(", ") ?? ""}` }),
      );
      if (health?.store) {
        const { files, bytes } = health.store;
        rows.push(h("p", { class: "note", text: `${files} model(s) cached on this machine · ${(bytes / 1e6).toFixed(0)} MB` }));
      }
      rows.push(h("p", { class: "note", text: "Everything the browser can do, plus conversion, native Python and the MCP bridge. Stop it with Ctrl+C in the terminal." }));
      rows.push(h("div", { class: "row" }, [this.moreLink()]));
    } else {
      rows.push(
        h("div", { class: "pop-title", text: "Web Studio" }),
        h("p", { class: "note", text: "Everything runs in this tab. Nothing is uploaded, nothing is installed." }),
        h("p", { class: "note", text: "Local Studio is a separate app. Install it and it opens its own copy of this viewer from your machine, with conversion, native Python and the MCP bridge already on. This tab is not involved and never reaches your machine." }),
        h("div", { class: "row" }, [this.copyButton(), this.moreLink()]),
      );
    }
    pop.replaceChildren(...rows);
  }

  private moreLink(): HTMLElement {
    const link = h("button", { class: "btn sm grow", type: "button", text: "What's the difference?" });
    link.addEventListener("click", () => this.open());
    return link;
  }

  private copyButton(): HTMLElement {
    const copy = h("button", { class: "btn sm accent", type: "button", text: "Copy install command" });
    copy.addEventListener("click", () => {
      void navigator.clipboard?.writeText(INSTALL_CMD).then(() => toast("Install command copied", "success"));
    });
    return copy;
  }

  // -- dialog ----------------------------------------------------------------

  private renderBody(mode: ServiceMode, health: ReturnType<ServiceClient["getHealth"]>): void {
    const local = mode === "local";
    const cards = h("div", { class: "mode-cards" }, [
      this.card("Web Studio", "A web page", !local, [
        "View, check, schedule and edit IFC entirely in the tab.",
        "Nothing is uploaded; nothing is installed.",
      ]),
      this.card("Local Studio", "An app on your machine", local, [
        "The same viewer, plus IfcOpenShell conversion and native Python.",
        "The only place an MCP client can connect, or a key can hide.",
      ]),
    ]);

    const list = h("div", { class: "feature-list" });
    for (const feature of FEATURES) {
      const on = feature.web || (local && this.service.can(feature.id));
      const note = on ? feature.note : local ? "not configured on this service" : "only in Local Studio";
      list.appendChild(
        h("div", { class: `feature${on ? " on" : ""}` }, [
          icon(on ? "check" : "x", 13),
          h("span", { class: "grow", text: feature.label }),
          h("span", { class: "note", text: note }),
        ]),
      );
    }

    const sections: (Node | string)[] = [
      cards,
      h("div", { class: "group-title", text: "How this works" }),
      this.howItWorks(),
      h("div", { class: "group-title", text: local ? "What you have" : "What you get" }),
      list,
    ];

    if (local && health) {
      sections.push(h("div", { class: "group-title", text: "This service" }));
      sections.push(this.serviceDetails(health));
    }
    if (!local) sections.push(this.install());

    this.body.replaceChildren(...sections);
  }

  /**
   * Two installs that do not talk is an unusual shape for a web app, and the
   * question it raises is always the same one: does the page reach my machine.
   * It does not, and saying so plainly is worth four lines.
   */
  private howItWorks(): HTMLElement {
    const points: Array<[string, string]> = [
      [
        "Two apps, one viewer",
        "Both carry the same build, so the layout, the shortcuts and the model you are looking at behave identically. Only the ribbon items that need a machine differ.",
      ],
      [
        "Web Studio is a web page",
        "Open the hosted link and work. There is nothing to install, and the model is read in this tab.",
      ],
      [
        "Local Studio is a separate app",
        "Install it with pip, run ifcviewx, and it serves its own copy of this viewer from your machine at 127.0.0.1:8765. It opens in its own tab with everything already on and nothing to type.",
      ],
      [
        "They never connect",
        "This page does not look for a local service and cannot reach one. Pick the studio you want and use it; each keeps its own settings, cached models and assistant key, because they are different origins.",
      ],
    ];
    return h(
      "div",
      { class: "how-list" },
      points.map(([title, text]) =>
        h("div", { class: "how" }, [h("b", { text: title }), h("span", { text })]),
      ),
    );
  }

  private card(title: string, subtitle: string, active: boolean, lines: string[]): HTMLElement {
    return h("div", { class: `mode-card${active ? " active" : ""}` }, [
      h("div", { class: "mode-card-head" }, [
        h("b", { text: title }),
        active ? h("span", { class: "pill", text: "you are here" }) : h("span", {}),
      ]),
      h("div", { class: "sub", text: subtitle }),
      ...lines.map((text) => h("p", { text })),
    ]);
  }

  private serviceDetails(health: NonNullable<ReturnType<ServiceClient["getHealth"]>>): HTMLElement {
    const rows = h("dl", { class: "kv" });
    const add = (key: string, value: string): void => {
      rows.append(h("dt", { text: key }), h("dd", { text: value }));
    };
    add("Version", health.version);
    add("Address", this.service.origin);
    if (health.readonly) add("Mode", "read-only (no uploads or edits)");
    if (!health.pythonEnabled) add("Python", "disabled on this service");
    if (health.llm?.configured) add("Assistant proxy", `${health.llm.provider} · ${health.llm.model}`);
    if (health.store) {
      const { files, bytes, quotaBytes } = health.store;
      add("Model cache", `${files} file(s) · ${(bytes / 1e6).toFixed(0)} MB of ${(quotaBytes / 1e9).toFixed(0)} GB`);
    }
    if (health.browserConnected !== undefined) {
      add("MCP bridge", health.browserConnected ? "a viewer is connected" : "waiting for a viewer");
    }
    return rows;
  }

  private install(): HTMLElement {
    return h("div", {}, [
      h("div", { class: "group-title", text: "Get Local Studio" }),
      h("p", { class: "note", text: "One package, conversion included. Run it and it opens its own tab, already set up." }),
      h("pre", { class: "shell", text: INSTALL_CMD }),
      h("p", { class: "note", text: "Nothing changes in this tab when you do: keep using Web Studio, or close it and work in Local Studio instead." }),
      h("div", { class: "row" }, [this.copyButton()]),
    ]);
  }
}
