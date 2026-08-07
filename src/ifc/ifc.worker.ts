// Semantic engine worker: holds one web-ifc model open for reading, and opens
// a throwaway second copy whenever an edit is proposed, so the model the user
// is looking at is never the one being written to.
import { IfcAPI } from "web-ifc";
import { IfcModel } from "./model.js";
import { validate } from "./checks.js";
import { schedule } from "./schedule.js";
import { applyEdits, type EditOp } from "./edits.js";

export type IfcRequest =
  | { type: "init"; id: number; wasmPath: string }
  | { type: "setModel"; id: number; bytes: ArrayBuffer }
  | { type: "validate"; id: number }
  | { type: "schedule"; id: number; ifcType: string; properties: string[]; limit: number }
  | { type: "types"; id: number }
  | { type: "propose"; id: number; op: EditOp }
  | { type: "proposeBatch"; id: number; ops: EditOp[] };

export type IfcResponse =
  | { type: "ready"; id: number }
  | { type: "modelSet"; id: number; schema: string; entities: number }
  | { type: "result"; id: number; payload: unknown }
  | { type: "proposed"; id: number; bytes: ArrayBuffer; payload: unknown }
  | { type: "fail"; id: number; message: string; stack?: string };

let api: IfcAPI | null = null;
let booting: Promise<IfcAPI> | null = null;
let wasmPath = "";
let model: IfcModel | null = null;
let sourceBytes: Uint8Array | null = null;

/**
 * One shared boot. Messages are handled concurrently, so a request that
 * arrives while Init() is still running must await the same instance rather
 * than start a second one with no wasm path.
 */
function ensureApi(): Promise<IfcAPI> {
  booting ??= (async () => {
    const next = new IfcAPI();
    next.SetWasmPath(wasmPath, true);
    await next.Init();
    api = next;
    return next;
  })();
  return booting;
}

function current(): IfcModel {
  if (!model) throw new Error("No model loaded.");
  return model;
}

/**
 * Edits run against a fresh copy; the read model stays untouched. Every copy
 * is a real byte copy: OpenModel takes ownership of the array it is handed,
 * so handing out a second view over the same buffer yields a corrupt model.
 */
function withCopy<T>(run: (copy: IfcModel) => T): { value: T; bytes: Uint8Array } {
  if (!api || !sourceBytes) throw new Error("No model loaded.");
  const id = api.OpenModel(sourceBytes.slice());
  const copy = new IfcModel(api, id);
  try {
    const value = run(copy);
    return { value, bytes: copy.save() };
  } finally {
    api.CloseModel(id);
  }
}

self.addEventListener("message", (event: MessageEvent<IfcRequest>) => {
  const request = event.data;
  void (async () => {
    try {
      if (request.type === "init") {
        wasmPath = request.wasmPath;
        await ensureApi();
        return post({ type: "ready", id: request.id });
      }

      if (request.type === "setModel") {
        const engine = await ensureApi();
        if (model) engine.CloseModel(model.id);
        // Cleared before the open: a throw in OpenModel would otherwise leave
        // this pointing at the model that was just closed.
        model = null;
        sourceBytes = new Uint8Array(request.bytes);
        const id = engine.OpenModel(sourceBytes.slice());
        model = new IfcModel(engine, id);
        return post({
          type: "modelSet",
          id: request.id,
          schema: model.schema,
          entities: model.byType("IfcRoot").length,
        });
      }

      if (request.type === "validate") {
        return post({ type: "result", id: request.id, payload: validate(current()) });
      }

      if (request.type === "schedule") {
        const payload = schedule(current(), request.ifcType, request.properties, request.limit);
        return post({ type: "result", id: request.id, payload });
      }

      if (request.type === "types") {
        const model_ = current();
        const counts: Record<string, number> = {};
        for (const id of model_.byType("IfcElement")) {
          const name = model_.typeName(id);
          counts[name] = (counts[name] ?? 0) + 1;
        }
        return post({ type: "result", id: request.id, payload: counts });
      }

      if (request.type === "propose" || request.type === "proposeBatch") {
        // One copy for the whole batch: a spreadsheet re-import is many
        // operations that have to be approved and applied as one thing.
        const ops = request.type === "propose" ? [request.op] : request.ops;
        const { value, bytes } = withCopy((copy) => applyEdits(copy, ops));
        const buffer = bytes.slice().buffer as ArrayBuffer;
        return post({ type: "proposed", id: request.id, bytes: buffer, payload: value }, [buffer]);
      }
    } catch (err) {
      // The stack matters here: most failures come from inside web-ifc, where
      // the message alone ("reading 'name'") says nothing about the cause.
      post({
        type: "fail",
        id: request.id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      });
    }
  })();
});

function post(message: IfcResponse, transfer: Transferable[] = []): void {
  (self as unknown as Worker).postMessage(message, transfer);
}
