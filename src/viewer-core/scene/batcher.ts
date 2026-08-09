// GPU batching: unique geometry is baked into spatially bucketed merged
// chunks, repeated geometry becomes instanced meshes. Per-element state
// (visible, highlighted) lives in a data texture read by a patched Lambert
// shader; picking is a GPU ID pass. Origin shift happens in f64 before the
// f32 cast so georeferenced models do not jitter.
import * as THREE from 'three';

import type { IfcMesh, MeshGeometry, ModelBounds, Vec3 } from '../engine/types.js';
import { modelOf, packId } from '../ids.js';

/** Free a subtree's GPU buffers. Shared materials are owned by the batcher. */
function disposeTree(root: THREE.Object3D): void {
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    mesh.geometry?.dispose();
    if ((mesh as THREE.InstancedMesh).isInstancedMesh) (mesh as THREE.InstancedMesh).dispose();
  });
  root.clear();
}

/** Deterministic, pleasant color from an integer key (golden-angle hue). */
function colorForId(id: number): THREE.Color {
  const hue = (id * 137.508) % 360;
  return new THREE.Color().setHSL(hue / 360, 0.45, 0.62);
}

function isDefaultWhite(c: { r: number; g: number; b: number; a: number }): boolean {
  return c.r >= 0.999 && c.g >= 0.999 && c.b >= 0.999 && c.a >= 0.999;
}

/** Highlight emissive: linear-space 0xff8c1a at intensity 0.55 (legacy look). */
const HIGHLIGHT_GLSL = 'vec3(1.0, 0.26225, 0.01033) * 0.55';

const STATE_TEX_WIDTH = 1024;
/** State R channel: hidden, ghosted, visible. Read as thresholds in the shader. */
const STATE_HIDDEN = 0;
const STATE_GHOST = 140;
const STATE_VISIBLE = 255;
/** Colour override palette entries. Index 0 means "no override". */
const PALETTE_SIZE = 256;
/**
 * Ghosts keep this many of every 16 screen pixels. A screen-space pattern
 * rather than blending, so an opaque chunk never needs sorting or a second
 * material to fade.
 */
const GHOST_KEPT = 3;

/** Flat fill for a cut face. Neutral, so it reads as material, not as colour. */
const CAP_GLSL = 'vec3(0.42, 0.44, 0.47)';
/** Vertex budget per merged chunk; bounds single-buffer size and draw grouping. */
const CHUNK_VERTEX_LIMIT = 500_000;
/**
 * When a small geometry repeats, baking the copies into a chunk that is drawn
 * anyway beats giving it an InstancedMesh of its own. Past these thresholds
 * the vertex duplication stops being worth the draw call it saves; the vertex
 * cap in particular is what keeps brep-heavy models from re-baking megabytes.
 */
const INSTANCE_MIN_VERTICES = 2_000;
const INSTANCE_MIN_COPIES = 8;
/** Far-from-origin threshold (m). Beyond this we recenter to avoid f32 jitter. */
const ORIGIN_THRESHOLD = 1e4;
const INITIAL_INSTANCE_CAPACITY = 16;
/**
 * Ingest batches above this vertex count are split into a coarse spatial grid
 * so per-chunk frustum culling has spatially tight chunks to reject. Small
 * batches keep a single chunk (identical output to the pre-grid pipeline).
 */
const SPATIAL_SPLIT_VERTEX_THRESHOLD = 50_000;
/** Spatial grid resolution per axis (27 cells). */
const GRID_DIVISIONS = 3;
/** Vertices this close weld into one before faces are paired (metres). */
const WELD = 1e-4;
/** Faces meeting sharper than this leave an edge worth snapping to (22 deg). */
const SHARP_COS = Math.cos((22 * Math.PI) / 180);
/** Above this a mesh keeps its box edges: terrain has no corners to catch. */
const SNAP_TRIANGLE_LIMIT = 12_000;
/** Snap segments kept per element, 24 B each. */
const SNAP_SEGMENT_LIMIT = 400;
/** The 12 edges of a unit box, as corner-index pairs (bit c = axis c). */
const BOX_EDGES = [0, 1, 2, 3, 4, 5, 6, 7, 0, 2, 1, 3, 4, 6, 5, 7, 0, 4, 1, 5, 2, 6, 3, 7];

/**
 * Normals need direction, not float precision. WebGL expands a normalized
 * signed-short attribute back to [-1, 1] in the vertex shader, cutting the
 * GPU normal buffer from 12 to 6 bytes per vertex at roughly 3e-5 component
 * precision.
 */
function packNormalComponent(source: number): number {
  return Math.round(Math.max(-1, Math.min(1, source || 0)) * 32_767);
}

export function packNormalBuffer(source: ArrayLike<number>): Int16Array {
  const packed = new Int16Array(source.length);
  for (let i = 0; i < source.length; i++) packed[i] = packNormalComponent(Number(source[i]));
  return packed;
}

/**
 * Feature edges in local space, reused by every mesh that shares the geometry
 * (IFC repeats doors and windows heavily). Weak, so it costs nothing once the
 * engine drops the geometry.
 */
const edgeCache = new WeakMap<object, Float32Array>();

interface ElementRecord {
  index: number;
  ifcType: string;
  triangles: number;
  min: [number, number, number];
  max: [number, number, number];
  hidden: boolean;
}

/** A geometry seen more than once but still cheap enough to keep baking. */
interface BakedGeometry {
  copies: number;
  vertices: number;
}

interface InstancedEntry {
  geometryID: number;
  /** Which federated model owns it, so it lands in that model's group. */
  model: number;
  alphaKey: string;
  position: THREE.BufferAttribute;
  normal: THREE.BufferAttribute;
  index: THREE.BufferAttribute;
  mesh: THREE.InstancedMesh | null;
  elementIndexAttr: THREE.InstancedBufferAttribute | null;
  capacity: number;
  used: number;
  trianglesPerInstance: number;
  /** Rotation-safe radius of the source geometry around its local origin. */
  geometryRadius: number;
  /** AABB of instance translations (shifted space), for the bounding sphere. */
  tMin: [number, number, number];
  tMax: [number, number, number];
  /** Largest instance scale seen; scales the geometry radius. */
  maxScale: number;
}

/** Growable typed-array writer; avoids per-component JS array churn. */
class F32Writer {
  array = new Float32Array(4096);
  length = 0;

  ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.array.length) return;
    let capacity = this.array.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Float32Array(capacity);
    next.set(this.array);
    this.array = next;
  }

  take(): Float32Array {
    return this.array.subarray(0, this.length);
  }
}

class U32Writer {
  array = new Uint32Array(4096);
  length = 0;

  ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.array.length) return;
    let capacity = this.array.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Uint32Array(capacity);
    next.set(this.array);
    this.array = next;
  }

  take(): Uint32Array {
    return this.array.subarray(0, this.length);
  }
}

class I16Writer {
  array = new Int16Array(4096);
  length = 0;

  ensure(extra: number): void {
    const needed = this.length + extra;
    if (needed <= this.array.length) return;
    let capacity = this.array.length * 2;
    while (capacity < needed) capacity *= 2;
    const next = new Int16Array(capacity);
    next.set(this.array);
    this.array = next;
  }

  take(): Int16Array {
    return this.array.subarray(0, this.length);
  }
}

/** Accumulator for one merged chunk (opaque or transparent). */
class ChunkAccumulator {
  positions = new F32Writer();
  normals = new I16Writer();
  colors = new F32Writer();
  elementIndices = new F32Writer();
  indices = new U32Writer();
  vertexCount = 0;

  constructor(readonly transparent: boolean) {}

  get colorSize(): number {
    return this.transparent ? 4 : 3;
  }

  /** Hand off the current buffers and start fresh (post-finalize). */
  reset(): void {
    this.positions = new F32Writer();
    this.normals = new I16Writer();
    this.colors = new F32Writer();
    this.elementIndices = new F32Writer();
    this.indices = new U32Writer();
    this.vertexCount = 0;
  }
}

