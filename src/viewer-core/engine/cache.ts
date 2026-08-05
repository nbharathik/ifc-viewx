// Format v1 model cache (spec: dev/FORMAT.md). Converted models are stored
// in OPFS as chunked, typed-array-aligned MeshBatch payloads plus a JSON
// manifest, keyed by the SHA-256 of the source bytes. A warm load replays
// chunks straight into the batcher and never touches web-ifc; the model is
// reopened lazily (parse only, no geometry) the first time properties,
// counts, or a lazy category are requested. Browsers without OPFS write
// support simply run uncached.
import { BatchBuilder, GeometryRegistry } from './packets.js';
import type { MeshBatch } from './packets.js';
import {
  CancelledError,
  type AsyncIfcEngine,
  type AsyncLoadOptions,
  type IfcMesh,
  type ItemProperties,
  type LazyCategory,
  type LoadSource,
  type LoadedModelMeta,
} from './types.js';

export const FORMAT_VERSION = 1;
const MAGIC = 0x58434649; // "IFCX"
const MAGIC_END = 0x444e4558; // "XEND"
const CACHE_DIR = 'ifcviewx-cache';
const INDEX_FILE = 'index.json';
const CACHE_LIMIT_BYTES = 1 << 30;

const enc = new TextEncoder();
const dec = new TextDecoder();

const align = (n: number, to: number): number => (n + to - 1) & ~(to - 1);

interface ChunkLayout {
  ids: number;
  vertexCounts: number;
  indexCounts: number;
  localBounds: number;
  positions: number;
  normals: number;
  indices: number;
  expressIDs: number;
  geometryIDs: number;
  matrices: number;
  colors: number;
  typeIndex: number;
  typeTable: number;
  total: number;
}

/** Section offsets for a chunk payload. Shared by writer and reader so the
 *  layout cannot drift. All values little-endian; f64 sections 8-aligned. */
function chunkLayout(
  geoCount: number,
  placements: number,
  posFloats: number,
  idxCount: number,
  typeBytes: number,
): ChunkLayout {
  let off = 20;
  const at = (bytes: number, alignment = 4): number => {
    off = align(off, alignment);
    const here = off;
    off += bytes;
    return here;
  };
  return {
    ids: at(geoCount * 4),
    vertexCounts: at(geoCount * 4),
    indexCounts: at(geoCount * 4),
    localBounds: at(geoCount * 48, 8),
    positions: at(posFloats * 4),
    normals: at(posFloats * 4),
    indices: at(idxCount * 4),
    expressIDs: at(placements * 4),
    geometryIDs: at(placements * 4),
    matrices: at(placements * 128, 8),
    colors: at(placements * 16),
    typeIndex: at(placements * 2, 2),
    typeTable: at(typeBytes, 1),
    total: off,
  };
}

export function serializeBatch(batch: MeshBatch): ArrayBuffer {
  const g = batch.geometries;
  const p = batch.placements;
  const geoCount = g.ids.length;
  const placements = p.expressIDs.length;

  const table: string[] = [];
  const tableIndex = new Map<string, number>();
  const typeIndex = new Uint16Array(placements);
  for (let i = 0; i < placements; i++) {
    const name = p.ifcTypes[i];
    let ti = tableIndex.get(name);
    if (ti === undefined) {
      ti = table.length;
      tableIndex.set(name, ti);
      table.push(name);
    }
    typeIndex[i] = ti;
  }
  const typeJson = enc.encode(JSON.stringify(table));

  const l = chunkLayout(geoCount, placements, g.positions.length, g.indices.length, typeJson.length);
  const buf = new ArrayBuffer(l.total);
  const view = new DataView(buf);
  view.setUint32(0, geoCount, true);
  view.setUint32(4, placements, true);
  view.setUint32(8, g.positions.length, true);
  view.setUint32(12, g.indices.length, true);
  view.setUint32(16, typeJson.length, true);
  new Uint32Array(buf, l.ids, geoCount).set(g.ids);
  new Uint32Array(buf, l.vertexCounts, geoCount).set(g.vertexCounts);
  new Uint32Array(buf, l.indexCounts, geoCount).set(g.indexCounts);
  new Float64Array(buf, l.localBounds, geoCount * 6).set(g.localBounds);
  new Float32Array(buf, l.positions, g.positions.length).set(g.positions);
  new Float32Array(buf, l.normals, g.normals.length).set(g.normals);
  new Uint32Array(buf, l.indices, g.indices.length).set(g.indices);
  new Uint32Array(buf, l.expressIDs, placements).set(p.expressIDs);
  new Uint32Array(buf, l.geometryIDs, placements).set(p.geometryIDs);
  new Float64Array(buf, l.matrices, placements * 16).set(p.matrices);
  new Float32Array(buf, l.colors, placements * 4).set(p.colors);
  new Uint16Array(buf, l.typeIndex, placements).set(typeIndex);
  new Uint8Array(buf, l.typeTable, typeJson.length).set(typeJson);
  return buf;
}

