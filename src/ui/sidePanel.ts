// The assistant chat. Presentation only: main.ts owns the engines, the tier
// choice and the edit lifecycle, and drives this through its methods. The
// pending edit lives in app chrome, not here, so it survives switching panels.
// The mode switch stays here, next to the conversation it governs; provider,
// key and model live in their own dialog (aiSettings).
//
// Replies are Markdown, so they are rendered as Markdown. Tool calls are not
// prose at all: each becomes a card that names the tool, says how it went, and
// keeps the JSON it sent and the report it got behind one click.
import { h, icon, iconButton, infoIcon, toast } from "./kit.js";
import { markdown, codeBlock } from "./markdown.js";
import { emptyState } from "./shell.js";
import { loadSettings, saveSettings, type AssistantMode } from "../llm/llmClient.js";
import { describeCall, prettyJson, summarizeReport, type ToolAvailability } from "../llm/tools.js";
import { AssistantSettings, connectionFields, type AssistantExtensionToolView } from "./aiSettings.js";
import type { EvidenceReference } from "../assistant/types.js";

export interface PendingEditView {
  summary: string;
  detail: string;
}

const SUGGESTIONS: Record<AssistantMode, string[]> = {
  query: ["How many walls are there?", "Run the checks and summarise", "Any clashes between structure and services?"],
  edit: ["Set IsExternal to true on the external walls", "Rename 'Basic Wall' to 'Wall'", "Tag the doors on Level 1"],
};

const MODE_NOTE: Record<AssistantMode, string> = {
  query: "Query the IFC file. Reads it and moves the view, never changes it.",
  edit: "Edits names and properties, never geometry or structure. Staged for your approval.",
};

/** A running tool call, until it settles one way or the other. */
export interface ToolCallView {
  settle(report: string, ok: boolean, retrying?: boolean): void;
}

/** An assistant message being written as it streams in. */
export interface StreamView {
  push(chunk: string): void;
  /** Finish, optionally replacing everything streamed with the final text. */
  settle(final?: string): void;
  text(): string;
}

/** Copy-to-clipboard affordance shared by messages and the escalation card. */
function copyButton(read: () => string): HTMLButtonElement {
  return iconButton("copy", "Copy", () => {
    if (!navigator.clipboard) return toast("The browser blocked the clipboard", "error");
    void navigator.clipboard
      .writeText(read())
      .then(() => toast("Copied", "success"))
      .catch(() => toast("The browser blocked the clipboard", "error"));
  }, "icon-btn sm ghost");
}

export interface EscalationActions {
  /** Hand code to the Python Console, unrun, for the user to read. */
  openConsole(code: string): void;
  /** Open the Studio dialog, which compares Web Studio and Local Studio. */
  openLocal(): void;
}

export interface AssistantCallbacks extends EscalationActions {
  onSend(text: string): void;
  onNewChat(): void;
  /** Abandon the turn in flight; the panel goes back to accepting input. */
  onStop(): void;
  /** The provider, model or mode changed: whoever shows them should re-read. */
  onSettingsChange(): void;
  /** Send the last question again. */
  onRetry?(): void;
  /** Open the saved-conversation list, anchored to the button that asked. */
  onHistory?(anchor: HTMLElement): void;
  /** The selection chip was switched on or off. */
  onAttachmentChange?(): void;
  /** The current viewport image is explicitly attached or removed. */
  onViewAttachmentChange?(): void;
  /** Follow one local evidence reference back into the model or result. */
  onEvidence?(reference: EvidenceReference): void;
  /** Accept a staged issue payload after inspecting its evidence. */
  onIssueProposal?(payload: Record<string, unknown>): void;
  /** Save a view, computed property or ruleset the assistant authored. */
  onDefinitionProposal?(payload: Record<string, unknown>): void;
  extensionTools?(): AssistantExtensionToolView[];
  onExtensionToolChange?(owner: string, id: string, enabled: boolean): void;
}