const _m = new THREE.Matrix4();
const _nm = new THREE.Matrix3();
const _v = new THREE.Vector3();

export class ModelBatcher {
  readonly group = new THREE.Group();

  /**
   * One child group per federated model, so hiding or moving a discipline is
   * a flag and a matrix on a group rather than a rewrite of the state texture
   * or a re-bake of its geometry. Chunks are never shared between models: the
   * accumulators are flushed at the end of every ingest, which is per model.
   */
  private readonly modelGroups = new Map<number, THREE.Group>();
  /** The model the current ingest belongs to; packed into every id it mints. */
  private activeModel = 0;

  private readonly elements = new Map<number, ElementRecord>();
  private readonly elementsByIndex: number[] = [];
  /** Snappable edges per element, scene space, 6 floats per segment. */
  private readonly segmentsByElement = new Map<number, Float32Array>();
  private ingestedMeshes = 0;
  private totalTriangles = 0;

  /** Latches on once the model is big enough to be worth spatial buckets. */
  private useGrid = false;

  private origin: Vec3 | null = null;
  private boundsMin: Vec3 | null = null;
  private boundsMax: Vec3 | null = null;

  // Per-element state texture: R = visible, G = highlighted.
  private stateData: Uint8Array;
  private stateTexture: THREE.DataTexture;
  private stateCapacity: number;
  private readonly stateTexUniform: { value: THREE.Texture };
  private readonly stateSizeUniform: { value: THREE.Vector2 };
  /** Palette for colour-by rules; index 0 is transparent and means untouched. */
  private paletteData = new Uint8Array(PALETTE_SIZE * 4);
  private paletteTexture: THREE.DataTexture;
  private readonly paletteTexUniform: { value: THREE.Texture };
  private readonly overrideOnUniform = { value: 0 };
  /** expressID to palette index, empty when no colour rule is active. */
  private overrideIndex = new Map<number, number>();
  private ghostHidden = false;
  /** Pick-pass reading, and the view-depth range mode 1 packs into 24 bits. */
  private readonly depthModeUniform = { value: 0 };
  private readonly depthRangeUniform = { value: new THREE.Vector2(0, 1) };

  private readonly mergedOpaque: THREE.MeshLambertMaterial;
  private readonly mergedTransparent: THREE.MeshLambertMaterial;
  private readonly instOpaque: THREE.MeshLambertMaterial;
  private readonly instTransparentByAlpha = new Map<string, THREE.MeshLambertMaterial>();
  readonly pickMaterial: THREE.ShaderMaterial;

  // Duplicate detection: geometry occurrences and where the first one went.
  /** Per repeated geometry: how often it has been baked, until it instances. */
  private readonly geometrySeen = new Map<string, InstancedEntry | BakedGeometry>();

  private highlighted = new Set<number>();
  private hiddenSet = new Set<number>();
  /** Whether any element is currently hidden or ghosted, so the shader needs
   *  its discards compiled in at all. */
  private hideActive = false;
  /** The user's front/double setting, and whether a cut is overriding it. */
  private userDoubleSided = true;
  private capped = false;
  private categoryVisible: Record<string, boolean> = {
    IfcSpace: false,
    IfcOpeningElement: false,
  };

  constructor() {
    this.stateCapacity = STATE_TEX_WIDTH * 64;
    this.stateData = new Uint8Array(this.stateCapacity * 4);
    this.stateTexture = this.makeStateTexture(this.stateData, 64);
    this.stateTexUniform = { value: this.stateTexture };
    this.stateSizeUniform = { value: new THREE.Vector2(STATE_TEX_WIDTH, 64) };
    this.paletteTexture = new THREE.DataTexture(this.paletteData, PALETTE_SIZE, 1, THREE.RGBAFormat);
    this.paletteTexture.minFilter = THREE.NearestFilter;
    this.paletteTexture.magFilter = THREE.NearestFilter;
    this.paletteTexture.needsUpdate = true;
    this.paletteTexUniform = { value: this.paletteTexture };

    this.mergedOpaque = this.makeLambert(false, true);
    this.mergedTransparent = this.makeLambert(true, true);
    this.instOpaque = this.makeLambert(false, false);
    this.pickMaterial = this.makePickMaterial();
  }

  /**
   * Front-side-only rendering roughly halves fill cost on heavy scenes;
   * models with inverted normals may show holes, so it is a user setting.
   */
  setDoubleSided(double: boolean): void {
    this.userDoubleSided = double;
    this.applySide();
  }

  /**
   * Cap the cut: fill the back faces a clipping plane exposes with one flat
   * colour, so a sectioned solid reads as cut rather than as hollow. Both
   * faces have to be drawn for there to be anything to fill, so this overrides
   * the front-side setting for as long as a section is on, and hands it back
   * afterwards.
   */
  setCapMode(on: boolean): void {
    if (on === this.capped) return;
    this.capped = on;
    for (const material of this.batchMaterials()) {
      if (on) material.defines = { ...material.defines, IFC_CAP: '' };
      else if (material.defines) delete material.defines.IFC_CAP;
      material.needsUpdate = true;
    }
    this.applySide();
  }

  private applySide(): void {
    const side = this.userDoubleSided || this.capped ? THREE.DoubleSide : THREE.FrontSide;
    for (const material of this.batchMaterials()) {
      if (material.side === side) continue;
      material.side = side;
      material.needsUpdate = true;
    }
    if (this.pickMaterial.side !== side) {
      this.pickMaterial.side = side;
      this.pickMaterial.needsUpdate = true;
    }
  }

  private batchMaterials(): THREE.Material[] {
    return [
      this.mergedOpaque,
      this.mergedTransparent,
      this.instOpaque,
      ...this.instTransparentByAlpha.values(),
    ];
  }

  private makeStateTexture(data: Uint8Array, height: number): THREE.DataTexture {
    const tex = new THREE.DataTexture(data, STATE_TEX_WIDTH, height, THREE.RGBAFormat);
    tex.minFilter = THREE.NearestFilter;
    tex.magFilter = THREE.NearestFilter;
    tex.needsUpdate = true;
    return tex;
  }

