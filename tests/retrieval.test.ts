import { describe, expect, it } from "vitest";
import { buildIndex, tokenize } from "../src/llm/retrieval.js";
import type { ModelElement } from "../src/sdk/types.js";

const el = (id: number, type: string, name: string, storey: string): ModelElement =>
  ({ id, type, name, storey });

const MODEL: ModelElement[] = [
  el(1, "IfcWallStandardCase", "Basic Wall - Exterior 200mm", "Level 1"),
  el(2, "IfcWallStandardCase", "Basic Wall - Interior 100mm", "Level 1"),
  el(3, "IfcDoor", "Single Flush Fire Rated 60min", "Level 1"),
  el(4, "IfcDoor", "Double Glazed Entrance", "Level 2"),
  el(5, "IfcWindow", "Fixed Window 1200x1500", "Level 2"),
  el(6, "IfcSlab", "Floor Slab 300mm", "Level 2"),
];

describe("tokenize", () => {
  it("lowercases and drops separators", () => {
    expect(tokenize("Basic Wall - Exterior")).toContain("basic");
    expect(tokenize("Basic Wall - Exterior")).toContain("exterior");
  });

  it("splits camel case but keeps the whole word", () => {
    const terms = tokenize("IfcWallStandardCase");
    expect(terms).toContain("ifcwallstandardcase");
    expect(terms).toContain("wall");
    expect(terms).toContain("standard");
  });

  it("drops single characters, which carry no signal", () => {
    expect(tokenize("a b wall")).toEqual(["wall"]);
  });

  it("keeps digits, so a size is searchable", () => {
    expect(tokenize("Window 1200x1500")).toContain("1200");
  });
});

describe("bm25 search", () => {
  const index = buildIndex(MODEL);

  it("indexes every element", () => {
    expect(index.size).toBe(MODEL.length);
  });

  it("finds by a word from the name", () => {
    const hits = index.search("fire rated", 5);
    expect(hits[0].id).toBe(3);
  });

  it("finds by class without the Ifc prefix", () => {
    const ids = index.search("window", 5).map((hit) => hit.id);
    expect(ids).toContain(5);
  });

  it("ranks a two-word match above a one-word match", () => {
    const hits = index.search("exterior wall", 5);
    expect(hits[0].id).toBe(1);
    expect(hits[0].score).toBeGreaterThan(hits[1].score);
  });

  it("combines class and storey in one query", () => {
    const hits = index.search("door level 2", 3);
    expect(hits[0].id).toBe(4);
  });

  it("returns nothing for a term the model does not have", () => {
    expect(index.search("helipad", 5)).toEqual([]);
  });

  it("returns nothing for an empty query", () => {
    expect(index.search("   ", 5)).toEqual([]);
  });

  it("honours the limit", () => {
    expect(index.search("wall door window slab", 2)).toHaveLength(2);
  });

  it("handles an empty model", () => {
    const empty = buildIndex([]);
    expect(empty.size).toBe(0);
    expect(empty.search("wall", 5)).toEqual([]);
  });

  it("does not let a term present in every document outrank a rare one", () => {
    // "basic" is in 2 of 6, "wall" is in 2 of 6 as a camel-split of the class
    // plus 2 names. A term in every document scores 0 and must not win.
    const all: ModelElement[] = MODEL.map((e) => ({ ...e, name: `Common ${e.name}` }));
    const hits = buildIndex(all).search("common fire", 3);
    expect(hits[0].id).toBe(3);
  });
});
