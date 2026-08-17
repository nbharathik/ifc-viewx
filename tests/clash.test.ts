import { describe, expect, it } from "vitest";
import { boxesOverlap, candidatePairs, cellSize, type BroadItem } from "../src/ifc/clash/broadphase.js";
import { ClashGeometryIndex, runSweep } from "../src/ifc/clash/sweep.js";
import { clashReport, detectClashes, idsOfTypes } from "../src/ifc/clash.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";
import { packId } from "../src/viewer-core/ids.js";
import type { IfcMesh, SpatialNode } from "../src/viewer-core/engine/types.js";
import type { SweepSpec } from "../src/ifc/clash/types.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

/**
 * An axis-aligned box as a mesh, so a test can put two solids in known places
 * and ask whether their surfaces really meet. The whole point of these tests is
 * that a box's geometry and a box's AABB are not the same thing.
 */
function boxMesh(
  expressID: number,
  type: string,
  size: [number, number, number],
  at: [number, number, number],
  geometryID = expressID,
): IfcMesh {
  const [sx, sy, sz] = size.map((value) => value / 2) as [number, number, number];
  const corners: number[] = [];
  for (let i = 0; i < 8; i++) {
    corners.push(i & 1 ? sx : -sx, i & 2 ? sy : -sy, i & 4 ? sz : -sz);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const indices: number[] = [];
  for (const [a, b, c, d] of quads) indices.push(a, b, c, a, c, d);
  return {
    expressID,
    ifcType: type,
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(corners),
      normals: new Float32Array(corners.length),
      indices: new Uint32Array(indices),
    },
    geometryID,
    localBounds: { min: { x: -sx, y: -sy, z: -sz }, max: { x: sx, y: sy, z: sz } },
  };
}

/**
 * The same box as web-ifc actually delivers it: flat shaded, four fresh
 * vertices per face, so every crease edge appears only once in the index.
 */
function soupBoxMesh(
  expressID: number,
  type: string,
  size: [number, number, number],
  at: [number, number, number],
): IfcMesh {
  const [sx, sy, sz] = size.map((value) => value / 2) as [number, number, number];
  const corners: number[][] = [];
  for (let i = 0; i < 8; i++) {
    corners.push([i & 1 ? sx : -sx, i & 2 ? sy : -sy, i & 4 ? sz : -sz]);
  }
  const quads: Array<[number, number, number, number]> = [
    [0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4],
    [2, 6, 7, 3], [0, 4, 6, 2], [1, 3, 7, 5],
  ];
  const positions: number[] = [];
  const indices: number[] = [];
  for (const quad of quads) {
    const base = positions.length / 3;
    for (const corner of quad) positions.push(...corners[corner]);
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  return {
    expressID,
    ifcType: type,
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(indices),
    },
    geometryID: expressID,
    localBounds: { min: { x: -sx, y: -sy, z: -sz }, max: { x: sx, y: sy, z: sz } },
  };
}

function rotateZ(mesh: IfcMesh, radians: number, translation: [number, number, number]): IfcMesh {
  const c = Math.cos(radians);
  const s = Math.sin(radians);
  mesh.matrix = [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, ...translation, 1];
  return mesh;
}

/**
 * A tube of triangles running along X, used to check that a slender element
 * threaded past a wall is not reported just because their boxes overlap.
 */
function rodMesh(expressID: number, at: [number, number, number], length: number, radius: number): IfcMesh {
  const sides = 12;
  const positions: number[] = [];
  const indices: number[] = [];
  for (let ring = 0; ring < 2; ring++) {
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      positions.push(ring ? length / 2 : -length / 2, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
  }
  for (let i = 0; i < sides; i++) {
    const next = (i + 1) % sides;
    indices.push(i, next, sides + i, next, sides + next, sides + i);
  }
  return {
    expressID,
    ifcType: "IfcPipeSegment",
    color: { r: 1, g: 1, b: 1, a: 1 },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, at[0], at[1], at[2], 1],
    geometry: {
      positions: new Float32Array(positions),
      normals: new Float32Array(positions.length),
      indices: new Uint32Array(indices),
    },
    geometryID: expressID,
    localBounds: {
      min: { x: -length / 2, y: -radius, z: -radius },
      max: { x: length / 2, y: radius, z: radius },
    },
  };
}