  /** Lambert with the element-state patch (discard hidden, add highlight). */
  private makeLambert(transparent: boolean, vertexColors: boolean): THREE.MeshLambertMaterial {
    const material = new THREE.MeshLambertMaterial({
      side: THREE.DoubleSide,
      vertexColors,
      transparent,
    });
    const stateTexUniform = this.stateTexUniform;
    const stateSizeUniform = this.stateSizeUniform;
    const paletteTexUniform = this.paletteTexUniform;
    const overrideOnUniform = this.overrideOnUniform;
    material.onBeforeCompile = (shader) => {
      shader.uniforms.uStateTex = stateTexUniform;
      shader.uniforms.uStateSize = stateSizeUniform;
      shader.uniforms.uPaletteTex = paletteTexUniform;
      shader.uniforms.uOverrideOn = overrideOnUniform;
      shader.vertexShader = shader.vertexShader
        .replace(
          'void main() {',
          'attribute float aElementIndex;\nvarying float vElementIndex;\nvoid main() {\n\tvElementIndex = aElementIndex;',
        );
      // The discards are behind IFC_HIDE on purpose. A fragment shader that
      // can discard loses early-Z on every draw, and a freshly loaded model
      // hides nothing, so the define is absent until something actually is
      // hidden or ghosted and the depth test does its job for free until then.
      shader.fragmentShader = shader.fragmentShader
        .replace(
          'void main() {',
          'uniform sampler2D uStateTex;\nuniform vec2 uStateSize;\nuniform sampler2D uPaletteTex;\nuniform float uOverrideOn;\nvarying float vElementIndex;\nvoid main() {\n' +
            '\tvec2 stUv = (vec2(mod(vElementIndex, uStateSize.x), floor(vElementIndex / uStateSize.x)) + 0.5) / uStateSize;\n' +
            '\tvec4 ifcState = texture2D(uStateTex, stUv);\n' +
            '\t#ifdef IFC_HIDE\n' +
            '\tif (ifcState.r < 0.25) discard;\n' +
            '\tfloat ifcGhost = step(ifcState.r, 0.75);\n' +
            '\tif (ifcGhost > 0.5 && mod(floor(gl_FragCoord.x) * 3.0 + floor(gl_FragCoord.y) * 5.0, 16.0) >= ' +
            `${GHOST_KEPT.toFixed(1)}) discard;\n` +
            '\t#else\n' +
            '\tfloat ifcGhost = 0.0;\n' +
            '\t#endif',
        )
        // The cap: a clipped solid shows its inside, so the back faces left
        // facing the camera are flooded with one flat colour and read as the
        // cut surface. It costs a define and no extra pass.
        .replace(
          '#include <color_fragment>',
          '#include <color_fragment>\n' +
            '\tif (uOverrideOn > 0.5 && ifcState.b > 0.0) {\n' +
            '\t\tdiffuseColor.rgb = texture2D(uPaletteTex, vec2((ifcState.b * 255.0 + 0.5) / 256.0, 0.5)).rgb;\n' +
            '\t}\n' +
            '\t#ifdef IFC_CAP\n' +
            `\tif (!gl_FrontFacing) diffuseColor.rgb = ${CAP_GLSL};\n` +
            '\t#endif\n' +
            '\tif (ifcGhost > 0.5) diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.62), 0.72);',
        )
        .replace(
          '#include <emissivemap_fragment>',
          `#include <emissivemap_fragment>\n\ttotalEmissiveRadiance += ifcState.g * (1.0 - ifcGhost) * ${HIGHLIGHT_GLSL};`,
        );
    };
    material.customProgramCacheKey = () => `ifc-batch-${transparent}-${vertexColors}`;
    return material;
  }

