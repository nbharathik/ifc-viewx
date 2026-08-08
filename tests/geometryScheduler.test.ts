import { describe, expect, it } from "vitest";
import { GeometryScheduler } from "../src/geometry/scheduler.js";

describe("geometry scheduler", () => {
  it("lets an interactive query run while background work is yielded", async () => {
    const scheduler = new GeometryScheduler();
    const order: string[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const background = scheduler.schedule(2, async () => {
      order.push("background-start");
      await gate;
      order.push("background-end");
    });
    await scheduler.schedule(0, () => void order.push("interactive"));
    expect(order).toEqual(["background-start", "interactive"]);
    release();
    await background;
  });

  it("keeps background queries serial and ordered by priority", async () => {
    const scheduler = new GeometryScheduler();
    const order: number[] = [];
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = scheduler.schedule(2, async () => {
      order.push(1);
      await gate;
    });
    const last = scheduler.schedule(2, () => void order.push(3));
    const middle = scheduler.schedule(1, () => void order.push(2));
    release();
    await Promise.all([first, middle, last]);
    expect(order).toEqual([1, 2, 3]);
  });
});