export function deserializeBatch(buf: ArrayBuffer): MeshBatch {
  const view = new DataView(buf);
  const geoCount = view.getUint32(0, true);
  const placements = view.getUint32(4, true);
  const posFloats = view.getUint32(8, true);
  const idxCount = view.getUint32(12, true);
  const typeBytes = view.getUint32(16, true);
  const l = chunkLayout(geoCount, placements, posFloats, idxCount, typeBytes);
  if (l.total !== buf.byteLength) throw new Error('corrupt cache chunk');

  const typeTable = JSON.parse(
    dec.decode(new Uint8Array(buf, l.typeTable, typeBytes)),
  ) as string[];
  const typeIndex = new Uint16Array(buf, l.typeIndex, placements);
  const ifcTypes = new Array<string>(placements);
  for (let i = 0; i < placements; i++) ifcTypes[i] = typeTable[typeIndex[i]];

  return {
    geometries: {
      ids: new Uint32Array(buf, l.ids, geoCount),
      vertexCounts: new Uint32Array(buf, l.vertexCounts, geoCount),
      indexCounts: new Uint32Array(buf, l.indexCounts, geoCount),
      localBounds: new Float64Array(buf, l.localBounds, geoCount * 6),
      positions: new Float32Array(buf, l.positions, posFloats),
      normals: new Float32Array(buf, l.normals, posFloats),
      indices: new Uint32Array(buf, l.indices, idxCount),
    },
    placements: {
      expressIDs: new Uint32Array(buf, l.expressIDs, placements),
      geometryIDs: new Uint32Array(buf, l.geometryIDs, placements),
      matrices: new Float64Array(buf, l.matrices, placements * 16),
      colors: new Float32Array(buf, l.colors, placements * 4),
      ifcTypes,
    },
  };
}

interface CacheManifest {
  stats: LoadedModelMeta['stats'];
  bounds: LoadedModelMeta['bounds'];
  tree: LoadedModelMeta['tree'];
}

interface CacheHit {
  manifest: CacheManifest;
  file: File;
  /** Byte offset where the chunk region ends and the manifest begins. */
  end: number;
}

type CacheIndex = Record<string, { bytes: number; srcBytes?: number; at: number; name?: string }>;

export interface CachedModel {
  sha: string;
  name: string;
  bytes: number;
  at: number;
}

class CacheWriter {
  private queue: Promise<void>;
  private failed = false;
  private bytes = 8;

  constructor(
    private readonly stream: FileSystemWritableFileStream,
    private readonly finalize: (ok: boolean, bytes: number) => Promise<void>,
  ) {
    const head = new ArrayBuffer(8);
    const v = new DataView(head);
    v.setUint32(0, MAGIC, true);
    v.setUint32(4, FORMAT_VERSION, true);
    this.queue = this.write(head);
  }

  private write(data: BufferSource): Promise<void> {
    return this.stream.write(data).catch(() => {
      this.failed = true;
    });
  }

  /** Queue one chunk. Writes run in the background; load is never blocked. */
  chunk(payload: ArrayBuffer): void {
    if (this.failed) return;
    const frame = new ArrayBuffer(4);
    new DataView(frame).setUint32(0, payload.byteLength, true);
    this.bytes += 4 + payload.byteLength;
    this.queue = this.queue.then(() => this.write(frame)).then(() => this.write(payload));
  }