  /**
   * One pass, two readings. Mode 0 writes the element index, which is what a
   * click needs. Mode 1 writes view depth packed across 24 bits of a range the
   * caller keeps tight around the model, which is what the measure tool needs:
   * the point then lands on the surface instead of on its bounding box.
   * Clipping is included so neither reading sees through a section plane.
   */
  private makePickMaterial(): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      side: THREE.DoubleSide,
      clipping: true,
      uniforms: {
        uStateTex: this.stateTexUniform,
        uStateSize: this.stateSizeUniform,
        uDepthMode: this.depthModeUniform,
        uDepthRange: this.depthRangeUniform,
      },
      vertexShader: `
        attribute float aElementIndex;
        varying float vElementIndex;
        varying float vViewDepth;
        #include <common>
        #include <clipping_planes_pars_vertex>
        void main() {
          vElementIndex = aElementIndex;
          #include <begin_vertex>
          #include <project_vertex>
          vViewDepth = -mvPosition.z;
          #include <clipping_planes_vertex>
        }
      `,
      fragmentShader: `
        uniform sampler2D uStateTex;
        uniform vec2 uStateSize;
        uniform float uDepthMode;
        uniform vec2 uDepthRange;
        varying float vElementIndex;
        varying float vViewDepth;
        #include <clipping_planes_pars_fragment>
        void main() {
          #include <clipping_planes_fragment>
          vec2 stUv = (vec2(mod(vElementIndex, uStateSize.x), floor(vElementIndex / uStateSize.x)) + 0.5) / uStateSize;
          if (texture2D(uStateTex, stUv).r < 0.75) discard;
          if (uDepthMode > 0.5) {
            float t = clamp((vViewDepth - uDepthRange.x) / uDepthRange.y, 0.0, 1.0);
            vec3 enc = fract(vec3(1.0, 255.0, 65025.0) * t);
            enc -= enc.yzz * vec3(1.0 / 255.0, 1.0 / 255.0, 0.0);
            gl_FragColor = vec4(enc, 1.0);
            return;
          }
          float id = vElementIndex + 1.0;
          gl_FragColor = vec4(
            floor(id / 65536.0) / 255.0,
            floor(mod(id, 65536.0) / 256.0) / 255.0,
            mod(id, 256.0) / 255.0,
            1.0
          );
        }
      `,
    });
  }

  /** Switch the pick pass between the id and the packed-depth reading. */
  setDepthPick(on: boolean, near = 0, span = 1): void {
    this.depthModeUniform.value = on ? 1 : 0;
    this.depthRangeUniform.value.set(near, Math.max(span, 1e-6));
  }

  // -- ingest --------------------------------------------------------------

  /**
   * Add a batch of meshes to a model. Every id this mints is packed with
   * `modelIndex`, and model 0 packs to itself, so a single open model behaves
   * exactly as it did before federation existed.
   */
  ingest(meshes: IfcMesh[], modelIndex = 0): void {
    if (meshes.length === 0) return;
    this.activeModel = modelIndex;
    // One origin for every model, decided by whichever arrives first. Per-model
    // origins would centre each discipline on its own extent and land them
    // kilometres apart.
    this.ensureOrigin(meshes);

    // Pass 1: element records and bounds. Bounds must be complete before
    // baking so the spatial grid covers the whole batch.
    let mergeVertexEstimate = 0;
    for (const mesh of meshes) {
      const record = this.recordFor(mesh);
      this.ingestedMeshes++;
      this.totalTriangles += mesh.geometry.indices.length / 3;
      record.triangles += mesh.geometry.indices.length / 3;
      this.expandElementBounds(record, mesh);
      this.recordSegments(mesh);
      mergeVertexEstimate += mesh.geometry.positions.length / 3;
    }

    // Pass 2: route each mesh to merged chunks (bucketed spatially when the
    // model is large, so frustum culling can reject far chunks) or instances.
    // The grid latches on: a load arrives in many batches, and switching the
    // bucketing halfway would scatter one cell across two sets of chunks.
    if (mergeVertexEstimate >= SPATIAL_SPLIT_VERTEX_THRESHOLD) this.useGrid = true;
    const accumulators = new Map<string, ChunkAccumulator>();
    const chunkFor = (transparent: boolean, mesh: IfcMesh): ChunkAccumulator => {
      const bucket = this.useGrid ? this.bucketOf(mesh) : 0;
      const key = `${transparent ? 't' : 'o'}:${bucket}`;
      let acc = accumulators.get(key);
      if (!acc) {
        acc = new ChunkAccumulator(transparent);
        accumulators.set(key, acc);
      }
      return acc;
    };
    const chunks: THREE.Mesh[] = [];

    for (const mesh of meshes) {
      const record = this.elements.get(this.idOf(mesh))!;
      const alpha = mesh.color.a;
      const isTransparent = alpha < 0.999;
      // The model has to be in the geometry key too: two files each have a
      // geometryID 5, and without it a wall would be instanced as a duct.
      const key = `${modelIndex}:${mesh.geometryID}:${isTransparent ? alpha.toFixed(3) : 'o'}`;
      const seen = this.geometrySeen.get(key);

      const bake = (): void => {
        const acc = chunkFor(isTransparent, mesh);
        this.bake(mesh, record.index, acc);
        if (acc.vertexCount >= CHUNK_VERTEX_LIMIT) {
          chunks.push(...this.finalizeChunk(acc));
        }
      };

      if (seen === undefined) {
        // First occurrence: bake into the merged chunk.
        this.geometrySeen.set(key, { copies: 1, vertices: mesh.geometry.positions.length / 3 });
        bake();
      } else if (!('geometryID' in seen)) {
        // An InstancedMesh is its own object: three transforms and culls it,
        // inserts and sorts it, then binds and draws it, every frame. For a
        // bracket that appears three times, a few thousand baked vertices in a
        // chunk that is already being drawn is much cheaper than that object.
        if (seen.vertices <= INSTANCE_MIN_VERTICES && seen.copies < INSTANCE_MIN_COPIES) {
          seen.copies += 1;
          bake();
        } else {
          const entry = this.createInstancedEntry(mesh, isTransparent ? alpha : null, key);
          this.geometrySeen.set(key, entry);
          this.addInstance(entry, mesh, record.index);
        }
      } else {
        this.addInstance(seen, mesh, record.index);
      }
    }

    for (const acc of accumulators.values()) {
      chunks.push(...this.finalizeChunk(acc));
    }
    const host = this.groupFor(modelIndex);
    for (const chunk of chunks) host.add(chunk);
  }

  /** This model's group, created on first sight. */
  private groupFor(modelIndex: number): THREE.Group {
    let group = this.modelGroups.get(modelIndex);
    if (!group) {
      group = new THREE.Group();
      // Nothing moves a model group except setModelTransform, so three does
      // not need to recompose its matrix on every frame.
      group.matrixAutoUpdate = false;
      this.modelGroups.set(modelIndex, group);
      this.group.add(group);
    }
    return group;
  }

  /** The packed id of a mesh in the ingest currently running. */
  private idOf(mesh: IfcMesh): number {
    return packId(this.activeModel, mesh.expressID);
  }

  /** Draw a model or leave it out entirely; the cheapest possible hide. */
  setModelVisible(modelIndex: number, visible: boolean): void {
    const group = this.modelGroups.get(modelIndex);
    if (group) group.visible = visible;
  }

  isModelVisible(modelIndex: number): boolean {
    return this.modelGroups.get(modelIndex)?.visible ?? true;
  }

  /** Nudge one discipline, for files that disagree about the shared origin. */
  setModelTransform(modelIndex: number, offset: [number, number, number]): void {
    const group = this.groupFor(modelIndex);
    group.position.set(offset[0], offset[1], offset[2]);
    group.updateMatrix();
  }

  getModelTransform(modelIndex: number): [number, number, number] {
    const group = this.modelGroups.get(modelIndex);
    return group ? [group.position.x, group.position.y, group.position.z] : [0, 0, 0];
  }

  /**
   * Drop one model's geometry and every id it minted. The state texture keeps
   * its slots: they are dense ordinals baked into vertex attributes of the
   * models that remain, so compacting them would mean re-baking everything.
   * The freed slots are simply never read again.
   */
  removeModel(modelIndex: number): void {
    const group = this.modelGroups.get(modelIndex);
    if (group) {
      disposeTree(group);
      this.group.remove(group);
      this.modelGroups.delete(modelIndex);
    }
    for (const id of [...this.elements.keys()]) {
      if (modelOf(id) !== modelIndex) continue;
      this.elements.delete(id);
      this.segmentsByElement.delete(id);
      this.hiddenSet.delete(id);
      this.highlighted.delete(id);
      this.overrideIndex.delete(id);
    }
    // The instanced meshes themselves went with the group; this drops the
    // dedup records that would otherwise keep matching a model that is gone.
    for (const key of [...this.geometrySeen.keys()]) {
      if (key.startsWith(`${modelIndex}:`)) this.geometrySeen.delete(key);
    }
    for (let i = 0; i < this.elementsByIndex.length; i++) {
      if (modelOf(this.elementsByIndex[i]) === modelIndex) this.elementsByIndex[i] = -1;
    }
    this.rewriteAllStates();
  }

  /** Coarse spatial cell (0..7) of a mesh's AABB center, in shifted space. */
  private bucketOf(mesh: IfcMesh): number {
    const record = this.elements.get(this.idOf(mesh));
    const min = this.boundsMin;
    const max = this.boundsMax;
    if (!record || !min || !max || record.min[0] === Infinity) return 0;
    const cx = (record.min[0] + record.max[0]) / 2;
    const cy = (record.min[1] + record.max[1]) / 2;
    const cz = (record.min[2] + record.max[2]) / 2;
    const cell = (value: number, lo: number, hi: number): number => {
      if (hi - lo < 1e-6) return 0;
      const t = Math.floor(((value - lo) / (hi - lo)) * GRID_DIVISIONS);
      return Math.min(GRID_DIVISIONS - 1, Math.max(0, t));
    };
    return (
      cell(cx, min.x, max.x) +
      cell(cy, min.y, max.y) * GRID_DIVISIONS +
      cell(cz, min.z, max.z) * GRID_DIVISIONS * GRID_DIVISIONS
    );
  }

  /** Decide the origin shift from the first geometry that arrives. */
  private ensureOrigin(meshes: IfcMesh[]): void {
    if (this.origin) return;
    let min: Vec3 | null = null;
    let max: Vec3 | null = null;
    for (const mesh of meshes) {
      const [lo, hi] = transformedAabb(mesh);
      if (!min || !max) {
        min = lo;
        max = hi;
      } else {
        min = { x: Math.min(min.x, lo.x), y: Math.min(min.y, lo.y), z: Math.min(min.z, lo.z) };
        max = { x: Math.max(max.x, hi.x), y: Math.max(max.y, hi.y), z: Math.max(max.z, hi.z) };
      }
    }
    if (!min || !max) {
      this.origin = { x: 0, y: 0, z: 0 };
      return;
    }
    const maxAbs = Math.max(
      Math.abs(min.x), Math.abs(min.y), Math.abs(min.z),
      Math.abs(max.x), Math.abs(max.y), Math.abs(max.z),
    );
    this.origin =
      maxAbs <= ORIGIN_THRESHOLD
        ? { x: 0, y: 0, z: 0 }
        : { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 };
  }

  private recordFor(mesh: IfcMesh): ElementRecord {
    const id = this.idOf(mesh);
    let record = this.elements.get(id);
    if (!record) {
      const index = this.elementsByIndex.length;
      this.ensureStateCapacity(index + 1);
      record = {
        index,
        ifcType: mesh.ifcType,
        triangles: 0,
        min: [Infinity, Infinity, Infinity],
        max: [-Infinity, -Infinity, -Infinity],
        hidden: false,
      };
      this.elements.set(id, record);
      this.elementsByIndex.push(id);
      this.writeState(record);
    }
    return record;
  }

  private expandElementBounds(record: ElementRecord, mesh: IfcMesh): void {
    const [lo, hi] = transformedAabb(mesh);
    const o = this.origin!;
    const min: [number, number, number] = [lo.x - o.x, lo.y - o.y, lo.z - o.z];
    const max: [number, number, number] = [hi.x - o.x, hi.y - o.y, hi.z - o.z];
    for (let i = 0; i < 3; i++) {
      if (min[i] < record.min[i]) record.min[i] = min[i];
      if (max[i] > record.max[i]) record.max[i] = max[i];
    }
    if (!this.boundsMin || !this.boundsMax) {
      this.boundsMin = { x: min[0], y: min[1], z: min[2] };
      this.boundsMax = { x: max[0], y: max[1], z: max[2] };
    } else {
      this.boundsMin.x = Math.min(this.boundsMin.x, min[0]);
      this.boundsMin.y = Math.min(this.boundsMin.y, min[1]);
      this.boundsMin.z = Math.min(this.boundsMin.z, min[2]);
      this.boundsMax.x = Math.max(this.boundsMax.x, max[0]);
      this.boundsMax.y = Math.max(this.boundsMax.y, max[1]);
      this.boundsMax.z = Math.max(this.boundsMax.z, max[2]);
    }
  }

  /** Bake one mesh (matrix applied, origin subtracted, f64 math) into a chunk. */
  private bake(mesh: IfcMesh, elementIndex: number, chunk: ChunkAccumulator): void {
    const g = mesh.geometry;
    const m = mesh.matrix;
    const o = this.origin!;
    const base = chunk.vertexCount;
    const color = this.displayColor(mesh);

    _m.fromArray(m);
    _nm.getNormalMatrix(_m);
    const n = _nm.elements;

    const vertexCount = g.positions.length / 3;
    chunk.positions.ensure(vertexCount * 3);
    chunk.normals.ensure(vertexCount * 3);
    chunk.colors.ensure(vertexCount * chunk.colorSize);
    chunk.elementIndices.ensure(vertexCount);
    chunk.indices.ensure(g.indices.length);

    const positions = chunk.positions.array;
    const normals = chunk.normals.array;
    const colors = chunk.colors.array;
    const elementIndices = chunk.elementIndices.array;
    let po = chunk.positions.length;
    let co = chunk.colors.length;
    let eo = chunk.elementIndices.length;

    for (let v = 0; v < vertexCount; v++) {
      const x = g.positions[v * 3];
      const y = g.positions[v * 3 + 1];
      const z = g.positions[v * 3 + 2];
      positions[po] = m[0] * x + m[4] * y + m[8] * z + m[12] - o.x;
      positions[po + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - o.y;
      positions[po + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - o.z;
      const nx = g.normals[v * 3];
      const ny = g.normals[v * 3 + 1];
      const nz = g.normals[v * 3 + 2];
      const wx = n[0] * nx + n[3] * ny + n[6] * nz;
      const wy = n[1] * nx + n[4] * ny + n[7] * nz;
      const wz = n[2] * nx + n[5] * ny + n[8] * nz;
      const len = Math.sqrt(wx * wx + wy * wy + wz * wz) || 1;
      normals[po] = packNormalComponent(wx / len);
      normals[po + 1] = packNormalComponent(wy / len);
      normals[po + 2] = packNormalComponent(wz / len);
      po += 3;
      colors[co] = color.r;
      colors[co + 1] = color.g;
      colors[co + 2] = color.b;
      if (chunk.transparent) {
        colors[co + 3] = mesh.color.a;
        co += 4;
      } else {
        co += 3;
      }
      elementIndices[eo++] = elementIndex;
    }
    chunk.positions.length = po;
    chunk.normals.length = po;
    chunk.colors.length = co;
    chunk.elementIndices.length = eo;

    const indices = chunk.indices.array;
    let io = chunk.indices.length;
    for (let i = 0; i < g.indices.length; i++) {
      indices[io++] = base + g.indices[i];
    }
    chunk.indices.length = io;
    chunk.vertexCount += vertexCount;
  }

  private displayColor(mesh: IfcMesh): THREE.Color {
    return isDefaultWhite(mesh.color)
      ? colorForId(this.idOf(mesh))
      : new THREE.Color(mesh.color.r, mesh.color.g, mesh.color.b);
  }

  private finalizeChunk(chunk: ChunkAccumulator): THREE.Mesh[] {
    if (chunk.vertexCount === 0) return [];
    // Merged chunks are write-once: free the CPU copy of each buffer after
    // GPU upload. This roughly halves JS heap on geometry-heavy models. The
    // tradeoff is no re-upload after a GPU context loss, which the viewer
    // does not currently recover from anyway.
    const uploaded = (array: Float32Array | Uint32Array | Int16Array, itemSize: number, normalized = false) =>
      new THREE.BufferAttribute(array, itemSize, normalized).onUpload(freeAttributeArray);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', uploaded(chunk.positions.take(), 3));
    geometry.setAttribute('normal', uploaded(chunk.normals.take(), 3, true));
    geometry.setAttribute('color', uploaded(chunk.colors.take(), chunk.colorSize));
    geometry.setAttribute('aElementIndex', uploaded(chunk.elementIndices.take(), 1));
    geometry.setIndex(uploaded(chunk.indices.take(), 1));
    // Computed eagerly for two reasons: the renderer's sort pass would
    // otherwise compute it lazily after onUpload freed the array, and the
    // sphere is what makes per-chunk frustum culling work.
    geometry.computeBoundingSphere();

    const mesh = new THREE.Mesh(
      geometry,
      chunk.transparent ? this.mergedTransparent : this.mergedOpaque,
    );
    mesh.frustumCulled = true;
    mesh.matrixAutoUpdate = false;

    chunk.reset();
    return [mesh];
  }

  private createInstancedEntry(
    mesh: IfcMesh,
    alpha: number | null,
    key: string,
  ): InstancedEntry {
    const g = mesh.geometry;
    const { min, max } = mesh.localBounds;
    // Furthest local corner from the origin: covers any instance rotation.
    let geometryRadius = 0;
    for (let c = 0; c < 8; c++) {
      const x = c & 1 ? max.x : min.x;
      const y = c & 2 ? max.y : min.y;
      const z = c & 4 ? max.z : min.z;
      geometryRadius = Math.max(geometryRadius, Math.hypot(x, y, z));
    }
    const entry: InstancedEntry = {
      geometryID: mesh.geometryID,
      model: this.activeModel,
      alphaKey: key,
      // Copied, not wrapped: the arrays handed in are views into the batch
      // buffer the worker transferred, and one small entry holding a view
      // pins that whole multi-megabyte buffer for the life of the model.
      position: new THREE.BufferAttribute(new Float32Array(g.positions), 3),
      normal: new THREE.BufferAttribute(packNormalBuffer(g.normals), 3, true),
      index: new THREE.BufferAttribute(new Uint32Array(g.indices), 1),
      mesh: null,
      elementIndexAttr: null,
      capacity: 0,
      used: 0,
      trianglesPerInstance: g.indices.length / 3,
      geometryRadius,
      tMin: [Infinity, Infinity, Infinity],
      tMax: [-Infinity, -Infinity, -Infinity],
      maxScale: 1,
    };
    this.growInstanced(entry, INITIAL_INSTANCE_CAPACITY, alpha);
    return entry;
  }

  private instancedMaterial(alpha: number | null): THREE.MeshLambertMaterial {
    if (alpha === null) return this.instOpaque;
    const key = alpha.toFixed(3);
    let material = this.instTransparentByAlpha.get(key);
    if (!material) {
      material = this.makeLambert(true, false);
      material.opacity = alpha;
      material.customProgramCacheKey = () => 'ifc-batch-true-false';
      this.instTransparentByAlpha.set(key, material);
    }
    return material;
  }

  private growInstanced(entry: InstancedEntry, capacity: number, alpha: number | null): void {
    const material =
      entry.mesh?.material as THREE.MeshLambertMaterial | undefined ??
      this.instancedMaterial(alpha);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', entry.position);
    geometry.setAttribute('normal', entry.normal);
    geometry.setIndex(entry.index);
    const elementIndexAttr = new THREE.InstancedBufferAttribute(new Float32Array(capacity), 1);
    geometry.setAttribute('aElementIndex', elementIndexAttr);
    // No computeBoundingSphere here: culling uses the object sphere that
    // addInstance maintains, and this one was two full passes over every
    // vertex on each capacity doubling for a value nothing ever read.

    const next = new THREE.InstancedMesh(geometry, material, capacity);
    // Culled against the incremental bounding sphere kept by addInstance.
    next.frustumCulled = true;
    // Every placement lives in instanceMatrix; the mesh itself never moves,
    // so recomposing its identity matrix every frame is pure overhead.
    next.matrixAutoUpdate = false;
    next.count = entry.used;

    const prev = entry.mesh;
    if (prev) {
      next.instanceMatrix.array.set(prev.instanceMatrix.array.subarray(0, entry.used * 16));
      elementIndexAttr.array.set(
        (entry.elementIndexAttr!.array as Float32Array).subarray(0, entry.used),
      );
      if (prev.instanceColor) {
        next.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(capacity * 3), 3);
        next.instanceColor.array.set(prev.instanceColor.array.subarray(0, entry.used * 3));
      }
      prev.removeFromParent();
      prev.geometry.dispose();
      prev.dispose();
    }

    entry.mesh = next;
    entry.elementIndexAttr = elementIndexAttr;
    entry.capacity = capacity;
    // An instanced entry belongs to one model: its key is model-namespaced,
    // so it goes in that model's group and moves and hides with it.
    this.groupFor(entry.model).add(next);
  }

  private addInstance(entry: InstancedEntry, mesh: IfcMesh, elementIndex: number): void {
    if (entry.used >= entry.capacity) {
      this.growInstanced(entry, entry.capacity * 2, null);
    }
    const target = entry.mesh!;
    const i = entry.used++;
    target.count = entry.used;

    const o = this.origin!;
    _m.fromArray(mesh.matrix);
    _m.elements[12] -= o.x;
    _m.elements[13] -= o.y;
    _m.elements[14] -= o.z;
    target.setMatrixAt(i, _m);
    target.instanceMatrix.needsUpdate = true;

    target.setColorAt(i, this.displayColor(mesh));
    if (target.instanceColor) target.instanceColor.needsUpdate = true;

    (entry.elementIndexAttr!.array as Float32Array)[i] = elementIndex;
    entry.elementIndexAttr!.needsUpdate = true;

    this.expandInstancedSphere(entry, _m.elements);
  }

  /**
   * Track the AABB of instance translations and keep the InstancedMesh
   * bounding sphere current, so the renderer can frustum-cull the whole
   * entry when its instances cluster away from the view.
   */
  private expandInstancedSphere(entry: InstancedEntry, m: number[] | Float32Array): void {
    // Column norms bound the instance scale; IFC placements are usually rigid.
    entry.maxScale = Math.max(
      entry.maxScale,
      Math.hypot(m[0], m[1], m[2]),
      Math.hypot(m[4], m[5], m[6]),
      Math.hypot(m[8], m[9], m[10]),
    );
    const tx = m[12];
    const ty = m[13];
    const tz = m[14];
    if (tx < entry.tMin[0]) entry.tMin[0] = tx;
    if (ty < entry.tMin[1]) entry.tMin[1] = ty;
    if (tz < entry.tMin[2]) entry.tMin[2] = tz;
    if (tx > entry.tMax[0]) entry.tMax[0] = tx;
    if (ty > entry.tMax[1]) entry.tMax[1] = ty;
    if (tz > entry.tMax[2]) entry.tMax[2] = tz;

    const target = entry.mesh!;
    if (!target.boundingSphere) target.boundingSphere = new THREE.Sphere();
    const sphere = target.boundingSphere;
    sphere.center.set(
      (entry.tMin[0] + entry.tMax[0]) / 2,
      (entry.tMin[1] + entry.tMax[1]) / 2,
      (entry.tMin[2] + entry.tMax[2]) / 2,
    );
    const half = Math.hypot(
      (entry.tMax[0] - entry.tMin[0]) / 2,
      (entry.tMax[1] - entry.tMin[1]) / 2,
      (entry.tMax[2] - entry.tMin[2]) / 2,
    );
    sphere.radius = half + entry.geometryRadius * entry.maxScale;
  }

  // -- element state -------------------------------------------------------

  private ensureStateCapacity(count: number): void {
    if (count <= this.stateCapacity) return;
    let height = this.stateCapacity / STATE_TEX_WIDTH;
    while (height * STATE_TEX_WIDTH < count) height *= 2;
    const data = new Uint8Array(STATE_TEX_WIDTH * height * 4);
    data.set(this.stateData);
    this.stateTexture.dispose();
    this.stateData = data;
    this.stateCapacity = STATE_TEX_WIDTH * height;
    this.stateTexture = this.makeStateTexture(data, height);
    this.stateTexUniform.value = this.stateTexture;
    this.stateSizeUniform.value.set(STATE_TEX_WIDTH, height);
  }

  private isVisible(record: ElementRecord, expressID: number): boolean {
    const categoryOK =
      record.ifcType in this.categoryVisible ? this.categoryVisible[record.ifcType] : true;
    return categoryOK && !this.hiddenSet.has(expressID);
  }

  /**
   * A category the user switched off stays fully hidden even in ghost mode:
   * ghosting is about keeping context while isolating, and nobody isolates in
   * order to see every space and opening faintly behind it.
   */
  private stateFor(record: ElementRecord, expressID: number): number {
    if (this.isVisible(record, expressID)) return STATE_VISIBLE;
    const categoryOff =
      record.ifcType in this.categoryVisible && !this.categoryVisible[record.ifcType];
    return this.ghostHidden && !categoryOff ? STATE_GHOST : STATE_HIDDEN;
  }

  /**
   * Recompile the batch materials with or without their discards. Materials are
   * shared singletons, so this is a handful of program rebuilds, and three
   * folds `defines` into its own program cache key.
   */
  private syncHideDefine(): void {
    // Read the state bytes rather than the hidden set: the lazy categories are
    // switched off by default but contribute no elements until they are loaded,
    // so a set-based test would claim a fresh model hides something.
    let needed = false;
    for (let i = 0; i < this.elementsByIndex.length; i++) {
      if (this.stateData[i * 4] !== STATE_VISIBLE) {
        needed = true;
        break;
      }
    }
    if (needed === this.hideActive) return;
    this.hideActive = needed;
    const materials: THREE.Material[] = [
      this.mergedOpaque,
      this.mergedTransparent,
      this.instOpaque,
      ...this.instTransparentByAlpha.values(),
    ];
    for (const material of materials) {
      if (needed) material.defines = { ...material.defines, IFC_HIDE: "" };
      else if (material.defines) delete material.defines.IFC_HIDE;
      material.needsUpdate = true;
    }
  }

  private writeState(record: ElementRecord): void {
    const expressID = this.elementsByIndex[record.index];
    const base = record.index * 4;
    this.stateData[base] = this.stateFor(record, expressID);
    this.stateData[base + 1] = this.highlighted.has(expressID) ? 255 : 0;
    this.stateData[base + 2] = this.overrideIndex.get(expressID) ?? 0;
    this.stateData[base + 3] = 255;
    this.stateTexture.needsUpdate = true;
  }

  /** Hidden elements stay on screen as a faint screen-space hatch. */
  setGhostHidden(on: boolean): void {
    if (this.ghostHidden === on) return;
    this.ghostHidden = on;
    this.rewriteAllStates();
  }

  isGhostHidden(): boolean {
    return this.ghostHidden;
  }

  /**
   * Colour elements by rule. `assignment` maps an expressID to a 1-based index
   * into `colors`; anything absent keeps its own colour. One byte per element
   * and one palette texture, so a rule costs no per-element GPU state.
   */
  setColorOverride(assignment: Map<number, number>, colors: Array<[number, number, number]>): void {
    this.paletteData.fill(0);
    for (let i = 0; i < colors.length && i < PALETTE_SIZE - 1; i++) {
      const base = (i + 1) * 4;
      this.paletteData[base] = colors[i][0];
      this.paletteData[base + 1] = colors[i][1];
      this.paletteData[base + 2] = colors[i][2];
      this.paletteData[base + 3] = 255;
    }
    this.paletteTexture.needsUpdate = true;
    this.overrideIndex = assignment;
    this.overrideOnUniform.value = assignment.size ? 1 : 0;
    this.rewriteAllStates();
  }

  clearColorOverride(): void {
    if (this.overrideOnUniform.value === 0) return;
    this.overrideIndex = new Map();
    this.overrideOnUniform.value = 0;
    this.rewriteAllStates();
  }

  hasColorOverride(): boolean {
    return this.overrideOnUniform.value > 0;
  }

  setHidden(expressIDs: Iterable<number>, hidden: boolean): void {
    for (const id of expressIDs) {
      if (hidden) this.hiddenSet.add(id);
      else this.hiddenSet.delete(id);
      const record = this.elements.get(id);
      if (record) this.writeState(record);
    }
    this.syncHideDefine();
  }

  isolate(expressIDs: Iterable<number>): void {
    const keep = new Set(expressIDs);
    this.hiddenSet = new Set([...this.elements.keys()].filter((id) => !keep.has(id)));
    this.rewriteAllStates();
  }

  showAll(): void {
    this.hiddenSet.clear();
    this.rewriteAllStates();
  }

  setCategoryVisible(type: string, visible: boolean): void {
    this.categoryVisible[type] = visible;
    for (const record of this.elements.values()) {
      if (record.ifcType === type) this.writeState(record);
    }
    this.syncHideDefine();
  }

  getCategoryVisible(type: string): boolean {
    return this.categoryVisible[type] ?? true;
  }

  private rewriteAllStates(): void {
    for (const record of this.elements.values()) this.writeState(record);
    this.syncHideDefine();
  }

  /**
   * Hide instanced entries too small to see. Only instanced entries: merged
   * chunks are never small on screen (they are spatial buckets of the whole
   * model), so testing them culls nothing, and per-element suppression would
   * save no draw call at all while breaking picking.
   *
   * Called from the render path, so it does no allocation and no upload. An
   * entry hidden here costs three nothing: no matrix, no frustum test, no sort,
   * no bind, no draw.
   */
  applyLod(camera: THREE.Camera, viewportHeight: number, thresholdPx: number): number {
    let culled = 0;
    const perspective = (camera as THREE.PerspectiveCamera).isPerspectiveCamera
      ? (camera as THREE.PerspectiveCamera)
      : null;
    // Pixels per metre at one metre, for a perspective camera.
    const scale = perspective
      ? viewportHeight / (2 * Math.tan((perspective.fov * Math.PI) / 360))
      : 0;
    const ortho = (camera as THREE.OrthographicCamera).isOrthographicCamera
      ? (camera as THREE.OrthographicCamera)
      : null;
    const orthoScale = ortho ? viewportHeight / Math.max(1e-6, (ortho.top - ortho.bottom) / ortho.zoom) : 0;

    for (const entry of this.geometrySeen.values()) {
      if (!('mesh' in entry)) continue;
      const mesh = entry.mesh;
      if (!mesh || entry.used === 0) continue;
      const sphere = mesh.boundingSphere;
      if (!sphere) continue;
      // The entry's sphere spans every copy across the whole building, so it is
      // model-sized and says nothing about how big one copy looks. What matters
      // is a single instance, at the distance of the nearest one. The sphere is
      // built as half + geometryRadius * maxScale (expandInstancedSphere), so
      // the spread of the copies is recoverable and gives that near distance.
      const instanceRadius = entry.geometryRadius * entry.maxScale;
      const spread = Math.max(0, sphere.radius - instanceRadius);
      let pixels: number;
      if (perspective) {
        const nearest = camera.position.distanceTo(sphere.center) - spread;
        // Inside the cluster: never cull, the frustum test owns that case.
        pixels = nearest <= instanceRadius ? Infinity : (instanceRadius * 2 * scale) / nearest;
      } else if (ortho) {
        pixels = instanceRadius * 2 * orthoScale;
      } else {
        pixels = Infinity;
      }
      const show = pixels >= thresholdPx;
      if (mesh.visible !== show) mesh.visible = show;
      if (!show) culled += 1;
    }
    return culled;
  }

  /** Put every instanced entry back on screen, for the pick and plan passes. */
  clearLod(): void {
    for (const entry of this.geometrySeen.values()) {
      if ('mesh' in entry && entry.mesh && !entry.mesh.visible) entry.mesh.visible = true;
    }
  }

  isElementVisible(expressID: number): boolean {
    const record = this.elements.get(expressID);
    return record ? this.isVisible(record, expressID) : false;
  }

  /** expressID to IFC class for every element that produced geometry. */
  getElementTypes(): Map<number, string> {
    const types = new Map<number, string>();
    for (const [id, record] of this.elements) types.set(id, record.ifcType);
    return types;
  }

  /** Only hide/isolate counts here; category visibility is asked separately. */
  getVisibilityCounts(): { total: number; hidden: number } {
    let hidden = 0;
    for (const id of this.elements.keys()) if (this.hiddenSet.has(id)) hidden++;
    return { total: this.elements.size, hidden };
  }

  /** Replace the highlighted set; only the elements that changed repaint. */
  setHighlighted(expressIDs: Iterable<number>): void {
    const next = new Set(expressIDs);
    const touched = new Set([...this.highlighted, ...next]);
    this.highlighted = next;
    for (const id of touched) {
      const record = this.elements.get(id);
      if (record) this.writeState(record);
    }
  }

  // -- queries -------------------------------------------------------------

  hasElement(expressID: number): boolean {
    return this.elements.has(expressID);
  }

  elementBounds(expressID: number): ModelBounds | null {
    const record = this.elements.get(expressID);
    if (!record || record.min[0] === Infinity) return null;
    return {
      min: { x: record.min[0], y: record.min[1], z: record.min[2] },
      max: { x: record.max[0], y: record.max[1], z: record.max[2] },
    };
  }

  expressIDForIndex(index: number): number | null {
    // Slots freed by removeModel hold -1: the ordinal is still baked into
    // vertex attributes elsewhere, so it is tombstoned rather than reused.
    const id = this.elementsByIndex[index] ?? -1;
    return id < 0 ? null : id;
  }

  get meshCount(): number {
    return this.ingestedMeshes;
  }

  get triangleCount(): number {
    return this.totalTriangles;
  }

  visibleTriangleCount(): number {
    let sum = 0;
    for (const [id, record] of this.elements) {
      if (this.isVisible(record, id)) sum += record.triangles;
    }
    return sum;
  }

  getBounds(): ModelBounds {
    return this.boundsMin && this.boundsMax
      ? { min: { ...this.boundsMin }, max: { ...this.boundsMax } }
      : { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } };
  }

  getOrigin(): Vec3 {
    return this.origin ?? { x: 0, y: 0, z: 0 };
  }

  /**
   * The edges the measure tool snaps to for one element, or undefined when it
   * is hidden or contributed none. Six floats per segment, scene space.
   */
  segmentsOf(expressID: number): Float32Array | undefined {
    const record = this.elements.get(expressID);
    if (!record || !this.isVisible(record, expressID)) return undefined;
    return this.segmentsByElement.get(expressID);
  }

  /**
   * Keep this mesh's feature edges, placed and origin-shifted, as what the
   * measure tool catches. It has to happen during ingest: the vertex arrays
   * are freed the moment the merged chunk reaches the GPU.
   */
  private recordSegments(mesh: IfcMesh): void {
    const existing = this.segmentsByElement.get(this.idOf(mesh));
    const room = SNAP_SEGMENT_LIMIT * 6 - (existing?.length ?? 0);
    if (room <= 0) return;
    let local = edgeCache.get(mesh.geometry);
    if (!local) {
      local = featureEdges(mesh.geometry) ?? boxEdges(mesh.localBounds);
      edgeCache.set(mesh.geometry, local);
    }
    const take = Math.min(local.length, room);
    const m = mesh.matrix;
    if (take === 0 || !m.every(Number.isFinite)) return;

    const base = existing?.length ?? 0;
    const out = new Float32Array(base + take);
    if (existing) out.set(existing);
    const o = this.origin!;
    for (let i = 0; i < take; i += 3) {
      const x = local[i];
      const y = local[i + 1];
      const z = local[i + 2];
      out[base + i] = m[0] * x + m[4] * y + m[8] * z + m[12] - o.x;
      out[base + i + 1] = m[1] * x + m[5] * y + m[9] * z + m[13] - o.y;
      out[base + i + 2] = m[2] * x + m[6] * y + m[10] * z + m[14] - o.z;
    }
    this.segmentsByElement.set(this.idOf(mesh), out);
  }

  rayElementPoint(
    rayOrigin: THREE.Vector3,
    rayDir: THREE.Vector3,
    expressID: number,
  ): [number, number, number] | null {
    const bounds = this.elementBounds(expressID);
    if (!bounds) return null;
    const box = new THREE.Box3(
      new THREE.Vector3(bounds.min.x, bounds.min.y, bounds.min.z),
      new THREE.Vector3(bounds.max.x, bounds.max.y, bounds.max.z),
    );
    const ray = new THREE.Ray(rayOrigin, rayDir);
    const hit = ray.intersectBox(box, _v);
    if (hit) return [hit.x, hit.y, hit.z];
    const center = box.getCenter(_v);
    return [center.x, center.y, center.z];
  }

  dispose(): void {
    disposeTree(this.group);
    this.modelGroups.clear();
    this.mergedOpaque.dispose();
    this.mergedTransparent.dispose();
    this.instOpaque.dispose();
    for (const material of this.instTransparentByAlpha.values()) material.dispose();
    this.instTransparentByAlpha.clear();
    this.pickMaterial.dispose();
    this.stateTexture.dispose();
    this.paletteTexture.dispose();
    this.elements.clear();
    this.segmentsByElement.clear();
    this.elementsByIndex.length = 0;
    this.geometrySeen.clear();
  }
}

