// web-ifc adapter: the only module in the codebase permitted to import web-ifc.
// Translates web-ifc's raw API into the framework-agnostic shapes in types.ts.
// Runs unchanged under Node and in the browser; the only environment difference
// is the wasm location (SetWasmPath in the browser).
import {
  IfcAPI,
  IFCPROJECT,
  IFCRELAGGREGATES,
  IFCRELCONTAINEDINSPATIALSTRUCTURE,
  IFCRELDEFINESBYPROPERTIES,
  IFCSPACE,
  IFCOPENINGELEMENT,
} from 'web-ifc';

import type {
  IfcEngine,
  IfcMesh,
  IfcProperty,
  IfcPropertySet,
  ItemProperties,
  LazyCategory,
  LoadOptions,
  LoadProgress,
  LoadedModel,
  MeshGeometry,
  ModelBounds,
  ModelStats,
  RGBA,
  SpatialNode,
  Vec3,
} from './types.js';

const CATEGORY_CODES: Record<LazyCategory, number> = {
  IfcSpace: IFCSPACE,
  IfcOpeningElement: IFCOPENINGELEMENT,
};

/** web-ifc value-type code for an entity reference (Handle). */
const REF_TYPE = 5;

/** Quantity value carriers on IfcPhysicalSimpleQuantity subtypes. */
const QUANTITY_VALUE_KEYS = [
  'LengthValue',
  'AreaValue',
  'VolumeValue',
  'CountValue',
  'WeightValue',
  'TimeValue',
] as const;

export interface WebIfcAdapterOptions {
  /** Directory (or file) serving web-ifc.wasm in the browser. Unused in Node. */
  wasmPath?: string;
  /** When true, `wasmPath` is treated as an absolute URL/path. */
  wasmAbsolute?: boolean;
  /** Prefetched wasm bytes, served to Emscripten from a local blob URL. */
  wasmBinary?: Uint8Array;
}

/** Cap web-ifc's internal allocation well below the wasm32 4 GB ceiling. */
const MEMORY_LIMIT_BYTES = 3 * 1024 * 1024 * 1024;

/** IFC type code to name. The table is schema-global, so one map serves all. */
const TYPE_NAMES = new Map<number, string>();

/** Stand-in for a source buffer that has been handed over and released. */
const EMPTY_BYTES = new Uint8Array(0);

/** Handed back by web-ifc's embind bindings; freed rather than left to leak. */
interface Deletable {
  delete(): void;
}

/**
 * Circle tessellation by file size. web-ifc's default is 12 segments per
 * circle; large files trade curve smoothness for fewer generated triangles
 * and a faster geometry phase. Committed fixtures stay at the default, so
 * pixel baselines are unaffected.
 */
function circleSegmentsFor(fileBytes: number): number {
  if (fileBytes > 80e6) return 6;
  if (fileBytes > 30e6) return 8;
  return 12;
}

interface CachedGeometry {
  geometry: MeshGeometry;
  localBounds: { min: Vec3; max: Vec3 };
  triangles: number;
}

interface ModelState {
  /** elementExpressID -> property-definition expressIDs (psets + qtos). */
  relDefsByObject: Map<number, number[]> | null;
  /** geometryExpressID -> converted triangle data, shared across placements. */
  geometryCache: Map<number, CachedGeometry>;
}

type WebIfcValue =
  | { value: unknown; type?: number; name?: string }
  | number
  | string
  | boolean
  | null
  | undefined;

function isPrimitive(v: unknown): v is number | string | boolean {
  const t = typeof v;
  return t === 'number' || t === 'string' || t === 'boolean';
}

/** Unwrap a web-ifc attribute into a display scalar, or null for refs/arrays. */
function unwrap(v: WebIfcValue): string | number | boolean | null {
  if (v === null || v === undefined) return null;
  if (isPrimitive(v)) return v;
  if (Array.isArray(v)) return null;
  if (typeof v === 'object') {
    // Reference handle: { value: <expressID>, type: 5 } with no value-type name.
    if (v.type === REF_TYPE && !('name' in v)) return null;
    if ('value' in v) {
      const inner = v.value;
      return isPrimitive(inner) ? inner : null;
    }
  }
  return null;
}