/** A store wired straight into an index, which is what the worker does. */
function feed(index: ClashGeometryIndex): TriangleStore {
  const store = new TriangleStore();
  store.connect({
    chunk: (chunk) => index.addChunk(chunk),
    dropModel: (model) => index.dropModel(model),
    clear: () => index.clear(),
    dispose: () => index.clear(),
  });
  return store;
}

function indexOf(meshes: IfcMesh[], model = 0): ClashGeometryIndex {
  const index = new ClashGeometryIndex();
  feed(index).add(meshes, model);
  return index;
}

function spec(a: number[], b: number[], over: Partial<SweepSpec> = {}): SweepSpec {
  return {
    a: Float64Array.from(a),
    b: Float64Array.from(b),
    origin: [0, 0, 0],
    offsets: new Float64Array(0),
    toleranceMm: 1,
    clearanceMm: 0,
    limit: 1000,
    ...over,
  };
}

describe("broad phase", () => {
  const item = (id: number, min: [number, number, number], max: [number, number, number]): BroadItem => ({ id, min, max });

  it("sizes the grid from the median element", () => {
    expect(cellSize([item(1, [0, 0, 0], [1, 1, 1]), item(2, [0, 0, 0], [1, 1, 1])])).toBeCloseTo(2);
  });

  it("keeps a floor under the cell size so tiny elements do not explode the grid", () => {
    expect(cellSize([item(1, [0, 0, 0], [0.001, 0.001, 0.001])])).toBe(0.25);
  });

  it("counts a margin as overlap", () => {
    const a = item(1, [0, 0, 0], [1, 1, 1]);
    const b = item(2, [1.05, 0, 0], [2, 1, 1]);
    expect(boxesOverlap(a, b, 0)).toBe(false);
    expect(boxesOverlap(a, b, 0.1)).toBe(true);
  });

  it("pairs only the boxes that meet", () => {
    const a = [item(1, [0, 0, 0], [1, 1, 1])];
    const b = [item(2, [0.5, 0, 0], [1.5, 1, 1]), item(3, [50, 0, 0], [51, 1, 1])];
    const pairs: Array<[number, number]> = [];
    candidatePairs(a, b, 0, (one, others) => others.forEach((other) => pairs.push([one.id, other.id])));
    expect(pairs).toEqual([[1, 2]]);
  });

  it("reports a pair once when a set is swept against itself", () => {
    const items = [item(1, [0, 0, 0], [2, 2, 2]), item(2, [1, 1, 1], [3, 3, 3])];
    const pairs: Array<[number, number]> = [];
    candidatePairs(items, items, 0, (one, others) => others.forEach((other) => pairs.push([one.id, other.id])));
    expect(pairs).toEqual([[1, 2]]);
  });

  it("hands out a candidate list the caller can keep", () => {
    const a = [item(1, [0, 0, 0], [1, 1, 1]), item(2, [10, 0, 0], [11, 1, 1])];
    const b = [item(3, [0.5, 0, 0], [1.5, 1, 1]), item(4, [10.5, 0, 0], [11.5, 1, 1])];
    const kept: Array<[number, BroadItem[]]> = [];
    candidatePairs(a, b, 0, (one, others) => kept.push([one.id, others]));
    expect(kept.map(([id, others]) => [id, others.map((other) => other.id)])).toEqual([
      [1, [3]],
      [2, [4]],
    ]);
  });

  it("never pairs an element with itself", () => {
    const items = [item(1, [0, 0, 0], [2, 2, 2])];
    const pairs: Array<[number, number]> = [];
    candidatePairs(items, items, 0, (one, others) => others.forEach((other) => pairs.push([one.id, other.id])));
    expect(pairs).toEqual([]);
  });

  it("drops invalid boxes and repeated ids before building the grid", () => {
    const repeated = item(2, [0.5, 0, 0], [1.5, 1, 1]);
    const pairs: Array<[number, number]> = [];
    candidatePairs(
      [item(1, [0, 0, 0], [1, 1, 1]), item(1, [0, 0, 0], [1, 1, 1])],
      [repeated, repeated, item(3, [NaN, 0, 0], [1, 1, 1])],
      Infinity,
      (one, others) => others.forEach((other) => pairs.push([one.id, other.id])),
    );
    expect(pairs).toEqual([[1, 2]]);
  });
});

