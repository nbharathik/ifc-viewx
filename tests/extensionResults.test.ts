import { describe, expect, it } from "vitest";
import { ExtensionResultStore } from "../src/extensions/results.js";

describe("extension result store", () => {
  it("pages results and keeps ownership isolated", () => {
    const results = new ExtensionResultStore();
    const handle = results.create("one", "one.rows", [1, 2, 3], { revision: "model:1" });
    expect(results.get("one", handle.id)).toMatchObject({ count: 3, revision: "model:1" });
    expect(results.get("two", handle.id)).toBeNull();
    expect(results.page<number>("one", handle.id, 1, 1).items).toEqual([2]);
    expect(() => results.page("two", handle.id)).toThrow(/Unknown or expired/);
  });

  it("disposes every result owned by an unloaded extension", () => {
    const results = new ExtensionResultStore();
    const first = results.create("one", "one.rows", [1]);
    const second = results.create("one", "one.more", [2]);
    const other = results.create("two", "two.rows", [3]);
    expect(results.disposeOwner("one")).toBe(2);
    expect(results.get("one", first.id)).toBeNull();
    expect(results.get("one", second.id)).toBeNull();
    expect(results.get("two", other.id)).not.toBeNull();
  });

  it("applies result quotas per extension owner", () => {
    const results = new ExtensionResultStore();
    results.create("one", "one.rows", Array.from({ length: 10_000 }, (_, index) => index));
    expect(() => results.create("one", "one.more", [1])).toThrow(/10000 result rows/);
    expect(() => results.create("two", "two.rows", [1])).not.toThrow();
  });
});
