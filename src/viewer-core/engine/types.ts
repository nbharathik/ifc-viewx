// Engine-layer data contracts. Framework-agnostic: no Three.js, no web-ifc, no
// vscode types leak through this surface. The web-ifc adapter (adapter.ts) is the
// ONLY module that imports web-ifc; everything else depends on these shapes.

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface RGBA {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** Raw geometry for one mesh, in the mesh's local space (pre-`matrix`). */
export interface MeshGeometry {
  /** xyz triples. */
  positions: Float32Array;
  /** xyz triples, parallel to `positions`. */
  normals: Float32Array;
  indices: Uint32Array;
}

/** One placed, colored piece of geometry tied to an IFC element. */
export interface IfcMesh {
  expressID: number;
  /** IFC class name of the element, e.g. "IfcWall", "IfcSpace". */
  ifcType: string;
  color: RGBA;
  /** 4x4 column-major placement matrix (web-ifc flatTransformation order). */
  matrix: number[];
  geometry: MeshGeometry;
  /**
   * Identity of the underlying triangle data (web-ifc geometry expressID).
   * Meshes sharing a geometryID share the same `geometry` object, which lets
   * the renderer instance repeated geometry instead of duplicating it.
   */
  geometryID: number;
  /** Local-space AABB of `geometry` (pre-`matrix`), computed once per geometry. */
  localBounds: { min: Vec3; max: Vec3 };
}

/** A node of the IFC spatial containment hierarchy. */
export interface SpatialNode {
  expressID: number;
  /** IFC class name, e.g. "IfcBuildingStorey". */
  type: string;
  name: string | null;
  children: SpatialNode[];
}

export interface IfcProperty {
  name: string;
  value: string | number | boolean | null;
  /** Optional unit/type hint for display (e.g. "IfcLabel", "m"). */
  unit?: string | null;
}

export interface IfcPropertySet {
  expressID: number;
  name: string;
  kind: 'pset' | 'qto';
  properties: IfcProperty[];
}

export interface ItemProperties {
  expressID: number;
  type: string;
  /** Direct attributes (Name, GlobalId, ObjectType, ...). */
  attributes: IfcProperty[];
  /** Property sets and quantity sets attached via IfcRelDefinesByProperties. */
  psets: IfcPropertySet[];
}

export interface ModelStats {
  totalEntities: number;
  meshCount: number;
  triangleCount: number;
  /** Entity count keyed by IFC class name. Computed on demand, not at load. */
  countsByType?: Record<string, number>;
  parseMs: number;
  geometryMs: number;
  /** File size in bytes, when known (URL loads). */
  fileBytes?: number;
  /** Time spent fetching the file, when loaded from a URL. */
  downloadMs?: number;
  /** Time spent building GPU objects on the main thread (set by the viewer). */
  uploadMs?: number;
}

export type ProgressPhase = 'downloading' | 'parsing' | 'geometry' | 'done';

export interface LoadProgress {
  phase: ProgressPhase;
  /** Entities processed so far (geometry phase). */
  entities: number;
  totalEntities: number;
  /** Meshes streamed so far. */
  meshes: number;
  /** Bytes fetched so far (downloading phase, URL loads). */
  bytesLoaded?: number;
  /** Total bytes when the server reports a length (downloading phase). */
  bytesTotal?: number;
}

export interface ModelBounds {
  min: Vec3;
  max: Vec3;
}

export interface LoadedModel {
  modelID: number;
  meshes: IfcMesh[];
  bounds: ModelBounds;
  stats: ModelStats;
}

export interface LoadOptions {
  onProgress?: (progress: LoadProgress) => void;
  /** Called once per streamed mesh, before `loadModel` resolves. */
  onMesh?: (mesh: IfcMesh) => void;
  /**
   * When false, `LoadedModel.meshes` is left empty and meshes are only
   * delivered through `onMesh`. Avoids retaining every mesh for large models.
   * Defaults to true (Node tests read the returned array).
   */
  collectMeshes?: boolean;
  /** Parse only, no geometry stream. Used to reopen a cached model lazily. */
  skipGeometry?: boolean;
}

/** Where the IFC bytes come from. URL sources are fetched by the engine. */
export type LoadSource =
  | { kind: 'bytes'; bytes: Uint8Array }
  | { kind: 'url'; url: string; fileName?: string };

/** IFC classes excluded from the default geometry stream, loaded on demand. */
export type LazyCategory = 'IfcSpace' | 'IfcOpeningElement';

/** Thin adapter surface over the IFC engine (web-ifc today). */
export interface IfcEngine {
  init(): Promise<void>;
  loadModel(buffer: Uint8Array, options?: LoadOptions): Promise<LoadedModel>;
  /** Stream meshes for a category excluded from loadModel (spaces/openings). */
  loadCategory(modelID: number, category: LazyCategory, onMesh?: (mesh: IfcMesh) => void): IfcMesh[];
  getSpatialTree(modelID: number): SpatialNode;
  getItemProperties(modelID: number, expressID: number): ItemProperties;
  getCountsByType(modelID: number): Record<string, number>;
  dispose(modelID: number): void;
}

/** Load result without the mesh array (meshes stream via onMeshBatch). */
export interface LoadedModelMeta {
  modelID: number;
  bounds: ModelBounds;
  stats: ModelStats;
  tree: SpatialNode | null;
}

export interface AsyncLoadOptions {
  onProgress?: (progress: LoadProgress) => void;
  /** Batches of meshes as they stream in; geometry may be shared across meshes. */
  onMeshBatch?: (meshes: IfcMesh[]) => void;
  /** Parse only, no geometry stream. Used to reopen a cached model lazily. */
  skipGeometry?: boolean;
}

/**
 * Async engine surface the viewer drives. Implemented by the worker client
 * (parsing off the main thread) and by a thin inline wrapper as fallback.
 */
export interface AsyncIfcEngine {
  init(): Promise<void>;
  loadModel(source: LoadSource, options?: AsyncLoadOptions): Promise<LoadedModelMeta>;
  loadCategory(
    modelID: number,
    category: LazyCategory,
    onMeshBatch: (meshes: IfcMesh[]) => void,
  ): Promise<void>;
  getItemProperties(modelID: number, expressID: number): Promise<ItemProperties>;
  getCountsByType(modelID: number): Promise<Record<string, number>>;
  dispose(modelID: number): void;
  /** Abort the in-flight load, if any. The load promise rejects with CancelledError. */
  cancel(): void;
  /** Tear down the engine entirely (terminates the worker). */
  terminate(): void;
}

/** Thrown (as rejection) when a load is cancelled by the user. */
export class CancelledError extends Error {
  constructor(message = 'Load cancelled') {
    super(message);
    this.name = 'CancelledError';
  }
}
