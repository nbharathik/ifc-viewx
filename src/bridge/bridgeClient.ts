// WebSocket client for the optional local MCP bridge (the ifcviewx service).
// The bridge is the MCP server; the browser is a tool backend: the bridge
// forwards each MCP tool call here as {id, method, params} and we answer
// with {id, result} or {id, error}. Only Local Studio ever opens this socket.

export type BridgeHandler = (params: Record<string, unknown>) => Promise<unknown> | unknown;

export interface BridgeClientOptions {
  onStatus(status: "disconnected" | "connecting" | "connected", detail?: string): void;
}

const DEFAULT_URL = "ws://127.0.0.1:8765";
/** Comfortably inside the service's own websocket frame limit. */
const MAX_FRAME_BYTES = 8e6;
const encoder = new TextEncoder();

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, BridgeHandler>();
  private closedByUser = false;
  private readonly inFlight = new WeakMap<WebSocket, number>();

  constructor(private readonly options: BridgeClientOptions) {}

  register(method: string, handler: BridgeHandler): void {
    this.handlers.set(method, handler);
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(token: string, url = DEFAULT_URL): void {
    this.disconnect();
    this.closedByUser = false;
    this.options.onStatus("connecting");
    const ws = new WebSocket(`${url}/ws?token=${encodeURIComponent(token)}`);
    this.ws = ws;

    ws.addEventListener("open", () => this.options.onStatus("connected"));
    ws.addEventListener("close", () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.options.onStatus("disconnected", this.closedByUser ? undefined : "bridge connection closed");
    });
    ws.addEventListener("error", () => {
      if (this.ws !== ws) return;
      this.options.onStatus("disconnected", "could not reach the bridge (is `ifcviewx` running?)");
    });
    ws.addEventListener("message", (event: MessageEvent<string>) => {
      void this.onMessage(ws, event.data);
    });
  }

  private async onMessage(ws: WebSocket, raw: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const { id, method, params } = parsed;
    if (typeof id !== "number" || !Number.isFinite(id) || typeof method !== "string" || !method) return;
    if (params !== undefined && !isRecord(params)) return;
    const handler = this.handlers.get(method);
    // The socket can close while a handler runs, and send() on a closed socket
    // throws straight past the catch that is meant to report the failure.
    const reply = (payload: string): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(payload);
      } catch {
        // Nothing left to answer on.
      }
    };
    const running = this.inFlight.get(ws) ?? 0;
    if (running >= 32) {
      reply(JSON.stringify({ id, error: "too many bridge requests are already running" }));
      return;
    }
    this.inFlight.set(ws, running + 1);
    try {
      if (!handler) throw new Error(`unknown method: ${method}`);
      const result = await handler(params ?? {});
      const body = JSON.stringify({ id, result: result ?? null });
      const bodyBytes = encoder.encode(body).byteLength;
      // A whole spatial tree can outrun the service's frame limit, and a frame
      // that never arrives reads as a hang rather than as a size problem.
      if (bodyBytes > MAX_FRAME_BYTES) {
        throw new Error(
          `result is ${(bodyBytes / 1e6).toFixed(1)} MB, over the ${MAX_FRAME_BYTES / 1e6} MB frame limit; ask for a narrower slice`,
        );
      }
      // Send the exact string whose encoded size was checked. Serializing a
      // result twice can invoke toJSON twice and produce a different frame.
      reply(body);
    } catch (err) {
      reply(JSON.stringify({ id, error: err instanceof Error ? err.message : String(err) }));
    } finally {
      const remaining = (this.inFlight.get(ws) ?? 1) - 1;
      if (remaining > 0) this.inFlight.set(ws, remaining);
      else this.inFlight.delete(ws);
    }
  }

  disconnect(): void {
    this.closedByUser = true;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
      this.options.onStatus("disconnected");
    }
  }
}