/** True when an attribute is a scalar/typed-value (vs a reference or array). */
function isScalarAttribute(v: WebIfcValue): boolean {
  if (v === null || v === undefined) return true; // legit null attribute
  if (isPrimitive(v)) return true;
  if (Array.isArray(v)) return false;
  return typeof v === 'object' && 'name' in v;
}

function valueUnit(v: WebIfcValue): string | null {
  if (v && typeof v === 'object' && !Array.isArray(v) && 'name' in v && typeof v.name === 'string') {
    return v.name;
  }
  return null;
}

export class WebIfcAdapter implements IfcEngine {
  private readonly api: IfcAPI;
  private initialized = false;
  private readonly options: WebIfcAdapterOptions;
  private readonly models = new Map<number, ModelState>();

  constructor(options: WebIfcAdapterOptions = {}) {
    this.options = options;
    this.api = new IfcAPI();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    if (this.options.wasmBinary) {
      // Workers in VS Code webviews cannot fetch resource URLs (only the
      // page's service worker resolves them), so the client prefetches the
      // wasm and it loads here from a local blob URL.
      const blobUrl = URL.createObjectURL(
        new Blob([this.options.wasmBinary as Uint8Array<ArrayBuffer>], {
          type: 'application/wasm',
        }),
      );
      try {
        await this.api.Init((path, prefix) => (path.endsWith('.wasm') ? blobUrl : prefix + path));
      } finally {
        URL.revokeObjectURL(blobUrl);
      }
      this.initialized = true;
      return;
    }
    if (this.options.wasmPath) {
      this.api.SetWasmPath(this.options.wasmPath, this.options.wasmAbsolute ?? false);
    }
    await this.api.Init();
    this.initialized = true;
  }

  async loadModel(buffer: Uint8Array, options: LoadOptions = {}): Promise<LoadedModel> {
    if (!this.initialized) {
      throw new Error('WebIfcAdapter.loadModel called before init()');
    }
    const { onProgress, onMesh } = options;
    const collect = options.collectMeshes ?? true;

    // Cheap header check first: a STEP/IFC file begins with "ISO-10303-21".
    // This rejects junk without entering web-ifc's wasm (whose abort path on
    // malformed input can destabilize the instance and emit async errors).
    if (!hasStepHeader(buffer)) {
      throw new Error('Not an IFC file: missing the "ISO-10303-21" STEP header.');
    }

    // Captured before the reference is dropped below: the stats and both
    // error paths still have to report the size of the file that was opened.
    const fileBytes = buffer.byteLength;
    const parseStart = now();
    let modelID: number;
    try {
      modelID = this.api.OpenModel(buffer, {
        MEMORY_LIMIT: MEMORY_LIMIT_BYTES,
        CIRCLE_SEGMENTS: circleSegmentsFor(fileBytes),
      });
    } catch (err) {
      throw mapWasmError(err, fileBytes);
    }
    // web-ifc copied the file into its own heap, so holding the JS copy for
    // the whole geometry phase is a second full-size buffer for nothing.
    buffer = EMPTY_BYTES;
    const parseMs = now() - parseStart;

    // The vector is a wasm allocation; only its size is wanted, so it goes
    // straight back rather than sitting in a heap capped at 32 bits.
    const allLines = this.api.GetAllLines(modelID);
    const totalEntities = allLines.size();
    (allLines as unknown as Deletable).delete?.();
    if (totalEntities === 0) {
      this.dispose(modelID);
      throw new Error('No IFC entities found: the file is empty or not a valid IFC model.');
    }
    emit(onProgress, { phase: 'parsing', entities: 0, totalEntities, meshes: 0 });

    this.models.set(modelID, { relDefsByObject: null, geometryCache: new Map() });

    const meshes: IfcMesh[] = [];
    const seenElements = new Set<number>();
    let geometryEmitted = false;
    let meshCount = 0;
    let triangleCount = 0;
    let boundsMin: Vec3 | null = null;
    let boundsMax: Vec3 | null = null;

    const geomStart = now();
    try {
      if (!options.skipGeometry) this.api.StreamAllMeshes(modelID, (flatMesh: any) => {
        const expressID: number = flatMesh.expressID;
        seenElements.add(expressID);
        const ifcType = this.typeName(modelID, expressID);
        const placed = flatMesh.geometries;
        for (let i = 0; i < placed.size(); i++) {
          const { mesh, min, max, triangles } = this.convertPlaced(
            modelID,
            expressID,
            ifcType,
            placed.get(i),
          );
          meshCount++;
          triangleCount += triangles;
          if (mesh.geometry.positions.length > 0) {
            [boundsMin, boundsMax] = expandBoundsByAabb(
              boundsMin,
              boundsMax,
              mesh.matrix,
              min[0], min[1], min[2],
              max[0], max[1], max[2],
            );
          }
          if (collect) meshes.push(mesh);
          onMesh?.(mesh);
        }
        if (!geometryEmitted || meshCount % 64 === 0) {
          geometryEmitted = true;
          emit(onProgress, {
            phase: 'geometry',
            entities: seenElements.size,
            totalEntities,
            meshes: meshCount,
          });
        }
      });
    } catch (err) {
      this.dispose(modelID);
      throw mapWasmError(err, fileBytes);
    }
    const geometryMs = now() - geomStart;

    const bounds: ModelBounds =
      boundsMin && boundsMax
        ? { min: boundsMin, max: boundsMax }
        : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };

