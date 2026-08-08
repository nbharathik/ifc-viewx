import type { SweepProgress, SweepResult, SweepSpec } from "../ifc/clash/types.js";
import { chunkTransfers, type TriangleStore } from "../viewer-core/scene/triangleStore.js";
import type { Viewer } from "../viewer-core/viewer.js";
import type {
  DistanceResult, DistanceSpec, GeometryDiagnostics, GeometryRequest, GeometryResponse, LaserResult, LaserSpec,
} from "./types.js";

interface Pending {
  kind: "clash" | "distance" | "laser";
  resolve(value: unknown): void;
  reject(error: Error): void;
  onProgress?(progress: SweepProgress): void;
  cleanup?(): void;
}

interface InlineRunner {
  clash(
    spec: SweepSpec,
    onProgress?: (progress: SweepProgress) => void,
    cancelled?: () => boolean,
  ): Promise<SweepResult>;
  distance(spec: DistanceSpec): Promise<DistanceResult>;
  laser(spec: LaserSpec, cancelled?: () => boolean): Promise<LaserResult>;
}

export class GeometryService {
  private worker: Worker | null = null;
  private inline: InlineRunner | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly cancelled = new Set<number>();
  private sequence = 0;

  constructor(private readonly store: TriangleStore) {}

  get active(): boolean {
    return this.worker !== null || this.inline !== null;
  }

  diagnostics(): GeometryDiagnostics {
    return {
      active: this.active,
      pending: this.pending.size,
      retainedTriangles: this.store.triangleCount,
      retainedBytes: this.store.retainedBytes,
      truncated: this.store.truncated,
    };
  }

  async clash(
    spec: SweepSpec,
    onProgress?: (progress: SweepProgress) => void,
    signal?: AbortSignal,
  ): Promise<SweepResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    this.cancelKind("clash");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.inline.clash(spec, onProgress, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<SweepResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "clash",
        resolve,
        reject,
        onProgress,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "clash", id, priority: 2, spec } satisfies GeometryRequest, [
        spec.a.buffer,
        spec.b.buffer,
        spec.offsets.buffer,
      ] as Transferable[]);
    });
  }

  async distance(spec: DistanceSpec, signal?: AbortSignal): Promise<DistanceResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const result = await this.inline.distance(spec);
      if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
      return result;
    }
    return new Promise<DistanceResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "distance",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "distance", id, priority: 0, spec } satisfies GeometryRequest, [
        spec.offsets.buffer,
      ] as Transferable[]);
    });
  }

  async laser(spec: LaserSpec, signal?: AbortSignal): Promise<LaserResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      try {
        const result = await this.inline.laser(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<LaserResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "laser",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "laser", id, priority: 0, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
        spec.offsets.buffer,
      ] as Transferable[]);
    });
  }

  cancelClash(): void {
    this.cancelKind("clash");
  }

  private start(): Promise<void> {
    if (this.starting) return this.starting;
    if (typeof Worker === "undefined") {
      this.starting = Promise.all([
        import("./geometryIndex.js"),
        import("../ifc/clash/sweep.js"),
        import("./distanceQuery.js"),
        import("./laserQuery.js"),
      ]).then(([{ GeometryIndex }, { runSweep }, { runDistance }, { runLaser }]) => {
        const index = new GeometryIndex();
        this.inline = {
          clash: (spec, onProgress, cancelled) => runSweep(index, spec, { onProgress, cancelled }),
          distance: (spec) => runDistance(index, spec),
          laser: (spec, cancelled) => runLaser(index, spec, { cancelled }),
        };
        this.store.connect({
          chunk: (chunk) => index.addChunk(chunk),
          dropModel: (model) => {
            this.cancelKind("clash");
            index.dropModel(model);
          },
          clear: () => {
            this.cancelKind("clash");
            index.clear();
          },
          dispose: () => this.shutdown(),
        });
      });
      return this.starting;
    }

    const worker = new Worker(new URL("./geometry.worker.ts", import.meta.url), { type: "module" });
    worker.onmessage = (event: MessageEvent<GeometryResponse>) => this.receive(event.data);
    worker.onerror = (event) => {
      const error = new Error(event.message || "the geometry worker stopped");
      for (const pending of this.pending.values()) {
        pending.cleanup?.();
        pending.reject(error);
      }
      this.pending.clear();
    };
    this.worker = worker;
    this.store.connect({
      chunk: (chunk) => worker.postMessage(
        { type: "geometry", chunk } satisfies GeometryRequest,
        chunkTransfers(chunk),
      ),
      dropModel: (model) => {
        this.cancelAll(new Error("Geometry changed while the query was running"));
        worker.postMessage({ type: "dropModel", model } satisfies GeometryRequest);
      },
      clear: () => {
        this.cancelAll(new Error("Geometry changed while the query was running"));
        worker.postMessage({ type: "clear" } satisfies GeometryRequest);
      },
      dispose: () => this.shutdown(),
    });
    this.starting = Promise.resolve();
    return this.starting;
  }

  private receive(message: GeometryResponse): void {
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.type === "clashProgress") {
      pending.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.id);
    pending.cleanup?.();
    if (message.type === "fail") pending.reject(new Error(message.message));
    else pending.resolve(message.result);
  }

  private cancelKind(kind: Pending["kind"]): void {
    for (const [id, pending] of this.pending) {
      if (pending.kind !== kind) continue;
      this.pending.delete(id);
      pending.cleanup?.();
      this.cancelled.add(id);
      this.worker?.postMessage({ type: "cancel", id } satisfies GeometryRequest);
      pending.reject(new DOMException("Geometry query cancelled", "AbortError"));
    }
    if (this.inline && kind === "clash") {
      this.cancelled.add(this.sequence);
    }
  }

  private cancelRequest(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup?.();
    this.cancelled.add(id);
    this.worker?.postMessage({ type: "cancel", id } satisfies GeometryRequest);
    pending.reject(new DOMException("Geometry query cancelled", "AbortError"));
  }

  private cancelAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      this.worker?.postMessage({ type: "cancel", id } satisfies GeometryRequest);
      pending.cleanup?.();
      pending.reject(error);
    }
    this.pending.clear();
  }

  private shutdown(): void {
    this.cancelAll(new Error("Geometry service disposed"));
    this.worker?.terminate();
    this.worker = null;
    this.inline = null;
    this.starting = null;
    this.cancelled.clear();
  }
}

const services = new WeakMap<Viewer, GeometryService>();

export function geometryService(viewer: Viewer): GeometryService {
  let service = services.get(viewer);
  if (!service) {
    service = new GeometryService(viewer.getTriangles());
    services.set(viewer, service);
  }
  return service;
}
