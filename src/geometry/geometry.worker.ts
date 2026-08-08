import { runSweep } from "../ifc/clash/sweep.js";
import { runDistance } from "./distanceQuery.js";
import { runLaser } from "./laserQuery.js";
import { GeometryIndex } from "./geometryIndex.js";
import { GeometryScheduler } from "./scheduler.js";
import type { GeometryRequest, GeometryResponse } from "./types.js";

const index = new GeometryIndex();
const cancelled = new Set<number>();
const active = new Set<number>();
const scheduler = new GeometryScheduler();

const post = (message: GeometryResponse): void => {
  (self as unknown as Worker).postMessage(message);
};

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = (event: MessageEvent<GeometryRequest>): void => {
  const message = event.data;
  switch (message.type) {
    case "geometry":
      index.addChunk(message.chunk);
      return;
    case "dropModel":
      for (const id of active) cancelled.add(id);
      index.dropModel(message.model);
      return;
    case "clear":
      for (const id of active) cancelled.add(id);
      index.clear();
      return;
    case "cancel":
      cancelled.add(message.id);
      return;
    case "clash": {
      const { id, spec } = message;
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runSweep(index, spec, {
          onProgress: (progress) => post({ type: "clashProgress", id, progress }),
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => post({ type: "clashResult", id, result }));
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "distance": {
      const { id, spec } = message;
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runDistance(index, spec).then((result) => {
          if (!cancelled.has(id)) post({ type: "distanceResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "laser": {
      const { id, spec } = message;
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runLaser(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "laserResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
  }
};
