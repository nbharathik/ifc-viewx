// Shared top-level acceleration for queries that already use per-mesh BVHs.
// The tree decides which transformed placements a point or ray can reach; the
// mesh BVH then answers the exact surface question in placement-local space.
import { Box3, Matrix4, Vector3 } from "three";
import { modelOf } from "../viewer-core/ids.js";
import type { ModelTransform } from "../viewer-core/engine/types.js";
import type { BvhPlacement, GeometryIndex } from "./geometryIndex.js";
import { scenePlacementMatrix } from "./modelTransform.js";

type Point = [number, number, number];

export interface BoundedPlacement {
  min: Point;
  max: Point;
}

export interface PreparedBvhPlacement extends BoundedPlacement {
  id: number;
  placement: BvhPlacement;
  matrix: Matrix4;
  inverse: Matrix4;
}

export interface PreparedPlacements {
  placements: PreparedBvhPlacement[];
  missing: number;
}

interface BroadNode extends BoundedPlacement {
  left: number;
  right: number;
  start: number;
  end: number;
}

const IDENTITY: ModelTransform = { translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none" };
const LEAF_SIZE = 8;

function validBounds(min: number[], max: number[]): boolean {
  return min.every(Number.isFinite) && max.every(Number.isFinite)
    && min[0] <= max[0] && min[1] <= max[1] && min[2] <= max[2];
}

function placementBounds(
  placement: BvhPlacement,
  matrix: Matrix4,
  fallback: BoundedPlacement,
  scratch: Box3,
  localBounds: WeakMap<BvhPlacement["bvh"], Box3>,
): BoundedPlacement | null {
  if (typeof placement.bvh.getBoundingBox === "function") {
    const cached = localBounds.get(placement.bvh);
    if (cached) scratch.copy(cached);
    else {
      placement.bvh.getBoundingBox(scratch);
      localBounds.set(placement.bvh, scratch.clone());
    }
    scratch.applyMatrix4(matrix);
    const min: Point = [scratch.min.x, scratch.min.y, scratch.min.z];
    const max: Point = [scratch.max.x, scratch.max.y, scratch.max.z];
    if (validBounds(min, max)) return { min, max };
  }
  return validBounds(fallback.min, fallback.max) ? fallback : null;
}

/**
 * Prepare every mesh placement once, including the viewer origin and each
 * model's translation, plan rotation and scale. Local BVH bounds are cached
 * because instances of one geometry share the same BVH.
 */
export function prepareBvhPlacements(
  index: GeometryIndex,
  ids: Iterable<number>,
  modelOrigin: Point,
  transforms: ReadonlyMap<number, ModelTransform>,
  cancelled?: () => boolean,
): PreparedPlacements {
  const placements: PreparedBvhPlacement[] = [];
  const scratch = new Box3();
  const localBounds = new WeakMap<BvhPlacement["bvh"], Box3>();
  let missing = 0;
  for (const id of ids) {
    if (cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    const transform = transforms.get(modelOf(id)) ?? IDENTITY;
    const fallback = index.worldBounds(id, modelOrigin, transform);
    if (!fallback) {
      missing += 1;
      continue;
    }
    for (const placement of index.bvhPlacements(id)) {
      const matrix = scenePlacementMatrix(placement.matrix, modelOrigin, transform, new Matrix4());
      const bounds = placementBounds(placement, matrix, fallback, scratch, localBounds);
      if (!bounds) continue;
      placements.push({
        id,
        placement,
        matrix,
        inverse: new Matrix4().copy(matrix).invert(),
        min: bounds.min,
        max: bounds.max,
      });
    }
  }
  return { placements, missing };
}

/** Balanced AABB tree over scene-space placement bounds. */
export class PlacementBroadPhase<T extends BoundedPlacement> {
  private readonly order: number[];
  private readonly nodes: BroadNode[] = [];
  private readonly stack: number[] = [];

  constructor(private readonly entries: T[]) {
    this.order = entries.map((_, index) => index);
    if (entries.length > 0) this.build(0, entries.length);
  }

  queryPoint(point: Vector3, radius: number, target: number[]): void {
    target.length = 0;
    if (this.nodes.length === 0) return;
    const radiusSquared = radius * radius;
    this.stack.length = 0;
    this.stack.push(0);
    while (this.stack.length > 0) {
      const node = this.nodes[this.stack.pop()!];
      if (pointBoxDistanceSquared(point, node.min, node.max) >= radiusSquared) continue;
      if (node.left >= 0) {
        this.stack.push(node.right, node.left);
        continue;
      }
      for (let at = node.start; at < node.end; at++) {
        const index = this.order[at];
        const entry = this.entries[index];
        if (pointBoxDistanceSquared(point, entry.min, entry.max) < radiusSquared) target.push(index);
      }
    }
  }

  /** Direction must be normalized so maxDistance remains a scene distance. */
  queryRay(origin: Vector3, direction: Vector3, maxDistance: number, target: number[]): void {
    target.length = 0;
    if (this.nodes.length === 0) return;
    this.stack.length = 0;
    this.stack.push(0);
    while (this.stack.length > 0) {
      const node = this.nodes[this.stack.pop()!];
      if (!rayIntersectsBox(origin, direction, node.min, node.max, maxDistance)) continue;
      if (node.left >= 0) {
        this.stack.push(node.right, node.left);
        continue;
      }
      for (let at = node.start; at < node.end; at++) {
        const index = this.order[at];
        const entry = this.entries[index];
        if (rayIntersectsBox(origin, direction, entry.min, entry.max, maxDistance)) target.push(index);
      }
    }
  }

  private build(start: number, end: number): number {
    const min: Point = [Infinity, Infinity, Infinity];
    const max: Point = [-Infinity, -Infinity, -Infinity];
    const centreMin: Point = [Infinity, Infinity, Infinity];
    const centreMax: Point = [-Infinity, -Infinity, -Infinity];
    for (let at = start; at < end; at++) {
      const entry = this.entries[this.order[at]];
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], entry.min[axis]);
        max[axis] = Math.max(max[axis], entry.max[axis]);
        const centre = (entry.min[axis] + entry.max[axis]) / 2;
        centreMin[axis] = Math.min(centreMin[axis], centre);
        centreMax[axis] = Math.max(centreMax[axis], centre);
      }
    }
    const nodeIndex = this.nodes.length;
    const node: BroadNode = { min, max, left: -1, right: -1, start, end };
    this.nodes.push(node);
    if (end - start <= LEAF_SIZE) return nodeIndex;

    const spans = centreMax.map((value, axis) => value - centreMin[axis]);
    const axis = spans[1] > spans[0] ? (spans[2] > spans[1] ? 2 : 1) : (spans[2] > spans[0] ? 2 : 0);
    const middle = start + Math.floor((end - start) / 2);
    this.select(start, end - 1, middle, axis);
    node.left = this.build(start, middle);
    node.right = this.build(middle, end);
    return nodeIndex;
  }

  /** In-place quickselect; tree construction stays O(n log n) without slices. */
  private select(left: number, right: number, target: number, axis: number): void {
    while (left < right) {
      const pivot = this.partition(left, right, Math.floor((left + right) / 2), axis);
      if (pivot === target) return;
      if (target < pivot) right = pivot - 1;
      else left = pivot + 1;
    }
  }

  private partition(left: number, right: number, pivot: number, axis: number): number {
    const pivotIndex = this.order[pivot];
    this.swap(pivot, right);
    let store = left;
    for (let at = left; at < right; at++) {
      const index = this.order[at];
      if (this.compare(index, pivotIndex, axis) < 0) {
        this.swap(store, at);
        store += 1;
      }
    }
    this.swap(store, right);
    return store;
  }

  private compare(a: number, b: number, axis: number): number {
    const one = this.entries[a];
    const two = this.entries[b];
    const delta = (one.min[axis] + one.max[axis]) - (two.min[axis] + two.max[axis]);
    return delta || a - b;
  }

  private swap(a: number, b: number): void {
    const value = this.order[a];
    this.order[a] = this.order[b];
    this.order[b] = value;
  }
}

export function pointBoxDistanceSquared(point: Vector3, min: Point, max: Point): number {
  const dx = Math.max(min[0] - point.x, 0, point.x - max[0]);
  const dy = Math.max(min[1] - point.y, 0, point.y - max[1]);
  const dz = Math.max(min[2] - point.z, 0, point.z - max[2]);
  return dx * dx + dy * dy + dz * dz;
}

function rayIntersectsBox(origin: Vector3, direction: Vector3, min: Point, max: Point, limit: number): boolean {
  let near = 0;
  let far = limit;
  for (let axis = 0; axis < 3; axis++) {
    const at = axis === 0 ? origin.x : axis === 1 ? origin.y : origin.z;
    const along = axis === 0 ? direction.x : axis === 1 ? direction.y : direction.z;
    if (Math.abs(along) < 1e-12) {
      if (at < min[axis] || at > max[axis]) return false;
      continue;
    }
    let first = (min[axis] - at) / along;
    let last = (max[axis] - at) / along;
    if (first > last) [first, last] = [last, first];
    near = Math.max(near, first);
    far = Math.min(far, last);
    if (far < near) return false;
  }
  return far >= 0 && near <= limit;
}