  async commit(manifest: CacheManifest): Promise<void> {
    const body = enc.encode(JSON.stringify(manifest));
    const foot = new ArrayBuffer(8);
    const v = new DataView(foot);
    v.setUint32(0, body.byteLength, true);
    v.setUint32(4, MAGIC_END, true);
    this.bytes += body.byteLength + 8;
    await this.queue;
    if (!this.failed) {
      await this.write(body);
      await this.write(foot);
    }
    try {
      // createWritable targets a swap file; close() is the atomic publish.
      if (this.failed) await this.stream.abort();
      else await this.stream.close();
    } catch {
      this.failed = true;
    }
    await this.finalize(!this.failed, this.bytes);
  }

  async abort(): Promise<void> {
    this.failed = true;
    await this.queue.catch(() => undefined);
    try {
      await this.stream.abort();
    } catch {
      // already closed
    }
    await this.finalize(false, 0);
  }
}

class ModelStore {
  private indexQueue: Promise<void> = Promise.resolve();

  private constructor(private readonly dir: FileSystemDirectoryHandle) {}

  static async open(): Promise<ModelStore | null> {
    try {
      if (
        typeof navigator === 'undefined' ||
        !navigator.storage?.getDirectory ||
        typeof FileSystemFileHandle === 'undefined' ||
        !('createWritable' in FileSystemFileHandle.prototype)
      ) {
        return null;
      }
      const root = await navigator.storage.getDirectory();
      return new ModelStore(await root.getDirectoryHandle(CACHE_DIR, { create: true }));
    } catch {
      return null;
    }
  }

  async read(sha: string): Promise<CacheHit | null> {
    let exists = false;
    try {
      const handle = await this.dir.getFileHandle(`${sha}.ifcx`);
      exists = true;
      const file = await handle.getFile();
      const head = new DataView(await file.slice(0, 8).arrayBuffer());
      const tail = new DataView(await file.slice(file.size - 8).arrayBuffer());
      if (head.getUint32(0, true) !== MAGIC) throw new Error('bad magic');
      if (head.getUint32(4, true) !== FORMAT_VERSION) throw new Error('format version');
      if (tail.getUint32(4, true) !== MAGIC_END) throw new Error('uncommitted');
      const manifestBytes = tail.getUint32(0, true);
      const end = file.size - 8 - manifestBytes;
      const manifest = JSON.parse(
        dec.decode(await file.slice(end, end + manifestBytes).arrayBuffer()),
      ) as CacheManifest;
      void this.touch(sha);
      return { manifest, file, end };
    } catch {
      if (exists) void this.removeContainer(sha);
      return null;
    }
  }

  async *chunks(hit: CacheHit): AsyncGenerator<ArrayBuffer> {
    let off = 8;
    while (off < hit.end) {
      const len = new DataView(await hit.file.slice(off, off + 4).arrayBuffer()).getUint32(0, true);
      off += 4;
      yield await hit.file.slice(off, off + len).arrayBuffer();
      off += len;
    }
  }

  async beginWrite(sha: string): Promise<CacheWriter | null> {
    try {
      const handle = await this.dir.getFileHandle(`${sha}.ifcx`, { create: true });
      const stream = await handle.createWritable();
      return new CacheWriter(stream, async (ok, bytes) => {
        if (ok) {
          await this.touch(sha, bytes);
          await this.evict();
        } else {
          await this.removeContainer(sha);
        }
      });
    } catch {
      return null;
    }
  }

  private async readIndex(): Promise<CacheIndex> {
    try {
      const handle = await this.dir.getFileHandle(INDEX_FILE);
      return JSON.parse(await (await handle.getFile()).text()) as CacheIndex;
    } catch {
      return {};
    }
  }

  private async writeIndex(index: CacheIndex): Promise<void> {
    try {
      const handle = await this.dir.getFileHandle(INDEX_FILE, { create: true });
      const stream = await handle.createWritable();
      await stream.write(JSON.stringify(index));
      await stream.close();
    } catch {
      // index is best effort; reads self-heal
    }
  }

