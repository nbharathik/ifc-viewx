import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AssistantPanel, type AssistantCallbacks } from "../src/ui/sidePanel.js";

function buildPanel() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const callbacks: AssistantCallbacks = {
    onSend: vi.fn(),
    onNewChat: vi.fn(),
    onStop: vi.fn(),
    onSettingsChange: vi.fn(),
    openConsole: vi.fn(),
    openLocal: vi.fn(),
  };
  return { host, panel: new AssistantPanel(host, callbacks), callbacks };
}

function buttonWithText(host: HTMLElement, text: string): HTMLButtonElement {
  const button = [...host.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === text);
  if (!button) throw new Error(`Missing button: ${text}`);
  return button;
}

describe("assistant panel workflow", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("keeps session context and message controls in one compact composer workflow", () => {
    const { host, callbacks } = buildPanel();
    const input = host.querySelector<HTMLTextAreaElement>(".ai-composer textarea")!;
    const send = host.querySelector<HTMLButtonElement>(".send")!;

    expect(host.querySelector(".ai-meta")).not.toBeNull();
    expect(host.querySelector(".ai-compose-foot")?.textContent).toContain("Shift+Enter");
    expect(host.querySelectorAll(".send-icon")).toHaveLength(2);
    expect(send.disabled).toBe(true);

    input.value = "Count the walls";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    expect(send.disabled).toBe(false);

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true }));
    expect(callbacks.onSend).not.toHaveBeenCalled();
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));

    expect(callbacks.onSend).toHaveBeenCalledWith("Count the walls");
    expect(input.value).toBe("");
    expect(send.disabled).toBe(true);
  });

  it("keeps new chat beside the conversation instead of duplicating it in the ribbon", () => {
    const { host, callbacks } = buildPanel();
    const newChat = host.querySelector<HTMLButtonElement>('[aria-label="New chat"]');

    expect(newChat).not.toBeNull();
    newChat!.click();

    expect(callbacks.onNewChat).toHaveBeenCalledTimes(1);
  });

  it("locks the turn's mode and keeps Stop operable while work is running", () => {
    vi.useFakeTimers();
    const { host, panel, callbacks } = buildPanel();
    const query = buttonWithText(host, "Query");
    const edit = buttonWithText(host, "Edit");
    const camera = host.querySelector<HTMLButtonElement>('[aria-label="Attach current view"]')!;
    const send = host.querySelector<HTMLButtonElement>(".send")!;
    panel.setAttachment(2, "Two selected walls");

    panel.setBusy(true);

    expect(query.disabled).toBe(true);
    expect(edit.disabled).toBe(true);
    expect(camera.disabled).toBe(true);
    expect([...host.querySelectorAll<HTMLButtonElement>(".attach-row button")].every((button) => button.disabled)).toBe(true);
    expect(send.disabled).toBe(false);
    expect(send.dataset.state).toBe("stop");
    expect(send.getAttribute("aria-label")).toBe("Stop response");
    edit.click();
    expect(panel.activeMode()).toBe("query");

    send.click();
    expect(callbacks.onStop).toHaveBeenCalledTimes(1);

    panel.setBusy(false);
    expect(query.disabled).toBe(false);
    expect(camera.disabled).toBe(false);
    expect(send.dataset.state).toBe("send");
    expect(send.getAttribute("aria-label")).toBe("Send message");
  });

  it("clears stale retry state with a new chat and lets long suggestions wrap", () => {
    const { host, panel } = buildPanel();
    const retry = host.querySelector<HTMLButtonElement>('[aria-label="Ask that again"]')!;
    const suggestion = "Compare every external wall against the loaded requirements and explain the failures";

    // Four openers filled the empty state below its own heading; three is the cap.
    panel.setSuggestions([suggestion, "b", "c", "d"]);
    expect(host.querySelectorAll(".ai-prompt")).toHaveLength(3);
    const prompt = host.querySelector<HTMLButtonElement>(".ai-prompt")!;
    expect(prompt.textContent).toBe(suggestion);
    expect(prompt.querySelectorAll("svg")).toHaveLength(1);

    panel.addMessage("user", "Old conversation prompt");
    expect(panel.lastPrompt()).toBe("Old conversation prompt");
    expect(retry.hidden).toBe(false);

    panel.reset();
    expect(panel.lastPrompt()).toBe("");
    expect(retry.hidden).toBe(true);
    expect(retry.disabled).toBe(true);
  });

  it("shows one empty state at a time and puts the connect fields back after a failed turn", () => {
    const { host, panel } = buildPanel();
    const setup = host.querySelector<HTMLElement>(".ai-setup")!;
    const welcome = host.querySelector<HTMLElement>(".ai-welcome")!;

    panel.setNeedsSetup(true, false);
    expect(setup.classList.contains("hidden")).toBe(false);
    // The openers belong to a panel that can answer; under an unanswered
    // connect form they are four buttons that cannot run yet.
    expect(welcome.classList.contains("hidden")).toBe(true);

    host.querySelector<HTMLButtonElement>('.ai-setup [aria-label="Close"]')!.click();
    expect(setup.classList.contains("hidden")).toBe(true);
    expect(welcome.classList.contains("hidden")).toBe(false);

    panel.addMessage("user", "How many walls?");
    panel.addMessage("system", "Error: Claude (Anthropic) needs an API key.");

    expect(setup.classList.contains("hidden")).toBe(false);
    expect(welcome.classList.contains("hidden")).toBe(true);
    expect(host.querySelectorAll(".msgs > *")).toHaveLength(2);
  });

  it("marks a streaming reply busy so the live region reads it once", () => {
    const { host, panel } = buildPanel();

    const stream = panel.startStream();
    const node = host.querySelector<HTMLElement>(".msg.assistant")!;
    expect(node.getAttribute("aria-busy")).toBe("true");

    stream.settle("There are 42 walls.");
    expect(node.getAttribute("aria-busy")).toBeNull();
  });

  it("exposes tool details as an accessible animated disclosure", () => {
    const { host, panel } = buildPanel();
    const call = panel.addToolCall("model.summary", "{\"limit\":3}");
    const head = host.querySelector<HTMLButtonElement>(".tc-head")!;
    const body = host.querySelector<HTMLElement>(".tc-body")!;

    expect(head.getAttribute("aria-controls")).toBe(body.id);
    expect(head.getAttribute("aria-expanded")).toBe("false");
    expect(body.getAttribute("aria-hidden")).toBe("true");
    expect(body.hasAttribute("inert")).toBe(true);
    expect(body.inert).toBe(true);
    expect(body.classList.contains("hidden")).toBe(false);

    head.click();
    expect(head.getAttribute("aria-expanded")).toBe("true");
    expect(body.getAttribute("aria-hidden")).toBe("false");
    expect(body.hasAttribute("inert")).toBe(false);
    expect(body.inert).toBe(false);
    expect(body.classList.contains("open")).toBe(true);

    call.settle("{\"count\":3}", true);
    expect(body.querySelectorAll(".tc-block")).toHaveLength(2);
  });

  it("collects one turn's tool calls into a single trace", () => {
    const { host, panel } = buildPanel();

    panel.addToolCall("model.summary", "{}").settle("{}", true);
    panel.addToolCall("model.filter", "{}").settle("{}", true);
    panel.addToolCall("view.isolate", "{}").settle("{}", true);

    const traces = host.querySelectorAll(".tc-trace");
    expect(traces).toHaveLength(1);
    expect(traces[0].querySelectorAll(".tc")).toHaveLength(3);
    expect(host.querySelector(".trace-count")?.textContent).toBe("3 steps");
  });

  it("folds the trace away when the reply lands, and starts a new one after it", () => {
    const { host, panel } = buildPanel();
    panel.addToolCall("model.summary", "{}").settle("{}", true);
    const trace = host.querySelector<HTMLElement>(".tc-trace")!;
    expect(trace.dataset.open).toBe("true");

    panel.addMessage("assistant", "There are 42 walls.");

    expect(trace.dataset.open).toBe("false");
    // Folded, the header still has to answer "which tool ran".
    expect(trace.querySelector(".trace-title")?.textContent).toBe("model.summary");

    panel.addToolCall("model.filter", "{}").settle("{}", true);
    expect(host.querySelectorAll(".tc-trace")).toHaveLength(2);
  });

  it("keeps a trace open and marked when one of its steps failed", () => {
    const { host, panel } = buildPanel();
    panel.addToolCall("model.summary", "{}").settle("{}", true);
    panel.addToolCall("view.isolate", "{}").settle("no such element", false);

    panel.addMessage("assistant", "That element is not in this model.");

    const trace = host.querySelector<HTMLElement>(".tc-trace")!;
    expect(trace.classList.contains("bad")).toBe(true);
    expect(trace.dataset.open).toBe("true");
    expect(trace.querySelector(".trace-title")?.textContent).toBe("model.summary · view.isolate · failed");
  });

  it("names the tools on the folded header, and counts the rest", () => {
    const { host, panel } = buildPanel();
    for (const tool of ["model.summary", "model.filter", "view.isolate", "model.properties"]) {
      panel.addToolCall(tool, "{}").settle("{}", true);
    }
    panel.addMessage("assistant", "Done.");

    const trace = host.querySelector<HTMLElement>(".tc-trace")!;
    expect(trace.querySelector(".trace-title")?.textContent).toBe("model.summary · model.filter +2");
    expect(trace.querySelector(".trace-count")?.textContent).toBe("4 steps");
    // The full list stays reachable without opening the trace.
    expect(trace.querySelector(".trace-head")?.getAttribute("title"))
      .toBe("Ran model.summary, model.filter, view.isolate, model.properties");
  });

  it("does not repeat a tool name that ran twice", () => {
    const { host, panel } = buildPanel();
    panel.addToolCall("model.filter", "{}").settle("{}", true);
    panel.addToolCall("model.filter", "{}").settle("{}", true);
    panel.addMessage("assistant", "Done.");

    const trace = host.querySelector<HTMLElement>(".tc-trace")!;
    expect(trace.querySelector(".trace-title")?.textContent).toBe("model.filter");
    expect(trace.querySelector(".trace-count")?.textContent).toBe("2 steps");
  });

  it("marks a failure on the header as soon as it happens", () => {
    const { host, panel } = buildPanel();
    panel.addToolCall("model.summary", "{}").settle("boom", false);

    // Still mid-turn: the trace has not settled and must already say so.
    const trace = host.querySelector<HTMLElement>(".tc-trace")!;
    expect(trace.classList.contains("bad")).toBe(true);
    expect(trace.querySelector(".trace-title")?.textContent).toBe("model.summary · failed");
  });

  it("folds two dozen near-identical citations into one row", () => {
    const { host, panel } = buildPanel();
    panel.addEvidence(
      Array.from({ length: 23 }, (_, i) => ({
        id: `E${i + 1}`,
        kind: "element" as const,
        label: `Systemelement:Verglasung:5654${85 + i} #${21440 + i * 12}`,
        capabilityId: "model.filter",
        elementIds: [1000 + i],
      })),
    );

    const rows = host.querySelectorAll(".evidence-row");
    expect(rows).toHaveLength(1);
    expect(rows[0].querySelector(".evidence-name")?.textContent).toBe("Systemelement:Verglasung");
    expect(host.querySelector(".evidence-count")?.textContent).toBe("23");
    expect(host.querySelector(".evidence-total")?.textContent).toBe("23 elements");
    // Nothing is laid out sideways any more, and the members stay closed.
    expect(host.querySelectorAll(".evidence-member")).toHaveLength(0);
  });

  it("selects a whole group from its row, and never moves the camera for it", () => {
    const { host, panel, callbacks } = buildPanel();
    const onEvidence = vi.fn();
    callbacks.onEvidence = onEvidence;
    panel.addEvidence([
      { id: "E1", kind: "element", label: "Wall:Basic:1 #10", capabilityId: "c", elementIds: [1] },
      { id: "E2", kind: "element", label: "Wall:Basic:2 #20", capabilityId: "c", elementIds: [2] },
    ]);

    host.querySelector<HTMLButtonElement>(".evidence-row")!.click();

    expect(onEvidence).toHaveBeenCalledTimes(1);
    const [references, action] = onEvidence.mock.calls[0];
    expect(action).toBe("select");
    expect(references).toHaveLength(2);
  });

  it("opens the members from the caret rather than selecting", () => {
    const { host, panel, callbacks } = buildPanel();
    const onEvidence = vi.fn();
    callbacks.onEvidence = onEvidence;
    panel.addEvidence([
      { id: "E1", kind: "element", label: "Wall:Basic:1 #10", capabilityId: "c", elementIds: [1] },
      { id: "E2", kind: "element", label: "Wall:Basic:2 #20", capabilityId: "c", elementIds: [2] },
    ]);
    const row = host.querySelector<HTMLButtonElement>(".evidence-row")!;

    row.querySelector<SVGElement>(".evidence-caret")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    expect(onEvidence).not.toHaveBeenCalled();
    expect(row.getAttribute("aria-expanded")).toBe("true");
    const members = host.querySelectorAll(".evidence-member");
    expect(members).toHaveLength(2);
    // The stem is on the row above, so a member only carries what differs.
    expect(members[0].querySelector(".evidence-detail")?.textContent).toBe("1 #10");
  });

  it("isolates all evidence without using the unreliable multi-object locate action", () => {
    const { host, panel, callbacks } = buildPanel();
    const onEvidence = vi.fn();
    callbacks.onEvidence = onEvidence;
    panel.addEvidence([{ id: "E1", kind: "element", label: "Wall:Basic:1 #10", capabilityId: "c", elementIds: [1] }]);

    host.querySelector<HTMLButtonElement>('[aria-label="Isolate every element cited here"]')!.click();

    expect(onEvidence).toHaveBeenCalledWith(expect.any(Array), "isolate");
  });

  it("keeps a reference with no shared stem as its own row", () => {
    const { host, panel } = buildPanel();
    panel.addEvidence([
      { id: "E1", kind: "element", label: "Wall:Basic:1 #10", capabilityId: "c", elementIds: [1] },
      { id: "E2", kind: "clash", label: "Duct meets beam", capabilityId: "c", elementIds: [2] },
    ]);

    expect(host.querySelectorAll(".evidence-row")).toHaveLength(2);
    expect(host.querySelector(".evidence-total")?.textContent).toBe("1 element · 1 clash");
    // A single-member group needs no count badge and no disclosure.
    expect(host.querySelector(".evidence-count")).toBeNull();
  });

  it("recalls the last question from an empty composer", () => {
    const { host, panel, callbacks } = buildPanel();
    const input = host.querySelector<HTMLTextAreaElement>(".ai-composer textarea")!;
    input.value = "How many walls are there?";
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(callbacks.onSend).toHaveBeenCalledWith("How many walls are there?");
    panel.addMessage("user", "How many walls are there?");
    expect(input.value).toBe("");

    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("How many walls are there?");

    // With something typed the arrow is an ordinary caret move again.
    input.value = "and how many doors";
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("and how many doors");
  });
});
