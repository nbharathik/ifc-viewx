// Assistant settings dialog: connection at the top, then what the assistant is
// allowed to do, as a grid of named tools rather than a paragraph. Anything
// that would take a sentence to say is an icon with the sentence on hover, so
// the catalog stays readable without scrolling. The connection fields are a
// standalone function: the panel shows the same ones inline before anything is
// configured, so a first run never opens a dialog on its own.
import { attachTip, h, icon, iconButton, infoIcon, lightDismiss, toast } from "./kit.js";
import {
  PROVIDERS,
  findProvider,
  listModels,
  loadSettings,
  saveSettings,
  verifyModel,
  type LlmSettings,
} from "../llm/llmClient.js";
import {
  LOCAL_EXTRAS,
  TIER_NOTE,
  TIER_TITLE,
  TOOLS,
  toolBlocker,
  type ToolAvailability,
  type ToolTier,
} from "../llm/tools.js";

/** What the verify line is saying, which decides its icon and its colour. */
type VerifyState = "idle" | "busy" | "ok" | "fail";

const VERIFY_ICON: Record<VerifyState, string> = {
  idle: "info",
  busy: "clock",
  ok: "check",
  fail: "alert",
};

/** The three promises the assistant makes: a chip each, the sentence on hover. */
const HOW: Array<[string, string, string]> = [
  ["shield", "Stays local", "Reads the model open in this tab. The file is never uploaded."],
  ["focus", "One action a turn", "Takes one action per turn, from the list below and nothing else."],
  ["check-circle", "You approve edits", "Any change to the model waits for your approval."],
];

export interface AiSettingsActions {
  /** The provider, model or key changed: whoever shows them should re-read. */
  onChange(): void;
  /** Open the Python Console, which is the only thing that runs code. */
  openConsole(): void;
  /** Open the Studio dialog, which says what Local Studio adds. */
  openLocal(): void;
}

export class AssistantSettings {
  private readonly dialog: HTMLDialogElement;
  private readonly toolsHost = h("div");
  private readonly connHost = h("div");
  private readonly proxyNote = h("div", { class: "note hidden" });

