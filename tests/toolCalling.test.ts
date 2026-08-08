// Native tool calling, driven against scripted providers.
//
// The loop that turns a provider reply into a viewer action is the part that
// silently breaks when a provider changes shape, so every wire detail is
// asserted here: how a stored transcript is rebuilt for each wire, how a
// refusal to take tools is told apart from a real error, and how malformed
// arguments survive far enough for the model to be told about them.
import { afterEach, describe, expect, it, vi } from "vitest";

import { converse, type ChatMessage, type LlmSettings } from "../src/llm/llmClient.js";
import { callToBlock, nativeTools, tierOf, TOOLS } from "../src/llm/tools.js";

const ANTHROPIC: LlmSettings = {
  provider: "anthropic",
  baseUrl: "",
  apiKey: "k",
  model: "claude-opus-5",
  mode: "query",
  verified: "",
};
const OPENAI: LlmSettings = { ...ANTHROPIC, provider: "openai", model: "gpt-4o" };

const ASK: ChatMessage[] = [
  { role: "system", content: "rules" },
  { role: "user", content: "how many walls" },
];

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Captures the request body so the wire format itself can be asserted. */
function capture(reply: unknown, status = 200) {
  const sent: Array<Record<string, unknown>> = [];
  const mock = vi.fn(async (_url: string, init: { body: string }) => {
    sent.push(JSON.parse(init.body) as Record<string, unknown>);
    return json(reply, status);
  });
  vi.stubGlobal("fetch", mock);
  return sent;
}

