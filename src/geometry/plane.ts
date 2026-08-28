import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { PlaneClassifyResult, PlaneClassifySpec } from "./types.js";
import { packedModelTransforms } from "./modelTransform.js";

export type { PlaneClassifyResult } from "./types.js";

export interface PlaneClassifyOptions {
  ids?: number[];
  includeHidden?: boolean;
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

export interface ClassifyPlane {
  normal: [number, number, number];
  constant: number;
}

/** Classify against several planes at once with conjunctive semantics. */
export function classifyByPlanes(
  viewer: Viewer,
  planes: ClassifyPlane[],
  options: PlaneClassifyOptions = {},
): Promise<PlaneClassifyResult> {
  if (planes.length === 0) throw new Error("classifyPlane needs at least one plane");
  for (const plane of planes) {
    if (plane.normal.length !== 3 || plane.normal.some((value) => !Number.isFinite(value)) ||
      !Number.isFinite(plane.constant)) {
      throw new Error("classifyPlane needs a valid plane");
    }
  }
  const ids = options.ids ?? [...viewer.getElementTypes().keys()].filter((id) =>
    options.includeHidden || viewer.isElementVisible(id));
  const spec: PlaneClassifySpec = {
    normal: [...planes[0].normal],
    constant: planes[0].constant,
    planes: planes.map((plane) => ({ normal: [...plane.normal] as [number, number, number], constant: plane.constant })),
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    transforms: packedModelTransforms(viewer.getModels()),
    epsilon: options.epsilon,
  };
  return geometryService(viewer).classifyPlane(spec, options.signal);
}

export function classifyByPlane(
  viewer: Viewer,
  normal: [number, number, number],
  constant: number,
  options: PlaneClassifyOptions = {},
): Promise<PlaneClassifyResult> {
  return classifyByPlanes(viewer, [{ normal, constant }], options);
}
