import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ServiceClient,
  satisfiesVersionRange,
  type LocalJob,
  type LocalProvider,
} from "../src/bridge/serviceClient.js";

afterEach(() => vi.restoreAllMocks());

function localClient(): ServiceClient {
  const client = new ServiceClient();
  const provider = {
    id: "org.example.native",
    version: "1.4.0",
    capabilities: [{ id: "geometry.exact", available: true }],
  } as LocalProvider;
  Object.assign(client, {
    health: { capabilities: [], store: {}, providerApi: { min: 1, max: 1 } },
    providers: [provider],
    sha: "a".repeat(64),
    origin: "http://127.0.0.1:8765",
  });
  return client;
}

function response(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
}

function job(status: LocalJob["status"]): LocalJob {
  return {
    schemaVersion: 1,
    id: "b".repeat(32),
    status,
    providerId: "org.example.native",
    providerVersion: "1.4.0",
    capabilityId: "geometry.exact",
    progress: { phase: status, done: 1, total: 1, message: status },
    resultAvailable: status === "succeeded",
  };
}

describe("Local Studio provider version matching", () => {
  it("supports the extension manifest range forms", () => {
    expect(satisfiesVersionRange("1.4.2", "*")).toBe(true);
    expect(satisfiesVersionRange("1.4.2", ">=1.2 <2")).toBe(true);
    expect(satisfiesVersionRange("1.4.2", "^1.3")).toBe(true);
    expect(satisfiesVersionRange("1.4.2", "~1.4")).toBe(true);
    expect(satisfiesVersionRange("1.4.2", "2.x")).toBe(false);
    expect(satisfiesVersionRange("1.4.2", "latest")).toBeNull();
  });

  it("invokes a matched provider and returns the versioned result value", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(job("succeeded")))
      .mockResolvedValueOnce(response({ schemaVersion: 1, value: { distance: 4.2 } }));
    const client = localClient();

    await expect(client.invokeLocal("org.example.native", "^1.2", "geometry.exact", { tolerance: 2 }))
      .resolves.toEqual({ distance: 4.2 });
    const start = JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;
    expect(start).toMatchObject({
      providerId: "org.example.native",
      providerVersion: "^1.2",
      capabilityId: "geometry.exact",
      modelSha: "a".repeat(64),
      input: { tolerance: 2 },
    });
    expect(JSON.stringify(start)).not.toContain("path");
  });

  it("cancels the service job when the caller aborts", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response(job("running")))
      .mockResolvedValueOnce(response(job("cancelled")));
    const controller = new AbortController();
    controller.abort();
    const client = localClient();

    await expect(client.invokeLocal("org.example.native", "^1.2", "geometry.exact", {}, controller.signal))
      .rejects.toMatchObject({ name: "AbortError" });
    expect(String(fetchMock.mock.calls[1][0])).toContain("/cancel");
  });
});

describe("Local Studio assistant stream", () => {
  it("normalizes CRLF SSE deltas, tool calls and usage", async () => {
    const encoder = new TextEncoder();
    const events = [
      { type: "text_delta", delta: "Checking" },
      { type: "tool_call", call: { id: "c1", name: "counts", input: {} } },
      { type: "usage", usage: { input: 19, output: 4 } },
      { type: "done", text: "Checking", calls: [{ id: "c1", name: "counts", input: {} }], toolsUsed: true },
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\r\n\r\n`));
        controller.close();
      },
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }));
    const deltas: string[] = [];
    let usage = { input: 0, output: 0 };

    const turn = await localClient().converse(
      [{ role: "user", content: "Count" }],
      [{ name: "counts", description: "Count IFC types", schema: { type: "object", properties: {}, required: [] } }],
      undefined,
      { onDelta: (value) => deltas.push(value), onUsage: (value) => (usage = value) },
    );

    expect(turn).toEqual({ text: "Checking", calls: [{ id: "c1", name: "counts", input: {} }], toolsUsed: true });
    expect(deltas).toEqual(["Checking"]);
    expect(usage).toEqual({ input: 19, output: 4 });
  });
});