describe("triangle store", () => {
  it("sends each geometry once however many placements use it", () => {
    const store = new TriangleStore();
    const chunks: number[] = [];
    store.connect({
      chunk: (chunk) => chunks.push(chunk.geometryIDs.length),
      dropModel: () => undefined,
      clear: () => undefined,
      dispose: () => undefined,
    });
    store.add([boxMesh(1, "IfcWall", [1, 1, 1], [0, 0, 0], 99), boxMesh(2, "IfcWall", [1, 1, 1], [5, 0, 0], 99)], 0);
    store.add([boxMesh(3, "IfcWall", [1, 1, 1], [9, 0, 0], 99)], 0);
    expect(chunks).toEqual([1, 0]);
  });

  it("hands the backlog over when a consumer connects late", () => {
    const store = new TriangleStore();
    store.add([boxMesh(1, "IfcWall", [1, 1, 1], [0, 0, 0])], 0);
    let seen = 0;
    store.connect({ chunk: () => (seen += 1), dropModel: () => undefined, clear: () => undefined, dispose: () => undefined });
    expect(seen).toBe(1);
  });

  it("packs the placement of every mesh, shared geometry included", () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [1, 1, 1], [0, 0, 0], 99),
      boxMesh(2, "IfcWall", [1, 1, 1], [5, 0, 0], 99),
    ]);
    expect(index.elementCount).toBe(2);
    expect(index.worldBounds(2, [0, 0, 0], [0, 0, 0])?.min[0]).toBeCloseTo(4.5);
  });
});

