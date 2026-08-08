import type { CapabilitySummary } from "../capabilities/types.js";
import type { ChatMessage, ChatUsage, ToolCall } from "../llm/llmClient.js";
import { extractCode, repairPrompt, stripBlock } from "../llm/prompts.js";
import type { NativeTool } from "../llm/tools.js";
import type { StreamView, ToolCallView } from "../ui/sidePanel.js";
import { AssistantCapabilityAdapter } from "./capabilityAdapter.js";
import type { AssistantToolApproval } from "./capabilityAdapter.js";
import { contextMessage } from "./context.js";
import type {
  AssistantToolExecution,
  AssistantTransport,
  EvidenceReference,
  ViewerContextSnapshot,
  ViewImageAttachment,
  AssistantTraceEvent,
} from "./types.js";
import type { ViewTransaction, ViewTransactionManager } from "./viewTransactions.js";

const MAX_HISTORY = 24;
const MAX_REPAIRS = 2;
const MAX_TOOL_ROUNDS = 8;

export interface AgentRuntimeUi {
  addMessage(role: "user" | "assistant" | "system", text: string): void;
  startStream(): StreamView;
  addToolCall(kind: string, code: string): ToolCallView;
  addEscalation(code: string, kind: "query" | "edit"): void;
  addEvidence(references: EvidenceReference[]): void;
  addRestoreView(label: string, restore: () => void): void;
  addIssueProposal(payload: Record<string, unknown>, references: EvidenceReference[]): void;
  setBusy(busy: boolean): void;
  setStatus(text: string, isError?: boolean): void;
  resetAttachment(): void;
}

export interface AgentRuntimeDependencies {
  ui(): AgentRuntimeUi;
  mode(): "query" | "edit";
  transport(): AssistantTransport;
  tools: AssistantCapabilityAdapter;
  viewTransactions: ViewTransactionManager;
  captureContext(includeImage: boolean): Promise<{ snapshot: ViewerContextSnapshot; image: ViewImageAttachment | null }>;
  attachView(): boolean;
  approvals(): AssistantToolApproval[];
  system(messages: ChatMessage[], native: boolean): ChatMessage[];
  onUsage(usage: ChatUsage): void;
  onPersist(messages: ChatMessage[]): void;
  onTrace?(event: AssistantTraceEvent): void;
}

interface WantedCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  code: string;
}

interface NormalizedTurn {
  calls: WantedCall[];
  python: { code: string; kind: "query" | "edit" } | null;
}

export class AgentRuntime {
  private readonly transcript: ChatMessage[] = [];
  private sequence = 0;
  private controller: AbortController | null = null;
  private nativeTools: boolean | null = null;
  private transportId = "";
  private activeViewTransaction: ViewTransaction | null = null;

  constructor(private readonly deps: AgentRuntimeDependencies) {}

  get busy(): boolean {
    return this.controller !== null;
  }

  history(): ChatMessage[] {
    return this.transcript.map((message) => ({ ...message, calls: message.calls?.map((call) => ({ ...call, input: { ...call.input } })) }));
  }

  replaceHistory(messages: ChatMessage[]): void {
    this.stop(false);
    this.transcript.splice(0, this.transcript.length, ...messages.map((message) => ({ ...message })));
  }

  clear(): void {
    this.stop(false);
    this.transcript.length = 0;
    this.nativeTools = null;
  }

  rewind(prompt: string): void {
    let at = this.transcript.length - 1;
    while (at >= 0 && !(this.transcript[at].role === "user" && !this.transcript[at].context && this.transcript[at].content === prompt)) at -= 1;
    if (at >= 0) this.transcript.length = at;
  }

  stop(announce = true): void {
    if (!this.controller) return;
    this.sequence += 1;
    this.controller.abort();
    this.activeViewTransaction?.restore();
    this.activeViewTransaction = null;
    this.deps.onTrace?.({ type: "cancel", targets: ["provider", "geometry", "local"] });
    this.controller = null;
    const ui = this.deps.ui();
    ui.setBusy(false);
    ui.setStatus("");
    if (announce) ui.addMessage("system", "Stopped. Geometry and Local Studio jobs from this turn were cancelled.");
  }

