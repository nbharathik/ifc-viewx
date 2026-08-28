// Element triangles baked into scene space, for the mesh exporters.
//
// The renderer keeps geometry once and places it many times, which is what
// makes it fast and what makes it useless to an exporter: a glTF or an OBJ
// wants one addressable object per element. Every placement of an element is
// transformed here and merged into a single buffer pair, so the caller only
// has to hand each entry to three.
import { Matrix4 } from "three";
import { modelOf } from "../viewer-core/ids.js";
import type { GeometryIndex } from "./geometryIndex.js";
import { scenePlacementMatrix, unpackModelTransforms } from "./modelTransform.js";
import type { MeshesResult, MeshesSpec } from "./types.js";

export interface MeshRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
}

/** Roughly 100 MB of positions and indices per batch. */
const DEFAULT_MAX_TRIANGLES = 2_000_000;
const ORIGIN: [number, number, number] = [0, 0, 0];

export async function runMeshes(
  index: GeometryIndex,
  spec: MeshesSpec,
  options: MeshRunOptions = {},
): Promise<MeshesResult> {
  const started = Date.now();
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const limit = Math.max(1, spec.maxTriangles ?? DEFAULT_MAX_TRIANGLES);
  const matrix = new Matrix4();
  const ids: number[] = [];
  const types: string[] = [];
  const vertexCounts: number[] = [];
  const indexCounts: number[] = [];
  const positionParts: Float32Array[] = [];
  const indexParts: Uint32Array[] = [];
  let vertexTotal = 0;
  let indexTotal = 0;
  let missing = 0;
  let truncated = false;
  let slice = performance.now();

  for (const id of spec.ids) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    const placements = index.placements(id);
    if (placements.length === 0) {
      missing += 1;
      continue;
    }
    let vertices = 0;
    let indices = 0;
    for (const placement of placements) {
      vertices += placement.positions.length / 3;
      indices += placement.indices.length;
    }
    if (indices === 0) {
      missing += 1;
      continue;
    }
    if ((indexTotal + indices) / 3 > limit) {
      truncated = true;
      break;
    }
    const positions = new Float32Array(vertices * 3);
    const elementIndices = new Uint32Array(indices);
    const model = transforms.get(modelOf(id)) ?? ORIGIN;
    let vertexAt = 0;
    let indexAt = 0;
    for (const placement of placements) {
      // scenePlacementMatrix owns the Y-up plan rotation; never re-derive it.
      const e = scenePlacementMatrix(placement.matrix, spec.modelOrigin, model, matrix).elements;
      const count = placement.positions.length / 3;
      for (let v = 0; v < count; v++) {
        const x = placement.positions[v * 3];
        const y = placement.positions[v * 3 + 1];
        const z = placement.positions[v * 3 + 2];
        const at = (vertexAt + v) * 3;
        positions[at] = e[0] * x + e[4] * y + e[8] * z + e[12];
        positions[at + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        positions[at + 2] = e[2] * x + e[6] * y + e[10] * z + e[14];
      }
      for (let i = 0; i < placement.indices.length; i++) {
        elementIndices[indexAt + i] = placement.indices[i] + vertexAt;
      }
      vertexAt += count;
      indexAt += placement.indices.length;
    }
    ids.push(id);
    types.push(index.typeOf(id));
    vertexCounts.push(vertices);
    indexCounts.push(indices);
    positionParts.push(positions);
    indexParts.push(elementIndices);
    vertexTotal += vertices;
    indexTotal += indices;
    if (performance.now() - slice >= 8 && options.yieldTurn) {
      await options.yieldTurn();
      slice = performance.now();
    }
  }

  const positions = new Float32Array(vertexTotal * 3);
  const indices = new Uint32Array(indexTotal);
  let positionAt = 0;
  let indexAt = 0;
  for (let i = 0; i < positionParts.length; i++) {
    positions.set(positionParts[i], positionAt);
    positionAt += positionParts[i].length;
    indices.set(indexParts[i], indexAt);
    indexAt += indexParts[i].length;
  }

  return {
    ids: new Float64Array(ids),
    types,
    vertexCounts: new Uint32Array(vertexCounts),
    indexCounts: new Uint32Array(indexCounts),
    positions,
    indices,
    missing,
    truncated,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-mesh",
    geometryRevision: index.revision,
  };
}

/** Every buffer in a result, so posting one out of the worker costs no copy. */
export function meshTransfers(result: MeshesResult): Transferable[] {
  return [
    result.ids.buffer,
    result.vertexCounts.buffer,
    result.indexCounts.buffer,
    result.positions.buffer,
    result.indices.buffer,
  ] as Transferable[];
}
