// Reading a second IFC without drawing it.
//
// A plugin that has to look at another file, a baseline revision or a
// neighbouring model, gets its spatial tree and its properties and nothing on
// the GPU, so the cost is parse time alone. The engine is behind a dynamic
// import: a plugin that never opens a side model never downloads it.
import type { ItemProperties, LoadProgress, SpatialNode } from "../viewer-core/engine/types.js";

export interface SideModel {
  /** Null when the file carries no spatial hierarchy. */
  tree: SpatialNode | null;
  properties(expressID: number): Promise<ItemProperties | null>;
  /** Terminates the worker holding the file. Always call it. */
  close(): void;
}

export interface SideModelOptions {
  onProgress?: (progress: LoadProgress) => void;
}

export async function openSideModel(
  bytes: Uint8Array,
  options: SideModelOptions = {},
): Promise<SideModel> {
  const { WorkerEngine } = await import("../viewer-core/engine/workerEngine.js");
  const engine = new WorkerEngine({
    wasmPath: `${import.meta.env.BASE_URL}wasm/`,
    wasmAbsolute: true,
    spawn: {
      factory: () =>
        new Worker(new URL("../viewer-core/engine/worker.entry.ts", import.meta.url), { type: "module" }),
    },
  });
  // A parse failure would otherwise leave the worker alive holding the whole
  // model, so the teardown is on every exit rather than on the happy path.
  try {
    await engine.init();
    const meta = await engine.loadModel(
      { kind: "bytes", bytes },
      { skipGeometry: true, onProgress: options.onProgress },
    );
    let closed = false;
    return {
      tree: meta.tree,
      properties: (expressID) =>
        closed
          ? Promise.resolve(null)
          : engine.getItemProperties(meta.modelID, expressID).catch(() => null),
      close: () => {
        if (closed) return;
        closed = true;
        engine.dispose(meta.modelID);
        engine.terminate();
      },
    };
  } catch (err) {
    engine.terminate();
    throw err;
  }
}