  async run(text: string): Promise<void> {
    const ui = this.deps.ui();
    if (this.controller) throw new Error("The assistant is still answering");
    const mine = ++this.sequence;
    const controller = new AbortController();
    this.controller = controller;
    ui.addMessage("user", text);
    ui.setBusy(true);
    ui.setStatus("Reading the viewer");
    let viewTransaction: ViewTransaction | null = null;
    const allEvidence: EvidenceReference[] = [];
    try {
      const transport = this.deps.transport();
      if (transport.id !== this.transportId) {
        this.transportId = transport.id;
        this.nativeTools = null;
      }
      const includeImage = this.deps.attachView();
      if (includeImage && !transport.multimodal) {
        throw new Error("This provider does not declare image support. Turn off the current-view attachment or choose a multimodal provider.");
      }
      const captured = await this.deps.captureContext(includeImage);
      this.deps.onTrace?.({
        type: "context",
        revision: captured.snapshot.revision,
        imageAttached: Boolean(captured.image),
      });
      this.remember({
        role: "user",
        content: contextMessage(captured.snapshot),
        context: true,
        ...(captured.image ? { image: { mimeType: captured.image.mimeType, dataUrl: captured.image.dataUrl } } : {}),
      });
      this.remember({ role: "user", content: text });
      ui.resetAttachment();
      const native = this.deps.tools.tools(this.deps.mode(), {
        imageAttached: Boolean(captured.image),
        approvals: this.deps.approvals(),
      });
      let repairs = 0;
      let rounds = 0;
      let turn = await this.askTurn(transport, native, ui, controller.signal);
      for (;;) {
        if (mine !== this.sequence || controller.signal.aborted) return;
        if (turn.python) {
          ui.addEscalation(turn.python.code, turn.python.kind);
          break;
        }
        if (turn.calls.length === 0) break;
        if (rounds >= MAX_TOOL_ROUNDS) {
          ui.addMessage("system", `Stopped after ${MAX_TOOL_ROUNDS} tool rounds. Ask again to continue.`);
          break;
        }
        rounds += 1;
        const parallel = turn.calls.length > 1 && turn.calls.every((call) => {
          const capability = this.deps.tools.resolve(call.name);
          return capability?.parallelSafe === true && capability.effect === "read";
        });
        const run = (wanted: WantedCall) => this.runCall(wanted, ui, controller.signal, () => {
          const capability = this.deps.tools.resolve(wanted.name);
          if (capability?.effect === "view" && !viewTransaction) {
            viewTransaction = this.deps.viewTransactions.begin("Assistant view");
            this.activeViewTransaction = viewTransaction;
          }
        });
        const outcomes = parallel
          ? await Promise.all(turn.calls.map(run))
          : await this.inSequence(turn.calls, run, controller.signal);
        if (mine !== this.sequence || controller.signal.aborted) return;
        let failed = false;
        for (let i = 0; i < outcomes.length; i++) {
          const outcome = outcomes[i];
          const wanted = turn.calls[i];
          if (outcome.done) {
            this.deps.onTrace?.({
              type: "tool_result",
              capabilityId: outcome.done.capabilityId,
              ...(outcome.done.result ? { resultId: outcome.done.result.id } : {}),
              evidence: outcome.done.evidence.map((reference) => reference.id),
            });
            allEvidence.push(...outcome.done.evidence);
            if (outcome.done.capabilityId === "issue.stage" && outcome.done.value && typeof outcome.done.value === "object") {
              ui.addIssueProposal(outcome.done.value as Record<string, unknown>, outcome.done.evidence);
            }
          } else failed = true;
          const giveUp = !outcome.done && repairs >= MAX_REPAIRS;
          outcome.card.settle(outcome.report, Boolean(outcome.done), !outcome.done && !giveUp);
          if (!outcome.done) repairs += 1;
          this.rememberToolResult(wanted, outcome.done, outcome.report, giveUp);
          if (giveUp) ui.addMessage("system", `Failed after ${MAX_REPAIRS + 1} attempts. The error is in the card above.`);
        }
        if (failed && repairs > MAX_REPAIRS) break;
        ui.setStatus("Reading the evidence");
        turn = await this.askTurn(transport, native, ui, controller.signal);
      }
      if (allEvidence.length) ui.addEvidence(allEvidence);
      if (viewTransaction !== null) {
        ui.addRestoreView("Restore the view from before this answer", (viewTransaction as ViewTransaction).restore);
      }
      this.activeViewTransaction = null;
      this.discardImagePayloads();
      this.deps.onPersist(this.history());
    } catch (error) {
      if (mine === this.sequence && !controller.signal.aborted) {
        this.activeViewTransaction?.restore();
        this.activeViewTransaction = null;
        ui.addMessage("system", `Error: ${error instanceof Error ? error.message : String(error)}`);
      }
    } finally {
      if (mine === this.sequence) {
        this.activeViewTransaction = null;
        this.discardImagePayloads();
        this.controller = null;
        ui.setBusy(false);
        ui.setStatus("");
      }
    }
  }

