// Pyodide + IfcOpenShell worker. Loaded lazily: the viewer never waits on
// Python. The model file lives in the runtime's own filesystem and every
// proposed edit re-parses it into a throwaway copy, so the live model is never
// mutated by running code; new bytes only become active via an explicit
// setModel (user clicked Apply).

// Version pins (see plan.md §3): Pyodide 0.29.x is the cp313/pyodide_2025_0
// ABI generation that matches the official IfcOpenShell wasm wheel. Do not
// bump either without checking https://ifcopenshell.github.io/wasm-wheels/.
const PYODIDE_VERSION = "0.29.4";
const PYODIDE_BASE = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const IFCOPENSHELL_WHEEL =
  "https://ifcopenshell.github.io/wasm-wheels/ifcopenshell-0.8.5-cp313-cp313-pyodide_2025_0_wasm32.whl";

export type PyRequest =
  | { type: "init"; id: number }
  | { type: "setModel"; id: number; bytes: ArrayBuffer; fileName: string }
  | { type: "runQuery"; id: number; code: string }
  | { type: "proposeEdit"; id: number; code: string };

export interface ModelSummary {
  schema: string;
  productCount: number;
  entityCount: number;
  storeys: string[];
  typeCounts: Record<string, number>;
}

export type PyResponse =
  | { type: "booted" }
  | { type: "initProgress"; id: number; step: string }
  | { type: "initDone"; id: number; error?: string }
  | { type: "modelSet"; id: number; summary: ModelSummary }
  | { type: "queryResult"; id: number; stdout: string; resultJson: string | null }
  | {
      type: "editProposed";
      id: number;
      bytes: ArrayBuffer;
      stdout: string;
      summary: string;
      affectedGuids: string[];
      entityCountBefore: number;
      entityCountAfter: number;
    }
  | { type: "fail"; id: number; message: string };

interface PyodideLike {
  FS: { writeFile(path: string, data: Uint8Array): void };
  loadPackage(name: string): Promise<void>;
  globals: { get(name: string): unknown; set(name: string, value: unknown): void };
  runPythonAsync(code: string): Promise<unknown>;
}

const ctx = self as unknown as Worker & typeof globalThis;
let pyodide: PyodideLike | null = null;

const post = (msg: PyResponse, transfer: Transferable[] = []): void =>
  ctx.postMessage(msg, transfer);

/** Python-side runtime installed once at init. */
const PY_RUNTIME = `
import io, json, contextlib, traceback
import ifcopenshell
import ifcopenshell.api
import ifcopenshell.util.element
import ifcopenshell.guid

_active = {"model": None, "path": None, "name": None}

def _summary():
    m = _active["model"]
    products = m.by_type("IfcProduct")
    counts = {}
    for p in products:
        counts[p.is_a()] = counts.get(p.is_a(), 0) + 1
    storeys = sorted(
        (s.Name or f"Storey #{s.id()}") for s in m.by_type("IfcBuildingStorey")
    )
    return {
        "schema": m.schema_identifier if hasattr(m, "schema_identifier") else m.schema,
        "productCount": len(products),
        "entityCount": len(m.by_type("IfcRoot")),
        "storeys": storeys,
        "typeCounts": dict(sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))),
    }

def load_model(path, name):
    _active["model"] = ifcopenshell.open(path)
    _active["path"] = path
    _active["name"] = name
    return json.dumps(_summary())

def run_query(code):
    ns = {"ifcopenshell": ifcopenshell, "model": _active["model"], "json": json}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<query>", "exec"), ns)
    result = ns.get("result")
    result_json = None
    if result is not None:
        try:
            result_json = json.dumps(result, default=str)[:200_000]
        except Exception:
            result_json = json.dumps(str(result))
    return json.dumps({"stdout": buf.getvalue(), "result": result_json})

def propose_edit(code):
    # Fresh parse from the file the runtime already holds: running code can
    # never corrupt the live model, and a failed edit leaves no trace. Read
    # back rather than kept as a string, because wasm32 gives the runtime, the
    # live model and this copy one 4 GB address space between them, and a
    # retained copy of the source cost that budget for the whole session.
    temp = ifcopenshell.open(_active["path"])
    before = len(temp.by_type("IfcRoot"))
    ns = {"ifcopenshell": ifcopenshell, "model": temp, "json": json}
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        exec(compile(code, "<edit>", "exec"), ns)
        result = ns.get("result")
        if result is None and callable(ns.get("edit")):
            result = ns["edit"](temp)
    after = len(temp.by_type("IfcRoot"))
    summary = ""
    guids = []
    if isinstance(result, dict):
        summary = str(result.get("summary", ""))
        guids = [str(g) for g in result.get("affected_guids", [])]
    return json.dumps({
        "stdout": buf.getvalue(),
        "summary": summary,
        "affectedGuids": guids,
        "entityCountBefore": before,
        "entityCountAfter": after,
    }), temp.to_string()
`;

