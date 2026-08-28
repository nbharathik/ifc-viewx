import { describe, expect, it, vi } from "vitest";
import { CapabilityPolicy } from "../src/capabilities/policy.js";
import { CapabilityRegistry } from "../src/capabilities/registry.js";
import { ResultStore } from "../src/capabilities/results.js";
import type { CapabilityDefinition } from "../src/capabilities/types.js";

interface Context {
  enabled: boolean;
}

const sample = (
  execute: CapabilityDefinition<Record<string, unknown>, unknown, Context>["execute"] = (input) => input,
): CapabilityDefinition<Record<string, unknown>, unknown, Context> => ({
  id: "model.inspect",
  title: "Inspect model",
  description: "Reads a named part of the model",
  input: {
    type: "object",
    properties: { id: { type: "integer" }, mode: { type: "string", enum: ["fast", "exact"] } },
    required: ["id"],
    additionalProperties: false,
  },
  effect: "read",
  permissions: ["model.read"],
  cost: "instant",
  parallelSafe: true,
  exposure: { assistant: true, mcp: true },
  available: (context) => ({ available: context.enabled, reason: "No model is loaded" }),
  execute,
});

describe("capability registry", () => {
  it("registers, describes and unregisters a capability", () => {
    const registry = new CapabilityRegistry<Context>();
    const remove = registry.register(sample());
    expect(registry.get("model.inspect")).toMatchObject({ effect: "read", cost: "instant" });
    expect(registry.list((entry) => entry.exposure.mcp === true)).toHaveLength(1);
    remove();
    expect(registry.has("model.inspect")).toBe(false);
  });

  it("rejects duplicate and invalid ids", () => {
    const registry = new CapabilityRegistry<Context>();
    registry.register(sample());
    expect(() => registry.register(sample())).toThrow(/already registered/);
    expect(() => registry.register({ ...sample(), id: "Bad id" })).toThrow(/Invalid capability id/);
  });

  it("validates required, primitive, enum and extra inputs", async () => {
    const registry = new CapabilityRegistry<Context>();
    registry.register(sample());
    const options = { policy: new CapabilityPolicy({ effects: ["read"], permissions: ["model.read"] }) };
    await expect(registry.execute("model.inspect", {}, { enabled: true }, options)).rejects.toThrow(/id is required/);
    await expect(registry.execute("model.inspect", { id: 1.2 }, { enabled: true }, options)).rejects.toThrow(/integer/);
    await expect(registry.execute("model.inspect", { id: 1, mode: "deep" }, { enabled: true }, options)).rejects.toThrow(/one of/);
    await expect(registry.execute("model.inspect", { id: 1, extra: true }, { enabled: true }, options)).rejects.toThrow(/not supported/);
  });

  it("enforces availability, effect, permission and cancellation", async () => {
    const run = vi.fn((input: Record<string, unknown>) => input.id);
    const registry = new CapabilityRegistry<Context>();
    registry.register(sample(run));
    const allowed = new CapabilityPolicy({ effects: ["read"], permissions: ["model.read"] });
    await expect(registry.execute("model.inspect", { id: 7 }, { enabled: false }, { policy: allowed })).rejects.toThrow(/No model/);
    await expect(registry.execute("model.inspect", { id: 7 }, { enabled: true }, {
      policy: new CapabilityPolicy({ effects: ["view"], permissions: ["model.read"] }),
    })).rejects.toThrow(/not allowed/);
    await expect(registry.execute("model.inspect", { id: 7 }, { enabled: true }, {
      policy: new CapabilityPolicy({ effects: ["read"] }),
    })).rejects.toThrow(/requires permission/);
    const controller = new AbortController();
    controller.abort();
    await expect(registry.execute("model.inspect", { id: 7 }, { enabled: true }, {
      policy: allowed,
      signal: controller.signal,
    })).rejects.toThrow(/cancelled/);
    expect(run).not.toHaveBeenCalled();
  });

  it("forwards progress and validates declared output", async () => {
    const registry = new CapabilityRegistry<Context>();
    registry.register({
      ...sample((_input, _context, _signal, reportProgress) => {
        reportProgress({ phase: "scan", done: 1, total: 2 });
        return "done";
      }),
      permissions: [],
      output: { type: "number" },
    });
    const progress = vi.fn();
    await expect(registry.execute("model.inspect", { id: 1 }, { enabled: true }, {
      policy: new CapabilityPolicy({ effects: ["read"] }),
      onProgress: progress,
    })).rejects.toThrow(/output must be number/);
    expect(progress).toHaveBeenCalledWith({ phase: "scan", done: 1, total: 2 });
  });

  it("normalizes JSON reports to the same typed value for every adapter", async () => {
    const registry = new CapabilityRegistry<Context>();
    registry.register({
      ...sample(() => JSON.stringify({ count: 2, rows: [{ id: 7 }] })),
      output: { type: "string" },
    });
    const policy = new CapabilityPolicy({ effects: ["read"], permissions: ["model.read"] });

    await expect(registry.executeValue("model.inspect", { id: 7 }, { enabled: true }, { policy }))
      .resolves.toEqual({ count: 2, rows: [{ id: 7 }] });
  });
});

describe("result store", () => {
  it("pages bounded result data and returns stable metadata", () => {
    const store = new ResultStore({ maxPageSize: 2 });
    const handle = store.create("model.search", [1, 2, 3], { revision: "model-a" });
    expect(store.page<number>(handle.id, 0, 50)).toMatchObject({ items: [1, 2], nextOffset: 2 });
    expect(store.page<number>(handle.id, 2, 50)).toMatchObject({ items: [3], nextOffset: null });
    expect(store.get(handle.id)?.revision).toBe("model-a");
  });

  it("evicts old handles and invalidates a model revision", () => {
    const store = new ResultStore({ maxHandles: 2, maxItems: 3 });
    const first = store.create("one", [1, 2], { revision: "old" });
    const second = store.create("two", [3, 4], { revision: "old" });
    expect(store.get(first.id)).toBeNull();
    expect(store.invalidateRevision("old")).toBe(1);
    expect(store.get(second.id)).toBeNull();
  });

  it("expires handles", () => {
    vi.useFakeTimers();
    const store = new ResultStore();
    const handle = store.create("short", [1], { ttlMs: 10 });
    vi.advanceTimersByTime(11);
    expect(store.get(handle.id)).toBeNull();
    vi.useRealTimers();
  });
});