    const stats: ModelStats = {
      totalEntities,
      meshCount,
      triangleCount,
      parseMs,
      geometryMs,
      fileBytes,
    };

    emit(onProgress, {
      phase: 'done',
      entities: totalEntities,
      totalEntities,
      meshes: meshCount,
    });

    return { modelID, meshes, bounds, stats };
  }

  loadCategory(modelID: number, category: LazyCategory, onMesh?: (mesh: IfcMesh) => void): IfcMesh[] {
    const code = CATEGORY_CODES[category];
    const ids = this.api.GetLineIDsWithType(modelID, code);
    const expressIDs: number[] = [];
    for (let i = 0; i < ids.size(); i++) expressIDs.push(ids.get(i));
    if (expressIDs.length === 0) return [];

    const meshes: IfcMesh[] = [];
    this.api.StreamMeshes(modelID, expressIDs, (flatMesh: any) => {
      const expressID: number = flatMesh.expressID;
      const placed = flatMesh.geometries;
      for (let i = 0; i < placed.size(); i++) {
        const { mesh } = this.convertPlaced(modelID, expressID, category, placed.get(i));
        meshes.push(mesh);
        onMesh?.(mesh);
      }
    });
    return meshes;
  }

  /** Convert one web-ifc placed geometry into an IfcMesh + its local AABB. */
  private convertPlaced(
    modelID: number,
    expressID: number,
    ifcType: string,
    pg: any,
  ): { mesh: IfcMesh; min: [number, number, number]; max: [number, number, number]; triangles: number } {
    const geometryID: number = pg.geometryExpressID;
    const cached = this.geometryFor(modelID, geometryID);
    const matrix = Array.from(pg.flatTransformation as ArrayLike<number>);
    const color: RGBA = { r: pg.color.x, g: pg.color.y, b: pg.color.z, a: pg.color.w };
    const { min, max } = cached.localBounds;

    return {
      mesh: {
        expressID,
        ifcType,
        color,
        matrix,
        geometry: cached.geometry,
        geometryID,
        localBounds: cached.localBounds,
      },
      min: [min.x, min.y, min.z],
      max: [max.x, max.y, max.z],
      triangles: cached.triangles,
    };
  }

  /**
   * A window onto web-ifc's own memory, or the copying public call when the
   * heap is not reachable (a different build, a future version). The returned
   * array is only valid until the next call into wasm.
   */
  private heapView(heap: 'HEAPF32' | 'HEAPU32', pointer: number, size: number): Float32Array | Uint32Array {
    const module = (this.api as unknown as { wasmModule?: Record<string, Float32Array | Uint32Array> }).wasmModule;
    const buffer = module?.[heap];
    if (buffer) return buffer.subarray(pointer / 4, pointer / 4 + size);
    return heap === 'HEAPF32'
      ? (this.api.GetVertexArray(pointer, size) as Float32Array)
      : (this.api.GetIndexArray(pointer, size) as Uint32Array);
  }

  /**
   * Triangle data for a geometry expressID, converted once per model. Repeated
   * placements (typed products, fasteners) share the same arrays, which cuts
   * both memory and per-instance conversion cost on large models.
   */
  private geometryFor(modelID: number, geometryID: number): CachedGeometry {
    const state = this.models.get(modelID);
    const hit = state?.geometryCache.get(geometryID);
    if (hit) return hit;

    const geometry = this.api.GetGeometry(modelID, geometryID);
    // Views into the wasm heap, not copies: web-ifc's GetVertexArray slices,
    // and the interleaved buffer is then split anyway, so the public call is
    // one full copy of every vertex for nothing. Both views are read below
    // before anything calls back into wasm, which is what could move the heap.
    const verts = this.heapView(
      'HEAPF32',
      geometry.GetVertexData(),
      geometry.GetVertexDataSize(),
    ) as Float32Array;
    const rawIndices = this.heapView(
      'HEAPU32',
      geometry.GetIndexData(),
      geometry.GetIndexDataSize(),
    ) as Uint32Array;

    const vertexCount = verts.length / 6;
    const positions = new Float32Array(vertexCount * 3);
    const normals = new Float32Array(vertexCount * 3);
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
    for (let v = 0; v < vertexCount; v++) {
      const px = verts[v * 6];
      const py = verts[v * 6 + 1];
      const pz = verts[v * 6 + 2];
      positions[v * 3] = px;
      positions[v * 3 + 1] = py;
      positions[v * 3 + 2] = pz;
      normals[v * 3] = verts[v * 6 + 3];
      normals[v * 3 + 1] = verts[v * 6 + 4];
      normals[v * 3 + 2] = verts[v * 6 + 5];
      if (px < minX) minX = px;
      if (py < minY) minY = py;
      if (pz < minZ) minZ = pz;
      if (px > maxX) maxX = px;
      if (py > maxY) maxY = py;
      if (pz > maxZ) maxZ = pz;
    }
    // One copy out of the heap view, taken before delete() frees it.
    const indices = new Uint32Array(rawIndices);
    geometry.delete();

    const entry: CachedGeometry = {
      geometry: { positions, normals, indices },
      localBounds: {
        min: { x: minX, y: minY, z: minZ },
        max: { x: maxX, y: maxY, z: maxZ },
      },
      triangles: indices.length / 3,
    };
    state?.geometryCache.set(geometryID, entry);
    return entry;
  }

  getSpatialTree(modelID: number): SpatialNode {
    const aggregates = this.relationMap(modelID, IFCRELAGGREGATES, 'RelatingObject', 'RelatedObjects');
    const contains = this.relationMap(
      modelID,
      IFCRELCONTAINEDINSPATIALSTRUCTURE,
      'RelatingStructure',
      'RelatedElements',
    );

    const projects = this.api.GetLineIDsWithType(modelID, IFCPROJECT);
    if (projects.size() === 0) {
      throw new Error('No IfcProject found in model');
    }
    const rootID = projects.get(0);
    const visited = new Set<number>();

    const build = (id: number): SpatialNode => {
      visited.add(id);
      const line: any = this.api.GetLine(modelID, id);
      const childIds = [...(aggregates.get(id) ?? []), ...(contains.get(id) ?? [])];
      const children: SpatialNode[] = [];
      for (const childID of childIds) {
        if (visited.has(childID)) continue;
        children.push(build(childID));
      }
      return {
        expressID: id,
        type: this.typeName(modelID, id),
        name: asString(unwrap(line.Name)),
        children,
      };
    };

    return build(rootID);
  }

  getItemProperties(modelID: number, expressID: number): ItemProperties {
    const line: any = this.api.GetLine(modelID, expressID);
    const attributes: IfcProperty[] = [];
    for (const key of Object.keys(line)) {
      if (key === 'expressID' || key === 'type') continue;
      const raw = line[key] as WebIfcValue;
      if (!isScalarAttribute(raw)) continue;
      attributes.push({ name: key, value: unwrap(raw), unit: valueUnit(raw) });
    }

    const psets: IfcPropertySet[] = [];
    for (const defID of this.relDefsFor(modelID, expressID)) {
      const def: any = this.api.GetLine(modelID, defID);
      const set = this.readPropertyDefinition(modelID, def);
      if (set) psets.push(set);
    }

    return {
      expressID,
      type: this.typeName(modelID, expressID),
      attributes,
      psets,
    };
  }

  /** Free converted-geometry memory kept for dedup during streaming. */
  clearGeometryCache(modelID: number): void {
    this.models.get(modelID)?.geometryCache.clear();
  }

  dispose(modelID: number): void {
    if (this.api.IsModelOpen?.(modelID) ?? true) {
      try {
        this.api.CloseModel(modelID);
      } catch {
        // already closed
      }
    }
    this.models.delete(modelID);
  }

  // -- internals ----------------------------------------------------------
  private typeName(modelID: number, expressID: number): string {
    const code = this.api.GetLineType(modelID, expressID);
    // Called once per element with geometry, and each miss marshals a fresh
    // std::string out of wasm. The table is schema-global, so it is safe to
    // share across models and it interns the strings while it is at it.
    let name = TYPE_NAMES.get(code);
    if (name === undefined) {
      name = this.api.GetNameFromTypeCode(code);
      TYPE_NAMES.set(code, name);
    }
    return name;
  }

  private relationMap(
    modelID: number,
    relType: number,
    fromKey: string,
    toKey: string,
  ): Map<number, number[]> {
    const map = new Map<number, number[]>();
    const rels = this.api.GetLineIDsWithType(modelID, relType);
    for (let i = 0; i < rels.size(); i++) {
      const rel: any = this.api.GetLine(modelID, rels.get(i));
      const parent = rel[fromKey];
      if (!parent || typeof parent.value !== 'number') continue;
      const related = rel[toKey];
      if (!Array.isArray(related)) continue;
      const ids = related.map((h: any) => h.value).filter((v: unknown) => typeof v === 'number');
      const existing = map.get(parent.value);
      if (existing) existing.push(...ids);
      else map.set(parent.value, ids);
    }
    return map;
  }

  private relDefsFor(modelID: number, expressID: number): number[] {
    const state = this.models.get(modelID) ?? {
      relDefsByObject: null,
      geometryCache: new Map<number, CachedGeometry>(),
    };
    if (!state.relDefsByObject) {
      state.relDefsByObject = this.buildRelDefIndex(modelID);
      this.models.set(modelID, state);
    }
    return state.relDefsByObject.get(expressID) ?? [];
  }

  private buildRelDefIndex(modelID: number): Map<number, number[]> {
    const index = new Map<number, number[]>();
    const rels = this.api.GetLineIDsWithType(modelID, IFCRELDEFINESBYPROPERTIES);
    for (let i = 0; i < rels.size(); i++) {
      const rel: any = this.api.GetLine(modelID, rels.get(i));
      const def = rel.RelatingPropertyDefinition;
      if (!def || typeof def.value !== 'number') continue;
      const objects = rel.RelatedObjects;
      if (!Array.isArray(objects)) continue;
      for (const handle of objects) {
        const objID = handle?.value;
        if (typeof objID !== 'number') continue;
        const existing = index.get(objID);
        if (existing) existing.push(def.value);
        else index.set(objID, [def.value]);
      }
    }
    return index;
  }

  private readPropertyDefinition(modelID: number, def: any): IfcPropertySet | null {
    const name = asString(unwrap(def.Name)) ?? 'Unnamed';
    if (Array.isArray(def.HasProperties)) {
      const properties = def.HasProperties.map((h: any) =>
        this.readSingleProperty(modelID, h.value),
      ).filter((p: IfcProperty | null): p is IfcProperty => p !== null);
      return { expressID: def.expressID, name, kind: 'pset', properties };
    }
    if (Array.isArray(def.Quantities)) {
      const properties = def.Quantities.map((h: any) =>
        this.readQuantity(modelID, h.value),
      ).filter((p: IfcProperty | null): p is IfcProperty => p !== null);
      return { expressID: def.expressID, name, kind: 'qto', properties };
    }
    return null;
  }

  private readSingleProperty(modelID: number, propID: number): IfcProperty | null {
    const prop: any = this.api.GetLine(modelID, propID);
    const name = asString(unwrap(prop.Name));
    if (name === null) return null;
    return {
      name,
      value: unwrap(prop.NominalValue),
      unit: valueUnit(prop.NominalValue),
    };
  }

  private readQuantity(modelID: number, quantID: number): IfcProperty | null {
    const quant: any = this.api.GetLine(modelID, quantID);
    const name = asString(unwrap(quant.Name));
    if (name === null) return null;
    let value: string | number | boolean | null = null;
    let unit: string | null = null;
    for (const key of QUANTITY_VALUE_KEYS) {
      if (key in quant && quant[key] !== null && quant[key] !== undefined) {
        value = unwrap(quant[key]);
        unit = key.replace(/Value$/, '');
        break;
      }
    }
    return { name, value, unit };
  }

  /** Entity counts per IFC class. One index scan per type; not on the load path. */
  getCountsByType(modelID: number): Record<string, number> {
    const counts: Record<string, number> = {};
    const types = this.api.GetAllTypesOfModel(modelID) as Array<{ typeID: number; typeName: string }>;
    for (const { typeID, typeName } of types) {
      counts[typeName] = this.api.GetLineIDsWithType(modelID, typeID).size();
    }
    return counts;
  }
}

