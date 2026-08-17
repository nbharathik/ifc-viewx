import { modelOf } from "../viewer-core/ids.js";
import type { GeometryIndex } from "./geometryIndex.js";
import type { ElementVolume, VolumesResult, VolumesSpec } from "./types.js";
import { unpackModelTransforms } from "./modelTransform.js";

export interface VolumeRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
}

function det3(m: Float64Array): number {
  return m[0] * (m[5] * m[10] - m[6] * m[9])
    - m[4] * (m[1] * m[10] - m[2] * m[9])
    + m[8] * (m[1] * m[6] - m[2] * m[5]);
}

export async function runVolumes(
  index: GeometryIndex,
  spec: VolumesSpec,
  options: VolumeRunOptions = {},
): Promise<VolumesResult> {
  const started = Date.now();
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const volumes: ElementVolume[] = [];
  let missing = 0;
  let slice = performance.now();
  for (const id of spec.ids) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    const pieces = index.placedVolumes(id);
    if (pieces.length === 0) {
      missing += 1;
      continue;
    }
    const scale = transforms.get(modelOf(id))?.scale ?? 1;
    const modelDet = scale * scale * scale;
    let volume = 0;
    let triangles = 0;
    let closed = true;
    for (const piece of pieces) {
      volume += Math.abs(piece.volume * det3(piece.matrix) * modelDet);
      triangles += piece.triangles;
      closed = closed && piece.closed;
    }
    volumes.push({ id, volume, triangles, closed });
    if (performance.now() - slice >= 8 && options.yieldTurn) {
      await options.yieldTurn();
      slice = performance.now();
    }
  }
  return {
    volumes,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-volume",
    geometryRevision: index.revision,
  };
}