describe("hard clashes", () => {
  it("finds two solids that really overlap", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("hard");
    expect(result.hits[0].a).toBe(1);
    expect(result.hits[0].b).toBe(2);
  });

  it("measures the penetration, not the box overlap", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.9, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.hits[0].distance).toBeCloseTo(0.1, 3);
  });

  it("keeps the penetration estimate stable when both solids are rotated", async () => {
    const angle = Math.PI / 4;
    const direction: [number, number, number] = [Math.cos(angle) * 1.9, Math.sin(angle) * 1.9, 0];
    const index = indexOf([
      rotateZ(boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]), angle, [0, 0, 0]),
      rotateZ(boxMesh(2, "IfcDuctSegment", [2, 2, 2], [0, 0, 0]), angle, direction),
    ]);
    const [hit] = (await runSweep(index, spec([1], [2]))).hits;
    expect(hit.distance).toBeCloseTo(0.1, 3);
  });

  it("puts the clash point inside the overlap", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
    ]);
    const [hit] = (await runSweep(index, spec([1], [2]))).hits;
    expect(hit.point[0]).toBeGreaterThan(0.4);
    expect(hit.point[0]).toBeLessThan(1.1);
    expect(Math.abs(hit.point[1])).toBeLessThan(1.01);
  });

  it("does not report two boxes that overlap while their meshes miss", async () => {
    // The rod runs along X just outside the corner edge of the wall: the two
    // AABBs overlap, but the corner is 113 mm from the axis of a 100 mm rod,
    // so no triangle of one crosses a triangle of the other.
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      rodMesh(2, [0, 1.08, 1.08], 6, 0.1),
    ]);
    const boxes = [index.worldBounds(1, [0, 0, 0], [0, 0, 0])!, index.worldBounds(2, [0, 0, 0], [0, 0, 0])!];
    expect(boxesOverlap(boxes[0], boxes[1], 0)).toBe(true);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.pairsTested).toBe(1);
    expect(result.hits).toEqual([]);
  });

  it("reports the same rod once it is driven through the wall", async () => {
    const index = indexOf([boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]), rodMesh(2, [0, 0, 0], 6, 0.1)]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.hits).toHaveLength(1);
  });

  it("treats two solids that only touch as a graze, not a clash", async () => {
    const index = indexOf([
      boxMesh(1, "IfcSlab", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcWall", [2, 2, 2], [2, 0, 0]),
    ]);
    expect((await runSweep(index, spec([1], [2]))).hits).toEqual([]);
  });

  it("honours the tolerance", async () => {
    // The two solids overlap by exactly 10 mm.
    const meshes = [boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]), boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.99, 0, 0])];
    expect((await runSweep(indexOf(meshes), spec([1], [2], { toleranceMm: 20 }))).hits).toEqual([]);
    expect((await runSweep(indexOf(meshes), spec([1], [2], { toleranceMm: 5 }))).hits).toHaveLength(1);
  });

  it("does not turn a tolerated penetration into a zero-gap clearance failure", async () => {
    const meshes = [
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.995, 0, 0]),
    ];
    const result = await runSweep(indexOf(meshes), spec([1], [2], { toleranceMm: 10, clearanceMm: 100 }));
    expect(result.hits).toEqual([]);
  });

  it("reports nothing for elements that are far apart", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [40, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.pairsTested).toBe(0);
    expect(result.hits).toEqual([]);
  });

  it("reports an element swallowed whole, which crosses no triangles at all", async () => {
    const index = indexOf([
      boxMesh(1, "IfcSlab", [4, 4, 4], [0, 0, 0]),
      boxMesh(2, "IfcValve", [0.4, 0.4, 0.4], [0, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("hard");
    expect(result.hits[0].distance).toBeCloseTo(0.4, 3);
  });

  it("finds containment inside a flat-shaded triangle-soup solid, web-ifc style", async () => {
    const index = indexOf([
      soupBoxMesh(1, "IfcSlab", [4, 4, 4], [0, 0, 0]),
      boxMesh(2, "IfcValve", [0.4, 0.4, 0.4], [0, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2]));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("hard");
    expect(result.hits[0].distance).toBeCloseTo(0.4, 3);
  });

  it("finds containment even when the outer solid has reversed winding", async () => {
    const outer = boxMesh(1, "IfcSlab", [4, 4, 4], [0, 0, 0]);
    const indices = outer.geometry.indices;
    for (let offset = 0; offset < indices.length; offset += 3) {
      const second = indices[offset + 1];
      indices[offset + 1] = indices[offset + 2];
      indices[offset + 2] = second;
    }
    const result = await runSweep(indexOf([
      outer,
      boxMesh(2, "IfcValve", [0.4, 0.4, 0.4], [0, 0, 0]),
    ]), spec([1], [2]));
    expect(result.hits).toHaveLength(1);
  });

  it("does not infer a contained solid inside an open shell", async () => {
    const shell = boxMesh(1, "IfcSlab", [4, 4, 4], [0, 0, 0]);
    shell.geometry.indices = shell.geometry.indices.slice(0, -6);
    const result = await runSweep(indexOf([
      shell,
      boxMesh(2, "IfcValve", [0.4, 0.4, 0.4], [0, 0, 0]),
    ]), spec([1], [2]));
    expect(result.hits).toEqual([]);
  });

  it("filters malformed faces without losing the valid solid", async () => {
    const wall = boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]);
    wall.geometry.indices = new Uint32Array([...wall.geometry.indices, 0, 0, 1, 999]);
    const result = await runSweep(indexOf([
      wall,
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
    ]), spec([1], [2]));
    expect(result.hits).toHaveLength(1);
  });

  it("deduplicates repeated ids before testing", async () => {
    const result = await runSweep(indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
    ]), spec([1, 1], [2, 2]));
    expect(result.elementsA).toBe(1);
    expect(result.elementsB).toBe(1);
    expect(result.pairsTested).toBe(1);
    expect(result.hits).toHaveLength(1);
  });

  it("counts elements it has no geometry for rather than silently skipping them", async () => {
    const index = indexOf([boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0])]);
    const result = await runSweep(index, spec([1], [2, 3]));
    expect(result.missing).toBe(2);
  });
});

describe("clearance", () => {
  it("reports a gap under the limit as its true surface distance", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [2.05, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2], { clearanceMm: 100 }));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("clearance");
    expect(result.hits[0].distance).toBeCloseTo(0.05, 3);
  });

  it("stays quiet when the gap is wide enough", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [2.5, 0, 0]),
    ]);
    expect((await runSweep(index, spec([1], [2], { clearanceMm: 100 }))).hits).toEqual([]);
  });

  it("prefers the hard clash when a pair both touches and is close", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2], { clearanceMm: 200 }));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("hard");
  });
});