  /** All index writes run through one queue so concurrent updates cannot race. */
  private mutateIndex(mutate: (index: CacheIndex) => void | Promise<void>): Promise<void> {
    const run = async (): Promise<void> => {
      const index = await this.readIndex();
      await mutate(index);
      await this.writeIndex(index);
    };
    this.indexQueue = this.indexQueue.then(run, run);
    return this.indexQueue;
  }

  private touch(sha: string, bytes?: number): Promise<void> {
    return this.mutateIndex((index) => {
      const prev = index[sha];
      // Spread, so a container write landing after the source was archived
      // does not drop the srcBytes that eviction budgets against.
      index[sha] = { ...prev, bytes: bytes ?? prev?.bytes ?? 0, at: Date.now() };
    });
  }

  setName(sha: string, name: string): Promise<void> {
    return this.mutateIndex((index) => {
      const prev = index[sha] ?? { bytes: 0, at: Date.now() };
      index[sha] = { ...prev, name };
    });
  }

  private async removeFiles(sha: string): Promise<void> {
    for (const file of [`${sha}.ifcx`, `${sha}.src`]) {
      try {
        await this.dir.removeEntry(file);
      } catch {
        // already gone
      }
    }
  }

  /**
   * Drop only the parsed container. The gzipped source is what backs the
   * recent-models list, so a failed or corrupt container write must not take
   * the model out of Recent along with it.
   */
  private async removeContainer(sha: string): Promise<void> {
    try {
      await this.dir.removeEntry(`${sha}.ifcx`);
    } catch {
      // already gone
    }
    let orphan = false;
    await this.mutateIndex((index) => {
      const entry = index[sha];
      if (!entry) return;
      if (entry.name) entry.bytes = 0;
      else orphan = true;
      if (orphan) delete index[sha];
    });
    if (orphan) await this.removeFiles(sha);
  }

  async list(): Promise<CachedModel[]> {
    const index = await this.readIndex();
    return Object.entries(index)
      .filter(([, e]) => e.name)
      .map(([sha, e]) => ({ sha, name: e.name!, bytes: e.bytes, at: e.at }))
      .sort((a, b) => b.at - a.at);
  }

  async writeSource(sha: string, bytes: Uint8Array): Promise<void> {
    const handle = await this.dir.getFileHandle(`${sha}.src`, { create: true });
    const stream = await handle.createWritable();
    await new Blob([bytes as Uint8Array<ArrayBuffer>])
      .stream()
      .pipeThrough(new CompressionStream('gzip'))
      .pipeTo(stream);
    const srcBytes = (await handle.getFile()).size;
    await this.mutateIndex((index) => {
      const prev = index[sha] ?? { bytes: 0, at: Date.now() };
      index[sha] = { ...prev, srcBytes };
    });
    await this.evict();
  }

  async readSource(sha: string): Promise<Uint8Array | null> {
    try {
      const handle = await this.dir.getFileHandle(`${sha}.src`);
      const file = await handle.getFile();
      const stream = file.stream().pipeThrough(new DecompressionStream('gzip'));
      return new Uint8Array(await new Response(stream).arrayBuffer());
    } catch {
      return null;
    }
  }

  /** Drop least-recently-used models until the cache fits the byte budget. */
  private evict(): Promise<void> {
    return this.mutateIndex(async (index) => {
      const entries = Object.entries(index).sort((a, b) => a[1].at - b[1].at);
      let total = entries.reduce((sum, [, e]) => sum + e.bytes + (e.srcBytes ?? 0), 0);
      for (const [sha, entry] of entries) {
        if (total <= CACHE_LIMIT_BYTES) break;
        await this.removeFiles(sha);
        delete index[sha];
        total -= entry.bytes + (entry.srcBytes ?? 0);
      }
    });
  }
}

let storePromise: Promise<ModelStore | null> | null = null;

function getStore(): Promise<ModelStore | null> {
  if (!storePromise) storePromise = ModelStore.open();
  return storePromise;
}