function eventStream(events: unknown[], newline = "\n"): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}${newline}${newline}`));
      controller.enqueue(encoder.encode(`data: [DONE]${newline}${newline}`));
      controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "text/event-stream" } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("tool catalog", () => {
  it("offers viewer tools in query mode and adds edits only in edit mode", () => {
    const query = nativeTools("query").map((t) => t.name);
    const edit = nativeTools("edit").map((t) => t.name);
    expect(query).toContain("find");
    expect(query).not.toContain("setAttribute");
    expect(edit).toContain("setAttribute");
    expect(edit.length).toBeGreaterThan(query.length);
  });

  it("never offers Python as a callable tool, in either mode", () => {
    for (const mode of ["query", "edit"] as const) {
      const names = nativeTools(mode).map((t) => t.name);
      expect(names.some((name) => name.includes("python"))).toBe(false);
    }
  });

  it("gives every offered tool an object schema with a required array", () => {
    for (const tool of nativeTools("edit")) {
      expect(tool.schema.type).toBe("object");
      expect(Array.isArray(tool.schema.required)).toBe(true);
      expect(tool.description.length).toBeGreaterThan(0);
      // Everything named as required has to actually be declared.
      for (const name of tool.schema.required) {
        expect(Object.keys(tool.schema.properties)).toContain(name);
      }
    }
  });

  it("keeps the offered set in step with the catalog", () => {
    const expected = TOOLS.filter((t) => t.tier === "viewer" || t.tier === "edit").length;
    expect(nativeTools("edit")).toHaveLength(expected);
  });
});

describe("bridging a call to the existing runner", () => {
  it("writes a viewer call as the action block the runner takes", () => {
    const block = callToBlock("find", { type: "door", storey: "L1" });
    expect(block?.kind).toBe("viewer");
    expect(JSON.parse(block!.code)).toEqual({ action: "find", type: "door", storey: "L1" });
  });

  it("writes an edit call as an op block", () => {
    const block = callToBlock("setAttribute", { ids: [1], attribute: "Name", value: "X" });
    expect(block?.kind).toBe("modelEdit");
    expect(JSON.parse(block!.code)).toEqual({ op: "setAttribute", ids: [1], attribute: "Name", value: "X" });
  });

  it("refuses a name that is not a tool, rather than inventing a block", () => {
    expect(callToBlock("deleteEverything", {})).toBeNull();
    expect(tierOf("deleteEverything")).toBeNull();
    expect(tierOf("find")).toBe("viewer");
  });
});

describe("anthropic wire", () => {
  it("reads text and tool calls out of one reply", async () => {
    capture({
      content: [
        { type: "text", text: "Let me look." },
        { type: "tool_use", id: "t1", name: "counts", input: {} },
      ],
      usage: { input_tokens: 30, output_tokens: 9 },
    });
    let usage: { input: number; output: number } | null = null;
    const turn = await converse(ANTHROPIC, ASK, nativeTools("query"), undefined, { onUsage: (u) => (usage = u) });
    expect(turn.toolsUsed).toBe(true);
    expect(turn.text).toBe("Let me look.");
    expect(turn.calls).toEqual([{ id: "t1", name: "counts", input: {} }]);
    expect(usage).toEqual({ input: 30, output: 9 });
  });

  it("marks the system block cacheable, since it is identical every turn", async () => {
    const sent = capture({ content: [{ type: "text", text: "ok" }] });
    await converse(ANTHROPIC, ASK, nativeTools("query"));
    const system = sent[0].system as Array<{ cache_control?: unknown; text?: string }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system[0].text).toBe("rules");
    expect(system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("rebuilds a tool exchange as content blocks", async () => {
    const sent = capture({ content: [{ type: "text", text: "12 walls." }] });
    const history: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "how many walls" },
      { role: "assistant", content: "Looking.", calls: [{ id: "t1", name: "counts", input: {} }] },
      { role: "tool", callId: "t1", name: "counts", content: "IfcWall: 12" },
    ];
    await converse(ANTHROPIC, history, nativeTools("query"));
    const messages = sent[0].messages as Array<{ role: string; content: unknown }>;
    expect(messages).toHaveLength(3);
    expect(messages[1].content).toEqual([
      { type: "text", text: "Looking." },
      { type: "tool_use", id: "t1", name: "counts", input: {} },
    ]);
    // A tool result is a user turn on this wire, and must carry the call id.
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "IfcWall: 12" }]);
  });

  it("reports several calls in one turn, in order", async () => {
    capture({
      content: [
        { type: "tool_use", id: "a", name: "counts", input: {} },
        { type: "tool_use", id: "b", name: "storeys", input: {} },
      ],
    });
    const turn = await converse(ANTHROPIC, ASK, nativeTools("query"));
    expect(turn.calls.map((c) => c.name)).toEqual(["counts", "storeys"]);
  });

  it("falls back rather than erroring when the endpoint refuses tools", async () => {
    capture({ error: { message: "tools are not supported by this model" } }, 400);
    const turn = await converse(ANTHROPIC, ASK, nativeTools("query"));
    expect(turn.toolsUsed).toBe(false);
    expect(turn.calls).toEqual([]);
  });

  it("still throws on a real failure", async () => {
    capture({ error: { message: "credit exhausted" } }, 402);
    await expect(converse(ANTHROPIC, ASK, nativeTools("query"))).rejects.toThrow("credit exhausted");
  });
});

describe("openai wire", () => {
  it("reads tool calls and parses their arguments", async () => {
    capture({
      choices: [
        {
          message: {
            content: "Checking.",
            tool_calls: [{ id: "c1", function: { name: "find", arguments: '{"type":"door"}' } }],
          },
        },
      ],
      usage: { prompt_tokens: 40, completion_tokens: 12 },
    });
    const turn = await converse(OPENAI, ASK, nativeTools("query"));
    expect(turn.text).toBe("Checking.");
    expect(turn.calls).toEqual([{ id: "c1", name: "find", input: { type: "door" } }]);
  });

  it("keeps a call whose arguments were malformed, so the model can be told", async () => {
    capture({
      choices: [{ message: { tool_calls: [{ id: "c1", function: { name: "find", arguments: "{not json" } }] } }],
    });
    const turn = await converse(OPENAI, ASK, nativeTools("query"));
    expect(turn.calls).toEqual([{ id: "c1", name: "find", input: {} }]);
  });

  it("rebuilds a tool exchange as this wire's message objects", async () => {
    const sent = capture({ choices: [{ message: { content: "done" } }] });
    const history: ChatMessage[] = [
      { role: "user", content: "rename them" },
      { role: "assistant", content: "", calls: [{ id: "c1", name: "counts", input: {} }] },
      { role: "tool", callId: "c1", name: "counts", content: "IfcWall: 12" },
    ];
    await converse(OPENAI, history, nativeTools("query"));
    const messages = sent[0].messages as Array<Record<string, unknown>>;
    expect(messages[1].tool_calls).toEqual([
      { id: "c1", type: "function", function: { name: "counts", arguments: "{}" } },
    ]);
    expect(messages[2]).toEqual({ role: "tool", tool_call_id: "c1", content: "IfcWall: 12" });
  });

  it("sends the tools as function definitions", async () => {
    const sent = capture({ choices: [{ message: { content: "ok" } }] });
    await converse(OPENAI, ASK, nativeTools("query"));
    const tools = sent[0].tools as Array<{ type: string; function: { name: string; parameters: unknown } }>;
    expect(tools[0].type).toBe("function");
    expect(tools.map((t) => t.function.name)).toContain("find");
    expect(tools[0].function.parameters).toHaveProperty("type", "object");
  });

  it("falls back when a local server does not know what tools are", async () => {
    capture({ error: { message: "unknown field: tools" } }, 400);
    const turn = await converse(OPENAI, ASK, nativeTools("query"));
    expect(turn.toolsUsed).toBe(false);
  });

  it("does not mistake an unrelated 400 for a missing tool feature", async () => {
    capture({ error: { message: "context length exceeded" } }, 400);
    await expect(converse(OPENAI, ASK, nativeTools("query"))).rejects.toThrow("context length");
  });
});

describe("streamed native tool calls", () => {
  it("reassembles OpenAI argument fragments while painting prose deltas", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      { choices: [{ delta: { content: "Checking " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "c1", function: { name: "find", arguments: "{\"type\":" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "\"IfcWall\"}" } }] } }] },
      { choices: [], usage: { prompt_tokens: 23, completion_tokens: 7 } },
    ], "\r\n")));
    const deltas: string[] = [];
    let usage = { input: 0, output: 0 };

    const turn = await converse(OPENAI, ASK, nativeTools("query"), undefined, {
      onDelta: (delta) => deltas.push(delta),
      onUsage: (value) => (usage = value),
    });

    expect(deltas).toEqual(["Checking "]);
    expect(turn).toEqual({
      text: "Checking ",
      calls: [{ id: "c1", name: "find", input: { type: "IfcWall" } }],
      toolsUsed: true,
    });
    expect(usage).toEqual({ input: 23, output: 7 });
  });

  it("reassembles Anthropic input JSON deltas and usage", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => eventStream([
      { type: "message_start", message: { usage: { input_tokens: 31 } } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Looking." } },
      { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t1", name: "result__group", input: {} } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "{\"handle\":\"result_1\"," } },
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: "\"field\":\"storey\"}" } },
      { type: "message_delta", usage: { output_tokens: 8 } },
    ])));
    const deltas: string[] = [];
    let usage = { input: 0, output: 0 };

    const turn = await converse(ANTHROPIC, ASK, nativeTools("query"), undefined, {
      onDelta: (delta) => deltas.push(delta),
      onUsage: (value) => (usage = value),
    });

    expect(deltas).toEqual(["Looking."]);
    expect(turn.calls).toEqual([{ id: "t1", name: "result__group", input: { handle: "result_1", field: "storey" } }]);
    expect(usage).toEqual({ input: 31, output: 8 });
  });
});

describe("guards", () => {
  it("refuses without a model chosen", async () => {
    await expect(converse({ ...ANTHROPIC, model: "" }, ASK, [])).rejects.toThrow(/provider and model/i);
  });

  it("refuses without the key a hosted provider needs", async () => {
    await expect(converse({ ...ANTHROPIC, apiKey: "" }, ASK, [])).rejects.toThrow(/API key/i);
  });
});
