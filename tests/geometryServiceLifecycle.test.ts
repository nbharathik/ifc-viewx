import { afterEach, describe, expect, it, vi } from "vitest";

import { GeometryService } from "../src/geometry/service.js";
import type { DistanceSpec, GeometryRequest, GeometryResponse } from "../src/geometry/types.js";
import { TriangleStore } from "../src/viewer-core/scene/triangleStore.js";

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage: ((event: MessageEvent<GeometryResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly sent: GeometryRequest[] = [];
  terminated = false;

  constructor() {
    FakeWorker.instances.push(this);
  }

  postMessage(message: GeometryRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }
}

const distanceSpec = (): DistanceSpec => ({
  a: 1,
  b: 2,
  offsets: new Float64Array(),
  origin: [0, 0, 0],
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorker.instances = [];
});

describe("GeometryService lifecycle", () => {
  it("fails closed after a worker crash instead of posting later work to a dead worker", async () => {
    vi.stubGlobal("Worker", FakeWorker);
    const service = new GeometryService(new TriangleStore());
    const first = service.distance(distanceSpec());
    await Promise.resolve();
    const worker = FakeWorker.instances[0];
    worker.onerror?.({ message: "worker crashed" } as ErrorEvent);

    await expect(first).rejects.toThrow(/worker crashed/);
    expect(worker.terminated).toBe(true);
    expect(service.active).toBe(false);
    await expect(service.distance(distanceSpec())).rejects.toThrow(/Reload the viewer/);
    expect(FakeWorker.instances).toHaveLength(1);
  });
});
