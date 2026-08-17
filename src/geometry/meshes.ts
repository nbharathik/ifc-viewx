import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { MeshesResult, MeshesSpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";

export type { MeshesResult } from "./types.js";

export interface MeshesOptions {
  signal?: AbortSignal;
  /** Stop the batch at the element that would cross this triangle count. */
  maxTriangles?: number;
}

function modelOffsets(viewer: Viewer): Float64Array {
  const models = viewer.getModels();
  const out = new Float64Array(models.length * 4);
  models.forEach((model, index) => {
    out[index * 4] = model.index;
    out[index * 4 + 1] = model.offset[0];
    out[index * 4 + 2] = model.offset[1];
    out[index * 4 + 3] = model.offset[2];
  });
  return out;
}

/** Scene-space triangles for these elements, one merged entry each. */
export function elementMeshes(
  viewer: Viewer,
  ids: number[],
  options: MeshesOptions = {},
): Promise<MeshesResult> {
  if (ids.length === 0) throw new Error("meshes need at least one element id");
  const spec: MeshesSpec = {
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
    maxTriangles: options.maxTriangles,
  };
  return geometryService(viewer).meshes(spec, options.signal);
}
