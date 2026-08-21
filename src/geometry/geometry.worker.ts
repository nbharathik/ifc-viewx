import { runSweep } from "../ifc/clash/sweep.js";
import { runDistance } from "./distanceQuery.js";
import { runLaser } from "./laserQuery.js";
import { runSectionContours } from "./sectionQuery.js";
import { runGeometrySignatures } from "./signatureQuery.js";
import { runVolumes } from "./volumeQuery.js";
import { runSun } from "./sunQuery.js";
import { runDeviation } from "./deviationQuery.js";
import { runClassifyPlane } from "./planeQuery.js";
import { meshTransfers, runMeshes } from "./meshQuery.js";
import { GeometryIndex } from "./geometryIndex.js";
import { GeometryScheduler } from "./scheduler.js";
import type { GeometryRequest, GeometryResponse } from "./types.js";

const index = new GeometryIndex();
const cancelled = new Set<number>();
const active = new Set<number>();
const known = new Set<number>();
const scheduler = new GeometryScheduler();

const post = (message: GeometryResponse, transfer: Transferable[] = []): void => {
  (self as unknown as Worker).postMessage(message, transfer);
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
      if (known.has(message.id)) cancelled.add(message.id);
      return;
    case "clash": {
      const { id, spec } = message;
      known.add(id);
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
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "distance": {
      const { id, spec } = message;
      known.add(id);
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
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "laser": {
      const { id, spec } = message;
      known.add(id);
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
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "sectionContours": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runSectionContours(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "sectionContourResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "signatures": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runGeometrySignatures(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "signatureResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "volumes": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runVolumes(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "volumesResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }

    case "sun": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runSun(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post(
            { type: "sunResult", id, result },
            [result.exposure.buffer],
          );
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }

    case "deviation": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runDeviation(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post(
            { type: "deviationResult", id, result },
            [result.distances.buffer, result.elements.buffer],
          );
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "meshes": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runMeshes(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "meshesResult", id, result }, meshTransfers(result));
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
    case "classifyPlane": {
      const { id, spec } = message;
      known.add(id);
      scheduler.schedule(message.priority, async () => {
        active.add(id);
        if (cancelled.has(id)) return;
        await runClassifyPlane(index, spec, {
          cancelled: () => cancelled.has(id),
          yieldTurn: turn,
        }).then((result) => {
          if (!cancelled.has(id)) post({ type: "classifyPlaneResult", id, result });
        });
      })
        .catch((error: unknown) => post({
          type: "fail",
          id,
          message: error instanceof Error ? error.message : String(error),
        }))
        .finally(() => {
          known.delete(id);
          active.delete(id);
          cancelled.delete(id);
        });
      return;
    }
  }
};
