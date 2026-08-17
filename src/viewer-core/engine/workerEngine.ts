// Worker-backed engine client: spawns the parser worker (blob fallback for
// cross-origin webview resources), maps request ids to promises, and unpacks
// mesh batches. Cancel is terminate-and-respawn; wasm cannot be interrupted.
import { GeometryRegistry } from './packets.js';
import type { MeshBatch, WorkerRequest, WorkerResponse } from './packets.js';
import {
  CancelledError,
  type AsyncIfcEngine,
  type AsyncLoadOptions,
  type IfcGridInfo,
  type IfcMesh,
  type IfcTaskGraph,
  type ItemProperties,
  type LazyCategory,
  type LoadSource,
  type LoadedModelMeta,
  type OrganizeIndex,
} from './types.js';

export interface WorkerSpawnOptions {
  /** Preferred: a factory the host controls (Vite worker import, test stub). */
  factory?: () => Worker;
  /** Bundled worker script URL (webview path); blob fallback when cross-origin. */
  url?: string;
}

export interface WorkerEngineOptions {
  wasmPath?: string;
  wasmAbsolute?: boolean;
  spawn: WorkerSpawnOptions;
}

interface Pending {
  resolve: (value: never) => void;
  reject: (err: Error) => void;
  onProgress?: AsyncLoadOptions['onProgress'];
  onMeshBatch?: (meshes: IfcMesh[]) => void;
  registry?: GeometryRegistry;
}

// Generous: first load can contend with the model download and page chunks;
// a false timeout costs a 3.5 MB main-thread inline-engine compile.
const BOOT_TIMEOUT_MS = 20000;
/** Minimum ms between download progress callbacks. */
const FETCH_PROGRESS_INTERVAL = 120;

/** True when `url` resolves to the caller's own origin. */
function isSameOrigin(url: string): boolean {
  try {
    return new URL(url, self.location.href).origin === self.location.origin;
  } catch {
    return false;
  }
}

/**
 * Stream a URL on the client thread. VS Code webview resource URLs resolve
 * only through the page's service worker; a fetch from inside the worker
 * bypasses it and stalls until a network timeout, so the client fetches
 * cross-origin sources and transfers the bytes instead.
 */
async function fetchBytesOnClient(
  url: string,
  signal: AbortSignal,
  onProgress?: AsyncLoadOptions['onProgress'],
): Promise<Uint8Array> {
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(`Could not read the file (HTTP ${response.status}).`);
  }
  const totalHeader = response.headers.get('content-length');
  const bytesTotal = totalHeader ? Number(totalHeader) : undefined;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  let lastProgress = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.byteLength;
    const t = performance.now();
    if (t - lastProgress > FETCH_PROGRESS_INTERVAL) {
      lastProgress = t;
      onProgress?.({
        phase: 'downloading',
        entities: 0,
        totalEntities: 0,
        meshes: 0,
        bytesLoaded: received,
        bytesTotal,
      });
    }
  }

  const bytes = new Uint8Array(received);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/** Wait for the worker's `booted` hello; reject on error or timeout. */
function awaitBoot(worker: Worker): Promise<Worker> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('worker boot timed out'));
    }, BOOT_TIMEOUT_MS);
    const onMessage = (e: MessageEvent<WorkerResponse>) => {
      if (e.data?.type === 'booted') {
        cleanup();
        resolve(worker);
      }
    };
    const onError = (e: ErrorEvent) => {
      cleanup();
      reject(new Error(e.message || 'worker failed to start'));
    };
    const cleanup = () => {
      clearTimeout(timer);
      worker.removeEventListener('message', onMessage);
      worker.removeEventListener('error', onError);
    };
    worker.addEventListener('message', onMessage);
    worker.addEventListener('error', onError);
  });
}

/**
 * Spawn the parser worker. A direct module-worker URL fails in VS Code
 * webviews (worker scripts must be same-origin, webview resources are not),
 * so fall back to fetching the script and booting it from a blob URL.
 */
export async function spawnParserWorker(options: WorkerSpawnOptions): Promise<Worker> {
  if (options.factory) {
    const worker = options.factory();
    try {
      return await awaitBoot(worker);
    } catch (err) {
      worker.terminate();
      if (!options.url) throw err;
    }
  }
  if (!options.url) throw new Error('no worker source configured');
  // Workers must be same-origin; a cross-origin URL (the VS Code webview
  // case) can only boot via blob, so skip the doomed direct attempt.
  if (isSameOrigin(options.url)) {
    try {
      const direct = new Worker(options.url, { type: 'module' });
      try {
        return await awaitBoot(direct);
      } catch {
        direct.terminate();
      }
    } catch {
      // constructor itself can throw on origin policy; fall through to blob
    }
  }
  const response = await fetch(options.url);
  if (!response.ok) throw new Error(`worker script fetch failed (HTTP ${response.status})`);
  const blobUrl = URL.createObjectURL(
    new Blob([await response.text()], { type: 'text/javascript' }),
  );
  const blobWorker = new Worker(blobUrl, { type: 'module' });
  return awaitBoot(blobWorker);
}

