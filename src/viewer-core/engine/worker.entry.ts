// Parser worker: fetches and parses IFC off the main thread and streams
// mesh batches back as transferables. Bundled standalone for the harness
// (Vite) and the webview (esbuild).
import { WebIfcAdapter } from './adapter.js';
import { BatchBuilder } from './packets.js';
import type { MeshBatch, WorkerRequest, WorkerResponse } from './packets.js';
import type { LazyCategory, LoadProgress, SpatialNode } from './types.js';

const scope = self as unknown as {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<WorkerRequest>) => void) | null;
};

let adapter: WebIfcAdapter | null = null;

/** Placements per batch before a flush. Size beats latency for GPU batching. */
const BATCH_PLACEMENTS = 2048;
/** Approximate payload bytes per batch before a flush. */
const BATCH_BYTES = 8 * 1024 * 1024;
/** Minimum ms between progress messages. */
const PROGRESS_INTERVAL = 120;

function post(message: WorkerResponse, transfer?: Transferable[]): void {
  scope.postMessage(message, transfer);
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function fetchBytes(
  url: string,
  id: number,
): Promise<Uint8Array> {
  const response = await fetch(url);
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
    if (t - lastProgress > PROGRESS_INTERVAL) {
      lastProgress = t;
      post({
        type: 'progress',
        id,
        progress: {
          phase: 'downloading',
          entities: 0,
          totalEntities: 0,
          meshes: 0,
          bytesLoaded: received,
          bytesTotal,
        },
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

async function handleLoad(req: Extract<WorkerRequest, { type: 'load' }>): Promise<void> {
  if (!adapter) throw new Error('worker: load before init');

  const downloadStart = performance.now();
  const bytes = req.bytes ?? (await fetchBytes(req.url!, req.id));
  // Client-fetched bytes carry their own download timing.
  const downloadMs = req.url ? performance.now() - downloadStart : req.downloadMs;

  const seen = new Set<number>();
  const builder = new BatchBuilder(seen);
  const flush = () => {
    const drained = builder.drain();
    if (drained) post({ type: 'meshBatch', id: req.id, batch: drained.batch }, drained.transfer);
  };

  let lastProgress = 0;
  let lastPhase = '';
  const model = await adapter.loadModel(bytes, {
    collectMeshes: false,
    skipGeometry: req.skipGeometry,
    onMesh: (mesh) => {
      builder.add(mesh);
      if (builder.placementCount >= BATCH_PLACEMENTS || builder.pendingBytes >= BATCH_BYTES) {
        flush();
      }
    },
    onProgress: (progress: LoadProgress) => {
      // Always pass phase transitions; throttle only repeats within a phase.
      const t = performance.now();
      if (progress.phase !== lastPhase || t - lastProgress > PROGRESS_INTERVAL) {
        lastPhase = progress.phase;
        lastProgress = t;
        post({ type: 'progress', id: req.id, progress });
      }
    },
  });
  flush();

  let tree: SpatialNode | null = null;
  try {
    tree = adapter.getSpatialTree(model.modelID);
  } catch {
    // no IfcProject; viewer handles a null tree
  }
  // The dedup cache exists to share triangle data during streaming; free it
  // once the stream is done (category loads re-convert their own geometry).
  adapter.clearGeometryCache(model.modelID);
  post({
    type: 'loadDone',
    id: req.id,
    result: {
      modelID: model.modelID,
      bounds: model.bounds,
      stats: { ...model.stats, downloadMs },
      tree,
      geo: model.geo,
    },
  });
}

function handleLoadCategory(req: Extract<WorkerRequest, { type: 'loadCategory' }>): void {
  if (!adapter) throw new Error('worker: loadCategory before init');
  // Fresh dedup set: category batches carry their own geometry, so the client
  // does not have to retain the main stream's geometry registry after load.
  const seen = new Set<number>();
  const builder = new BatchBuilder(seen);
  adapter.loadCategory(req.modelID, req.category as LazyCategory, (mesh) => {
    builder.add(mesh);
    if (builder.placementCount >= BATCH_PLACEMENTS || builder.pendingBytes >= BATCH_BYTES) {
      const drained = builder.drain();
      if (drained) post({ type: 'meshBatch', id: req.id, batch: drained.batch }, drained.transfer);
    }
  });
  const drained = builder.drain();
  if (drained) post({ type: 'meshBatch', id: req.id, batch: drained.batch }, drained.transfer);
  post({ type: 'categoryDone', id: req.id });
}

scope.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  void (async () => {
    try {
      switch (req.type) {
        case 'init': {
          adapter = new WebIfcAdapter({
            wasmPath: req.wasmPath,
            wasmAbsolute: req.wasmAbsolute,
            wasmBinary: req.wasmBinary,
          });
          try {
            await adapter.init();
            post({ type: 'initDone' });
          } catch (err) {
            post({ type: 'initDone', error: errorText(err) });
          }
          break;
        }
        case 'load':
          await handleLoad(req);
          break;
        case 'loadCategory':
          handleLoadCategory(req);
          break;
        case 'getProperties': {
          if (!adapter) throw new Error('worker: getProperties before init');
          const result = adapter.getItemProperties(req.modelID, req.expressID);
          post({ type: 'properties', id: req.id, result });
          break;
        }
        case 'getCounts': {
          if (!adapter) throw new Error('worker: getCounts before init');
          post({ type: 'counts', id: req.id, result: adapter.getCountsByType(req.modelID) });
          break;
        }
        case 'getTaskGraph': {
          if (!adapter) throw new Error('worker: getTaskGraph before init');
          post({ type: 'taskGraph', id: req.id, result: adapter.getTaskGraph(req.modelID) });
          break;
        }
        case 'getOrganizeIndex': {
          if (!adapter) throw new Error('worker: getOrganizeIndex before init');
          post({ type: 'organizeIndex', id: req.id, result: adapter.getOrganizeIndex(req.modelID) });
          break;
        }
        case 'getGridAxes': {
          if (!adapter) throw new Error('worker: getGridAxes before init');
          post({ type: 'gridAxes', id: req.id, result: adapter.getGridAxes(req.modelID) });
          break;
        }
        case 'dispose':
          adapter?.dispose(req.modelID);
          break;
      }
    } catch (err) {
      const id = 'id' in req ? req.id : -1;
      post({ type: 'fail', id, message: errorText(err) });
    }
  })();
};

post({ type: 'booted' });

export type { MeshBatch };
