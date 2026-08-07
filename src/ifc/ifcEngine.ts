// Client for the semantic worker. Same shape as PythonEngine so the shell
// wires it the same way, but there is nothing to download: web-ifc is already
// in the bundle, so checks, schedules and edits are available on first paint.
import type { ValidationReport } from "./checks.js";
import type { ScheduleReport } from "./schedule.js";
import type { EditOp, EditOutcome } from "./edits.js";
import type { IfcRequest, IfcResponse } from "./ifc.worker.js";

export type { ValidationReport, Check, Severity } from "./checks.js";
export type { ScheduleReport } from "./schedule.js";
export type { EditOp, EditDiff, EditOutcome } from "./edits.js";

export interface ProposedEdit extends EditOutcome {
  bytes: Uint8Array;
}

const TIMEOUT_MS = 120_000;

interface Pending {
  resolve: (message: IfcResponse) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class IfcEngine {
  private worker: Worker | null = null;
  private booted: Promise<unknown> | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private bytes: Uint8Array | null = null;
  private pushed = false;
  private pushing: Promise<void> | null = null;

  constructor(private readonly wasmPath: string) {}

  private spawn(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./ifc.worker.ts", import.meta.url), { type: "module" });
    worker.addEventListener("message", (e: MessageEvent<IfcResponse>) => this.settle(e.data));
    worker.addEventListener("error", (e: ErrorEvent) =>
      this.failAll(new Error(e.message || "the IFC worker crashed")),
    );
    this.worker = worker;
    this.booted = this.send({ type: "init", id: 0, wasmPath: this.wasmPath });
    return worker;
  }

  private settle(message: IfcResponse): void {
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.type === "fail") {
      // The worker's own console is not reachable from the page, so surface
      // the stack here: an error from inside web-ifc is unreadable without it.
      if (message.stack) console.error("[ifc engine]", message.stack);
      entry.reject(new Error(message.message));
    } else entry.resolve(message);
  }

  private failAll(err: Error): void {
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pending.clear();
    // Dropping the reference is not enough: the thread stays alive with a
    // parsed model and its wasm heap until it is told to stop.
    this.worker?.terminate();
    this.worker = null;
    this.pushed = false;
    this.pushing = null;
  }

  private send(request: IfcRequest, transfer: Transferable[] = []): Promise<IfcResponse> {
    const worker = this.spawn();
    const id = request.type === "init" ? 0 : this.nextId++;
    return new Promise<IfcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.worker?.terminate();
        this.failAll(new Error(`The IFC engine timed out after ${TIMEOUT_MS / 1000}s`));
      }, TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ ...request, id }, transfer);
    });
  }

  /** Remember the active bytes (null for .ifcx, which has no STEP source);
   *  the worker is only loaded when first used. */
  setModel(bytes: Uint8Array | null): void {
    this.bytes = bytes;
    this.pushed = false;
    this.pushing = null;
  }

  private ready(): Promise<void> {
    // Single-flight: checks and schedules both call this, and without the
    // shared promise each would copy and transfer the whole model on its own.
    this.pushing ??= this.push().catch((err: unknown) => {
      this.pushing = null;
      throw err;
    });
    return this.pushing;
  }

  private async push(): Promise<void> {
    if (this.pushed) return;
    if (!this.bytes) {
      throw new Error(
        "No readable .ifc source. Open an .ifc file; a converted .ifcx carries no STEP source for checks, schedules and edits.",
      );
    }
    if (this.bytes.byteLength === 0) {
      throw new Error("The model bytes were released before the engine could read them.");
    }
    this.spawn();
    await this.booted;
    const copy = this.bytes.slice();
    await this.send({ type: "setModel", id: 0, bytes: copy.buffer as ArrayBuffer }, [copy.buffer]);
    this.pushed = true;
  }

  async validate(): Promise<ValidationReport> {
    await this.ready();
    const message = await this.send({ type: "validate", id: 0 });
    return (message as { payload: ValidationReport }).payload;
  }

  async schedule(ifcType: string, properties: string[] = [], limit = 500): Promise<ScheduleReport> {
    await this.ready();
    const message = await this.send({ type: "schedule", id: 0, ifcType, properties, limit });
    return (message as { payload: ScheduleReport }).payload;
  }

  async elementTypes(): Promise<Record<string, number>> {
    await this.ready();
    const message = await this.send({ type: "types", id: 0 });
    return (message as { payload: Record<string, number> }).payload;
  }

  async propose(op: EditOp): Promise<ProposedEdit> {
    return this.proposeBatch([op]);
  }

  /** Several ops against one copy, staged as one approval. */
  async proposeBatch(ops: EditOp[]): Promise<ProposedEdit> {
    await this.ready();
    const message = await this.send({ type: "proposeBatch", id: 0, ops });
    if (message.type !== "proposed") throw new Error("unexpected response");
    return { ...(message.payload as EditOutcome), bytes: new Uint8Array(message.bytes) };
  }
}