/** Hash a weld cell. A collision costs a duplicate point, never a pairing. */
function hash3(x: number, y: number, z: number): number {
  return (x * 73856093) ^ (y * 19349663) ^ (z * 83492791);
}

/** Packs an undirected edge into one exact float key; welds stay well below. */
const EDGE_STRIDE = 1 << 26;

/**
 * The edges a person actually points at: every triangle edge that is either a
 * boundary or a crease between two visibly different faces. A tessellated
 * cylinder keeps its two rims and loses its facet lines, a box keeps exactly
 * its twelve. Null means the mesh is too heavy to walk, and the caller falls
 * back to its box. Six floats per segment, in the mesh's local space.
 */
function featureEdges(geometry: MeshGeometry): Float32Array | null {
  const indices = geometry.indices;
  const triangles = indices.length / 3;
  if (triangles === 0 || triangles > SNAP_TRIANGLE_LIMIT) return null;

  // Weld first: web-ifc emits one vertex per face corner, so raw indices pair
  // no faces at all and every edge in the mesh would read as a boundary.
  const source = geometry.positions;
  const welded = new Int32Array(source.length / 3);
  const points = new Float32Array(source.length);
  const cells = new Map<number, number>();
  let unique = 0;
  for (let v = 0; v < welded.length; v++) {
    const x = source[v * 3];
    const y = source[v * 3 + 1];
    const z = source[v * 3 + 2];
    const key = hash3(Math.round(x / WELD), Math.round(y / WELD), Math.round(z / WELD));
    const hit = cells.get(key);
    if (
      hit !== undefined &&
      Math.abs(points[hit * 3] - x) <= WELD &&
      Math.abs(points[hit * 3 + 1] - y) <= WELD &&
      Math.abs(points[hit * 3 + 2] - z) <= WELD
    ) {
      welded[v] = hit;
      continue;
    }
    points[unique * 3] = x;
    points[unique * 3 + 1] = y;
    points[unique * 3 + 2] = z;
    cells.set(key, unique);
    welded[v] = unique++;
  }

  // One entry per undirected edge: the first face normal, then a verdict.
  const slots = new Map<number, number>();
  const ends: number[] = [];
  const normals: number[] = [];
  const verdict: number[] = []; // 0 unpaired, 1 keep, 2 smooth
  const pair = (a: number, b: number, nx: number, ny: number, nz: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    const slot = slots.get(lo * EDGE_STRIDE + hi);
    if (slot === undefined) {
      slots.set(lo * EDGE_STRIDE + hi, verdict.length);
      ends.push(lo, hi);
      normals.push(nx, ny, nz);
      verdict.push(0);
    } else if (verdict[slot] !== 0) {
      verdict[slot] = 1; // three faces meeting: always a real edge
    } else {
      const dot = normals[slot * 3] * nx + normals[slot * 3 + 1] * ny + normals[slot * 3 + 2] * nz;
      verdict[slot] = dot < SHARP_COS ? 1 : 2;
    }
  };

  for (let t = 0; t < triangles; t++) {
    const a = welded[indices[t * 3]];
    const b = welded[indices[t * 3 + 1]];
    const c = welded[indices[t * 3 + 2]];
    if (a === b || b === c || c === a) continue; // collapsed by the weld
    const ux = points[b * 3] - points[a * 3];
    const uy = points[b * 3 + 1] - points[a * 3 + 1];
    const uz = points[b * 3 + 2] - points[a * 3 + 2];
    const vx = points[c * 3] - points[a * 3];
    const vy = points[c * 3 + 1] - points[a * 3 + 1];
    const vz = points[c * 3 + 2] - points[a * 3 + 2];
    const nx = uy * vz - uz * vy;
    const ny = uz * vx - ux * vz;
    const nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue; // sliver: its normal says nothing
    pair(a, b, nx / len, ny / len, nz / len);
    pair(b, c, nx / len, ny / len, nz / len);
    pair(c, a, nx / len, ny / len, nz / len);
  }

  let kept = 0;
  for (const state of verdict) if (state !== 2) kept++;
  const out = new Float32Array(Math.min(kept, SNAP_SEGMENT_LIMIT) * 6);
  let o = 0;
  for (let s = 0; s < verdict.length && o < out.length; s++) {
    if (verdict[s] === 2) continue;
    const a = ends[s * 2] * 3;
    const b = ends[s * 2 + 1] * 3;
    // A point that is not a number would beat every candidate it is compared
    // with, so a broken triangle is dropped here rather than downstream.
    if (!isFinite3(points, a) || !isFinite3(points, b)) continue;
    out[o++] = points[a];
    out[o++] = points[a + 1];
    out[o++] = points[a + 2];
    out[o++] = points[b];
    out[o++] = points[b + 1];
    out[o++] = points[b + 2];
  }
  return o === out.length ? out : out.slice(0, o);
}

