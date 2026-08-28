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

export interface IfcClassification {
  system: string;
  value: string | null;
  name: string | null;
  uri: string | null;
}

export interface IfcMaterial {
  name: string;
  category: string | null;
  code: string | null;
  uri: string | null;
}

export interface IfcRelationTarget {
  relation: string;
  expressID: number;
  type: string;
  name: string | null;
}

export interface ItemProperties {
  expressID: number;
  type: string;
  /** Direct attributes (Name, GlobalId, ObjectType, ...). */
  attributes: IfcProperty[];
  /** Property sets and quantity sets attached via IfcRelDefinesByProperties. */
  psets: IfcPropertySet[];
  /** Classification references associated with the occurrence or its type. */
  classifications: IfcClassification[];
  /** Materials resolved through single, layer, profile and constituent sets. */
  materials: IfcMaterial[];
  /** Direct and transitive parents used by IDS partOf facets. */
  partOf: IfcRelationTarget[];
}

export interface IfcScheduleTime {
  scheduleStart: string | null;
  scheduleFinish: string | null;
  scheduleDuration: string | null;
  actualStart: string | null;
  actualFinish: string | null;
  actualDuration: string | null;
  remainingTime: string | null;
  completion: number | null;
  statusTime: string | null;
}

export interface IfcWorkScheduleRecord {
  expressID: number;
  globalId: string;
  name: string;
  description: string;
  identification: string;
  status: string;
  predefinedType: string;
  creationDate: string | null;
  startTime: string | null;
  finishTime: string | null;
  taskIds: number[];
  modelIndex: number;
  modelName: string;
}

export interface IfcTaskRecord {
  expressID: number;
  globalId: string;
  name: string;
  description: string;
  identification: string;
  status: string;
  predefinedType: string;
  workMethod: string;
  priority: number | null;
  isMilestone: boolean;
  taskTime: IfcScheduleTime | null;
  scheduleIds: number[];
  parentTaskId: number | null;
  childTaskIds: number[];
  productIds: number[];
  predecessorIds: number[];
  successorIds: number[];
  modelIndex: number;
  modelName: string;
}

export interface IfcTaskSequenceRecord {
  expressID: number;
  predecessorId: number;
  successorId: number;
  sequenceType: string;
  timeLag: string | null;
  modelIndex: number;
  modelName: string;
}

export interface IfcTaskGraph {
  schedules: IfcWorkScheduleRecord[];
  tasks: IfcTaskRecord[];
  sequences: IfcTaskSequenceRecord[];
}

export interface OrganizeGroup {
  expressID: number;
  name: string | null;
  /** IFC class of the group entity: IfcGroup, IfcSystem, IfcZone, ... */
  ifcType: string;
  ids: number[];
}

export interface OrganizeLayer {
  name: string;
  ids: number[];
}

export interface OrganizeClassification {
  system: string;
  code: string | null;
  ids: number[];
}

export interface OrganizeMaterial {
  name: string;
  ids: number[];
}

export interface OrganizeIndex {
  groups: OrganizeGroup[];
  layers: OrganizeLayer[];
  classifications: OrganizeClassification[];
  materials: OrganizeMaterial[];
}

export interface GridAxisLine {
  /** IfcGridAxis.AxisTag, e.g. "A" or "1". */
  label: string | null;
  axisGroup: 'U' | 'V' | 'W';
  /** Flat xyz triples in MODEL coordinates (same frame as IfcMesh.matrix). */
  points: number[];
}

export interface IfcGridInfo {
  expressID: number;
  name: string | null;
  axes: GridAxisLine[];
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

export interface ProjectedCrsInfo {
  expressID: number;
  name: string | null;
  description: string | null;
  geodeticDatum: string | null;
  verticalDatum: string | null;
  mapProjection: string | null;
  mapZone: string | null;
  mapUnit: string | null;
}

export interface TrueNorthInfo {
  direction: [number, number];
  /** Clockwise angle from grid north to true north, in degrees. */
  degreesFromGridNorth: number;
}

export interface MapConversionInfo {
  kind: 'map-conversion';
  expressID: number;
  sourceCrsID: number | null;
  targetCrsID: number | null;
  eastings: number;
  northings: number;
  orthogonalHeight: number;
  xAxisAbscissa: number;
  xAxisOrdinate: number;
  rotation: number;
  scale: number;
}

export interface RigidOperationInfo {
  kind: 'rigid-operation';
  expressID: number;
  sourceCrsID: number | null;
  targetCrsID: number | null;
  firstCoordinate: number;
  secondCoordinate: number;
  height: number;
  coordinateKind: 'length' | 'angle' | 'unknown';
}

export type CoordinateOperationInfo = MapConversionInfo | RigidOperationInfo;

export interface IfcGeoReference {
  schema: string;
  projectedCrs: ProjectedCrsInfo | null;
  operation: CoordinateOperationInfo | null;
  trueNorth: TrueNorthInfo | null;
  warnings: string[];
}

export type ModelTransformSource = 'none' | 'automatic' | 'manual';

/** Affine placement from one model's engineering coordinates into the federation frame. */
export interface ModelTransform {
  translation: [number, number, number];
  rotationZ: number;
  scale: number;
  source: ModelTransformSource;
  recordedAt?: string;
}

export interface GeoreferencedPoint {
  crs: string;
  coordinates: [number, number, number];
}

export interface LoadedModel {
  modelID: number;
  meshes: IfcMesh[];
  bounds: ModelBounds;
  stats: ModelStats;
  geo: IfcGeoReference;
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
  getTaskGraph(modelID: number): IfcTaskGraph;
  getOrganizeIndex(modelID: number): OrganizeIndex;
  getGridAxes(modelID: number): IfcGridInfo[];
  dispose(modelID: number): void;
}

/** Load result without the mesh array (meshes stream via onMeshBatch). */
export interface LoadedModelMeta {
  modelID: number;
  bounds: ModelBounds;
  stats: ModelStats;
  tree: SpatialNode | null;
  geo: IfcGeoReference;
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
  getTaskGraph(modelID: number): Promise<IfcTaskGraph>;
  getOrganizeIndex(modelID: number): Promise<OrganizeIndex>;
  getGridAxes(modelID: number): Promise<IfcGridInfo[]>;
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