  constructor(private readonly actions: AiSettingsActions) {
    this.dialog = h("dialog", { id: "assistant-dialog" }, [
      h("div", { class: "dlg-head" }, [
        h("span", { text: "Assistant" }),
        iconButton("x", "Close", () => this.dialog.close(), "icon-btn dlg-x"),
      ]),
      h("div", { class: "dlg-body" }, [
        h("div", { class: "group-title", text: "Connection" }),
        this.proxyNote,
        this.connHost,
        h("div", { class: "group-title", text: "What it can do" }),
        h(
          "div",
          { class: "how-row" },
          HOW.map(([name, label, detail]) => {
            const chip = h("span", { class: "how", tabindex: "0" }, [icon(name, 12), h("span", { text: label })]);
            attachTip(chip, detail);
            return chip;
          }),
        ),
        this.toolsHost,
      ]),
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
  }

  open(): void {
    // Rebuilt on every open: the same fields also live in the panel, and two
    // copies of one setting must never disagree about what is stored.
    this.connHost.replaceChildren(...connectionFields(() => this.actions.onChange()));
    if (!this.dialog.open) this.dialog.showModal();
  }

  /** Local Studio holds the key: the fields stay, but they do nothing. */
  setProxy(active: boolean): void {
    this.proxyNote.textContent = active ? "Local Studio holds the key. These fields are unused." : "";
    this.proxyNote.classList.toggle("hidden", !active);
  }

  /**
   * The tool catalog, rendered from the same array the system prompt is built
   * from, so this list cannot claim a tool the model was never told about.
   *
   * The tools the assistant actually calls are named on screen, two to a row,
   * with what each does on hover. What it cannot call, generated Python and the
   * optional local service, share one collapsed section: both are things the
   * user runs, not things the assistant reaches, so they belong together and
   * out of the way.
   */
  setToolState(state: ToolAvailability): void {
    const blocks: HTMLElement[] = [];
    for (const tier of ["viewer", "edit"] as ToolTier[]) {
      const rows = TOOLS.filter((tool) => tool.tier === tier);
      const blocked = rows.map((tool) => toolBlocker(tool, state));
      // One reason for the whole tier is said once, next to the heading.
      // Repeating "open a model" down thirteen rows is noise, not information.
      const shared = blocked.every((why) => why === blocked[0]) ? blocked[0] : "";
      blocks.push(
        h("div", { class: "tool-sec" }, [
          h("div", { class: "tool-title" }, [
            h("span", { text: TIER_TITLE[tier] }),
            infoIcon(TIER_NOTE[tier]),
            ...(shared ? [infoIcon(shared, "clock")] : []),
          ]),
          this.grid(
            rows.map((tool, i) => ({
              icon: tool.icon,
              name: tool.name,
              off: Boolean(blocked[i]),
              plain: tool.plain,
              note: blocked[i],
            })),
          ),
        ]),
      );
    }
    blocks.push(this.extrasGroup(state.localCaps));
    this.toolsHost.replaceChildren(...blocks);
  }

  /**
   * Named tools, two to a row: the name shows, and the sentence is behind the
   * mark at the end of the row. The bubble opens beside that mark rather than
   * under the pointer, so reading one tool never covers the next.
   */
  private grid(
    rows: Array<{ icon: string; name: string; off: boolean; plain: string; note: string }>,
  ): HTMLElement {
    return h(
      "div",
      { class: "tool-grid" },
      rows.map((row) =>
        h("div", { class: `tool-cell${row.off ? " off" : ""}` }, [
          icon(row.icon, 13),
          h("span", { class: "grow", text: row.name }),
          infoIcon(row.plain, "info", row.note),
        ]),
      ),
    );
  }

  /**
   * Everything the assistant cannot run itself, in one place: the Python it
   * writes for the user, and the optional service that changes what the app can
   * do rather than what the assistant may do.
   */
  private extrasGroup(caps: string[] | null): HTMLElement {
    const have = (capability: string): boolean => caps?.includes(capability) ?? false;
    const local = h("button", { class: "btn sm", type: "button" }, [
      icon("server", 13),
      h("span", { text: caps ? "Local Studio" : "About Local Studio" }),
    ]);
    local.addEventListener("click", () => {
      this.dialog.close();
      this.actions.openLocal();
    });
    const console_ = h("button", { class: "btn sm", type: "button" }, [
      icon("terminal", 13),
      h("span", { text: "Python Console" }),
    ]);
    console_.addEventListener("click", () => {
      this.dialog.close();
      this.actions.openConsole();
    });

    const body = h("div", { class: "tool-body hidden" }, [
      h("div", { class: "tool-title" }, [
        h("span", { text: TIER_TITLE.python }),
        infoIcon(TIER_NOTE.python),
      ]),
      this.grid(
        TOOLS.filter((tool) => tool.tier === "python").map((tool) => ({
          icon: tool.icon,
          name: tool.name,
          off: true,
          plain: tool.plain,
          note: "Written for you, never run",
        })),
      ),
      h("div", { class: "tool-title" }, [
        h("span", { text: "Local Studio" }),
        infoIcon(
          "Optional, and it adds nothing to the tools above: the assistant has the same ones either way. It is for the four things a browser tab cannot do.",
        ),
      ]),
      this.grid(
        LOCAL_EXTRAS.map((extra) => ({
          icon: extra.icon,
          name: extra.capability,
          off: !have(extra.capability),
          plain: extra.plain,
          note: have(extra.capability) ? "Connected" : "Needs Local Studio",
        })),
      ),
      h("div", { class: "row" }, [console_, local]),
    ]);
    const head = h("button", { class: "tool-head", type: "button", "aria-expanded": "false" }, [
      icon("chevron", 12),
      h("span", { class: "grow", text: "Generated Python and Local Studio" }),
      h("span", { class: "note", text: caps ? "connected" : "" }),
    ]);
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(open));
      body.classList.toggle("hidden", !open);
    });
    return h("div", { class: "tool-group" }, [head, body]);
  }
}

/** Two field sets can be on screen at once, so each owns its model list. */
let listSeq = 0;

/**
 * Provider controls. Each provider carries its own endpoint, wire format and
 * auth header, so the only real choice is the model. A typed id is a guess
 * until it answers, so nothing here claims a model works: Verify uses the id
 * for real and reports what came back, and any later edit drops that proof.
 */