/** Recently opened models that can be reopened without picking the file again. */
export async function listCachedModels(): Promise<CachedModel[]> {
  const store = await getStore();
  return store ? store.list() : [];
}

/** Archive the source IFC (gzip) so the model appears in the recent list. */
export async function storeSourceBytes(bytes: Uint8Array, name: string): Promise<void> {
  const store = await getStore();
  if (!store || typeof CompressionStream === 'undefined') return;
  const sha = await digest(bytes);
  if (!sha) return;
  try {
    await store.writeSource(sha, bytes);
    await store.setName(sha, name);
  } catch {
    // archive is best effort
  }
}

export async function loadCachedSource(sha: string): Promise<Uint8Array | null> {
  const store = await getStore();
  if (!store || typeof DecompressionStream === 'undefined') return null;
  return store.readSource(sha);
}

/** True when the buffer is a format v1 container (magic "IFCX"). */
export function isFormatBytes(bytes: Uint8Array): boolean {
  return (
    bytes.byteLength > 16 &&
    new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true) === MAGIC
  );
}

async function digest(bytes: Uint8Array): Promise<string | null> {
  try {
    const hash = await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>);
    return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

/**
 * Transparent cache layer over any engine. Serves one model at a time, like
 * the app: incoming modelIDs are ignored and requests go to the single live
 * model, reopening it from the retained source bytes when a warm load never
 * parsed one.
 */
export class CachedEngine implements AsyncIfcEngine {
  private readonly store: Promise<ModelStore | null>;
  private bytes: Uint8Array | null = null;
  private liveID: number | null = null;
  private opening: Promise<number> | null = null;
  private loadToken = 0;

  constructor(private readonly inner: AsyncIfcEngine) {
    this.store = getStore();
  }

  init(): Promise<void> {
    return this.inner.init();
  }

  async loadModel(source: LoadSource, options: AsyncLoadOptions = {}): Promise<LoadedModelMeta> {
    const token = ++this.loadToken;
    this.bytes = source.kind === 'bytes' ? source.bytes : null;
    this.liveID = null;
    this.opening = null;

    // A converted .ifcx file replays directly; no parser involved.
    if (this.bytes && isFormatBytes(this.bytes)) {
      return this.replayBuffer(this.bytes, options, token);
    }

    const store = await this.store;
    const sha =
      store && this.bytes && !options.skipGeometry ? await digest(this.bytes) : null;

    if (store && sha) {
      const hit = await store.read(sha);
      if (hit) return this.replay(store, hit, options, token);
    }

    const writer = store && sha ? await store.beginWrite(sha) : null;
    const builder = writer ? new BatchBuilder(new Set()) : null;
    try {
      const meta = await this.inner.loadModel(
        // Hand the worker a copy it can transfer; ours is retained for reopen.
        this.bytes ? { kind: 'bytes', bytes: this.bytes.slice() } : source,
        {
          ...options,
          onMeshBatch: (meshes: IfcMesh[]) => {
            options.onMeshBatch?.(meshes);
            if (builder && writer) {
              for (const mesh of meshes) builder.add(mesh);
              const drained = builder.drain();
              if (drained) writer.chunk(serializeBatch(drained.batch));
            }
          },
        },
      );
      if (token !== this.loadToken) {
        this.inner.dispose(meta.modelID);
        throw new CancelledError();
      }
      this.liveID = meta.modelID;
      if (writer) {
        void writer
          .commit({ stats: meta.stats, bounds: meta.bounds, tree: meta.tree })
          .catch(() => undefined);
      }
      return meta;
    } catch (err) {
      if (writer) void writer.abort().catch(() => undefined);
      throw err;
    }
  }

  /** Replay a whole .ifcx file held in memory (drag-dropped or fetched). */
  private async replayBuffer(
    bytes: Uint8Array,
    options: AsyncLoadOptions,
    token: number,
  ): Promise<LoadedModelMeta> {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = bytes.byteLength;
    if (view.getUint32(4, true) !== FORMAT_VERSION) {
      throw new Error('This .ifcx file uses an unsupported format version.');
    }
    if (view.getUint32(size - 4, true) !== MAGIC_END) {
      throw new Error('Truncated .ifcx file.');
    }
    const manifestBytes = view.getUint32(size - 8, true);
    const end = size - 8 - manifestBytes;
    const manifest = JSON.parse(
      dec.decode(bytes.subarray(end, end + manifestBytes)),
    ) as CacheManifest;

    const registry = new GeometryRegistry();
    const totalEntities = manifest.stats.totalEntities;
    let meshes = 0;
    let off = 8;
    while (off < end) {
      if (token !== this.loadToken) throw new CancelledError();
      const len = view.getUint32(off, true);
      off += 4;
      const payload = bytes.buffer.slice(
        bytes.byteOffset + off,
        bytes.byteOffset + off + len,
      ) as ArrayBuffer;
      off += len;
      const unpacked = registry.unpack(deserializeBatch(payload));
      meshes += unpacked.length;
      options.onMeshBatch?.(unpacked);
      options.onProgress?.({ phase: 'geometry', entities: meshes, totalEntities, meshes });
    }
    options.onProgress?.({ phase: 'done', entities: totalEntities, totalEntities, meshes });
    return { modelID: -1, bounds: manifest.bounds, stats: manifest.stats, tree: manifest.tree };
  }

  private async replay(
    store: ModelStore,
    hit: CacheHit,
    options: AsyncLoadOptions,
    token: number,
  ): Promise<LoadedModelMeta> {
    const registry = new GeometryRegistry();
    const totalEntities = hit.manifest.stats.totalEntities;
    let meshes = 0;
    for await (const payload of store.chunks(hit)) {
      if (token !== this.loadToken) throw new CancelledError();
      const unpacked = registry.unpack(deserializeBatch(payload));
      meshes += unpacked.length;
      options.onMeshBatch?.(unpacked);
      options.onProgress?.({ phase: 'geometry', entities: meshes, totalEntities, meshes });
    }
    options.onProgress?.({ phase: 'done', entities: totalEntities, totalEntities, meshes });
    return {
      modelID: -1,
      bounds: hit.manifest.bounds,
      stats: { ...hit.manifest.stats, parseMs: 0, geometryMs: 0 },
      tree: hit.manifest.tree,
    };
  }

  /** Open the retained bytes in the inner engine, parse only, at most once. */
  private ensureLive(): Promise<number> {
    if (this.liveID !== null) return Promise.resolve(this.liveID);
    if (!this.opening) {
      const bytes = this.bytes;
      if (!bytes) return Promise.reject(new Error('no model loaded'));
      const opening: Promise<number> = this.inner
        .loadModel({ kind: 'bytes', bytes: bytes.slice() }, { skipGeometry: true })
        .then((meta) => {
          if (this.opening !== opening) {
            this.inner.dispose(meta.modelID);
            throw new CancelledError();
          }
          this.liveID = meta.modelID;
          return meta.modelID;
        })
        .catch((err) => {
          if (this.opening === opening) this.opening = null;
          throw err;
        });
      this.opening = opening;
    }
    return this.opening;
  }

  async loadCategory(
    _modelID: number,
    category: LazyCategory,
    onMeshBatch: (meshes: IfcMesh[]) => void,
  ): Promise<void> {
    const id = await this.ensureLive();
    return this.inner.loadCategory(id, category, onMeshBatch);
  }

  async getItemProperties(_modelID: number, expressID: number): Promise<ItemProperties> {
    const id = await this.ensureLive();
    return this.inner.getItemProperties(id, expressID);
  }

  async getCountsByType(_modelID: number): Promise<Record<string, number>> {
    const id = await this.ensureLive();
    return this.inner.getCountsByType(id);
  }

  dispose(_modelID: number): void {
    if (this.liveID !== null) this.inner.dispose(this.liveID);
    this.liveID = null;
    this.opening = null;
    this.bytes = null;
  }

  cancel(): void {
    this.loadToken++;
    this.inner.cancel();
  }

  terminate(): void {
    this.loadToken++;
    this.inner.terminate();
  }
}