export class WorkerEngine implements AsyncIfcEngine {
  private worker: Worker | null = null;
  private spawning: Promise<Worker> | null = null;
  private initialized = false;
  private nextId = 1;
  private readonly pending = new Map<number, Pending>();
  private loadInFlight: number | null = null;
  private fetchAbort: AbortController | null = null;

  constructor(private readonly options: WorkerEngineOptions) {}

  private async ensureWorker(): Promise<Worker> {
    if (this.worker) return this.worker;
    if (!this.spawning) {
      this.spawning = spawnParserWorker(this.options.spawn)
        .then((worker) => {
          worker.addEventListener('message', (e: MessageEvent<WorkerResponse>) =>
            this.onMessage(e.data),
          );
          worker.addEventListener('error', (e: ErrorEvent) =>
            this.failAll(new Error(e.message || 'parser worker crashed')),
          );
          this.worker = worker;
          this.spawning = null;
          return worker;
        })
        .catch((err: unknown) => {
          // A rejected promise kept here would re-throw the same stale error
          // for every later load instead of trying to spawn again.
          this.spawning = null;
          throw err;
        });
    }
    return this.spawning;
  }

  private send(message: WorkerRequest, transfer?: Transferable[]): void {
    if (!this.worker) throw new Error('worker not initialized');
    this.worker.postMessage(message, transfer ?? []);
  }

