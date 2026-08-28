import { describe, expect, it } from "vitest";
import { Vector3 } from "three";

import {
  PlacementBroadPhase,
  pointBoxDistanceSquared,
  type BoundedPlacement,
} from "../src/geometry/placementBroadPhase.js";

function randomSource(seed = 0x51f15e): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function rayHits(origin: Vector3, direction: Vector3, box: BoundedPlacement, limit: number): boolean {
  let near = 0;
  let far = limit;
  const from = [origin.x, origin.y, origin.z];
  const along = [direction.x, direction.y, direction.z];
  for (let axis = 0; axis < 3; axis++) {
    if (Math.abs(along[axis]) < 1e-12) {
      if (from[axis] < box.min[axis] || from[axis] > box.max[axis]) return false;
      continue;
    }
    let first = (box.min[axis] - from[axis]) / along[axis];
    let last = (box.max[axis] - from[axis]) / along[axis];
    if (first > last) [first, last] = [last, first];
    near = Math.max(near, first);
    far = Math.min(far, last);
    if (far < near) return false;
  }
  return far >= 0 && near <= limit;
}

describe("shared placement broad phase", () => {
  const random = randomSource();
  const boxes: BoundedPlacement[] = Array.from({ length: 500 }, () => {
    const min: [number, number, number] = [
      random() * 200 - 100,
      random() * 40 - 20,
      random() * 200 - 100,
    ];
    const size = [random() * 8 + 0.05, random() * 8 + 0.05, random() * 8 + 0.05];
    return { min, max: [min[0] + size[0], min[1] + size[1], min[2] + size[2]] };
  });
  const broadPhase = new PlacementBroadPhase(boxes);

  it("matches brute-force point-radius candidates", () => {
    const candidates: number[] = [];
    for (let sample = 0; sample < 80; sample++) {
      const point = new Vector3(random() * 200 - 100, random() * 40 - 20, random() * 200 - 100);
      const radius = random() * 12 + 0.1;
      broadPhase.queryPoint(point, radius, candidates);
      const expected = boxes.flatMap((box, index) =>
        pointBoxDistanceSquared(point, box.min, box.max) < radius * radius ? [index] : []);
      expect([...candidates].sort((a, b) => a - b)).toEqual(expected);
    }
  });

  it("matches brute-force finite ray candidates", () => {
    const candidates: number[] = [];
    for (let sample = 0; sample < 80; sample++) {
      const origin = new Vector3(random() * 200 - 100, random() * 40 - 20, random() * 200 - 100);
      const direction = new Vector3(random() - 0.5, random() - 0.5, random() - 0.5).normalize();
      const limit = random() * 120 + 1;
      broadPhase.queryRay(origin, direction, limit, candidates);
      const expected = boxes.flatMap((box, index) => rayHits(origin, direction, box, limit) ? [index] : []);
      expect([...candidates].sort((a, b) => a - b)).toEqual(expected);
    }
  });
});
