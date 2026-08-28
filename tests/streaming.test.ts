// Streaming is the one place a wrong assumption about a provider silently
// costs the answer, so every path is driven against a fake server: chunk
// boundaries mid-event, a server that ignores `stream`, and a real error.
import { afterEach, describe, expect, it, vi } from "vitest";

import { chat, type ChatMessage, type LlmSettings } from "../src/llm/llmClient.js";

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

/** An SSE response whose body arrives in exactly these network chunks. */
function sse(chunks: string[], status = 200): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { "content-type": "text/event-stream" } });
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("anthropic streaming", () => {
  it("emits deltas in order and returns the joined text", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          'data: {"type":"message_start","message":{"usage":{"input_tokens":11}}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"There are "}}\n\n',
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"12 walls."}}\n\n',
          'data: {"type":"message_delta","usage":{"output_tokens":7}}\n\n',
        ]),
      ),
    );
    const seen: string[] = [];
    let usage: { input: number; output: number } | null = null;
    const text = await chat(ANTHROPIC, ASK, undefined, undefined, {
      onDelta: (chunk) => seen.push(chunk),
      onUsage: (u) => (usage = u),
    });
    expect(seen).toEqual(["There are ", "12 walls."]);
    expect(text).toBe("There are 12 walls.");
    expect(usage).toEqual({ input: 11, output: 7 });
  });

  it("reassembles an event split across network chunks", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          'data: {"type":"content_block_delta","delta":{"type":"text_',
          'delta","text":"split"}}\n',
          '\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" fine"}}\n\n',
        ]),
      ),
    );
    const seen: string[] = [];
    const text = await chat(ANTHROPIC, ASK, undefined, undefined, { onDelta: (c) => seen.push(c) });
    expect(seen).toEqual(["split", " fine"]);
    expect(text).toBe("split fine");
  });

  it("surfaces an error event instead of returning a half answer", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"partial"}}\n\n',
          'data: {"type":"error","error":{"message":"overloaded"}}\n\n',
        ]),
      ),
    );
    await expect(chat(ANTHROPIC, ASK, undefined, undefined, { onDelta: () => undefined })).rejects.toThrow(
      "overloaded",
    );
  });

  it("does not stream at all when no delta handler is given", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) =>
      json({ content: [{ type: "text", text: "plain" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);
    expect(await chat(ANTHROPIC, ASK)).toBe("plain");
    const body = JSON.parse(String(fetchMock.mock.calls[0][1].body)) as { stream?: boolean };
    expect(body.stream).toBeUndefined();
  });
});

describe("openai streaming", () => {
  it("emits deltas and stops at the done sentinel", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        sse([
          'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":" there"}}]}\n\n',
          'data: {"usage":{"prompt_tokens":5,"completion_tokens":2},"choices":[]}\n\n',
          "data: [DONE]\n\n",
          'data: {"choices":[{"delta":{"content":"never"}}]}\n\n',
        ]),
      ),
    );
    const seen: string[] = [];
    let usage: { input: number; output: number } | null = null;
    const text = await chat(OPENAI, ASK, undefined, undefined, {
      onDelta: (c) => seen.push(c),
      onUsage: (u) => (usage = u),
    });
    expect(seen).toEqual(["Hello", " there"]);
    expect(text).toBe("Hello there");
    expect(usage).toEqual({ input: 5, output: 2 });
  });

  it("falls back to the one-shot request when the server will not stream", async () => {
    const fetchMock = vi
      .fn()
      // A local server that answers JSON to a stream request.
      .mockResolvedValueOnce(json({ choices: [{ message: { content: "fallback" } }] }))
      .mockResolvedValueOnce(json({ choices: [{ message: { content: "fallback" } }] }));
    vi.stubGlobal("fetch", fetchMock);
    const seen: string[] = [];
    const text = await chat(OPENAI, ASK, undefined, undefined, { onDelta: (c) => seen.push(c) });
    expect(text).toBe("fallback");
    // Nothing was streamed, so the panel must not have been told otherwise.
    expect(seen).toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("throws a real server error rather than retrying forever", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: { message: "no credit" } }, 402)));
    await expect(chat(OPENAI, ASK, undefined, undefined, { onDelta: () => undefined })).rejects.toThrow("no credit");
  });
});

describe("guards", () => {
  it("uses the proxy untouched, since the service answers in one piece", async () => {
    const proxy = vi.fn(async () => "from the service");
    vi.stubGlobal("fetch", vi.fn(async () => json({})));
    const seen: string[] = [];
    expect(await chat(ANTHROPIC, ASK, proxy, undefined, { onDelta: (c) => seen.push(c) })).toBe("from the service");
    expect(proxy).toHaveBeenCalledOnce();
    expect(seen).toEqual([]);
  });

  it("refuses to send without a model chosen", async () => {
    await expect(chat({ ...ANTHROPIC, model: "" }, ASK)).rejects.toThrow(/provider and model/i);
  });

  it("refuses to send without the key a hosted provider needs", async () => {
    await expect(chat({ ...ANTHROPIC, apiKey: "" }, ASK)).rejects.toThrow(/API key/i);
  });
});
