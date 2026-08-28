import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { VolumesResult, VolumesSpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";

export type { ElementVolume, VolumesResult } from "./types.js";

export interface VolumeOptions {
  signal?: AbortSignal;
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

export function measureVolumes(
  viewer: Viewer,
  ids: number[],
  options: VolumeOptions = {},
): Promise<VolumesResult> {
  if (ids.length === 0 || ids.some((id) => !Number.isFinite(id) || id <= 0)) {
    throw new Error("volumes need at least one valid element id");
  }
  const spec: VolumesSpec = {
    ids: new Float64Array(ids),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
  };
  return geometryService(viewer).volumes(spec, options.signal);
}
