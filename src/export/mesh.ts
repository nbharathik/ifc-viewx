// glTF, GLB, STL and OBJ export of what is on screen.
//
// The export scene is rebuilt from the retained triangles rather than lifted
// out of the viewport, so none of the render-side machinery (state textures,
// merged chunks, instancing, caps) can leak into the file. One mesh per
// element, named by GlobalId, is what a downstream tool expects.
import { BufferAttribute, BufferGeometry, DoubleSide, Mesh, MeshStandardMaterial, Scene } from "three";
import { elementMeshes } from "../geometry/meshes.js";
import { download } from "../sdk/data.js";
import { elementsOf } from "../sdk/data.js";
import { modelOf } from "../viewer-core/ids.js";
import type { Viewer } from "../viewer-core/viewer.js";

export type MeshFormat = "gltf" | "glb" | "stl" | "obj";

export interface MeshExportOptions {
  /** Explicit scope. Without one, every element with geometry is exported. */
  ids?: Iterable<number>;
  /** Keep only what the viewport is drawing. */
  visibleOnly?: boolean;
  /** Keep only the current selection. */
  selectedOnly?: boolean;
  /** GlobalIds by element id. Resolved from the model when omitted. */
  names?: Map<number, string>;
  /** STL defaults to binary; ASCII is readable but roughly five times larger. */
  stlBinary?: boolean;
  fileName?: string;
  signal?: AbortSignal;
  onProgress?(done: number, total: number): void;
}

export interface MeshExportResult {
  blob: Blob;
  fileName: string;
  elements: number;
  triangles: number;
  /** True when a cap stopped the export before every element was written. */
  truncated: boolean;
}

/**
 * Elements per geometry round trip. The worker bakes a batch into scene space
 * and hands it over, so peak memory is the finished scene plus one batch
 * rather than the whole model twice.
 */
const BATCH = 2000;
/** Whole-export ceiling, about 250 MB of positions and indices in the scene. */
const MAX_TRIANGLES = 6_000_000;
/** Above this, GlobalId lookups cost more than the export; ids stand in. */
const GUID_LIMIT = 20_000;
/** Property reads in flight, matching PropertyIndex. */
const WINDOW = 12;

const EXTENSION: Record<MeshFormat, string> = { gltf: "gltf", glb: "glb", stl: "stl", obj: "obj" };
const MIME: Record<MeshFormat, string> = {
  gltf: "model/gltf+json",
  glb: "model/gltf-binary",
  stl: "model/stl",
  obj: "model/obj",
};

export async function exportMesh(
  viewer: Viewer,
  format: MeshFormat,
  options: MeshExportOptions = {},
): Promise<MeshExportResult> {
  const ids = scopedIds(viewer, options);
  if (ids.length === 0) throw new Error("Nothing to export: no element with geometry is in scope");
  const names = options.names ?? await globalIds(viewer, ids, options.signal);
  const storeys = storeyOf(viewer);
  const models = new Map(viewer.getModels().map((model) => [model.index, model.name]));

  const scene = new Scene();
  scene.name = "ifcviewx";
  const material = new MeshStandardMaterial({ name: "ifc", side: DoubleSide });
  let triangles = 0;
  let elements = 0;
  let truncated = false;

  try {
    for (let at = 0; at < ids.length; at += BATCH) {
      if (options.signal?.aborted) throw new DOMException("Export cancelled", "AbortError");
      const batch = await elementMeshes(viewer, ids.slice(at, at + BATCH), {
        signal: options.signal,
        maxTriangles: MAX_TRIANGLES - triangles,
      });
      let vertexAt = 0;
      let indexAt = 0;
      for (let i = 0; i < batch.ids.length; i++) {
        const vertices = batch.vertexCounts[i];
        const count = batch.indexCounts[i];
        const id = batch.ids[i];
        const geometry = new BufferGeometry();
        geometry.setAttribute("position", new BufferAttribute(
          batch.positions.slice(vertexAt * 3, (vertexAt + vertices) * 3),
          3,
        ));
        geometry.setIndex(new BufferAttribute(batch.indices.slice(indexAt, indexAt + count), 1));
        geometry.computeVertexNormals();
        const mesh = new Mesh(geometry, material);
        mesh.name = names.get(id) || String(id);
        mesh.userData = {
          id,
          ifcType: batch.types[i],
          storey: storeys.get(id) ?? "",
          modelName: models.get(modelOf(id)) ?? "",
        };
        scene.add(mesh);
        vertexAt += vertices;
        indexAt += count;
        triangles += count / 3;
        elements += 1;
      }
      truncated = truncated || batch.truncated;
      options.onProgress?.(Math.min(at + BATCH, ids.length), ids.length);
      if (truncated) break;
    }

    const blob = await encode(scene, format, options.stlBinary ?? true);
    return { blob, fileName: options.fileName ?? suggestName(viewer, format), elements, triangles, truncated };
  } finally {
    for (const child of scene.children) {
      if (child instanceof Mesh) (child.geometry as BufferGeometry).dispose();
    }
    scene.clear();
    material.dispose();
  }
}