  private onMessage(msg: WorkerResponse): void {
    switch (msg.type) {
      case 'progress':
        this.pending.get(msg.id)?.onProgress?.(msg.progress);
        break;
      case 'meshBatch': {
        const p = this.pending.get(msg.id);
        if (p?.registry && p.onMeshBatch) {
          p.onMeshBatch(p.registry.unpack(msg.batch as MeshBatch));
        }
        break;
      }
      case 'loadDone': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (this.loadInFlight === msg.id) this.loadInFlight = null;
        // The registry (and the transferred geometry buffers it holds) is
        // only needed while batches stream; drop it so large models do not
        // retain a second copy of their geometry in JS memory.
        if (p) p.registry = undefined;
        (p?.resolve as ((v: LoadedModelMeta) => void) | undefined)?.(msg.result);
        break;
      }
      case 'categoryDone': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        (p?.resolve as ((v: void) => void) | undefined)?.(undefined);
        break;
      }
      case 'properties':
      case 'counts':
      case 'taskGraph':
      case 'organizeIndex':
      case 'gridAxes': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        (p?.resolve as ((v: unknown) => void) | undefined)?.(msg.result);
        break;
      }
      case 'fail': {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (this.loadInFlight === msg.id) this.loadInFlight = null;
        p?.reject(new Error(msg.message));
        break;
      }
      case 'booted':
      case 'initDone':
        break;
    }
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.loadInFlight = null;
  }

  async init(): Promise<void> {
    if (this.initialized && this.worker) return;
    const worker = await this.ensureWorker();
    const wasmBinary = await this.prefetchWasm();
    await new Promise<void>((resolve, reject) => {
      const onInit = (e: MessageEvent<WorkerResponse>) => {
        if (e.data?.type === 'initDone') {
          worker.removeEventListener('message', onInit);
          if (e.data.error) reject(new Error(e.data.error));
          else resolve();
        }
      };
      worker.addEventListener('message', onInit);
      this.send(
        {
          type: 'init',
          wasmPath: this.options.wasmPath,
          wasmAbsolute: this.options.wasmAbsolute,
          wasmBinary,
        },
        wasmBinary ? [wasmBinary.buffer] : [],
      );
    });
    this.initialized = true;
  }

  /**
   * Cross-origin wasm (VS Code webview resources) cannot be fetched from
   * inside the worker; prefetch on the client and transfer the bytes.
   */
  private async prefetchWasm(): Promise<Uint8Array | undefined> {
    const dir = this.options.wasmPath;
    if (!dir || isSameOrigin(dir)) return undefined;
    try {
      const response = await fetch(new URL('web-ifc.wasm', dir).toString());
      if (!response.ok) return undefined;
      return new Uint8Array(await response.arrayBuffer());
    } catch {
      return undefined; // the worker falls back to fetching wasmPath itself
    }
  }

  async loadModel(source: LoadSource, options: AsyncLoadOptions = {}): Promise<LoadedModelMeta> {
    await this.init();
    const id = this.nextId++;
    this.loadInFlight = id;
    return new Promise<LoadedModelMeta>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
        onProgress: options.onProgress,
        onMeshBatch: options.onMeshBatch,
        registry: new GeometryRegistry(),
      });
      if (source.kind === 'bytes') {
        // Transfer when the buffer is exactly the bytes (no shared views).
        const { bytes } = source;
        const owns =
          bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength;
        this.send(
          { type: 'load', id, bytes, fileName: undefined, skipGeometry: options.skipGeometry },
          owns ? [bytes.buffer] : [],
        );
      } else if (isSameOrigin(source.url)) {
        // Same-origin (harness): the worker streams the download off-thread.
        this.send({ type: 'load', id, url: source.url, fileName: source.fileName, skipGeometry: options.skipGeometry });
      } else {
        // Cross-origin (webview resources): fetch here, transfer the bytes.
        void this.fetchThenLoad(id, source.url, source.fileName, options.skipGeometry);
      }
    });
  }

  private async fetchThenLoad(id: number, url: string, fileName?: string, skipGeometry?: boolean): Promise<void> {
    const abort = new AbortController();
    this.fetchAbort = abort;
    try {
      const t0 = performance.now();
      const bytes = await fetchBytesOnClient(url, abort.signal, (p) =>
        this.pending.get(id)?.onProgress?.(p),
      );
      const downloadMs = performance.now() - t0;
      if (!this.pending.has(id)) return; // cancelled while downloading
      this.send({ type: 'load', id, bytes, fileName, downloadMs, skipGeometry }, [bytes.buffer]);
    } catch (err) {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      if (this.loadInFlight === id) this.loadInFlight = null;
      p.reject(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (this.fetchAbort === abort) this.fetchAbort = null;
    }
  }

  async loadCategory(
    modelID: number,
    category: LazyCategory,
    onMeshBatch: (meshes: IfcMesh[]) => void,
  ): Promise<void> {
    await this.init();
    const id = this.nextId++;
    // Category batches are self-contained (the worker resends their geometry),
    // so a fresh registry per request is enough.
    return new Promise<void>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: never) => void,
        reject,
        onMeshBatch,
        registry: new GeometryRegistry(),
      });
      this.send({ type: 'loadCategory', id, modelID, category });
    });
  }

  async getItemProperties(modelID: number, expressID: number): Promise<ItemProperties> {
    await this.init();
    const id = this.nextId++;
    return new Promise<ItemProperties>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'getProperties', id, modelID, expressID });
    });
  }

  async getCountsByType(modelID: number): Promise<Record<string, number>> {
    await this.init();
    const id = this.nextId++;
    return new Promise<Record<string, number>>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'getCounts', id, modelID });
    });
  }

  async getTaskGraph(modelID: number): Promise<IfcTaskGraph> {
    await this.init();
    const id = this.nextId++;
    return new Promise<IfcTaskGraph>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'getTaskGraph', id, modelID });
    });
  }

  async getOrganizeIndex(modelID: number): Promise<OrganizeIndex> {
    await this.init();
    const id = this.nextId++;
    return new Promise<OrganizeIndex>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'getOrganizeIndex', id, modelID });
    });
  }

  async getGridAxes(modelID: number): Promise<IfcGridInfo[]> {
    await this.init();
    const id = this.nextId++;
    return new Promise<IfcGridInfo[]>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: never) => void, reject });
      this.send({ type: 'getGridAxes', id, modelID });
    });
  }

  dispose(modelID: number): void {
    // Fire-and-forget cleanup: nothing to dispose without a live worker, so
    // this stays a no-op rather than routing through send()'s throw.
    this.worker?.postMessage({ type: 'dispose', modelID });
  }

  /**
   * Hard-abort everything in flight. wasm work cannot be interrupted from JS,
   * so the worker is terminated and a fresh one spawns on the next request.
   */
  cancel(): void {
    this.fetchAbort?.abort();
    this.worker?.terminate();
    this.worker = null;
    this.spawning = null;
    this.initialized = false;
    this.failAll(new CancelledError());
  }

  terminate(): void {
    this.fetchAbort?.abort();
    this.worker?.terminate();
    this.worker = null;
    this.spawning = null;
    this.initialized = false;
    this.failAll(new CancelledError('viewer disposed'));
  }
}
