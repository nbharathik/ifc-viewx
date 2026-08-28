import { afterEach, describe, expect, it, vi } from "vitest";

import { IfcEngine } from "../src/ifc/ifcEngine.js";

type WorkerRequest = { id: number; type: string; bytes?: ArrayBuffer };
type MessageListener = (event: MessageEvent) => void;
type ErrorListener = (event: ErrorEvent) => void;

class ControlledWorker {
  static latest: ControlledWorker | null = null;
  readonly requests: WorkerRequest[] = [];
  private readonly messageListeners: MessageListener[] = [];
  private readonly errorListeners: ErrorListener[] = [];

  constructor() {
    ControlledWorker.latest = this;
  }

  addEventListener(type: string, listener: EventListener): void {
    if (type === "message") this.messageListeners.push(listener as unknown as MessageListener);
    if (type === "error") this.errorListeners.push(listener as unknown as ErrorListener);
  }

  postMessage(request: WorkerRequest): void {
    this.requests.push(request);
  }

  terminate(): void {}

  respond(message: Record<string, unknown>): void {
    for (const listener of this.messageListeners) {
      listener({ data: message } as MessageEvent);
    }
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  ControlledWorker.latest = null;
});

describe("IfcEngine model revisions", () => {
  it("does not let an old semantic upload mark a replacement as ready", async () => {
    vi.stubGlobal("Worker", ControlledWorker);
    const engine = new IfcEngine("/wasm/");
    engine.setModel(new Uint8Array([1]));
    const first = engine.validate();
    const firstOutcome = first.then(
      () => new Error("stale validation unexpectedly resolved"),
      (error: unknown) => error instanceof Error ? error : new Error(String(error)),
    );
    const worker = ControlledWorker.latest;
    if (!worker) throw new Error("worker was not created");
    expect(worker.requests.map((request) => request.type)).toEqual(["init"]);

    worker.respond({ type: "ready", id: 0 });
    await vi.waitFor(() => expect(worker.requests.some((request) => request.type === "setModel")).toBe(true));
    const firstSet = worker.requests.find((request) => request.type === "setModel");
    if (!firstSet) throw new Error("first model was not sent");
    expect(new Uint8Array(firstSet.bytes ?? new ArrayBuffer(0)).at(0)).toBe(1);

    engine.setModel(new Uint8Array([2]));
    worker.respond({ type: "modelSet", id: firstSet.id });
    expect((await firstOutcome).message).toContain("active model changed");

    const second = engine.validate();
    await vi.waitFor(() => {
      expect(worker.requests.filter((request) => request.type === "setModel")).toHaveLength(2);
    });
    const secondSet = worker.requests.filter((request) => request.type === "setModel")[1];
    expect(new Uint8Array(secondSet.bytes ?? new ArrayBuffer(0)).at(0)).toBe(2);
    worker.respond({ type: "modelSet", id: secondSet.id });
    await vi.waitFor(() => expect(worker.requests.some((request) => request.type === "validate")).toBe(true));
    const validation = worker.requests.find((request) => request.type === "validate");
    if (!validation) throw new Error("validation was not sent");
    worker.respond({ type: "result", id: validation.id, payload: { ok: true, checks: [] } });

    await expect(second).resolves.toMatchObject({ ok: true });
  });
});
