import { describe, expect, it, vi } from "vitest";
import { AssistantCapabilityAdapter, assistantToolName } from "../src/assistant/capabilityAdapter.js";
import { ExtensionToolApprovals } from "../src/assistant/extensionTools.js";
import { createViewerCapabilityRegistry, type ViewerCapabilityContext } from "../src/capabilities/viewer.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const viewer = {} as Viewer;

describe("assistant capability adapter", () => {
  it("derives strict tools from the registry and gates mode and image tools", () => {
    const registry = createViewerCapabilityRegistry();
    const adapter = new AssistantCapabilityAdapter(registry, { viewer });
    const query = adapter.tools("query");
    const edit = adapter.tools("edit", { imageAttached: true });

    expect(query.map((tool) => tool.name)).not.toContain(assistantToolName("issue.stage"));
    expect(query.map((tool) => tool.name)).not.toContain(assistantToolName("view.pickAt"));
    expect(edit.map((tool) => tool.name)).toContain(assistantToolName("issue.stage"));
    expect(edit.map((tool) => tool.name)).toContain(assistantToolName("view.pickAt"));
    expect(query.map((tool) => tool.name)).toContain(assistantToolName("laser"));
    expect(edit.every((tool) => tool.schema.additionalProperties === false)).toBe(true);
  });

  it("groups a prior result without rerunning its source and rejects it after a revision change", async () => {
    let revision = "model-a";
    const source = vi.fn(() => ({
      elements: [
        { id: 11, type: "IfcWall", storey: "L1" },
        { id: 12, type: "IfcWall", storey: "L1" },
        { id: 21, type: "IfcDoor", storey: "L2" },
      ],
    }));
    const registry = createViewerCapabilityRegistry();
    registry.register({
      id: "audit.rows",
      title: "Audit rows",
      description: "Returns model rows",
      input: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true, mcp: true, sdk: true },
      source: "core",
      execute: source,
    });
    const context: ViewerCapabilityContext = { viewer, revision: () => revision };
    const adapter = new AssistantCapabilityAdapter(registry, context);
    adapter.tools("query");

    const first = await adapter.execute(assistantToolName("audit.rows"), {}, "query", new AbortController().signal);
    expect(first.result?.count).toBe(3);
    expect(first.evidence[0]).toMatchObject({ id: "E1", resultId: first.result?.id, elementIds: [11] });

    const grouped = await adapter.execute(
      assistantToolName("result.group"),
      { handle: first.result!.id, field: "storey" },
      "query",
      new AbortController().signal,
    );
    expect(grouped.value).toMatchObject({
      handle: first.result!.id,
      groups: [{ key: "L1", count: 2 }, { key: "L2", count: 1 }],
    });
    expect(source).toHaveBeenCalledTimes(1);

    revision = "model-b";
    await expect(adapter.execute(
      assistantToolName("result.page"),
      { handle: first.result!.id },
      "query",
      new AbortController().signal,
    )).rejects.toThrow(/earlier model revision/);
  });

  it("keeps contributed assistant tools disabled until the user approves them", () => {
    const registry = createViewerCapabilityRegistry();
    registry.register({
      id: "sample.inspect",
      title: "Sample inspect",
      description: "Extension analysis",
      input: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      permissions: [],
      cost: "instant",
      parallelSafe: true,
      exposure: { assistant: true },
      source: "org.example.sample",
      execute: () => ({ ok: true }),
    });
    const adapter = new AssistantCapabilityAdapter(registry, { viewer });
    expect(adapter.tools("query").map((tool) => tool.name)).not.toContain(assistantToolName("sample.inspect"));
    expect(adapter.tools("query", {
      approvals: [{ owner: "org.example.sample", capability: "sample.inspect", enabled: true }],
    }).map((tool) => tool.name)).toContain(assistantToolName("sample.inspect"));
  });

  it("keeps clash rows connected through open, isolate and staged issue steps", async () => {
    const isolate = vi.fn();
    const active = vi.fn();
    const clash = vi.fn(async () => ({
      clashes: 1,
      worst: [{
        a: { id: 101, type: "IfcWall" },
        b: { id: 202, type: "IfcPipeSegment" },
        kind: "hard",
        penetrationMm: 18,
        at: [1, 2, 3],
      }],
    }));
    const clashViewer = {
      getSpatialTree: () => null,
      isolate,
    } as unknown as Viewer;
    const registry = createViewerCapabilityRegistry();
    const context: ViewerCapabilityContext = {
      viewer: clashViewer,
      semantic: {
        check: async () => ({}),
        schedule: async () => ({}),
        ids: async () => ({}),
        clash,
      },
      revision: () => "model-a",
      setActiveResult: active,
    };
    const adapter = new AssistantCapabilityAdapter(registry, context);
    adapter.tools("edit");

    const detected = await adapter.execute(
      "clash",
      { a: ["IfcWall"], b: ["IfcPipeSegment"] },
      "edit",
      new AbortController().signal,
    );
    await adapter.execute("result__open", { handle: detected.result!.id }, "edit", new AbortController().signal);
    await adapter.execute("result__isolate", { handle: detected.result!.id, rows: [0] }, "edit", new AbortController().signal);
    const issue = await adapter.execute(
      "issue__stage",
      { title: "Wall and pipe clash", handle: detected.result!.id, rows: [0] },
      "edit",
      new AbortController().signal,
    );

    expect(clash).toHaveBeenCalledTimes(1);
    expect(active).toHaveBeenCalledWith(detected.result!.id, undefined);
    expect(isolate).toHaveBeenCalledWith([101, 202], `Result ${detected.result!.id}`);
    expect(issue.value).toMatchObject({ staged: true, elementIds: [101, 202] });
    expect(issue.evidence[0]).toMatchObject({ resultId: detected.result!.id, row: 0, elementIds: [101, 202] });
    expect(issue.report).toContain("[E");
  });

  it("keeps large result arrays out of assistant history reports", async () => {
    const registry = createViewerCapabilityRegistry();
    registry.register({
      id: "audit.large",
      title: "Large audit",
      description: "Returns many rows",
      input: { type: "object", properties: {}, additionalProperties: false },
      effect: "read",
      permissions: [],
      cost: "long",
      parallelSafe: false,
      exposure: { assistant: true },
      source: "core",
      execute: () => ({ rows: Array.from({ length: 50_000 }, (_, id) => ({ id: id + 1, storey: `L${id % 4}` })) }),
    });
    const adapter = new AssistantCapabilityAdapter(registry, { viewer, revision: () => "model-a" });
    adapter.tools("query");

    const result = await adapter.execute("audit__large", {}, "query", new AbortController().signal);

    expect(result.result?.count).toBe(50_000);
    expect(result.report.length).toBeLessThan(20_000);
    expect(JSON.parse(result.report.split("\nEvidence references:")[0])).toMatchObject({
      shown: 40,
      truncated: true,
      resultHandle: { count: 50_000 },
    });
  });

  it("persists extension approval by contribution, not just capability name", () => {
    localStorage.clear();
    const approvals = new ExtensionToolApprovals();
    approvals.set("org.example.sample", "inspect", true);
    const contribution = {
      owner: "org.example.sample",
      kind: "assistantTools" as const,
      contribution: { id: "inspect", capability: "sample.inspect" },
    };
    expect(new ExtensionToolApprovals().list([contribution])).toEqual([
      { owner: "org.example.sample", capability: "sample.inspect", enabled: true },
    ]);
  });
});
