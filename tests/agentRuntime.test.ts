import { describe, expect, it, vi } from "vitest";
import { AgentRuntime, type AgentRuntimeUi } from "../src/assistant/agentRuntime.js";
import type { AssistantCapabilityAdapter } from "../src/assistant/capabilityAdapter.js";
import type { AssistantTraceEvent, AssistantTransport, EvidenceReference, ViewerContextSnapshot } from "../src/assistant/types.js";
import type { ViewTransactionManager } from "../src/assistant/viewTransactions.js";
import type { ChatMessage } from "../src/llm/llmClient.js";

function uiHarness() {
  const messages: Array<{ role: string; text: string }> = [];
  const evidence: EvidenceReference[][] = [];
  const streams: Array<{ push: ReturnType<typeof vi.fn>; settle: ReturnType<typeof vi.fn>; text: () => string }> = [];
  const ui: AgentRuntimeUi = {
    addMessage: (role, text) => messages.push({ role, text }),
    startStream: () => {
      const view = { push: vi.fn(), settle: vi.fn(), text: () => "" };
      streams.push(view);
      return view;
    },
    addToolCall: () => ({ settle: vi.fn() }),
    addEscalation: vi.fn(),
    addEvidence: (references) => evidence.push(references),
    addRestoreView: vi.fn(),
    addIssueProposal: vi.fn(),
    setBusy: vi.fn(),
    setStatus: vi.fn(),
    resetAttachment: vi.fn(),
  };
  return { ui, messages, evidence, streams };
}

const snapshot: ViewerContextSnapshot = {
  version: 1,
  revision: "model-a",
  capturedAt: 1,
  models: [],
  summary: null,
  selection: [],
  view: {
    camera: { position: [1, 1, 1], target: [0, 0, 0] },
    sections: [],
    sectionBox: null,
    plan: false,
    visibility: { total: 0, hidden: 0, manualHidden: 0, rules: [] },
    modelsHidden: [],
  },
  workspace: { panel: "assistant" },
  imageAttached: false,
};

function runtime(
  transport: AssistantTransport,
  tools: AssistantCapabilityAdapter,
  ui: AgentRuntimeUi,
  captureContext = vi.fn(async () => ({ snapshot, image: null })),
  viewTransactions = { begin: vi.fn() } as unknown as ViewTransactionManager,
  mode: () => "query" | "edit" = () => "query",
  system: (messages: ChatMessage[], native: boolean, mode: "query" | "edit") => ChatMessage[] = (messages) => messages,
) {
  const trace: AssistantTraceEvent[] = [];
  return {
    agent: new AgentRuntime({
      ui: () => ui,
      mode,
      transport: () => transport,
      tools,
      viewTransactions,
      captureContext,
      attachView: () => false,
      approvals: () => [],
      system,
      onUsage: vi.fn(),
      onPersist: vi.fn(),
      onTrace: (event) => trace.push(event),
    }),
    captureContext,
    trace,
    viewTransactions,
  };
}

