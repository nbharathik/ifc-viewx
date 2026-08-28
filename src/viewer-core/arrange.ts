// Display-offset builders: storey slide and explode as pure functions over
// the spatial tree, so the math is testable without a GPU.
import type { SpatialNode } from './engine/types.js';

export type OffsetEntry = [number, [number, number, number]];

export interface StoreySet {
  id: number;
  name: string;
  ids: number[];
}

/** Storeys in tree order with every element id under each one. */
export function storeyElementSets(tree: SpatialNode | null): StoreySet[] {
  const storeys: StoreySet[] = [];
  if (!tree) return storeys;
  const collect = (node: SpatialNode, into: number[] | null): void => {
    if (node.type === 'IfcBuildingStorey') {
      const bucket: StoreySet = {
        id: node.expressID,
        name: node.name || `Storey ${storeys.length + 1}`,
        ids: [],
      };
      storeys.push(bucket);
      bucket.ids.push(node.expressID);
      for (const child of node.children) collect(child, bucket.ids);
      return;
    }
    if (into) into.push(node.expressID);
    for (const child of node.children) collect(child, into);
  };
  collect(tree, null);
  return storeys;
}

/**
 * Pull the storeys apart along one axis: storey i moves spacing * i. Zero
 * spacing writes zero offsets, which is how a slide is put back together.
 */
export function storeySlideOffsets(
  tree: SpatialNode | null,
  axis: 'x' | 'y' | 'z',
  spacing: number,
): OffsetEntry[] {
  const dim = axis === 'x' ? 0 : axis === 'y' ? 1 : 2;
  const out: OffsetEntry[] = [];
  storeyElementSets(tree).forEach((storey, index) => {
    for (const id of storey.ids) {
      const offset: [number, number, number] = [0, 0, 0];
      offset[dim] = spacing * index;
      out.push([id, offset]);
    }
  });
  return out;
}

/** Radial offsets from `origin`, scaled by each element's own distance. */
export function explodeOffsets(
  ids: Iterable<number>,
  centerOf: (id: number) => [number, number, number] | null,
  origin: [number, number, number],
  factor: number,
): OffsetEntry[] {
  const out: OffsetEntry[] = [];
  for (const id of ids) {
    const center = centerOf(id);
    if (!center) continue;
    out.push([
      id,
      [
        (center[0] - origin[0]) * factor,
        (center[1] - origin[1]) * factor,
        (center[2] - origin[2]) * factor,
      ],
    ]);
  }
  return out;
}