function isFinite3(values: ArrayLike<number>, at: number): boolean {
  return (
    Number.isFinite(values[at]) &&
    Number.isFinite(values[at + 1]) &&
    Number.isFinite(values[at + 2])
  );
}

/**
 * The twelve edges of a local box: the fallback for a mesh too heavy to walk.
 * A mesh that contributed no geometry has no box, and gets no edges either.
 */
function boxEdges(bounds: { min: Vec3; max: Vec3 }): Float32Array {
  const { min, max } = bounds;
  const corners = [min.x, min.y, min.z, max.x, max.y, max.z];
  if (!isFinite3(corners, 0) || !isFinite3(corners, 3)) return new Float32Array(0);
  const out = new Float32Array(BOX_EDGES.length * 3);
  for (let e = 0; e < BOX_EDGES.length; e++) {
    const c = BOX_EDGES[e];
    out[e * 3] = c & 1 ? max.x : min.x;
    out[e * 3 + 1] = c & 2 ? max.y : min.y;
    out[e * 3 + 2] = c & 4 ? max.z : min.z;
  }
  return out;
}

/** onUpload callback: drop the CPU copy once the GPU has the buffer. */
function freeAttributeArray(this: THREE.BufferAttribute): void {
  (this as { array: THREE.TypedArray | null }).array = null;
}

/** World-space AABB of a mesh: transform the 8 local corners (f64 math). */
function transformedAabb(mesh: IfcMesh): [Vec3, Vec3] {
  const { min, max } = mesh.localBounds;
  const m = mesh.matrix;
  let lox = Infinity, loy = Infinity, loz = Infinity;
  let hix = -Infinity, hiy = -Infinity, hiz = -Infinity;
  for (let c = 0; c < 8; c++) {
    const x = c & 1 ? max.x : min.x;
    const y = c & 2 ? max.y : min.y;
    const z = c & 4 ? max.z : min.z;
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14];
    if (wx < lox) lox = wx;
    if (wy < loy) loy = wy;
    if (wz < loz) loz = wz;
    if (wx > hix) hix = wx;
    if (wy > hiy) hiy = wy;
    if (wz > hiz) hiz = wz;
  }
  return [
    { x: lox, y: loy, z: loz },
    { x: hix, y: hiy, z: hiz },
  ];
}
