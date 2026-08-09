import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { SectionAxis, SectionContourResult, SectionContourSpec } from "./types.js";

export type { SectionAxis, SectionContourResult, SectionPolyline } from "./types.js";

export interface SectionContourOptions {
  ids?: number[];
  includeHidden?: boolean;
  tolerance?: number;
  maxSegments?: number;
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

export function extractSectionContours(
  viewer: Viewer,
  axis: SectionAxis,
  offset: number,
  options: SectionContourOptions = {},
): Promise<SectionContourResult> {
  if ((axis !== "x" && axis !== "y" && axis !== "z") || !Number.isFinite(offset)) {
    throw new Error("section contours need a valid axis and offset");
  }
  const ids = options.ids ?? [...viewer.getElementTypes().keys()].filter((id) =>
    options.includeHidden || viewer.isElementVisible(id));
  const spec: SectionContourSpec = {
    axis,
    offset,
    ids: new Float64Array(ids),
    modelOrigin: viewer.getModelOrigin(),
    offsets: modelOffsets(viewer),
    tolerance: options.tolerance,
    maxSegments: options.maxSegments,
  };
  return geometryService(viewer).sectionContours(spec, options.signal);
}
