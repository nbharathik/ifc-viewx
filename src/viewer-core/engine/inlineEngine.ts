// Main-thread fallback engine: same async surface as the worker client, but
// runs the adapter inline. Used when Worker is unavailable or fails to boot,
// so the viewer always works; the UI blocks during parse in this mode.
import { WebIfcAdapter } from './adapter.js';
import type { WebIfcAdapterOptions } from './adapter.js';
import {
  CancelledError,
  type AsyncIfcEngine,
  type AsyncLoadOptions,
  type IfcMesh,
  type ItemProperties,
  type LazyCategory,
  type LoadSource,
  type LoadedModelMeta,
  type SpatialNode,
} from './types.js';

const BATCH_PLACEMENTS = 2048;

export class InlineEngine implements AsyncIfcEngine {
  private readonly adapter: WebIfcAdapter;
  private abort: AbortController | null = null;

  constructor(options: WebIfcAdapterOptions = {}) {
    this.adapter = new WebIfcAdapter(options);
  }

  init(): Promise<void> {
    return this.adapter.init();
  }

  async loadModel(source: LoadSource, options: AsyncLoadOptions = {}): Promise<LoadedModelMeta> {
    let bytes: Uint8Array;
    let downloadMs: number | undefined;
    if (source.kind === 'bytes') {
      bytes = source.bytes;
    } else {
      this.abort = new AbortController();
      const t0 = performance.now();
      try {
        const response = await fetch(source.url, { signal: this.abort.signal });
        if (!response.ok) throw new Error(`Could not read the file (HTTP ${response.status}).`);
        bytes = new Uint8Array(await response.arrayBuffer());
      } catch (err) {
        if (this.abort.signal.aborted) throw new CancelledError();
        throw err;
      } finally {
        this.abort = null;
      }
      downloadMs = performance.now() - t0;
    }

    let pending: IfcMesh[] = [];
    const model = await this.adapter.loadModel(bytes, {
      collectMeshes: false,
      skipGeometry: options.skipGeometry,
      onProgress: options.onProgress,
      onMesh: (mesh) => {
        pending.push(mesh);
        if (pending.length >= BATCH_PLACEMENTS) {
          options.onMeshBatch?.(pending);
          pending = [];
        }
      },
    });
    if (pending.length > 0) options.onMeshBatch?.(pending);

    let tree: SpatialNode | null = null;
    try {
      tree = this.adapter.getSpatialTree(model.modelID);
    } catch {
      // no IfcProject; viewer handles a null tree
    }
    return {
      modelID: model.modelID,
      bounds: model.bounds,
      stats: { ...model.stats, downloadMs },
      tree,
    };
  }

  async loadCategory(
    modelID: number,
    category: LazyCategory,
    onMeshBatch: (meshes: IfcMesh[]) => void,
  ): Promise<void> {
    const meshes = this.adapter.loadCategory(modelID, category);
    if (meshes.length > 0) onMeshBatch(meshes);
  }

  async getItemProperties(modelID: number, expressID: number): Promise<ItemProperties> {
    return this.adapter.getItemProperties(modelID, expressID);
  }

  async getCountsByType(modelID: number): Promise<Record<string, number>> {
    return this.adapter.getCountsByType(modelID);
  }

  dispose(modelID: number): void {
    this.adapter.dispose(modelID);
  }

  /** Only the download can be aborted inline; wasm work runs to completion. */
  cancel(): void {
    this.abort?.abort();
  }

  terminate(): void {
    this.abort?.abort();
  }
}
