import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { LaserResult, LaserSpec } from "./types.js";

export type { LaserAxis, LaserAxisResult, LaserHit, LaserResult } from "./types.js";

export interface LaserOptions {
  source?: number;
  ids?: number[];
  includeHidden?: boolean;
  maxDistance?: number;
  epsilon?: number;
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

export function measureLaser(
  viewer: Viewer,
  origin: [number, number, number],
  options: LaserOptions = {},
): Promise<LaserResult> {
  if (origin.length !== 3 || origin.some((value) => !Number.isFinite(value))) {
    throw new Error("laser needs a valid surface point");
  }
  const ids = options.ids ?? [...viewer.getElementTypes().keys()].filter((id) =>
    options.includeHidden || viewer.isElementVisible(id));
  const spec: LaserSpec = {
    origin: [...origin],
    source: options.source,
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    maxDistance: options.maxDistance,
    epsilon: options.epsilon,
  };
  return geometryService(viewer).laser(spec, options.signal);
}
