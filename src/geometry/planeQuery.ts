import { modelOf } from "../viewer-core/ids.js";
import { Matrix4 } from "three";
import type { GeometryIndex } from "./geometryIndex.js";
import type { PlaneClassifyResult, PlaneClassifySpec } from "./types.js";
import { scenePlacementMatrix, unpackModelTransforms } from "./modelTransform.js";
import type { ModelTransform } from "../viewer-core/engine/types.js";

export interface PlaneRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
}

const VERTEX_SLICE = 65_536;

export async function runClassifyPlane(
  index: GeometryIndex,
  spec: PlaneClassifySpec,
  options: PlaneRunOptions = {},
): Promise<PlaneClassifyResult> {
  const started = Date.now();
  const source = spec.planes?.length ? spec.planes : [{ normal: spec.normal, constant: spec.constant }];
  const planes = source.map((plane) => {
    const length = Math.hypot(...plane.normal);
    if (!Number.isFinite(length) || length === 0) throw new Error("classifyPlane needs a non-zero normal");
    return [
      plane.normal[0] / length, plane.normal[1] / length, plane.normal[2] / length,
      plane.constant / length,
    ] as [number, number, number, number];
  });
  const single = planes.length === 1;
  const [nx, ny, nz, constant] = planes[0];
  const epsilon = Math.max(1e-9, spec.epsilon ?? 1e-6);
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const kept: number[] = [], cut: number[] = [], dropped: number[] = [];
  let missing = 0;
  const worldMatrix = new Matrix4();
  let sinceYield = 0;

  for (const id of spec.ids) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    const modelTransform: ModelTransform = transforms.get(modelOf(id)) ?? {
      translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none",
    };
    const bounds = index.worldBounds(id, spec.modelOrigin, modelTransform);
    if (!bounds) {
      missing += 1;
      continue;
    }

    // Bounds pre-pass: entirely outside any plane drops the element, entirely
    // inside all planes keeps it, anything else needs the vertex pass.
    let outsideAny = false;
    let insideAll = true;
    for (const [px, py, pz, pc] of planes) {
      let minD = Infinity, maxD = -Infinity;
      for (let corner = 0; corner < 8; corner++) {
        const x = corner & 1 ? bounds.max[0] : bounds.min[0];
        const y = corner & 2 ? bounds.max[1] : bounds.min[1];
        const z = corner & 4 ? bounds.max[2] : bounds.min[2];
        const d = px * x + py * y + pz * z + pc;
        if (d < minD) minD = d;
        if (d > maxD) maxD = d;
      }
      if (maxD < -epsilon) {
        outsideAny = true;
        break;
      }
      if (minD <= epsilon) insideAll = false;
    }
    if (!outsideAny && insideAll) {
      kept.push(id);
      continue;
    }
    if (outsideAny) {
      dropped.push(id);
      continue;
    }

    if (single) {
      let anyPos = false, anyNeg = false;
      placements: for (const placement of index.placements(id)) {
        const m = scenePlacementMatrix(placement.matrix, spec.modelOrigin, modelTransform, worldMatrix).elements;
        const p = placement.positions;
        for (let v = 0; v < p.length; v += 3) {
          const x = m[0] * p[v] + m[4] * p[v + 1] + m[8] * p[v + 2] + m[12];
          const y = m[1] * p[v] + m[5] * p[v + 1] + m[9] * p[v + 2] + m[13];
          const z = m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + m[14];
          const d = nx * x + ny * y + nz * z + constant;
          if (d > epsilon) anyPos = true;
          else if (d < -epsilon) anyNeg = true;
          if (anyPos && anyNeg) break placements;
        }
        sinceYield += p.length / 3;
        if (sinceYield >= VERTEX_SLICE) {
          sinceYield = 0;
          await options.yieldTurn?.();
          if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
        }
      }
      if (anyPos && anyNeg) cut.push(id);
      else if (anyNeg) dropped.push(id);
      else kept.push(id);
      continue;
    }

    // Conjunctive vertex pass: a vertex counts as inside only when it
    // satisfies every plane at once, matching clipIntersection=false rendering.
    let anyInsideAll = false;
    let allInsideAll = true;
    placements: for (const placement of index.placements(id)) {
      const m = scenePlacementMatrix(placement.matrix, spec.modelOrigin, modelTransform, worldMatrix).elements;
      const p = placement.positions;
      for (let v = 0; v < p.length; v += 3) {
        const x = m[0] * p[v] + m[4] * p[v + 1] + m[8] * p[v + 2] + m[12];
        const y = m[1] * p[v] + m[5] * p[v + 1] + m[9] * p[v + 2] + m[13];
        const z = m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + m[14];
        let inside = true;
        for (const [px, py, pz, pc] of planes) {
          if (px * x + py * y + pz * z + pc <= -epsilon) {
            inside = false;
            break;
          }
        }
        if (inside) anyInsideAll = true;
        else allInsideAll = false;
        if (anyInsideAll && !allInsideAll) break placements;
      }
      sinceYield += p.length / 3;
      if (sinceYield >= VERTEX_SLICE) {
        sinceYield = 0;
        await options.yieldTurn?.();
        if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
      }
    }
    if (allInsideAll) kept.push(id);
    else if (anyInsideAll) cut.push(id);
    else dropped.push(id);
  }

  return {
    kept,
    cut,
    dropped,
    testedElements: spec.ids.length - missing,
    missing,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-plane",
    geometryRevision: index.revision,
  };
}