describe("assistant agent runtime", () => {
  it("keeps the mode captured at turn start for every tool execution", async () => {
    let currentMode: "query" | "edit" = "query";
    let round = 0;
    const transport: AssistantTransport = {
      id: "mode-snapshot",
      multimodal: false,
      converse: async () => {
        round += 1;
        currentMode = "edit";
        return round === 1
          ? { text: "Checking", toolsUsed: true, calls: [{ id: "c1", name: "model__summary", input: {} }] }
          : { text: "Done", toolsUsed: true, calls: [] };
      },
      complete: async () => "unused",
    };
    const adapter = {
      tools: vi.fn(() => [{ name: "model__summary", description: "summary", schema: { type: "object", properties: {}, required: [] } }]),
      resolve: () => ({ id: "model.summary", effect: "read", parallelSafe: true }),
      execute: vi.fn(async () => ({
        capabilityId: "model.summary",
        title: "Model summary",
        effect: "read",
        report: "{}",
        value: {},
        result: null,
        evidence: [],
      })),
    } as unknown as AssistantCapabilityAdapter;
    const harness = uiHarness();
    const system = vi.fn((messages: ChatMessage[]) => messages);
    const built = runtime(transport, adapter, harness.ui, undefined, undefined, () => currentMode, system);

    await built.agent.run("Summarise the model");

    expect(adapter.tools).toHaveBeenCalledWith("query", expect.anything());
    expect(adapter.execute).toHaveBeenCalledWith("model__summary", {}, "query", expect.any(AbortSignal), expect.any(Function));
    expect(system).toHaveBeenCalledWith(expect.any(Array), expect.any(Boolean), "query");
  });

  it("executes a native tool, returns evidence and sends no image unless attached", async () => {
    const requests: Array<{ messages: unknown[] }> = [];
    let round = 0;
    const transport: AssistantTransport = {
      id: "scripted",
      multimodal: true,
      converse: async (request) => {
        requests.push({ messages: request.messages });
        round += 1;
        return round === 1
          ? { text: "Checking", toolsUsed: true, calls: [{ id: "c1", name: "audit__rows", input: {} }] }
          : { text: "Two walls [E1].", toolsUsed: true, calls: [] };
      },
      complete: async () => "unused",
    };
    const reference: EvidenceReference = {
      id: "E1",
      kind: "element",
      label: "Wall #11",
      capabilityId: "audit.rows",
      resultId: "result_1",
      row: 0,
      elementIds: [11],
    };
    const adapter = {
      tools: () => [{ name: "audit__rows", description: "audit", schema: { type: "object", properties: {}, required: [] } }],
      resolve: () => ({ effect: "read", parallelSafe: true }),
      execute: vi.fn(async () => ({
        capabilityId: "audit.rows",
        title: "Audit rows",
        effect: "read",
        report: "{\"count\":2}\nEvidence references: [E1] Wall #11",
        value: { count: 2 },
        result: { id: "result_1", capabilityId: "audit.rows", count: 2, createdAt: 1 },
        evidence: [reference],
      })),
    } as unknown as AssistantCapabilityAdapter;
    const harness = uiHarness();
    const built = runtime(transport, adapter, harness.ui);

    await built.agent.run("Count the walls");

    expect(built.captureContext).toHaveBeenCalledWith(false);
    expect(requests.flatMap((request) => request.messages).some((message) => (
      typeof message === "object" && message !== null && "image" in message
    ))).toBe(false);
    expect(harness.evidence).toEqual([[reference]]);
    expect(adapter.execute).toHaveBeenCalledTimes(1);
    expect(built.agent.history().some((message) => message.context)).toBe(true);
    expect(built.trace).toEqual(expect.arrayContaining([
      { type: "context", revision: "model-a", imageAttached: false },
      { type: "tool_call", capabilityId: "audit__rows" },
      { type: "tool_result", capabilityId: "audit.rows", resultId: "result_1", evidence: ["E1"] },
    ]));
  });

  it("aborts the provider turn and announces cancellation", async () => {
    let aborted = false;
    const transport: AssistantTransport = {
      id: "blocking",
      multimodal: false,
      converse: (request) => new Promise((_resolve, reject) => {
        request.signal.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("cancelled", "AbortError"));
        }, { once: true });
      }),
      complete: async () => "unused",
    };
    const adapter = {
      tools: () => [],
      resolve: () => null,
    } as unknown as AssistantCapabilityAdapter;
    const harness = uiHarness();
    const built = runtime(transport, adapter, harness.ui);

    const turn = built.agent.run("Run a clash check");
    await Promise.resolve();
    built.agent.stop();
    await turn;

    expect(aborted).toBe(true);
    expect(harness.messages.at(-1)?.text).toMatch(/Geometry and Local Studio jobs/);
    expect(built.trace.at(-1)).toEqual({ type: "cancel", targets: ["provider", "geometry", "local"] });
    expect(built.agent.busy).toBe(false);
  });

  it("closes the reply bubble it opened when the provider refuses the turn", async () => {
    const transport: AssistantTransport = {
      id: "no-key",
      multimodal: false,
      converse: async () => {
        throw new Error("Claude (Anthropic) needs an API key.");
      },
      complete: async () => "unused",
    };
    const adapter = {
      tools: () => [],
      resolve: () => null,
      execute: vi.fn(),
    } as unknown as AssistantCapabilityAdapter;
    const harness = uiHarness();
    const built = runtime(transport, adapter, harness.ui);

    await built.agent.run("How many walls are there?");

    // Unsettled, the bubble stays in the transcript as an empty card with a
    // caret blinking in it, under the error that explains the failure.
    expect(harness.streams).toHaveLength(1);
    expect(harness.streams[0].settle).toHaveBeenCalledTimes(1);
    expect(harness.messages.at(-1)?.text).toContain("needs an API key");
  });

  it("restores a partial view transaction when the turn is stopped", async () => {
    const restore = vi.fn();
    let markStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => (markStarted = resolve));
    const viewTransactions = {
      begin: vi.fn(() => ({ id: "view_1", label: "Assistant view", restore })),
    } as unknown as ViewTransactionManager;
    const transport: AssistantTransport = {
      id: "view-script",
      multimodal: false,
      converse: async () => ({
        text: "",
        toolsUsed: true,
        calls: [{ id: "v1", name: "isolate", input: { ids: [11] } }],
      }),
      complete: async () => "unused",
    };
    const adapter = {
      tools: () => [{ name: "isolate", description: "isolate", schema: { type: "object", properties: {}, required: [] } }],
      resolve: () => ({ id: "isolate", effect: "view", parallelSafe: false }),
      execute: vi.fn((_name, _input, _mode, signal: AbortSignal) => new Promise((_resolve, reject) => {
        markStarted();
        signal.addEventListener("abort", () => reject(new DOMException("cancelled", "AbortError")), { once: true });
      })),
    } as unknown as AssistantCapabilityAdapter;
    const harness = uiHarness();
    const built = runtime(transport, adapter, harness.ui, undefined, viewTransactions);

    const turn = built.agent.run("Isolate it");
    await started;
    built.agent.stop();
    await turn;

    expect(viewTransactions.begin).toHaveBeenCalledTimes(1);
    expect(restore).toHaveBeenCalledTimes(1);
  });
});
