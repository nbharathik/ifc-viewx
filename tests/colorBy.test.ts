import { describe, expect, it } from "vitest";

import { applyColors, computeColors, cssColor, type ColorResult } from "../src/ui/colorBy.js";
import type { SpatialNode, Viewer } from "../src/viewer-core/viewer.js";
import type { ElementRow } from "../src/sdk/data.js";

/** A tree with two storeys, so class and storey rules both have something. */
function tree(): SpatialNode {
  const node = (expressID: number, type: string, name: string | null, children: SpatialNode[] = []): SpatialNode => ({
    expressID,
    type,
    name,
    children,
  });
  return node(1, "IfcProject", "P", [
    node(2, "IfcBuildingStorey", "L1", [
      node(10, "IfcWall", "W1"),
      node(11, "IfcWall", "W2"),
      node(12, "IfcDoor", "D1"),
    ]),
    node(3, "IfcBuildingStorey", "L2", [node(20, "IfcWall", "W3"), node(21, "IfcSlab", "S1")]),
  ]);
}

function fakeViewer(withGeometry: Set<number>): Viewer {
  return {
    getSpatialTree: () => tree(),
    hasGeometry: (id: number) => withGeometry.has(id),
    setColorOverride: () => undefined,
    clearColorOverride: () => undefined,
  } as unknown as Viewer;
}

const ALL = new Set([10, 11, 12, 20, 21]);

const row = (id: number, props: Record<string, unknown>): ElementRow =>
  ({ id, type: "IfcWall", name: `E${id}`, storey: "L1", globalId: "", attrs: {}, props }) as ElementRow;

describe("colour by class", () => {
  it("groups by class, largest first, and assigns 1-based palette indices", () => {
    const result = computeColors(fakeViewer(ALL), { kind: "class" }, []);
    expect(result.groups.map((g) => g.label)).toEqual(["Wall", "Door", "Slab"]);
    expect(result.groups[0].count).toBe(3);
    // Index 0 means "untouched" in the state texture, so nothing may claim it.
    expect([...result.assignment.values()].every((index) => index >= 1)).toBe(true);
    expect(result.assignment.get(10)).toBe(1);
    expect(result.assignment.get(12)).toBe(2);
  });

  it("skips elements the viewer has no geometry for", () => {
    const result = computeColors(fakeViewer(new Set([10, 11])), { kind: "class" }, []);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].count).toBe(2);
    expect(result.assignment.has(12)).toBe(false);
  });

  it("gives every group a distinct colour", () => {
    const result = computeColors(fakeViewer(ALL), { kind: "class" }, []);
    const colors = new Set(result.groups.map((g) => cssColor(g.color)));
    expect(colors.size).toBe(result.groups.length);
  });
});

describe("colour by storey", () => {
  it("groups by the storey each element sits under", () => {
    const result = computeColors(fakeViewer(ALL), { kind: "storey" }, []);
    expect(result.groups.map((g) => g.label).sort()).toEqual(["L1", "L2"]);
    const l1 = result.groups.find((g) => g.label === "L1");
    expect(l1?.count).toBe(3);
  });
});

describe("colour by property", () => {
  it("groups by exact value when there are few of them", () => {
    const rows = [
      row(10, { "Pset.FireRating": "REI 60" }),
      row(11, { "Pset.FireRating": "REI 60" }),
      row(12, { "Pset.FireRating": "REI 30" }),
      row(20, {}),
    ];
    const result = computeColors(fakeViewer(ALL), { kind: "property", key: "Pset.FireRating" }, rows);
    expect(result.groups.map((g) => g.label)).toEqual(["REI 60", "REI 30", "(not set)"]);
    // "(not set)" is always last, however many carry it.
    expect(result.groups[result.groups.length - 1].label).toBe("(not set)");
  });

  it("bands numbers once there are more distinct values than labels are worth", () => {
    const ids = [10, 11, 12, 20, 21];
    const geometry = new Set(ids);
    const rows = ids.map((id, i) => row(id, { "Qto.Area": i * 1.5 + 0.25 }));
    const many = [...rows];
    // Push past the banding threshold with values the viewer also has geometry for.
    for (let i = 0; i < 20; i++) {
      const id = 100 + i;
      geometry.add(id);
      many.push(row(id, { "Qto.Area": i * 3.7 }));
    }
    const result = computeColors(fakeViewer(geometry), { kind: "property", key: "Qto.Area" }, many);
    expect(result.groups.length).toBeGreaterThan(1);
    expect(result.groups.length).toBeLessThanOrEqual(8);
    // A band reads as a range, which is the whole point of banding.
    expect(result.groups[0].label).toMatch(/ to /);
  });

  it("returns nothing when the rule points at a property no element carries", () => {
    const result = computeColors(fakeViewer(ALL), { kind: "property", key: "Nope.Missing" }, [row(10, {})]);
    expect(result.groups.map((g) => g.label)).toEqual(["(not set)"]);
  });
});

describe("applying a rule", () => {
  it("clears the override when the rule produced no groups", () => {
    let cleared = false;
    let applied = false;
    const viewer = {
      clearColorOverride: () => (cleared = true),
      setColorOverride: () => (applied = true),
    } as unknown as Viewer;
    applyColors(viewer, { groups: [], assignment: new Map(), unset: 0 } as ColorResult);
    expect(cleared).toBe(true);
    expect(applied).toBe(false);
  });

  it("passes the palette in group order", () => {
    let seen: Array<[number, number, number]> = [];
    const viewer = {
      clearColorOverride: () => undefined,
      setColorOverride: (_a: Map<number, number>, colors: Array<[number, number, number]>) => (seen = colors),
    } as unknown as Viewer;
    const result = computeColors(fakeViewer(ALL), { kind: "class" }, []);
    applyColors(viewer, result);
    expect(seen).toHaveLength(result.groups.length);
    expect(seen[0]).toEqual(result.groups[0].color);
  });

  it("keeps none as a no-op", () => {
    const result = computeColors(fakeViewer(ALL), { kind: "none" }, []);
    expect(result.groups).toHaveLength(0);
    expect(result.assignment.size).toBe(0);
  });
});