/** The export, handed to the browser as a download. */
export async function saveMesh(
  viewer: Viewer,
  format: MeshFormat,
  options: MeshExportOptions = {},
): Promise<MeshExportResult> {
  const result = await exportMesh(viewer, format, options);
  download(result.fileName, result.blob, result.blob.type);
  return result;
}

/** The exporters are three example modules, imported here so they stay lazy. */
async function encode(scene: Scene, format: MeshFormat, stlBinary: boolean): Promise<Blob> {
  if (format === "obj") {
    const { OBJExporter } = await import("three/examples/jsm/exporters/OBJExporter.js");
    return new Blob([new OBJExporter().parse(scene)], { type: MIME.obj });
  }
  if (format === "stl") {
    const { STLExporter } = await import("three/examples/jsm/exporters/STLExporter.js");
    const data = new STLExporter().parse(scene, { binary: stlBinary });
    return new Blob([data as BlobPart], { type: MIME.stl });
  }
  const { GLTFExporter } = await import("three/examples/jsm/exporters/GLTFExporter.js");
  const binary = format === "glb";
  const data = await new GLTFExporter().parseAsync(scene, { binary, onlyVisible: false });
  return binary
    ? new Blob([data as ArrayBuffer], { type: MIME.glb })
    : new Blob([JSON.stringify(data)], { type: MIME.gltf });
}

function scopedIds(viewer: Viewer, options: MeshExportOptions): number[] {
  const source = options.ids
    ? [...options.ids]
    : options.selectedOnly
      ? viewer.getSelectedIds()
      : [...viewer.getElementTypes().keys()];
  return source.filter((id) => viewer.hasGeometry(id) && (!options.visibleOnly || viewer.isElementVisible(id)));
}

function storeyOf(viewer: Viewer): Map<number, string> {
  const out = new Map<number, string>();
  for (const element of elementsOf(viewer.getSpatialTree())) out.set(element.id, element.storey);
  return out;
}

/** One property read per element, windowed. Skipped entirely on a big scope. */
async function globalIds(viewer: Viewer, ids: number[], signal?: AbortSignal): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  if (ids.length > GUID_LIMIT) return out;
  let next = 0;
  const pump = async (): Promise<void> => {
    for (;;) {
      const at = next++;
      if (at >= ids.length || signal?.aborted) return;
      const properties = await viewer.getProperties(ids[at]).catch(() => null);
      const guid = properties?.attributes.find((attribute) => attribute.name === "GlobalId")?.value;
      if (typeof guid === "string" && guid) out.set(ids[at], guid);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(WINDOW, ids.length)) }, pump));
  return out;
}

function suggestName(viewer: Viewer, format: MeshFormat): string {
  const raw = viewer.getModels()[0]?.name ?? "model";
  const base = raw.replace(/\.(ifc|ifcxml|ifczip|ifcx)$/i, "").replace(/[\\/:*?"<>|]/g, "-").trim();
  return `${base || "model"}.${EXTENSION[format]}`;
}