export class AssistantPanel {
  private readonly messages = h("div", { class: "msgs hidden", role: "log", "aria-live": "polite", "aria-label": "Assistant transcript" });
  private readonly setup = h("div", { class: "ai-setup hidden" });
  private readonly welcome: HTMLElement;
  private readonly chips = h("div", { class: "chips" });
  private readonly status = h("div", { class: "status-line" });
  private readonly engine = h("span", { class: "tier" });
  private readonly tools = h("span", { class: "tier" });
  private readonly busyText = h("span", { class: "t-text", text: "Thinking" });
  private readonly busyClock = h("span", { class: "t-clock" });
  private readonly typing = h("div", { class: "typing hidden" }, [
    h("span", { class: "t-dots" }, [h("i"), h("i"), h("i")]),
    this.busyText,
    this.busyClock,
  ]);
  private readonly input = h("textarea", { rows: "1", "aria-label": "Assistant message" });
  private readonly send = h("button", { class: "btn accent send", type: "button", title: "Send  Enter", "aria-label": "Send message" }, [icon("message", 14)]);

  private readonly modeButtons = new Map<AssistantMode, HTMLButtonElement>();
  private readonly settings: AssistantSettings;
  private mode: AssistantMode = loadSettings().mode;
  /** Ticks the elapsed seconds while a turn is in flight. */
  private clock = 0;
  /** Whether the inline connection card is up, so it is built only on change. */
  private setupShown = false;
  private setupDismissed = false;
  /** A turn is in flight, so the send button is a stop button instead. */
  private busy = false;
  private readonly usage = h("span", { class: "tier usage" });
  private readonly historyBtn = h("button", { class: "icon-btn sm", type: "button", title: "Chat history", "aria-label": "Chat history" }, [icon("clock")]);
  private readonly attach = h("div", { class: "attach-row hidden" });
  private readonly viewAttach = h("button", {
    class: "icon-btn sm",
    type: "button",
    title: "Attach the current view to this turn. Remote providers receive it only when this is on.",
    "aria-label": "Attach current view",
    "aria-pressed": "false",
  }, [icon("camera", 13)]);
  /** The user switched the selection off for this turn. */
  private attachOff = false;
  private viewAttached = false;
  private selectionCount = 0;
  private lastSent = "";
  private suggested: string[] = [];

  constructor(
    host: HTMLElement,
    private readonly callbacks: AssistantCallbacks,
  ) {
    const submit = (): void => {
      const text = this.input.value.trim();
      if (!text) return;
      this.input.value = "";
      this.grow();
      callbacks.onSend(text);
    };
    this.send.addEventListener("click", () => (this.busy ? callbacks.onStop() : submit()));
    this.input.addEventListener("input", () => this.grow());
    this.input.addEventListener("keydown", (e) => {
      // An IME candidate is confirmed with Enter, and that Enter is not a send.
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submit();
      }
    });

    this.historyBtn.addEventListener("click", () => callbacks.onHistory?.(this.historyBtn));
    this.viewAttach.addEventListener("click", () => {
      if (this.busy) return;
      this.viewAttached = !this.viewAttached;
      this.viewAttach.setAttribute("aria-pressed", String(this.viewAttached));
      this.viewAttach.title = this.viewAttached
        ? "Current view attached. Click to keep the image on this device."
        : "Attach the current view to this turn. Remote providers receive it only when this is on.";
      this.paintAttachments();
      callbacks.onViewAttachmentChange?.();
    });

    this.settings = new AssistantSettings({
      onChange: () => callbacks.onSettingsChange(),
      // Two live copies of the same fields would overwrite each other on save,
      // so the inline card stands down whenever the dialog takes over.
      onOpen: () => this.closeSetup(),
      openConsole: () => callbacks.openConsole(""),
      openLocal: () => callbacks.openLocal(),
      extensionTools: () => callbacks.extensionTools?.() ?? [],
      setExtensionTool: (owner, id, enabled) => callbacks.onExtensionToolChange?.(owner, id, enabled),
    });