describe("results", () => {
  it("puts hard clashes before near misses, worst first", async () => {
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
      boxMesh(3, "IfcDuctSegment", [2, 2, 2], [1.9, 0, 0]),
      boxMesh(4, "IfcDuctSegment", [2, 2, 2], [2.05, 0, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2, 3, 4], { clearanceMm: 100 }));
    expect(result.hits.map((hit) => [hit.b, hit.kind])).toEqual([
      [2, "hard"],
      [3, "hard"],
      [4, "clearance"],
    ]);
  });

  it("stops at the limit and says so", async () => {
    const meshes = [boxMesh(1, "IfcWall", [10, 2, 2], [0, 0, 0])];
    for (let i = 0; i < 5; i++) meshes.push(boxMesh(10 + i, "IfcDuctSegment", [2, 2, 2], [i * 1.5, 1.5, 0]));
    const ducts = meshes.slice(1).map((mesh) => mesh.expressID);
    const all = await runSweep(indexOf(meshes), spec([1], ducts));
    expect(all.hits.length).toBeGreaterThan(2);
    const capped = await runSweep(indexOf(meshes), spec([1], ducts, { limit: 2 }));
    expect(capped.hits).toHaveLength(2);
    expect(capped.truncated).toBe(true);
  });

  it("stops when the caller cancels", async () => {
    const meshes = [boxMesh(1, "IfcWall", [10, 2, 2], [0, 0, 0])];
    for (let i = 0; i < 5; i++) meshes.push(boxMesh(10 + i, "IfcDuctSegment", [2, 2, 2], [i * 1.5, 1.5, 0]));
    const result = await runSweep(indexOf(meshes), spec([1], meshes.slice(1).map((mesh) => mesh.expressID)), {
      cancelled: () => true,
    });
    expect(result.truncated).toBe(true);
  });

  it("reports pair-level progress and yields inside one large candidate list", async () => {
    const meshes = [boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0])];
    for (let index = 0; index < 405; index++) {
      meshes.push(boxMesh(10 + index, "IfcDuctSegment", [2, 2, 2], [0, 0, 0]));
    }
    const updates: Array<{ done: number; total: number }> = [];
    await runSweep(indexOf(meshes), spec([1], meshes.slice(1).map((mesh) => mesh.expressID), {
      toleranceMm: 5_000,
    }), {
      onProgress: ({ done, total }) => updates.push({ done, total }),
      yieldTurn: async () => undefined,
    });
    expect(updates).toEqual([{ done: 400, total: 405 }, { done: 405, total: 405 }]);
  });
});

describe("federation", () => {
  it("clashes across two models through their packed ids", async () => {
    const index = new ClashGeometryIndex();
    const store = feed(index);
    store.add([boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0])], 0);
    store.add([boxMesh(1, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0])], 1);
    const other = packId(1, 1);
    const result = await runSweep(index, spec([1], [other]));
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].b).toBe(other);
  });

  it("moves a model when its offset moves, so a nudge changes the answer", async () => {
    const index = new ClashGeometryIndex();
    const store = feed(index);
    store.add([boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0])], 0);
    store.add([boxMesh(1, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0])], 1);
    const other = packId(1, 1);
    const apart = await runSweep(index, spec([1], [other], { offsets: Float64Array.from([1, 20, 0, 0]) }));
    expect(apart.hits).toEqual([]);
  });

  it("forgets a model that was unloaded", async () => {
    const index = new ClashGeometryIndex();
    const store = feed(index);
    store.add([boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0])], 0);
    store.add([boxMesh(1, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0])], 1);
    store.dropModel(1);
    const result = await runSweep(index, spec([1], [packId(1, 1)]));
    expect(result.hits).toEqual([]);
    expect(result.missing).toBe(1);
  });
});