/**
 * Map a wasm-side failure to an actionable message. web-ifc runs in 32-bit
 * wasm, so its address space tops out at 4 GB regardless of host RAM; very
 * large models fail with allocation aborts that would otherwise be cryptic.
 */
function mapWasmError(err: unknown, fileBytes: number): Error {
  const detail = err instanceof Error ? err.message : String(err);
  const mb = Math.round(fileBytes / 1e6);
  const memoryLike =
    /memory|allocat|abort|out of bounds|OOM|enlarge/i.test(detail) || err instanceof RangeError;
  if (memoryLike) {
    return new Error(
      `The model (${mb} MB) exceeds the parser's memory. ` +
        `web-ifc runs in 32-bit WebAssembly and cannot address more than 4 GB ` +
        `regardless of system RAM. Try a smaller export (for example one ` +
        `discipline or storey per file). (web-ifc: ${detail})`,
      { cause: err },
    );
  }
  return new Error(`Could not parse IFC file (web-ifc: ${detail}).`, { cause: err });
}

/** True if the buffer looks like a STEP/IFC file (header within the first 256B). */
function hasStepHeader(buffer: Uint8Array): boolean {
  const probe = buffer.subarray(0, 256);
  const text = new TextDecoder('latin1').decode(probe);
  return text.includes('ISO-10303-21');
}