export function connectionFields(onChange: () => void): HTMLElement[] {
  const settings = loadSettings();
  let verified = settings.verified;

  const provider = h("select");
  for (const entry of PROVIDERS) provider.append(h("option", { value: entry.id, text: entry.label }));
  provider.value = settings.provider;

  const listId = `llm-models-${++listSeq}`;
  const baseUrl = h("input", { type: "text", value: settings.baseUrl });
  const apiKey = h("input", { type: "password", value: settings.apiKey });
  const models = h("datalist", { id: listId });
  const model = h("input", { type: "text", value: settings.model, list: listId, placeholder: "model id" });
  const browse = iconButton("refresh", "List the models this endpoint offers", () => runBrowse(), "icon-btn sm");
  const verify = h("button", { class: "btn sm accent", type: "button", text: "Verify" });
  const note = h("div", { class: "note" });
  const line = h("div", { class: "verify" });
  const urlRow = h("label", { class: "field" }, [
    h("span", { class: "field-label", text: "Endpoint" }),
    baseUrl,
  ]);

  const read = (): LlmSettings => ({
    provider: provider.value as LlmSettings["provider"],
    baseUrl: baseUrl.value.trim(),
    apiKey: apiKey.value.trim(),
    model: model.value.trim(),
    mode: loadSettings().mode,
    verified,
  });
  const persist = (): void => {
    saveSettings(read());
    onChange();
  };

  const say = (state: VerifyState, text: string): void => {
    line.className = `verify ${state}`;
    line.replaceChildren(icon(VERIFY_ICON[state], 12), h("span", { text }));
  };
  /** Every field below feeds the call, so touching one un-proves the model. */
  const invalidate = (): void => {
    verified = "";
    persist();
    say("idle", model.value.trim() ? "Not verified yet." : "Enter a model id.");
  };

  const setOptions = (list: string[]): void =>
    models.replaceChildren(...list.map((id) => h("option", { value: id })));

  const runBrowse = (): void => {
    browse.disabled = true;
    say("busy", "Reading the model list");
    void listModels(read())
      .then((list) => {
        setOptions(list);
        say("idle", `${list.length} models offered. Pick one, then Verify.`);
      })
      .catch((err: unknown) => say("fail", err instanceof Error ? err.message : String(err)))
      .finally(() => (browse.disabled = false));
  };

  /** Reflect the chosen provider: its URL, its key hint, its known models. */
  const syncProvider = (reset: boolean): void => {
    const entry = findProvider(provider.value);
    urlRow.classList.toggle("hidden", entry.fixedUrl);
    baseUrl.placeholder = entry.baseUrl;
    apiKey.placeholder = entry.keyPlaceholder;
    note.textContent = entry.note;
    setOptions(entry.models);
    if (reset) baseUrl.value = entry.fixedUrl ? "" : entry.baseUrl;
    // Never leave the field blank when the provider ships a known-good
    // default: a first run should be provider, key, verify.
    if (reset || !model.value) model.value = entry.models[0] ?? "";
  };

  provider.addEventListener("change", () => {
    syncProvider(true);
    invalidate();
  });
  verify.addEventListener("click", () => {
    const current = read();
    verify.disabled = true;
    verify.classList.add("busy");
    say("busy", `Asking ${current.model || "the endpoint"} to answer`);
    void verifyModel(current)
      .then((result) => {
        verified = result.model;
        persist();
        say("ok", `${result.model} answered in ${result.ms} ms`);
        toast("Model verified", "success");
      })
      .catch((err: unknown) => {
        verified = "";
        persist();
        say("fail", `Not loaded. ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        verify.disabled = false;
        verify.classList.remove("busy");
      });
  });

  for (const control of [baseUrl, apiKey, model]) control.addEventListener("change", invalidate);

  syncProvider(false);
  if (verified && verified === model.value.trim()) say("ok", `${verified} verified on this endpoint.`);
  else invalidate();

  return [
    h("label", { class: "field" }, [h("span", { class: "field-label", text: "Provider" }), provider]),
    urlRow,
    h("label", { class: "field" }, [
      h("span", { class: "field-label" }, [
        h("span", { text: "API key" }),
        h("span", { class: "hint", text: "Kept in this browser only." }),
      ]),
      apiKey,
    ]),
    h("label", { class: "field" }, [
      h("span", { class: "field-label", text: "Model" }),
      h("span", { class: "row model-row" }, [model, browse, verify]),
    ]),
    line,
    note,
    models,
  ];
}
