// The eval script cannot import TypeScript, so it carries its own copy of the
// tool schemas. That copy is the thing that silently rots: a tool added to
// TOOLS and forgotten there is simply never scored, and the eval keeps
// reporting a clean run. These tests are what make the copy honest.
import { describe, expect, it } from "vitest";
import { CASES, TOOLS as MIRROR } from "../scripts/eval-assistant.mjs";
import { AssistantCapabilityAdapter } from "../src/assistant/capabilityAdapter.js";
import { createViewerCapabilityRegistry } from "../src/capabilities/viewer.js";
import { TOOLS } from "../src/llm/tools.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const real = new AssistantCapabilityAdapter(
  createViewerCapabilityRegistry(),
  { viewer: {} as Viewer },
).tools("query");
const mirrorNames = (MIRROR as Array<[string, string, object, string[]]>).map(([name]) => name);

describe("eval tool mirror", () => {
  it("covers every viewer tool the query mode offers", () => {
    expect(mirrorNames.slice().sort()).toEqual(real.map((tool) => tool.name).sort());
  });

  it("offers no tool the app does not have", () => {
    const known = new Set(real.map((tool) => tool.name));
    for (const name of mirrorNames) expect(known).toContain(name);
  });

  it("agrees on which arguments are required", () => {
    for (const [name, , , required] of MIRROR as Array<[string, string, object, string[]]>) {
      const actual = real.find((tool) => tool.name === name)!;
      expect([name, required.slice().sort()]).toEqual([name, actual.schema.required.slice().sort()]);
    }
  });

  it("names the same arguments", () => {
    for (const [name, , properties] of MIRROR as Array<[string, string, Record<string, unknown>, string[]]>) {
      const actual = real.find((tool) => tool.name === name)!;
      expect([name, Object.keys(properties).sort()]).toEqual([name, Object.keys(actual.schema.properties).sort()]);
    }
  });

  it("never offers an edit tool, which the eval must not exercise", () => {
    const editNames = new Set(TOOLS.filter((tool) => tool.tier === "edit").map((tool) => tool.name));
    for (const name of mirrorNames) expect(editNames.has(name)).toBe(false);
  });
});

describe("golden cases", () => {
  it("only expects tools that exist", () => {
    const known = new Set(mirrorNames);
    for (const testCase of CASES as Array<{ ask: string; expect: string[] }>) {
      for (const name of testCase.expect) expect([testCase.ask, known.has(name)]).toEqual([testCase.ask, true]);
    }
  });

  it("gives every case at least one acceptable tool", () => {
    for (const testCase of CASES as Array<{ ask: string; expect: string[] }>) {
      expect(testCase.expect.length).toBeGreaterThan(0);
    }
  });

  it("asks about more than half of the offered tools", () => {
    const asked = new Set((CASES as Array<{ expect: string[] }>).flatMap((c) => c.expect));
    expect(asked.size).toBeGreaterThan(mirrorNames.length / 2);
  });
});