function asString(v: string | number | boolean | null): string | null {
  if (v === null) return null;
  return typeof v === 'string' ? v : String(v);
}

function emit(cb: ((p: LoadProgress) => void) | undefined, progress: LoadProgress): void {
  cb?.(progress);
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

function expandBoundsByAabb(
  min: Vec3 | null,
  max: Vec3 | null,
  m: number[],
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
): [Vec3, Vec3] {
  // Runs once per placement, so it allocates nothing: the corner list, the
  // clones and the point returned per corner were about nineteen short-lived
  // objects each time, tens of millions over a large model. The accumulators
  // are grown in place, which is what the clones were undoing anyway.
  let lo = min;
  let hi = max;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? maxX : minX;
    const y = c & 2 ? maxY : minY;
    const z = c & 4 ? maxZ : minZ;
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (!lo || !hi) {
      lo = { x: wx, y: wy, z: wz };
      hi = { x: wx, y: wy, z: wz };
      continue;
    }
    if (wx < lo.x) lo.x = wx;
    if (wy < lo.y) lo.y = wy;
    if (wz < lo.z) lo.z = wz;
    if (wx > hi.x) hi.x = wx;
    if (wy > hi.y) hi.y = wy;
    if (wz > hi.z) hi.z = wz;
  }
  return [lo!, hi!];
}
