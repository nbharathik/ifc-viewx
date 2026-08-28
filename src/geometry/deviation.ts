import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { DeviationResult, DeviationSpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";

export type { DeviationResult } from "./types.js";

export interface DeviationOptions {
  ids?: number[];
  includeHidden?: boolean;
  /** Beyond this a point counts as having no nearby surface, in metres. */
  maxDistance?: number;
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

/** Distance from each scanned point to the nearest model surface. */
export function measureDeviation(
  viewer: Viewer,
  points: Float64Array,
  options: DeviationOptions = {},
): Promise<DeviationResult> {
  if (points.length < 3) throw new Error("deviation needs at least one point");
  if (points.length % 3 !== 0) throw new Error("deviation points must contain complete XYZ triples");
  if (options.maxDistance !== undefined && (!Number.isFinite(options.maxDistance) || options.maxDistance <= 0)) {
    throw new Error("deviation maxDistance must be a positive finite number");
  }
  const ids = options.ids ?? [...viewer.getElementTypes().keys()].filter((id) =>
    options.includeHidden || viewer.isElementVisible(id));
  const spec: DeviationSpec = {
    // GeometryService transfers request buffers to its worker. Keep the
    // caller-owned scan usable for rendering and subsequent analyses.
    points: points.slice(),
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
    maxDistance: options.maxDistance,
  };
  return geometryService(viewer).deviation(spec, options.signal);
}
