// Federation without a GPU: the id namespace and the tree rewrite are pure,
// and they are where a mistake would silently merge two disciplines.
import { describe, expect, it } from "vitest";
import { packTree } from "../src/viewer-core/viewer.js";
import { byModel, expressOf, modelOf, packId } from "../src/viewer-core/ids.js";
import type { SpatialNode } from "../src/viewer-core/viewer.js";

const tree = (): SpatialNode =>
  ({
    expressID: 1,
    type: "IfcProject",
    name: "Sample",
    children: [
      {
        expressID: 2,
        type: "IfcBuildingStorey",
        name: "Level 1",
        children: [
          { expressID: 47, type: "IfcWall", name: "South wall", children: [] },
          { expressID: 60, type: "IfcWall", name: "North wall", children: [] },
        ],
      },
    ],
  }) as SpatialNode;

const ids = (node: SpatialNode): number[] => [
  node.expressID,
  ...node.children.flatMap(ids),
];

describe("packTree", () => {
  it("returns the very same object for model 0, so one model is untouched", () => {
    const source = tree();
    expect(packTree(source, 0)).toBe(source);
  });

  it("packs every id in the tree for a later model", () => {
    const packed = packTree(tree(), 1);
    expect(ids(packed)).toEqual([1, 2, 47, 60].map((id) => packId(1, id)));
  });

  it("leaves the source tree alone", () => {
    const source = tree();
    packTree(source, 2);
    expect(ids(source)).toEqual([1, 2, 47, 60]);
  });

  it("keeps names and types, which the tree panel renders", () => {
    const packed = packTree(tree(), 3);
    expect(packed.name).toBe("Sample");
    expect(packed.children[0].children[1].name).toBe("North wall");
    expect(packed.children[0].type).toBe("IfcBuildingStorey");
  });

  it("round-trips back to the raw ids the engine wants", () => {
    const packed = packTree(tree(), 5);
    expect(ids(packed).map(expressOf)).toEqual([1, 2, 47, 60]);
    expect(ids(packed).map(modelOf)).toEqual([5, 5, 5, 5]);
  });
});

describe("two files with the same expressIDs", () => {
  // This is the case federation exists for: the architecture file and the
  // services file both have a #47, and they must not become one element.
  const a = packTree(tree(), 0);
  const b = packTree(tree(), 1);

  it("produces no overlapping ids", () => {
    const overlap = ids(a).filter((id) => ids(b).includes(id));
    expect(overlap).toEqual([]);
  });

  it("keeps the first file's ids raw", () => {
    expect(ids(a)).toEqual([1, 2, 47, 60]);
  });

  it("names each id's own file", () => {
    for (const id of ids(a)) expect(modelOf(id)).toBe(0);
    for (const id of ids(b)) expect(modelOf(id)).toBe(1);
  });

  it("splits a mixed selection back into per-file engine queries", () => {
    const mixed = [packId(0, 47), packId(1, 47), packId(1, 60)];
    expect(byModel(mixed)).toEqual(new Map([
      [0, [47]],
      [1, [47, 60]],
    ]));
  });

  it("survives a Set, which is how the viewer holds a selection", () => {
    const selection = new Set([...ids(a), ...ids(b)]);
    expect(selection.size).toBe(8);
    expect(selection.has(packId(1, 47))).toBe(true);
    expect(selection.has(packId(2, 47))).toBe(false);
  });
});
