import type { SweepProgress, SweepResult, SweepSpec } from "../ifc/clash/types.js";
import { chunkTransfers, type TriangleStore } from "../viewer-core/scene/triangleStore.js";
import type { Viewer } from "../viewer-core/viewer.js";
import type {
  DistanceResult, DistanceSpec, GeometryDiagnostics, GeometryRequest, GeometryResponse, LaserResult, LaserSpec,
  MeshesResult, MeshesSpec, SectionContourResult, SectionContourSpec, GeometrySignatureResult, GeometrySignatureSpec,
  VolumesResult, VolumesSpec, PlaneClassifyResult, PlaneClassifySpec,
} from "./types.js";

interface Pending {
  kind: "clash" | "distance" | "laser" | "sectionContours" | "signatures" | "volumes" | "classifyPlane" | "meshes";
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
  sectionContours(spec: SectionContourSpec, cancelled?: () => boolean): Promise<SectionContourResult>;
  signatures(spec: GeometrySignatureSpec, cancelled?: () => boolean): Promise<GeometrySignatureResult>;
  volumes(spec: VolumesSpec, cancelled?: () => boolean): Promise<VolumesResult>;
  classifyPlane(spec: PlaneClassifySpec, cancelled?: () => boolean): Promise<PlaneClassifyResult>;
  meshes(spec: MeshesSpec, cancelled?: () => boolean): Promise<MeshesResult>;
}

export class GeometryService {
  private worker: Worker | null = null;
  private inline: InlineRunner | null = null;
  private starting: Promise<void> | null = null;
  private readonly pending = new Map<number, Pending>();
  private readonly cancelled = new Set<number>();
  private readonly inlineActive = new Map<number, Pending["kind"]>();
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
      this.inlineActive.set(id, "clash");
      try {
        const result = await this.inline.clash(spec, onProgress, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
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
        ...(spec.transforms ? [spec.transforms.buffer] : []),
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
        ...(spec.transforms ? [spec.transforms.buffer] : []),
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
      this.inlineActive.set(id, "laser");
      try {
        const result = await this.inline.laser(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
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
        ...(spec.transforms ? [spec.transforms.buffer] : []),
      ] as Transferable[]);
    });
  }

  async sectionContours(spec: SectionContourSpec, signal?: AbortSignal): Promise<SectionContourResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      this.inlineActive.set(id, "sectionContours");
      try {
        const result = await this.inline.sectionContours(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<SectionContourResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "sectionContours",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "sectionContours", id, priority: 0, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
        spec.offsets.buffer,
        ...(spec.transforms ? [spec.transforms.buffer] : []),
      ] as Transferable[]);
    });
  }

  async signatures(spec: GeometrySignatureSpec, signal?: AbortSignal): Promise<GeometrySignatureResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      this.inlineActive.set(id, "signatures");
      try {
        const result = await this.inline.signatures(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<GeometrySignatureResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "signatures",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "signatures", id, priority: 1, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
      ] as Transferable[]);
    });
  }

  async volumes(spec: VolumesSpec, signal?: AbortSignal): Promise<VolumesResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      this.inlineActive.set(id, "volumes");
      try {
        const result = await this.inline.volumes(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<VolumesResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "volumes",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "volumes", id, priority: 1, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
        spec.offsets.buffer,
        ...(spec.transforms ? [spec.transforms.buffer] : []),
      ] as Transferable[]);
    });
  }

  async classifyPlane(spec: PlaneClassifySpec, signal?: AbortSignal): Promise<PlaneClassifyResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      this.inlineActive.set(id, "classifyPlane");
      try {
        const result = await this.inline.classifyPlane(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<PlaneClassifyResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "classifyPlane",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "classifyPlane", id, priority: 0, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
        spec.offsets.buffer,
        ...(spec.transforms ? [spec.transforms.buffer] : []),
      ] as Transferable[]);
    });
  }

  async meshes(spec: MeshesSpec, signal?: AbortSignal): Promise<MeshesResult> {
    if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
    await this.start();
    const id = ++this.sequence;
    this.cancelled.delete(id);
    if (this.inline) {
      const abort = (): void => void this.cancelled.add(id);
      signal?.addEventListener("abort", abort, { once: true });
      this.inlineActive.set(id, "meshes");
      try {
        const result = await this.inline.meshes(spec, () => this.cancelled.has(id));
        if (signal?.aborted) throw new DOMException("Geometry query cancelled", "AbortError");
        return result;
      } finally {
        this.inlineActive.delete(id);
        signal?.removeEventListener("abort", abort);
        this.cancelled.delete(id);
      }
    }
    return new Promise<MeshesResult>((resolve, reject) => {
      const abort = (): void => this.cancelRequest(id);
      this.pending.set(id, {
        kind: "meshes",
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener("abort", abort),
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) return abort();
      this.worker?.postMessage({ type: "meshes", id, priority: 1, spec } satisfies GeometryRequest, [
        spec.ids.buffer,
        spec.offsets.buffer,
        ...(spec.transforms ? [spec.transforms.buffer] : []),
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
        import("./sectionQuery.js"),
        import("./signatureQuery.js"),
        import("./volumeQuery.js"),
        import("./planeQuery.js"),
        import("./meshQuery.js"),
      ]).then(([
        { GeometryIndex }, { runSweep }, { runDistance }, { runLaser },
        { runSectionContours }, { runGeometrySignatures }, { runVolumes }, { runClassifyPlane }, { runMeshes },
      ]) => {
        const index = new GeometryIndex();
        this.inline = {
          clash: (spec, onProgress, cancelled) => runSweep(index, spec, {
            onProgress,
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
          distance: (spec) => runDistance(index, spec),
          laser: (spec, cancelled) => runLaser(index, spec, { cancelled }),
          sectionContours: (spec, cancelled) => runSectionContours(index, spec, {
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
          signatures: (spec, cancelled) => runGeometrySignatures(index, spec, {
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
          volumes: (spec, cancelled) => runVolumes(index, spec, {
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
          classifyPlane: (spec, cancelled) => runClassifyPlane(index, spec, {
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
          meshes: (spec, cancelled) => runMeshes(index, spec, {
            cancelled,
            yieldTurn: () => new Promise((resolve) => setTimeout(resolve, 0)),
          }),
        };
        this.store.connect({
          chunk: (chunk) => index.addChunk(chunk),
          dropModel: (model) => {
            this.cancelInlineActive();
            index.dropModel(model);
          },
          clear: () => {
            this.cancelInlineActive();
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
      if (this.inline) this.cancelled.add(id);
      this.worker?.postMessage({ type: "cancel", id } satisfies GeometryRequest);
      pending.reject(new DOMException("Geometry query cancelled", "AbortError"));
    }
    for (const [id, active] of this.inlineActive) {
      if (active === kind) this.cancelled.add(id);
    }
  }

  private cancelInlineActive(): void {
    for (const id of this.inlineActive.keys()) this.cancelled.add(id);
  }

  private cancelRequest(id: number): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    pending.cleanup?.();
    if (this.inline) this.cancelled.add(id);
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
    this.inlineActive.clear();
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
