// Client for the Pyodide worker: lazy spawn, request/response correlation,
// wall-clock timeouts with terminate-and-respawn (wasm cannot be interrupted
// from JS: same cancel semantics as the parser worker).
import type { ModelSummary, PyRequest, PyResponse } from "./py.worker.js";

export type { ModelSummary } from "./py.worker.js";

export interface QueryResult {
  stdout: string;
  /** JSON-encoded value of the `result` variable, if the code set one. */
  resultJson: string | null;
}

export interface ProposedEdit {
  /** Full edited IFC bytes; becomes active only on Apply. */
  bytes: Uint8Array;
  stdout: string;
  summary: string;
  affectedGuids: string[];
  entityCountBefore: number;
  entityCountAfter: number;
}

export interface PythonEngineEvents {
  onInitProgress?: (step: string) => void;
}

/** Long ceiling: first init downloads tens of MB of runtime. */
const INIT_TIMEOUT_MS = 300_000;
/** Model load / edit execution ceiling. */
const EXEC_TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (msg: PyResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class PythonEngine {
  private worker: Worker | null = null;
  private initDone: Promise<void> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  /** Last bytes handed to setModel; used to restore state after a respawn. */
  private modelBytes: Uint8Array | null = null;
  private modelName = "";
  private modelPushed = false;

  constructor(private readonly events: PythonEngineEvents = {}) {}

  isReady(): boolean {
    return this.initDone !== null && this.worker !== null;
  }

  /** Boot Pyodide + install IfcOpenShell. Idempotent; safe to call early. */
  ensureReady(): Promise<void> {
    if (!this.initDone) {
      this.initDone = this.boot().catch((err) => {
        this.initDone = null;
        throw err;
      });
    }
    return this.initDone;
  }

  private async boot(): Promise<void> {
    const worker = new Worker(new URL("./py.worker.ts", import.meta.url), {
      type: "module",
    });
    worker.addEventListener("message", (e: MessageEvent<PyResponse>) =>
      this.onMessage(e.data),
    );
    // terminate, not just failAll: the broken worker must be dropped or the
    // next call would post into it while boot() spawns a second one.
    worker.addEventListener("error", (e: ErrorEvent) =>
      this.terminate(e.message || "python worker crashed"),
    );
    this.worker = worker;
    const done = await this.request({ type: "init", id: 0 }, INIT_TIMEOUT_MS);
    if (done.type === "initDone" && done.error) {
      throw new Error(done.error);
    }
  }

  private onMessage(msg: PyResponse): void {
    if (msg.type === "booted") return;
    if (msg.type === "initProgress") {
      this.events.onInitProgress?.(msg.step);
      return;
    }
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.type === "fail") p.reject(new Error(msg.message));
    else p.resolve(msg);
  }

  private request(msg: PyRequest, timeoutMs: number, transfer?: Transferable[]): Promise<PyResponse> {
    const id = msg.type === "init" ? 0 : this.nextId++;
    const outgoing = { ...msg, id };
    return new Promise<PyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Runaway Python cannot be interrupted; kill the worker. State is
        // restored lazily from modelBytes on the next call.
        this.terminate();
        reject(new Error(`Python operation timed out after ${timeoutMs / 1000}s`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.worker?.postMessage(outgoing, transfer ?? []);
    });
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  /** Set the active model. Retains the bytes so respawned workers can restore it. */
  async setModel(bytes: Uint8Array, fileName: string): Promise<ModelSummary> {
    this.modelBytes = bytes;
    this.modelName = fileName;
    await this.ensureReady();
    const summary = await this.pushModel();
    return summary;
  }

  private async pushModel(): Promise<ModelSummary> {
    const bytes = this.modelBytes!;
    const copy = bytes.slice(); // transfer a copy, keep ours
    const res = await this.request(
      { type: "setModel", id: 0, bytes: copy.buffer, fileName: this.modelName },
      EXEC_TIMEOUT_MS,
      [copy.buffer],
    );
    if (res.type !== "modelSet") throw new Error("unexpected response");
    this.modelPushed = true;
    return res.summary;
  }

  /** Re-push the model if the worker was respawned since the last setModel. */
  private async ensureModel(): Promise<void> {
    await this.ensureReady();
    if (!this.modelPushed) {
      if (!this.modelBytes) throw new Error("no model loaded");
      await this.pushModel();
    }
  }

  async runQuery(code: string): Promise<QueryResult> {
    await this.ensureModel();
    const res = await this.request({ type: "runQuery", id: 0, code }, EXEC_TIMEOUT_MS);
    if (res.type !== "queryResult") throw new Error("unexpected response");
    return { stdout: res.stdout, resultJson: res.resultJson };
  }

  async proposeEdit(code: string): Promise<ProposedEdit> {
    await this.ensureModel();
    const res = await this.request({ type: "proposeEdit", id: 0, code }, EXEC_TIMEOUT_MS);
    if (res.type !== "editProposed") throw new Error("unexpected response");
    return {
      bytes: new Uint8Array(res.bytes),
      stdout: res.stdout,
      summary: res.summary,
      affectedGuids: res.affectedGuids,
      entityCountBefore: res.entityCountBefore,
      entityCountAfter: res.entityCountAfter,
    };
  }

  terminate(reason = "python worker terminated"): void {
    this.worker?.terminate();
    this.worker = null;
    this.initDone = null;
    this.modelPushed = false;
    this.failAll(new Error(reason));
  }
}