    const modes = h("div", { class: "seg" });
    for (const mode of ["query", "edit"] as const) {
      const button = h("button", {
        type: "button",
        text: mode === "query" ? "Query" : "Edit",
        title: MODE_NOTE[mode],
      });
      button.addEventListener("click", () => this.setMode(mode, true));
      modes.appendChild(button);
      this.modeButtons.set(mode, button);
    }

    this.welcome = h("div", { class: "page", style: "padding:0;gap:14px" }, [
      emptyState("bot", "Ask about this model", "The assistant reads the viewer directly, so most questions need no download."),
      this.chips,
    ]);

    host.appendChild(
      h("div", { class: "page" }, [
        h("div", { class: "ai-bar" }, [
          modes,
          h("span", { class: "grow" }),
          this.usage,
          this.tools,
          iconButton("undo", "Ask that again", () => callbacks.onRetry?.(), "icon-btn sm"),
          this.historyBtn,
          iconButton("plus", "New chat", () => callbacks.onNewChat(), "icon-btn sm"),
          iconButton("sliders", "Assistant settings", () => this.settings.open(), "icon-btn sm"),
        ]),
        this.setup,
        this.welcome,
        this.messages,
        this.typing,
        h("div", { class: "row between" }, [this.status, this.engine]),
        this.attach,
        h("div", { class: "chat-row" }, [this.viewAttach, this.input, this.send]),
      ]),
    );
    this.setMode(this.mode, false);
  }

  /** The mode is the promise the panel makes about what can happen next. */
  private setMode(mode: AssistantMode, announce: boolean): void {
    const changed = mode !== this.mode;
    this.mode = mode;
    for (const [id, button] of this.modeButtons) button.setAttribute("aria-pressed", String(id === mode));
    this.input.placeholder = mode === "edit" ? "Ask, or describe a property change" : "Ask about the model";
    this.paintChips();
    saveSettings({ ...loadSettings(), mode });
    this.callbacks.onSettingsChange();
    // Mid-conversation the switch changes what the model is allowed to do, so
    // it belongs in the transcript; on a blank panel it would be noise.
    if (announce && changed && this.messages.childElementCount > 0) {
      this.addMessage("system", MODE_NOTE[mode]);
    }
  }

  /**
   * Openers written from the model that is actually loaded. Falls back to the
   * generic set, so an empty viewer still offers somewhere to start.
   */
  setSuggestions(list: string[]): void {
    this.suggested = list.filter((text) => text.trim().length > 0).slice(0, 4);
    this.paintChips();
  }

  private paintChips(): void {
    const mode = this.mode;
    this.chips.replaceChildren(
      ...(this.suggested.length ? this.suggested : SUGGESTIONS[mode]).map((text) => {
        const chip = h("button", { class: "chip", type: "button", text });
        chip.addEventListener("click", () => {
          if (!this.busy) this.callbacks.onSend(text);
        });
        return chip;
      }),
    );
  }

  /** Which mode the next turn runs under. */
  activeMode(): AssistantMode {
    return this.mode;
  }

  /** Local Studio holds the key: the dialog says so rather than hiding it. */
  setProxy(active: boolean): void {
    this.settings.setProxy(active);
  }

  /** Open assistant setup, for callers that just told the user to fix it. */
  openSettings(): void {
    this.settings.open();
  }

  /**
   * Nothing to answer with yet, so the connection fields sit in the panel,
   * above the conversation they unblock: a first run is answered where the
   * question was asked, not by a dialog that opens itself over the app.
   *
   * It opens when nothing is configured and closes when the model has
   * answered a check, or when the user closes it. A typed key alone is not
   * enough to take it away: that would pull Verify out from under the pointer.
   */
  setNeedsSetup(need: boolean, ready: boolean): void {
    if (ready) return this.closeSetup();
    if (!need || this.setupShown || this.setupDismissed) return;
    this.setupShown = true;
    const more = h("button", { class: "link-btn", type: "button", text: "All settings" });
    more.addEventListener("click", () => this.settings.open());
    const close = iconButton("x", "Close", () => {
      // Closed by hand stays closed: the settings icon is the way back.
      this.setupDismissed = true;
      this.closeSetup();
    }, "icon-btn sm");
    this.setup.replaceChildren(
      h("div", { class: "group-title" }, [
        h("span", { text: "Connect a model" }),
        h("span", { class: "row" }, [more, close]),
      ]),
      h("div", { class: "note", text: "Pick a provider, paste a key, then verify. The key stays in this browser." }),
      ...connectionFields(() => this.callbacks.onSettingsChange()),
    );
    this.setup.classList.remove("hidden");
  }

  private closeSetup(): void {
    if (!this.setupShown) return;
    this.setupShown = false;
    this.setup.classList.add("hidden");
    this.setup.replaceChildren();
  }

  /** What the assistant can reach right now, listed in the setup dialog. */
  setToolState(state: ToolAvailability): void {
    this.settings.setToolState(state);
  }

  /** Grow the input with its content, up to a few lines. */
  private grow(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
  }

  /** True while the reader is at the end, which is when following is wanted. */
  private atBottom(): boolean {
    const box = this.messages;
    return box.scrollHeight - box.scrollTop - box.clientHeight < 48;
  }

  private push(node: HTMLElement): void {
    // Following the tail is right until the user scrolls back to read: after
    // that, yanking them to the bottom on every append is the wrong answer.
    const follow = this.atBottom();
    this.welcome.classList.add("hidden");
    this.messages.classList.remove("hidden");
    this.messages.appendChild(node);
    if (follow) this.messages.scrollTop = this.messages.scrollHeight;
  }

  /**
   * An assistant message that grows as the reply arrives. Markdown is re-parsed
   * on each flush rather than appended to, because a fenced block only becomes
   * a code block once its closing fence lands. Flushes are rAF-batched so a
   * fast stream cannot spend the frame budget re-rendering.
   */
  startStream(): StreamView {
    const md = h("div", { class: "md" });
    const node = h("div", { class: "msg assistant streaming" }, [md]);
    // Sampled before each paint: a user who scrolled up to read is not dragged
    // back down by the stream still arriving.
    const follow = (): boolean => this.atBottom();
    this.push(node);
    let text = "";
    let frame = 0;
    const paint = (): void => {
      frame = 0;
      md.replaceChildren(markdown(text));
      if (follow()) this.messages.scrollTop = this.messages.scrollHeight;
    };
    return {
      push: (chunk: string) => {
        text += chunk;
        if (!frame) frame = requestAnimationFrame(paint);
      },
      settle: (final?: string) => {
        if (frame) cancelAnimationFrame(frame);
        frame = 0;
        if (final !== undefined) text = final;
        node.classList.remove("streaming");
        if (!text.trim()) return void node.remove();
        md.replaceChildren(markdown(text));
        node.appendChild(copyButton(() => text));
        if (follow()) this.messages.scrollTop = this.messages.scrollHeight;
      },
      text: () => text,
    };
  }

  /** Tokens the provider reported, this turn and for the session. */
  setUsage(turn: { input: number; output: number } | null, session: { input: number; output: number }): void {
    if (session.input === 0 && session.output === 0) {
      this.usage.replaceChildren();
      this.usage.title = "";
      return;
    }
    const total = session.input + session.output;
    this.usage.replaceChildren(
      icon("chip", 12),
      h("span", { text: total >= 10000 ? `${(total / 1000).toFixed(1)}k tok` : `${total} tok` }),
    );
    this.usage.title = turn
      ? `This turn: ${turn.input.toLocaleString()} in, ${turn.output.toLocaleString()} out\nSession: ${session.input.toLocaleString()} in, ${session.output.toLocaleString()} out`
      : `Session: ${session.input.toLocaleString()} in, ${session.output.toLocaleString()} out`;
  }

  /** What the next turn will carry as context, or nothing when nothing is selected. */
  setAttachment(count: number, label: string): void {
    this.selectionCount = count;
    this.attach.replaceChildren();
    if (count > 0) {
      const clear = iconButton("x", "Do not send the selection", () => {
        this.attachOff = true;
        this.callbacks.onAttachmentChange?.();
      }, "icon-btn sm ghost");
      const chip = h("button", { class: "chip attach-chip", type: "button", title: label }, [
        icon("focus", 12),
        h("span", { text: `${count} selected as context` }),
      ]);
      chip.addEventListener("click", () => {
        this.attachOff = !this.attachOff;
        this.callbacks.onAttachmentChange?.();
      });
      chip.setAttribute("aria-pressed", String(!this.attachOff));
      this.attach.append(chip, clear);
    }
    this.paintAttachments();
  }

  private paintAttachments(): void {
    this.attach.querySelector(".view-attach-chip")?.remove();
    if (this.viewAttached) {
      const chip = h("button", {
        class: "chip view-attach-chip",
        type: "button",
        title: "This viewport image will be sent to the configured provider for this turn only.",
      }, [icon("camera", 12), h("span", { text: "Current view attached" })]);
      chip.addEventListener("click", () => this.viewAttach.click());
      this.attach.appendChild(chip);
    }
    this.attach.classList.toggle("hidden", this.selectionCount === 0 && !this.viewAttached);
  }

  /** False once the user switches the selection chip off for this turn. */
  attachmentEnabled(): boolean {
    return !this.attachOff;
  }

  viewAttachmentEnabled(): boolean {
    return this.viewAttached;
  }

  /** A new turn starts with the selection attached again. */
  resetAttachment(): void {
    this.attachOff = false;
    this.viewAttached = false;
    this.viewAttach.setAttribute("aria-pressed", "false");
    this.paintAttachments();
  }

  /** The last thing the user asked, so it can be sent again. */
  lastPrompt(): string {
    return this.lastSent;
  }

  addMessage(role: "user" | "assistant" | "system", text: string): void {
    if (role === "user") this.lastSent = text;
    if (role === "system") {
      const error = /^(error|failed)/i.test(text);
      this.push(
        h("div", { class: `notice${error ? " err" : ""}` }, [
          icon(error ? "alert" : "info", 13),
          h("span", { class: "grow", text }),
        ]),
      );
      return;
    }
    if (role === "user") {
      this.push(h("div", { class: "msg user", text }));
      return;
    }
    const node = h("div", { class: "msg assistant" }, [h("div", { class: "md" }, [markdown(text)])]);
    node.appendChild(copyButton(() => text));
    this.push(node);
  }

  addEvidence(references: EvidenceReference[]): void {
    if (references.length === 0) return;
    const unique = new Map(references.map((reference) => [reference.id, reference]));
    const rail = h("div", { class: "evidence-rail", "aria-label": "Evidence used in this answer" }, [
      h("div", { class: "evidence-title" }, [icon("link", 12), h("span", { text: "Model evidence" })]),
      h("div", { class: "evidence-list" }, [...unique.values()].slice(0, 24).map((reference) => {
        const button = h("button", {
          class: "evidence-chip",
          type: "button",
          title: `${reference.kind}: ${reference.label}`,
        }, [
          h("span", { class: "evidence-id", text: reference.id }),
          h("span", { class: "evidence-label", text: reference.label }),
        ]);
        button.addEventListener("click", () => this.callbacks.onEvidence?.(reference));
        return button;
      })),
    ]);
    this.push(rail);
  }

  addRestoreView(label: string, restore: () => void): void {
    const button = h("button", { class: "btn sm view-restore", type: "button" }, [
      icon("undo", 13),
      h("span", { text: "Restore previous view" }),
    ]);
    button.addEventListener("click", () => {
      restore();
      button.disabled = true;
      button.replaceChildren(icon("check", 13), h("span", { text: "View restored" }));
    });
    this.push(h("div", { class: "view-transaction" }, [h("span", { text: label }), button]));
  }

  /**
   * A definition the assistant wrote, shown as what it is: a named thing with
   * its rules spelled out in words, and one button to keep it. Nothing has
   * been applied and nothing has been saved when this appears.
   */
  addDefinitionProposal(payload: Record<string, unknown>): void {
    const kind = String(payload.staged ?? "definition");
    const label = kind === "view" ? "Saved view" : kind === "property" ? "Computed property" : "Ruleset";
    const body = payload.view ?? payload.property ?? payload.ruleset;
    const name = String((body as { name?: unknown } | undefined)?.name ?? "Untitled");
    const explains = Array.isArray(payload.explains) ? payload.explains.map(String) : [];
    const rules = kind === "ruleset" ? (payload.ruleset as { rules?: unknown[] } | undefined)?.rules?.length ?? 0 : 0;
    const button = h("button", { class: "btn accent sm", type: "button" }, [
      icon("bookmark", 13),
      h("span", { text: `Save ${label.toLowerCase()}` }),
    ]);
    button.addEventListener("click", () => {
      this.callbacks.onDefinitionProposal?.(payload);
      button.disabled = true;
      button.replaceChildren(icon("check", 13), h("span", { text: "Saved" }));
    });
    this.push(h("div", { class: "issue-proposal" }, [
      h("div", { class: "issue-kicker", text: `Proposed ${label.toLowerCase()}` }),
      h("div", { class: "grow" }, [
        h("div", { class: "issue-title", text: name }),
        ...explains.map((line) => h("div", { class: "note", text: line })),
        ...(rules ? [h("div", { class: "note", text: `${rules} rule(s)` })] : []),
        ...(payload.portable === false
          ? [h("div", { class: "note error", text: "One of these rules names specific elements, so it will not follow a revision." })]
          : []),
        h("div", { class: "note", text: "Nothing has been applied or saved. Reading it is the point." }),
      ]),
      button,
    ]));
  }

  addIssueProposal(payload: Record<string, unknown>, references: EvidenceReference[]): void {
    const button = h("button", { class: "btn accent sm", type: "button" }, [icon("flag", 13), h("span", { text: "Create issue" })]);
    button.addEventListener("click", () => this.callbacks.onIssueProposal?.(payload));
    this.push(h("div", { class: "issue-proposal" }, [
      h("div", { class: "issue-kicker", text: "Staged issue" }),
      h("div", { class: "grow" }, [
        h("div", { class: "issue-title", text: String(payload.title ?? "Untitled issue") }),
        h("div", { class: "note", text: `${references.length} source reference(s). Nothing has been added yet.` }),
      ]),
      button,
    ]));
  }

  /**
   * One tool call, opened while it runs and settled when the report lands. The
   * header carries everything a reader normally wants (which tool, on what, how
   * it went); the JSON sent and the JSON returned stay one click away, so a
   * forty-row report never buries the answer that follows it.
   */
  addToolCall(kind: string, code: string): ToolCallView {
    const info = describeCall(kind, code);
    const state = h("span", { class: "tc-state" }, [h("span", { class: "t-dots" }, [h("i"), h("i"), h("i")])]);
    const body = h("div", { class: "tc-body hidden" }, [this.callBlock("Sent", codeBlock(prettyJson(code)))]);
    const head = h("button", {
      class: "tc-head",
      type: "button",
      title: info.plain,
      "aria-expanded": "false",
    }, [
      icon(info.icon, 13),
      h("span", { class: "tc-name", text: info.name }),
      h("span", { class: "grow tc-args", text: info.args, title: info.args }),
      state,
      icon("chevron", 12),
    ]);
    const expand = (open: boolean): void => {
      head.setAttribute("aria-expanded", String(open));
      body.classList.toggle("hidden", !open);
      // Keep the card the user just clicked in view, rather than the tail.
      head.scrollIntoView({ block: "nearest" });
    };
    head.addEventListener("click", () => expand(head.getAttribute("aria-expanded") !== "true"));

    const card = h("div", { class: "tc" }, [head, body]);
    this.push(card);

    return {
      settle: (report, ok, retrying = false): void => {
        card.classList.add(ok ? "ok" : "bad");
        state.replaceChildren(
          icon(ok ? "check" : "alert", 12),
          h("span", { text: ok ? summarizeReport(report) : retrying ? "Failed, retrying" : "Failed" }),
        );
        body.appendChild(
          ok
            ? this.callBlock("Report", codeBlock(prettyJson(report)))
            : this.callBlock("Error", h("div", { class: "tc-err", text: report })),
        );
        // A failure is the one case worth opening: the model is about to act on
        // it, and the user should see what it read.
        if (!ok) expand(true);
      },
    };
  }

  private callBlock(label: string, content: HTMLElement): HTMLElement {
    return h("div", { class: "tc-block" }, [h("div", { class: "tc-label", text: label }), content]);
  }

  /**
   * The assistant reached for Python, which it is never allowed to run. The
   * code is handed to the user instead: read it, then send it to the console,
   * which is the only thing in the app that executes anything.
   */
  addEscalation(code: string, kind: "query" | "edit"): void {
    const console_ = h("button", { class: "btn accent sm", type: "button" }, [
      icon("terminal", 13),
      h("span", { text: "Review in console" }),
    ]);
    console_.addEventListener("click", () => this.callbacks.openConsole(code));

    this.push(
      h("div", { class: "esc" }, [
        h("div", { class: "esc-head" }, [
          icon("terminal", 13),
          h("span", { class: "grow", text: kind === "edit" ? "This change needs Python" : "This answer needs Python" }),
          infoIcon(
            "Nothing was run, and nothing will be until you run it. Review in console opens the code in the Python Console, where you read it and press Run yourself.",
          ),
        ]),
        h("div", { class: "md" }, [codeBlock(code, "python")]),
        h("div", { class: "row" }, [console_]),
      ]),
    );
  }

  /** Clear the transcript; the caller owns the model-side history. */
  reset(): void {
    this.messages.replaceChildren();
    this.messages.classList.add("hidden");
    this.welcome.classList.remove("hidden");
    this.setStatus("");
  }

  /**
   * Which engine answers: the local proxy, a user endpoint, or none yet. A
   * verified model gets the check, so the header agrees with the settings
   * block instead of restating an unproven id as if it were working.
   */
  setEngine(label: string, hint = "", verified = false): void {
    const name = verified ? "check" : label.startsWith("Local") ? "server" : "globe";
    this.engine.replaceChildren(icon(name, 12), h("span", { text: label }));
    this.engine.classList.toggle("ok", verified);
    this.engine.title = hint;
  }

  /** What this session can execute, said before the user types, not after. */
  setTools(label: string, hint: string): void {
    this.tools.replaceChildren(icon(label === "Tools only" ? "focus" : "terminal", 12), h("span", { text: label }));
    this.tools.title = hint;
  }

  /** Errors sit under the transcript; progress rides with the typing dots. */
  setStatus(text: string, isError = false): void {
    this.status.textContent = isError ? text : "";
    this.status.classList.toggle("error", isError);
    if (!isError && text) this.busyText.textContent = text;
  }

  setBusy(busy: boolean): void {
    this.busy = busy;
    // The one control that stays live: a turn nobody can stop is a hang.
    this.send.replaceChildren(icon(busy ? "x" : "message", 14));
    this.send.title = busy ? "Stop" : "Send  Enter";
    this.send.classList.toggle("stop", busy);
    this.input.disabled = busy;
    this.typing.classList.toggle("hidden", !busy);
    clearInterval(this.clock);
    if (!busy) {
      this.busyClock.textContent = "";
      return;
    }
    // Inference can take a while on a local model, so the wait is counted
    // rather than left to look like a hang.
    const started = performance.now();
    this.clock = window.setInterval(() => {
      this.busyClock.textContent = `${Math.round((performance.now() - started) / 1000)}s`;
    }, 500);
    this.messages.scrollTop = this.messages.scrollHeight;
  }
}
