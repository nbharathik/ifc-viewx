import { describe, expect, it } from "vitest";

import { explodeOffsets, storeyElementSets, storeySlideOffsets } from "../src/viewer-core/arrange.js";
import type { SpatialNode } from "../src/viewer-core/viewer.js";

const node = (
  expressID: number,
  type: string,
  name: string | null,
  children: SpatialNode[] = [],
): SpatialNode => ({ expressID, type, name, children });

const tree = (): SpatialNode =>
  node(1, "IfcProject", "P", [
    node(2, "IfcSite", "S", [
      node(3, "IfcBuilding", "B", [
        node(10, "IfcBuildingStorey", "L1", [node(100, "IfcWall", "W1"), node(101, "IfcSlab", "S1")]),
        node(20, "IfcBuildingStorey", "L2", [node(200, "IfcWall", "W2")]),
        node(30, "IfcBuildingStorey", "L3", [node(300, "IfcColumn", "C1"), node(301, "IfcBeam", "B1")]),
      ]),
    ]),
  ]);

describe("storey element sets", () => {
  it("collects the storeys in tree order with every descendant id", () => {
    const sets = storeyElementSets(tree());
    expect(sets.map((s) => s.name)).toEqual(["L1", "L2", "L3"]);
    expect(sets[0].ids).toContain(100);
    expect(sets[0].ids).toContain(101);
    expect(sets[0].ids).toContain(10);
    expect(sets[2].ids).toEqual(expect.arrayContaining([30, 300, 301]));
  });

  it("returns nothing for an empty tree", () => {
    expect(storeyElementSets(null)).toEqual([]);
  });
});

describe("storey slide", () => {
  it("moves storey i by spacing * i along the chosen axis", () => {
    const entries = new Map(storeySlideOffsets(tree(), "y", 4));
    expect(entries.get(100)).toEqual([0, 0, 0]);
    expect(entries.get(200)).toEqual([0, 4, 0]);
    expect(entries.get(300)).toEqual([0, 8, 0]);
    expect(entries.get(301)).toEqual([0, 8, 0]);
  });

  it("writes explicit zeros at spacing 0 so a slide can be undone", () => {
    const entries = storeySlideOffsets(tree(), "z", 0);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every(([, offset]) => offset.every((v) => v === 0))).toBe(true);
  });

  it("slides along x when asked", () => {
    const entries = new Map(storeySlideOffsets(tree(), "x", 2));
    expect(entries.get(200)).toEqual([2, 0, 0]);
  });
});

describe("explode", () => {
  const centers = new Map<number, [number, number, number]>([
    [1, [0, 0, 0]],
    [2, [10, 0, 0]],
    [3, [0, 20, 0]],
  ]);
  const centerOf = (id: number): [number, number, number] | null => centers.get(id) ?? null;

  it("pushes elements away from the origin in proportion to distance", () => {
    const entries = new Map(explodeOffsets(centers.keys(), centerOf, [0, 0, 0], 0.5));
    expect(entries.get(1)).toEqual([0, 0, 0]);
    expect(entries.get(2)).toEqual([5, 0, 0]);
    expect(entries.get(3)).toEqual([0, 10, 0]);
  });

  it("factor 0 writes zeros for every element", () => {
    const entries = explodeOffsets(centers.keys(), centerOf, [5, 5, 5], 0);
    expect(entries.every(([, offset]) => offset.every((v) => v === 0))).toBe(true);
  });

  it("skips elements without geometry", () => {
    const entries = explodeOffsets([1, 99], centerOf, [0, 0, 0], 1);
    expect(entries.map(([id]) => id)).toEqual([1]);
  });
});
