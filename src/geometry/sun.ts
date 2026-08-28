import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { SunResult, SunSample, SunSpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";
import { assertSunIds, finiteXyz, sunScalars, unitXyz } from "./sunValidation.js";

export type { SunResult, SunSample } from "./types.js";

export interface SunOptions {
  /** Elements that may cast a shadow. Everything visible by default. */
  ids?: number[];
  includeHidden?: boolean;
  /** Shadow reach in metres: at least epsilon and at most 1,000 km. */
  maxDistance?: number;
  /** Surface offset in metres, from 1 micrometre through 10 metres. */
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

/**
 * Sunlit hours per sample point. `directions` are the sun directions through
 * the day, each standing for a positive `stepMinutes` no greater than one
 * day, so the answer is hours rather than a count nobody can check.
 */
export function measureSun(
  viewer: Viewer,
  samples: SunSample[],
  directions: Array<[number, number, number]>,
  stepMinutes: number,
  options: SunOptions = {},
): Promise<SunResult> {
  if (samples.length === 0) throw new Error("sun exposure needs at least one sample point");
  if (directions.length === 0) throw new Error("sun exposure needs at least one sun direction");
  const { epsilon, maxDistance } = sunScalars(stepMinutes, options.epsilon, options.maxDistance);
  const points = new Float64Array(samples.length * 3);
  samples.forEach((sample, index) => {
    if (!Array.isArray(sample.point) || sample.point.length !== 3) {
      throw new Error(`sun sample ${index + 1} point must be an XYZ triple`);
    }
    if (!Array.isArray(sample.normal) || sample.normal.length !== 3) {
      throw new Error(`sun sample ${index + 1} normal must be an XYZ triple`);
    }
    finiteXyz(sample.point[0], sample.point[1], sample.point[2], `sun sample ${index + 1} point`);
    const normal = unitXyz(
      sample.normal[0],
      sample.normal[1],
      sample.normal[2],
      `sun sample ${index + 1} normal`,
    );
    // Start the ray just off the surface, along its own normal: a ray from
    // exactly on the face hits that face and every point reads as shaded.
    points[index * 3] = sample.point[0] + normal[0] * epsilon;
    points[index * 3 + 1] = sample.point[1] + normal[1] * epsilon;
    points[index * 3 + 2] = sample.point[2] + normal[2] * epsilon;
  });
  const flat = new Float64Array(directions.length * 3);
  directions.forEach((direction, index) => {
    if (!Array.isArray(direction) || direction.length !== 3) {
      throw new Error(`sun direction ${index + 1} must be an XYZ triple`);
    }
    const unit = unitXyz(direction[0], direction[1], direction[2], `sun direction ${index + 1}`);
    flat[index * 3] = unit[0];
    flat[index * 3 + 1] = unit[1];
    flat[index * 3 + 2] = unit[2];
  });
  const ids = options.ids ?? [...viewer.getElementTypes().keys()].filter((id) =>
    options.includeHidden || viewer.isElementVisible(id));
  assertSunIds(ids);
  const spec: SunSpec = {
    points,
    directions: flat,
    stepMinutes,
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
    maxDistance,
    epsilon,
  };
  return geometryService(viewer).sun(spec, options.signal);
}
