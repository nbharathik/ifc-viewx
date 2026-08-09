import { describe, expect, it } from "vitest";
import {
  clashFingerprint,
  groupClashes,
  resolvedClashes,
  reviewClashes,
  type ClashDecision,
  type ClashElementIdentity,
  type ClashPair,
} from "../src/ifc/clash.js";

const hit = (overrides: Partial<ClashPair> = {}): ClashPair => ({
  a: 11,
  b: 22,
  aType: "IfcWall",
  bType: "IfcPipeSegment",
  kind: "hard",
  distance: 0.04,
  point: [1.02, 2.03, 3.04],
  extent: [0.2, 0.2, 0.2],
  triangles: 2,
  ...overrides,
});

const identity = (overrides: Partial<ClashElementIdentity>): ClashElementIdentity => ({
  id: 11,
  model: 0,
  globalId: "wall-guid",
  type: "IfcWall",
  name: "Wall",
  storey: "Level 1",
  ...overrides,
});

describe("clash workflow", () => {
  it("keeps fingerprints stable across runtime ids, side order and small contact movement", () => {
    const a = identity({ id: 11 });
    const b = identity({ id: 22, globalId: "pipe-guid", type: "IfcPipeSegment", name: "Pipe" });
    const first = clashFingerprint(hit(), a, b);
    const revisedA = identity({ id: 911 });
    const revisedB = identity({ id: 922, globalId: "pipe-guid", type: "IfcPipeSegment", name: "Pipe" });
    const reversed = hit({
      a: 922,
      b: 911,
      aType: "IfcPipeSegment",
      bType: "IfcWall",
      point: [1.04, 2.02, 3.01],
    });

    expect(clashFingerprint(reversed, revisedB, revisedA)).toBe(first);
    expect(first).toMatch(/^CL-[0-9A-Z]{13}$/);
  });

  it("classifies new, unchanged, assigned, ignored and resolved references", () => {
    const a = identity({});
    const b = identity({ id: 22, globalId: "pipe-guid", type: "IfcPipeSegment", name: "Pipe" });
    const identities = new Map([[11, a], [22, b]]);
    const fingerprint = clashFingerprint(hit(), a, b);
    const previous = new Set([fingerprint, "CL-RESOLVED0001"]);

    const unchanged = reviewClashes([hit()], identities, previous, new Map(), []);
    expect(unchanged[0].state).toBe("unchanged");
    expect(resolvedClashes(previous, unchanged)).toEqual(["CL-RESOLVED0001"]);

    const assigned = new Map<string, ClashDecision>([[fingerprint, {
      state: "assigned", assignee: "Mira", updatedAt: "2026-08-08T10:00:00Z",
    }]]);
    expect(reviewClashes([hit()], identities, previous, assigned, [])[0]).toMatchObject({
      state: "assigned", assignee: "Mira",
    });

    const rules = [{
      id: "rule-1", aType: "IfcPipeSegment", bType: "IfcWall", kind: "hard" as const,
      createdAt: "2026-08-08T10:00:00Z",
    }];
    expect(reviewClashes([hit()], identities, previous, assigned, rules)[0].state).toBe("ignored");
    expect(reviewClashes([hit({ point: [8, 8, 8] })], identities, previous, new Map(), [])[0].state).toBe("new");
  });

  it("groups deterministically by class and bounded proximity clusters", () => {
    const a = identity({});
    const b = identity({ id: 22, globalId: "pipe-guid", type: "IfcPipeSegment", name: "Pipe" });
    const identities = new Map([[11, a], [22, b]]);
    const rows = reviewClashes([
      hit({ point: [0, 0, 0] }),
      hit({ point: [0.5, 0.4, 0.2] }),
      hit({ point: [8, 8, 8] }),
    ], identities, new Set(), new Map(), []);

    expect(groupClashes(rows, "class")).toMatchObject([{ label: "PipeSegment / Wall", rows: { length: 3 } }]);
    const forward = groupClashes(rows, "proximity", 2);
    const reverse = groupClashes([...rows].reverse(), "proximity", 2);
    expect(forward.map((group) => group.rows.length)).toEqual([2, 1]);
    expect(reverse.map((group) => group.rows.map((row) => row.fingerprint))).toEqual(
      forward.map((group) => group.rows.map((row) => row.fingerprint)),
    );
  });
});
