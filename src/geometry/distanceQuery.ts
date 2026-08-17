import { modelOf } from "../viewer-core/ids.js";
import { buildElement, disposeElement, hardClash, surfaceDistance } from "../ifc/clash/narrow.js";
import type { GeometryIndex } from "./geometryIndex.js";
import type { DistanceResult, DistanceSpec } from "./types.js";
import { unpackModelTransforms } from "./modelTransform.js";
import type { ModelTransform } from "../viewer-core/engine/types.js";

export async function runDistance(index: GeometryIndex, spec: DistanceSpec): Promise<DistanceResult> {
  const started = Date.now();
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const transform = (id: number): ModelTransform => transforms.get(modelOf(id)) ?? {
    translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none",
  };
  const boundsA = index.worldBounds(spec.a, spec.origin, transform(spec.a));
  const boundsB = index.worldBounds(spec.b, spec.origin, transform(spec.b));
  const missing = Number(boundsA === null) + Number(boundsB === null);
  const empty = (): DistanceResult => ({
    a: spec.a,
    b: spec.b,
    distance: null,
    pointA: null,
    pointB: null,
    point: null,
    intersecting: false,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-bvh",
    geometryRevision: index.revision,
  });
  if (!boundsA || !boundsB) return empty();

  const centre = (bounds: typeof boundsA): [number, number, number] => [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ];
  const a = buildElement(spec.a, index.placements(spec.a), spec.origin, transform(spec.a), centre(boundsA));
  const b = buildElement(spec.b, index.placements(spec.b), spec.origin, transform(spec.b), centre(boundsB));
  if (!a || !b) {
    if (a) disposeElement(a);
    if (b) disposeElement(b);
    return empty();
  }

  try {
    const contact = spec.a === spec.b ? { point: a.centre } : hardClash(a, b, 0);
    if (contact) {
      const point = contact.point as [number, number, number];
      return {
        a: spec.a,
        b: spec.b,
        distance: 0,
        pointA: point,
        pointB: point,
        point,
        intersecting: true,
        missing: 0,
        elapsedMs: Date.now() - started,
        fidelity: "mesh",
        engine: "browser-bvh",
        geometryRevision: index.revision,
      };
    }
    const limit = spec.maxDistance === undefined ? Infinity : Math.max(0, spec.maxDistance);
    const result = surfaceDistance(a, b, limit);
    if (!result) return empty();
    return {
      a: spec.a,
      b: spec.b,
      distance: result.distance,
      pointA: result.pointA,
      pointB: result.pointB,
      point: result.point,
      intersecting: result.distance === 0,
      missing: 0,
      elapsedMs: Date.now() - started,
      fidelity: "mesh",
      engine: "browser-bvh",
      geometryRevision: index.revision,
    };
  } finally {
    disposeElement(a);
    disposeElement(b);
  }
}