  private async inSequence<T>(items: WantedCall[], run: (item: WantedCall) => Promise<T>, signal: AbortSignal): Promise<T[]> {
    const values: T[] = [];
    for (const item of items) {
      if (signal.aborted) break;
      values.push(await run(item));
    }
    return values;
  }

  private async runCall(
    wanted: WantedCall,
    ui: AgentRuntimeUi,
    signal: AbortSignal,
    before: () => void,
  ): Promise<{ card: ToolCallView; report: string; done: AssistantToolExecution | null }> {
    const card = ui.addToolCall(wanted.name, wanted.code);
    ui.setStatus("Running the tool");
    const capability = this.deps.tools.resolve(wanted.name);
    const capabilityId = capability?.id ?? wanted.name;
    this.deps.onTrace?.({ type: "tool_call", capabilityId });
    try {
      before();
      const done = await this.deps.tools.execute(wanted.name, wanted.input, this.deps.mode(), signal, (message) => ui.setStatus(message));
      return { card, report: done.report, done };
    } catch (error) {
      const report = error instanceof Error ? error.message : String(error);
      this.deps.onTrace?.({
        type: "tool_error",
        capabilityId,
        code: /earlier model revision|stale/i.test(report)
          ? "stale"
          : /unknown|unapproved|not allowed|refused|forbidden/i.test(report) ? "refused" : "failed",
      });
      return { card, report, done: null };
    }
  }

  private async askTurn(
    transport: AssistantTransport,
    tools: NativeTool[],
    ui: AgentRuntimeUi,
    signal: AbortSignal,
  ): Promise<NormalizedTurn> {
    if (this.nativeTools !== false) {
      const stream = ui.startStream();
      const result = await transport.converse({
        messages: this.deps.system(this.history(), true),
        tools,
        signal,
        onDelta: (delta) => stream.push(delta),
        onUsage: this.deps.onUsage,
      });
      if (result.toolsUsed) {
        this.nativeTools = true;
        stream.settle(result.text);
        this.remember({ role: "assistant", content: result.text, calls: result.calls });
        return {
          calls: result.calls.map((call) => ({ id: call.id, name: call.name, input: call.input, code: JSON.stringify(call.input) })),
          python: null,
        };
      }
      stream.settle("");
      this.nativeTools = false;
    }

    const stream = ui.startStream();
    const reply = await transport.complete({
      messages: this.deps.system(this.history(), false),
      signal,
      onDelta: (delta) => stream.push(delta),
      onUsage: this.deps.onUsage,
    });
    this.remember({ role: "assistant", content: reply });
    const extracted = extractCode(reply);
    stream.settle(extracted ? stripBlock(reply, extracted.code) : reply);
    if (!extracted) return { calls: [], python: null };
    if (extracted.kind === "query" || extracted.kind === "edit") {
      return { calls: [], python: { code: extracted.code, kind: extracted.kind } };
    }
    let input: Record<string, unknown>;
    try {
      input = JSON.parse(extracted.code) as Record<string, unknown>;
    } catch {
      input = {};
    }
    const name = String(input.action ?? input.op ?? "");
    delete input.action;
    delete input.op;
    return { calls: [{ id: "", name, input, code: extracted.code }], python: null };
  }

  private rememberToolResult(
    wanted: WantedCall,
    done: AssistantToolExecution | null,
    report: string,
    giveUp: boolean,
  ): void {
    if (wanted.id) {
      this.remember({ role: "tool", callId: wanted.id, name: wanted.name, content: report });
      return;
    }
    if (giveUp) return;
    this.remember({
      role: "user",
      content: done
        ? `${done.title}:\n${report}\n\nContinue with another tool call if needed; otherwise answer in plain text.`
        : repairPrompt(report),
    });
  }

  private remember(entry: ChatMessage): void {
    this.transcript.push(entry);
    if (this.transcript.length <= MAX_HISTORY) return;
    let cut = this.transcript.length - MAX_HISTORY;
    while (cut < this.transcript.length && this.transcript[cut].role !== "user") cut += 1;
    if (cut < this.transcript.length) this.transcript.splice(0, cut);
  }

  private discardImagePayloads(): void {
    for (const message of this.transcript) {
      if (!message.image) continue;
      delete message.image;
      message.imageSent = true;
    }
  }
}

export function capabilityForCall(adapter: AssistantCapabilityAdapter, call: ToolCall): CapabilitySummary | null {
  return adapter.resolve(call.name);
}
