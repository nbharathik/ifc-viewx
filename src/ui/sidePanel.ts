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
import { AssistantSettings } from "./aiSettings.js";

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

/** Copy-to-clipboard affordance shared by messages and the escalation card. */
function copyButton(read: () => string): HTMLButtonElement {
  return iconButton("copy", "Copy", () => {
    void navigator.clipboard?.writeText(read()).then(() => toast("Copied", "success"));
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
  /** The provider, model or mode changed: whoever shows them should re-read. */
  onSettingsChange(): void;
}

export class AssistantPanel {
  private readonly messages = h("div", { class: "msgs hidden" });
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
  private readonly input = h("textarea", { rows: "1" });
  private readonly send = h("button", { class: "btn accent send", type: "button", title: "Send  Enter" }, [icon("message", 14)]);

  private readonly modeButtons = new Map<AssistantMode, HTMLButtonElement>();
  private readonly settings: AssistantSettings;
  private mode: AssistantMode = loadSettings().mode;
  /** Ticks the elapsed seconds while a turn is in flight. */
  private clock = 0;

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
    this.send.addEventListener("click", submit);
    this.input.addEventListener("input", () => this.grow());
    this.input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        submit();
      }
    });

    this.settings = new AssistantSettings({
      onChange: () => callbacks.onSettingsChange(),
      openConsole: () => callbacks.openConsole(""),
      openLocal: () => callbacks.openLocal(),
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
          this.tools,
          iconButton("plus", "New chat", () => callbacks.onNewChat(), "icon-btn sm"),
          iconButton("sliders", "Assistant settings", () => this.settings.open(), "icon-btn sm"),
        ]),
        this.welcome,
        this.messages,
        this.typing,
        h("div", { class: "row between" }, [this.status, this.engine]),
        h("div", { class: "chat-row" }, [this.input, this.send]),
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
    this.chips.replaceChildren(
      ...SUGGESTIONS[mode].map((text) => {
        const chip = h("button", { class: "chip", type: "button", text });
        chip.addEventListener("click", () => this.callbacks.onSend(text));
        return chip;
      }),
    );
    saveSettings({ ...loadSettings(), mode });
    this.callbacks.onSettingsChange();
    // Mid-conversation the switch changes what the model is allowed to do, so
    // it belongs in the transcript; on a blank panel it would be noise.
    if (announce && changed && this.messages.childElementCount > 0) {
      this.addMessage("system", MODE_NOTE[mode]);
    }
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

  /** What the assistant can reach right now, listed in the setup dialog. */
  setToolState(state: ToolAvailability): void {
    this.settings.setToolState(state);
  }

  /** Grow the input with its content, up to a few lines. */
  private grow(): void {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 120)}px`;
  }

  private push(node: HTMLElement): void {
    this.welcome.classList.add("hidden");
    this.messages.classList.remove("hidden");
    this.messages.appendChild(node);
    this.messages.scrollTop = this.messages.scrollHeight;
  }

  addMessage(role: "user" | "assistant" | "system", text: string): void {
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
      this.messages.scrollTop = this.messages.scrollHeight;
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
    this.send.disabled = busy;
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
