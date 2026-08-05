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
const MAX_FRAME_CHARS = 8e6;

export class BridgeClient {
  private ws: WebSocket | null = null;
  private readonly handlers = new Map<string, BridgeHandler>();
  private closedByUser = false;

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
    let msg: { id?: number; method?: string; params?: Record<string, unknown> };
    try {
      msg = JSON.parse(raw) as typeof msg;
    } catch {
      return;
    }
    if (msg.id === undefined || !msg.method) return;
    const handler = this.handlers.get(msg.method);
    // The socket can close while a handler runs, and send() on a closed socket
    // throws straight past the catch that is meant to report the failure.
    const reply = (payload: unknown): void => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify(payload));
      } catch {
        // Nothing left to answer on.
      }
    };
    try {
      if (!handler) throw new Error(`unknown method: ${msg.method}`);
      const result = await handler(msg.params ?? {});
      const body = JSON.stringify({ id: msg.id, result: result ?? null });
      // A whole spatial tree can outrun the service's frame limit, and a frame
      // that never arrives reads as a hang rather than as a size problem.
      if (body.length > MAX_FRAME_CHARS) {
        throw new Error(
          `result is ${(body.length / 1e6).toFixed(1)} MB, over the ${MAX_FRAME_CHARS / 1e6} MB frame limit; ask for a narrower slice`,
        );
      }
      reply({ id: msg.id, result: result ?? null });
    } catch (err) {
      reply({ id: msg.id, error: err instanceof Error ? err.message : String(err) });
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
