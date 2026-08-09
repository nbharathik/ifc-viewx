import type { Viewer } from "../viewer-core/viewer.js";
import { geometryService } from "./service.js";
import type { GeometrySignatureResult } from "./types.js";

export type { GeometrySignature, GeometrySignatureResult } from "./types.js";

export interface GeometrySignatureOptions {
  signal?: AbortSignal;
}

export function geometrySignatures(
  viewer: Viewer,
  ids: number[],
  options: GeometrySignatureOptions = {},
): Promise<GeometrySignatureResult> {
  const valid = ids.filter((id) => Number.isFinite(id) && id > 0);
  return geometryService(viewer).signatures({ ids: new Float64Array(valid) }, options.signal);
}
