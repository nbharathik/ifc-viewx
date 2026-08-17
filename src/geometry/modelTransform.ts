import { Matrix4 } from 'three';
import type { ModelTransform } from '../viewer-core/engine/types.js';

type Point = [number, number, number];
type ModelPlacementSource = { index: number; transform?: ModelTransform; offset?: Point };

export function packedModelTransforms(models: ModelPlacementSource[]): Float64Array {
  const out = new Float64Array(models.length * 6);
  models.forEach((model, index) => {
    const transform = model.transform ?? {
      translation: model.offset ?? [0, 0, 0],
      rotationZ: 0,
      scale: 1,
      source: 'none',
    } satisfies ModelTransform;
    const at = index * 6;
    out[at] = model.index;
    out[at + 1] = transform.translation[0];
    out[at + 2] = transform.translation[1];
    out[at + 3] = transform.translation[2];
    out[at + 4] = transform.rotationZ;
    out[at + 5] = transform.scale;
  });
  return out;
}

export function unpackModelTransforms(
  transforms: Float64Array | undefined,
  offsets: Float64Array,
): Map<number, ModelTransform> {
  const out = new Map<number, ModelTransform>();
  if (transforms) {
    for (let index = 0; index + 5 < transforms.length; index += 6) {
      out.set(transforms[index], {
        translation: [transforms[index + 1], transforms[index + 2], transforms[index + 3]],
        rotationZ: transforms[index + 4],
        scale: transforms[index + 5],
        source: 'automatic',
      });
    }
  }
  for (let index = 0; index + 3 < offsets.length; index += 4) {
    if (out.has(offsets[index])) continue;
    out.set(offsets[index], {
      translation: [offsets[index + 1], offsets[index + 2], offsets[index + 3]],
      rotationZ: 0,
      scale: 1,
      source: 'manual',
    });
  }
  return out;
}

export function normalizedModelTransform(value: ModelTransform | Point): ModelTransform {
  return Array.isArray(value)
    ? { translation: value, rotationZ: 0, scale: 1, source: 'manual' }
    : value;
}

export function scenePlacementMatrix(
  placement: Float64Array,
  origin: Point,
  model: ModelTransform | Point,
  target: Matrix4,
): Matrix4 {
  const transform = normalizedModelTransform(model);
  // Must mirror the batcher's group transform exactly: the scene is Y-up, so
  // rotationZ is a plan rotation about the Y axis.
  const c = Math.cos(transform.rotationZ) * transform.scale;
  const s = Math.sin(transform.rotationZ) * transform.scale;
  const modelMatrix = new Matrix4().set(
    c, 0, s, transform.translation[0] - origin[0],
    0, transform.scale, 0, transform.translation[1] - origin[1],
    -s, 0, c, transform.translation[2] - origin[2],
    0, 0, 0, 1,
  );
  return target.copy(modelMatrix).multiply(new Matrix4().fromArray(placement));
}
