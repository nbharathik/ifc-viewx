// Main-thread half of the clash engine.
//
// The worker is not started until the first sweep is asked for, so a session
// that never opens the clash panel downloads no BVH code and runs no extra
// thread. Until then the triangle store keeps the packed chunks, and starting
// up hands them over with a transfer, so they are copied once on the way in
// and never again.
//
// Nothing here imports three or three-mesh-bvh. Both live behind the worker
// entry and behind one dynamic import, which is what keeps them out of the
// app's first load.
import { chunkTransfers, type TriangleStore } from "../../viewer-core/scene/triangleStore.js";
import type { ClashRequest, ClashResponse, SweepProgress, SweepResult, SweepSpec } from "./types.js";

interface Pending {
  resolve(result: SweepResult): void;
  reject(error: Error): void;
  onProgress?(progress: SweepProgress): void;
}

/** Stands in for the worker where there is none, such as under Node. */
interface InlineRunner {
  run(spec: SweepSpec, onProgress?: (progress: SweepProgress) => void, cancelled?: () => boolean): Promise<SweepResult>;
}

export class ClashEngine {
  private worker: Worker | null = null;
  private inline: InlineRunner | null = null;
  private starting: Promise<void> | null = null;
  private seq = 0;
  private pending: Pending | null = null;
  private pendingId = 0;
  private cancelled = false;

  constructor(private readonly store: TriangleStore) {}

  /** True once the worker exists, which is what the model panel reports. */
  get active(): boolean {
    return this.worker !== null || this.inline !== null;
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    if (typeof Worker === "undefined") {
      this.starting = import("./sweep.js").then(({ ClashGeometryIndex, runSweep }) => {
        const index = new ClashGeometryIndex();
        this.inline = {
          run: (spec, onProgress, cancelled) => runSweep(index, spec, { onProgress, cancelled }),
        };
        this.store.connect({
          chunk: (chunk) => index.addChunk(chunk),
          dropModel: (model) => index.dropModel(model),
          clear: () => index.clear(),
          dispose: () => this.shutdown(),
        });
      });
      return this.starting;
    }
    const worker = new Worker(new URL("./clash.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<ClashResponse>) => this.receive(event.data);
    worker.onerror = (event) => {
      this.pending?.reject(new Error(event.message || "the clash worker stopped"));
      this.pending = null;
    };
    this.worker = worker;
    this.store.connect({
      chunk: (chunk) =>
        worker.postMessage({ type: "geometry", chunk } satisfies ClashRequest, chunkTransfers(chunk)),
      dropModel: (model) => worker.postMessage({ type: "dropModel", model } satisfies ClashRequest),
      clear: () => {
        this.cancel();
        worker.postMessage({ type: "clear" } satisfies ClashRequest);
      },
      dispose: () => this.shutdown(),
    });
    this.starting = Promise.resolve();
    return this.starting;
  }

  private receive(message: ClashResponse): void {
    if (!this.pending || message.id !== this.pendingId) return;
    if (message.type === "progress") {
      this.pending.onProgress?.(message.progress);
      return;
    }
    const pending = this.pending;
    this.pending = null;
    if (message.type === "result") pending.resolve(message.result);
    else pending.reject(new Error(message.message));
  }

  /** One sweep at a time; asking for another abandons the one in flight. */
  async sweep(spec: SweepSpec, onProgress?: (progress: SweepProgress) => void): Promise<SweepResult> {
    this.cancel();
    await this.start();
    const id = ++this.seq;
    this.pendingId = id;
    this.cancelled = false;

    if (this.inline) return this.inline.run(spec, onProgress, () => this.cancelled);
    return new Promise<SweepResult>((resolve, reject) => {
      this.pending = { resolve, reject, onProgress };
      this.worker?.postMessage({ type: "sweep", id, spec } satisfies ClashRequest, [
        spec.a.buffer,
        spec.b.buffer,
        spec.offsets.buffer,
      ] as Transferable[]);
    });
  }

  cancel(): void {
    this.cancelled = true;
    if (!this.pending) return;
    this.pending = null;
    this.worker?.postMessage({ type: "cancel" } satisfies ClashRequest);
  }

  /** Called by the store when the viewer it belongs to is torn down. */
  private shutdown(): void {
    this.cancel();
    this.worker?.terminate();
    this.worker = null;
    this.inline = null;
    this.starting = null;
  }
}
