// Broad phase: reduce every A against every B to the handful of pairs whose
// boxes could touch, so the triangle test only ever sees plausible work.
//
// A uniform grid sized from the median box, which suits building models: most
// elements are within an order of magnitude of each other, and the few that
// are not (a site slab, a curtain wall) would smear across thousands of cells,
// so anything spanning too many is kept aside and tested against everything.
//
// No three, no BVH, no geometry. Pure arithmetic over boxes, which is what
// makes it cheap to test on its own.

export interface BroadItem {
  id: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** Cells one item may occupy before it is treated as oversized. */
const MAX_SPAN = 64;

/** Grid pitch from the median box, so a cell holds a handful of items. */
export function cellSize(items: BroadItem[]): number {
  if (items.length === 0) return 1;
  const sizes = items.map((item) =>
    Math.max(item.max[0] - item.min[0], item.max[1] - item.min[1], item.max[2] - item.min[2]),
  );
  sizes.sort((a, b) => a - b);
  return Math.max(0.25, sizes[Math.floor(sizes.length / 2)] * 2);
}

function cellsOf(min: number[], max: number[], cell: number, keys: number[]): number[] {
  keys.length = 0;
  const lo = [Math.floor(min[0] / cell), Math.floor(min[1] / cell), Math.floor(min[2] / cell)];
  const hi = [Math.floor(max[0] / cell), Math.floor(max[1] / cell), Math.floor(max[2] / cell)];
  for (let x = lo[0]; x <= hi[0]; x++) {
    for (let y = lo[1]; y <= hi[1]; y++) {
      for (let z = lo[2]; z <= hi[2]; z++) {
        keys.push(hash(x, y, z));
        if (keys.length > MAX_SPAN) return keys;
      }
    }
  }
  return keys;
}

/** Cheap 3D cell hash; a collision only costs one extra box test. */
function hash(x: number, y: number, z: number): number {
  return (((x * 73856093) ^ (y * 19349663) ^ (z * 83492791)) | 0) >>> 0;
}

export function boxesOverlap(a: BroadItem, b: BroadItem, margin: number): boolean {
  return (
    a.min[0] - margin <= b.max[0] && a.max[0] + margin >= b.min[0] &&
    a.min[1] - margin <= b.max[1] && a.max[1] + margin >= b.min[1] &&
    a.min[2] - margin <= b.max[2] && a.max[2] + margin >= b.min[2]
  );
}

/**
 * Every A paired with the Bs whose box is within `margin` of it, each pair
 * seen once. Callers get one A at a time with its whole candidate list, which
 * is what lets the narrow phase build that element's BVH once and reuse it.
 *
 * Each list is a fresh array. Reusing one buffer here would be cheaper and was
 * how this started, but a caller that keeps the list past the call then holds
 * something that is emptied out from under it.
 */
export function candidatePairs(
  a: BroadItem[],
  b: BroadItem[],
  margin: number,
  visit: (item: BroadItem, candidates: BroadItem[]) => void,
): void {
  if (a.length === 0 || b.length === 0) return;
  const cell = cellSize(b);
  const buckets = new Map<number, BroadItem[]>();
  const oversized: BroadItem[] = [];
  const keys: number[] = [];

  for (const item of b) {
    const span = cellsOf(item.min, item.max, cell, keys);
    if (span.length > MAX_SPAN) {
      oversized.push(item);
      continue;
    }
    for (const key of span) {
      const list = buckets.get(key);
      if (list) list.push(item);
      else buckets.set(key, [item]);
    }
  }

  // When the two sets share elements, a pair turns up from both directions.
  // Emitting only from the lower id keeps each one once, and costs a pair of
  // id sets that are not built at all when the sets are disjoint.
  const bIds = new Set(b.map((item) => item.id));
  const shared = a.some((item) => bIds.has(item.id));
  const aIds = shared ? new Set(a.map((item) => item.id)) : null;

  const seen = new Set<number>();
  for (const item of a) {
    const candidates: BroadItem[] = [];
    seen.clear();
    const collect = (other: BroadItem): void => {
      if (other.id === item.id || seen.has(other.id)) return;
      seen.add(other.id);
      if (aIds && item.id > other.id && aIds.has(other.id) && bIds.has(item.id)) return;
      if (boxesOverlap(item, other, margin)) candidates.push(other);
    };
    const span = cellsOf(
      [item.min[0] - margin, item.min[1] - margin, item.min[2] - margin],
      [item.max[0] + margin, item.max[1] + margin, item.max[2] + margin],
      cell,
      keys,
    );
    // Too big to bucket sensibly: it has to see everything, or it would be
    // compared against an arbitrary handful of cells.
    if (span.length > MAX_SPAN) for (const other of b) collect(other);
    else for (const key of span) for (const other of buckets.get(key) ?? []) collect(other);
    for (const other of oversized) collect(other);
    if (candidates.length) visit(item, candidates);
  }
}
