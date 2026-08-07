// The clash worker.
//
// Holds the retained triangles and runs every sweep, so building BVHs over a
// few thousand elements never touches the frame the viewer is drawing. Nothing
// but message plumbing lives here; the work is in sweep.ts.
import { ClashGeometryIndex, runSweep } from "./sweep.js";
import type { ClashRequest, ClashResponse } from "./types.js";

const index = new ClashGeometryIndex();
let cancelRequested = false;

const post = (message: ClashResponse): void => {
  (self as unknown as Worker).postMessage(message);
};

const turn = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

self.onmessage = (event: MessageEvent<ClashRequest>): void => {
  const message = event.data;
  switch (message.type) {
    case "geometry":
      index.addChunk(message.chunk);
      return;
    case "dropModel":
      index.dropModel(message.model);
      return;
    case "clear":
      index.clear();
      return;
    case "cancel":
      cancelRequested = true;
      return;
    case "sweep": {
      cancelRequested = false;
      const { id, spec } = message;
      runSweep(index, spec, {
        onProgress: (progress) => post({ type: "progress", id, progress }),
        cancelled: () => cancelRequested,
        yieldTurn: turn,
      })
        .then((result) => post({ type: "result", id, result }))
        .catch((err: unknown) => {
          post({ type: "fail", id, message: err instanceof Error ? err.message : String(err) });
        });
      return;
    }
  }
};