async function init(id: number): Promise<void> {
  if (pyodide) {
    post({ type: "initDone", id });
    return;
  }
  post({ type: "initProgress", id, step: "Downloading Python runtime (Pyodide)…" });
  const mod = (await import(/* @vite-ignore */ `${PYODIDE_BASE}pyodide.mjs`)) as {
    loadPyodide(opts: { indexURL: string }): Promise<PyodideLike>;
  };
  const py = await mod.loadPyodide({ indexURL: PYODIDE_BASE });
  post({ type: "initProgress", id, step: "Installing IfcOpenShell (WASM wheel)…" });
  await py.loadPackage("micropip");
  py.globals.set("_wheel_url", IFCOPENSHELL_WHEEL);
  await py.runPythonAsync(
    "import micropip\nawait micropip.install(_wheel_url)",
  );
  post({ type: "initProgress", id, step: "Starting IfcOpenShell…" });
  await py.runPythonAsync(PY_RUNTIME);
  pyodide = py;
  post({ type: "initDone", id });
}

async function setModel(id: number, bytes: ArrayBuffer, fileName: string): Promise<void> {
  const py = pyodide!;
  py.FS.writeFile("/model.ifc", new Uint8Array(bytes));
  py.globals.set("_model_name", fileName);
  const summaryJson = (await py.runPythonAsync(
    'load_model("/model.ifc", _model_name)',
  )) as string;
  post({ type: "modelSet", id, summary: JSON.parse(summaryJson) as ModelSummary });
}

async function runQuery(id: number, code: string): Promise<void> {
  const py = pyodide!;
  py.globals.set("_user_code", code);
  const outJson = (await py.runPythonAsync("run_query(_user_code)")) as string;
  const out = JSON.parse(outJson) as { stdout: string; result: string | null };
  post({ type: "queryResult", id, stdout: out.stdout, resultJson: out.result });
}

async function proposeEdit(id: number, code: string): Promise<void> {
  const py = pyodide!;
  py.globals.set("_user_code", code);
  const pair = (await py.runPythonAsync("propose_edit(_user_code)")) as {
    toJs(): [string, string];
    destroy(): void;
  };
  const [metaJson, editedText] = pair.toJs();
  pair.destroy();
  const meta = JSON.parse(metaJson) as {
    stdout: string;
    summary: string;
    affectedGuids: string[];
    entityCountBefore: number;
    entityCountAfter: number;
  };
  const bytes = new TextEncoder().encode(editedText);
  post(
    {
      type: "editProposed",
      id,
      bytes: bytes.buffer,
      stdout: meta.stdout,
      summary: meta.summary,
      affectedGuids: meta.affectedGuids,
      entityCountBefore: meta.entityCountBefore,
      entityCountAfter: meta.entityCountAfter,
    },
    [bytes.buffer],
  );
}

/** Trim Pyodide's noisy traceback header down to the Python error itself. */
function pythonError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  const start = lines.findIndex((l) => l.startsWith("Traceback"));
  return (start >= 0 ? lines.slice(start) : lines).join("\n");
}

ctx.addEventListener("message", (event: MessageEvent<PyRequest>) => {
  const msg = event.data;
  void (async () => {
    try {
      switch (msg.type) {
        case "init":
          await init(msg.id);
          break;
        case "setModel":
          await setModel(msg.id, msg.bytes, msg.fileName);
          break;
        case "runQuery":
          await runQuery(msg.id, msg.code);
          break;
        case "proposeEdit":
          await proposeEdit(msg.id, msg.code);
          break;
      }
    } catch (err) {
      if (msg.type === "init") {
        post({ type: "initDone", id: msg.id, error: pythonError(err) });
      } else {
        post({ type: "fail", id: msg.id, message: pythonError(err) });
      }
    }
  })();
});

post({ type: "booted" });
