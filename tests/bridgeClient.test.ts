import { describe, expect, it, vi } from "vitest";
import { BridgeClient } from "../src/bridge/bridgeClient.js";

type TestableBridgeClient = {
  onMessage(ws: WebSocket, raw: string): Promise<void>;
};

function socket(): { ws: WebSocket; send: ReturnType<typeof vi.fn> } {
  const send = vi.fn();
  return {
    ws: { readyState: WebSocket.OPEN, send } as unknown as WebSocket,
    send,
  };
}

async function deliver(client: BridgeClient, ws: WebSocket, raw: string): Promise<void> {
  await (client as unknown as TestableBridgeClient).onMessage(ws, raw);
}

describe("BridgeClient frames", () => {
  it("sends the exact serialized result whose size it checked", async () => {
    const client = new BridgeClient({ onStatus: vi.fn() });
    let serializations = 0;
    client.register("dynamic", () => ({
      toJSON: () => ({ version: ++serializations }),
    }));
    const { ws, send } = socket();

    await deliver(client, ws, JSON.stringify({ id: 1, method: "dynamic", params: {} }));

    expect(serializations).toBe(1);
    expect(send).toHaveBeenCalledOnce();
    expect(send).toHaveBeenCalledWith('{"id":1,"result":{"version":1}}');
  });

  it("measures the frame limit in UTF-8 bytes", async () => {
    const client = new BridgeClient({ onStatus: vi.fn() });
    client.register("large", () => "é".repeat(4_000_000));
    const { ws, send } = socket();

    await deliver(client, ws, JSON.stringify({ id: 2, method: "large", params: {} }));

    expect(send).toHaveBeenCalledOnce();
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      id: 2,
      error: expect.stringContaining("over the 8 MB frame limit"),
    });
  });

  it("ignores malformed and non-object request frames", async () => {
    const client = new BridgeClient({ onStatus: vi.fn() });
    const handler = vi.fn();
    client.register("valid", handler);
    const { ws, send } = socket();
    const invalid = [
      "{",
      "null",
      "[]",
      '"text"',
      "3",
      '{"id":"1","method":"valid","params":{}}',
      '{"id":1,"method":2,"params":{}}',
      '{"id":1,"method":"valid","params":[]}',
    ];

    for (const frame of invalid) await deliver(client, ws, frame);

    expect(handler).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("bounds concurrent bridge handlers", async () => {
    const client = new BridgeClient({ onStatus: vi.fn() });
    const releases: Array<() => void> = [];
    client.register("slow", () => new Promise<void>((resolve) => releases.push(resolve)));
    const { ws, send } = socket();
    const running = Array.from({ length: 32 }, (_, index) =>
      deliver(client, ws, JSON.stringify({ id: index, method: "slow", params: {} })),
    );
    await Promise.resolve();

    await deliver(client, ws, JSON.stringify({ id: 99, method: "slow", params: {} }));
    expect(JSON.parse(String(send.mock.calls[0]?.[0]))).toMatchObject({
      id: 99,
      error: expect.stringContaining("too many bridge requests"),
    });

    for (const release of releases) release();
    await Promise.all(running);
  });

  it("does not let abandoned work on an old socket block a reconnect", async () => {
    const client = new BridgeClient({ onStatus: vi.fn() });
    const releases: Array<() => void> = [];
    client.register("slow", () => new Promise<void>((resolve) => releases.push(resolve)));
    client.register("fast", () => "ready");
    const oldSocket = socket();
    const newSocket = socket();
    const abandoned = Array.from({ length: 32 }, (_, index) =>
      deliver(client, oldSocket.ws, JSON.stringify({ id: index, method: "slow", params: {} })),
    );
    await Promise.resolve();

    await deliver(client, newSocket.ws, JSON.stringify({ id: 100, method: "fast", params: {} }));
    expect(newSocket.send).toHaveBeenCalledWith('{"id":100,"result":"ready"}');

    for (const release of releases) release();
    await Promise.all(abandoned);
  });
});
