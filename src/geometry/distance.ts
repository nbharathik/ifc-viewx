import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { DistanceResult, DistanceSpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";

export type { DistanceResult } from "./types.js";

export interface DistanceOptions {
  /** Stop looking beyond this scene-space distance in metres. */
  maxDistance?: number;
  signal?: AbortSignal;
}

function modelOffsets(viewer: Viewer): Float64Array {
  const models = viewer.getModels();
  const out = new Float64Array(models.length * 4);
  models.forEach((model, i) => {
    out[i * 4] = model.index;
    out[i * 4 + 1] = model.offset[0];
    out[i * 4 + 2] = model.offset[1];
    out[i * 4 + 3] = model.offset[2];
  });
  return out;
}

export function measureDistance(
  viewer: Viewer,
  a: number,
  b: number,
  options: DistanceOptions = {},
): Promise<DistanceResult> {
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) {
    throw new Error("distance needs two valid element ids");
  }
  const spec: DistanceSpec = {
    a,
    b,
    origin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
    maxDistance: options.maxDistance,
  };
  return geometryService(viewer).distance(spec, options.signal);
}