describe("origin shift", () => {
  it("gives the same answer for a model placed far from the origin", async () => {
    const far = 500_000;
    const index = indexOf([
      boxMesh(1, "IfcWall", [2, 2, 2], [far, far, 0]),
      boxMesh(2, "IfcDuctSegment", [2, 2, 2], [far + 1.9, far, 0]),
    ]);
    const result = await runSweep(index, spec([1], [2], {}));
    const shifted = await runSweep(index, spec([1], [2], { origin: [far, far, 0] }));
    expect(shifted.hits).toHaveLength(1);
    expect(shifted.hits[0].distance).toBeCloseTo(0.1, 2);
    expect(result.hits).toHaveLength(1);
  });
});

/**
 * A viewer stub with only the parts a sweep reads. The point is to run the
 * assistant's whole path, from class names down to the reported millimetres,
 * without a renderer or an IFC file.
 */
function stubViewer(meshes: IfcMesh[]): Viewer {
  const store = new TriangleStore();
  const tree: SpatialNode = {
    expressID: 1,
    type: "IfcProject",
    name: "Project",
    children: [{
      expressID: 2,
      type: "IfcBuildingStorey",
      name: "L1",
      children: meshes.map((mesh) => ({
        expressID: mesh.expressID,
        type: mesh.ifcType,
        name: `${mesh.ifcType} ${mesh.expressID}`,
        children: [],
      })),
    }],
  };
  const ids = new Set(meshes.map((mesh) => mesh.expressID));
  store.add(meshes, 0);
  return {
    getTriangles: () => store,
    getSpatialTree: () => tree,
    hasGeometry: (id: number) => ids.has(id),
    getModels: () => [{ index: 0, name: "Model", visible: true, offset: [0, 0, 0], elements: meshes.length, triangles: 0 }],
    getModelOrigin: () => [0, 0, 0],
  } as unknown as Viewer;
}

describe("the sweep as the assistant and panels reach it", () => {
  const meshes = [
    boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]),
    boxMesh(2, "IfcSlab", [6, 0.3, 6], [0, 1.2, 0]),
    boxMesh(3, "IfcDuctSegment", [2, 2, 2], [1.5, 0, 0]),
  ];

  it("picks out the ids of the classes asked for", () => {
    const viewer = stubViewer(meshes);
    const elements = [
      { id: 1, type: "IfcWall", name: "", storey: "L1" },
      { id: 3, type: "IfcDuctSegment", name: "", storey: "L1" },
    ];
    expect(idsOfTypes(elements, new Set(["IfcWall"]), (id) => viewer.hasGeometry(id))).toEqual([1]);
  });

  it("runs a sweep straight off a viewer", async () => {
    const result = await detectClashes(stubViewer(meshes), [1], [3], { toleranceMm: 1 });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0].kind).toBe("hard");
  });

  it("reports what it found in the shape an assistant reads", async () => {
    const report = await clashReport(stubViewer(meshes), ["IfcWall"], ["IfcDuctSegment"], 1);
    expect(report.clashes).toBe(1);
    expect(report.elementsA).toBe(1);
    expect(report.method).toContain("triangle");
    const worst = report.worst as Array<Record<string, unknown>>;
    expect(worst[0].penetrationMm).toBe(500);
    expect((worst[0].a as { type: string }).type).toBe("IfcWall");
    expect(worst[0]).toMatchObject({ classPair: "DuctSegment|Wall", level: "L1", severity: "critical" });
    expect(report.rows).toHaveLength(1);
  });

  it("names the empty side rather than reporting a clean model", async () => {
    await expect(clashReport(stubViewer(meshes), ["IfcWall"], ["IfcPipeSegment"], 1)).rejects.toThrow(
      /set B \(IfcPipeSegment\)/,
    );
  });

  it("reports a clearance failure through the same path", async () => {
    const apart = [boxMesh(1, "IfcWall", [2, 2, 2], [0, 0, 0]), boxMesh(3, "IfcDuctSegment", [2, 2, 2], [2.05, 0, 0])];
    const report = await clashReport(stubViewer(apart), ["IfcWall"], ["IfcDuctSegment"], 1, 100);
    expect(report.clashes).toBe(0);
    expect(report.clearanceFailures).toBe(1);
    const worst = report.worst as Array<Record<string, unknown>>;
    expect(worst[0].gapMm).toBe(50);
  });
});
