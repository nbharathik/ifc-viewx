// Python console: the same execution pipeline the assistant uses, with a human
// writing the code. Queries return a value, edits run on a copy and land in the
// pending bar for approval. The panel never executes anything itself, it only
// calls api.python, so the tier choice stays in one place.
//
// The static guard is deliberately not in this path. It exists to check code an
// LLM wrote; what you type here is your own, and running natively the service
// applies its own guard regardless of who wrote it.
import { h, icon, iconButton, toast } from "../../ui/kit.js";
import type { PluginApi, PluginInstance } from "../host.js";

const START = `# The model is available as \`model\` (ifcopenshell.file).
# Assign to \`result\` to display a value.
walls = model.by_type("IfcWall")
result = {"count": len(walls), "names": [w.Name for w in walls[:10]]}
`;

const SNIPPETS: Array<[string, string]> = [
  ["Count by type", 'walls = model.by_type("IfcWall")\nresult = {"walls": len(walls)}'],
  ["Storeys", 'result = [s.Name for s in model.by_type("IfcBuildingStorey")]'],
  [
    "Property sets of one element",
    'import ifcopenshell.util.element as util\nel = model.by_type("IfcWall")[0]\nresult = util.get_psets(el)',
  ],
  [
    "Rename an element (edit)",
    'def edit(model):\n    wall = model.by_type("IfcWall")[0]\n    wall.Name = "Renamed wall"\n    return {"summary": "renamed one wall", "affected_guids": [wall.GlobalId]}',
  ],
];

export function mount(host: HTMLElement, api: PluginApi, payload?: unknown): PluginInstance {
  const code = h("textarea", { class: "code", spellcheck: "false" });
  const output = h("pre", { class: "output" });
  const status = h("div", { class: "status-line" });
  const tier = h("div", { class: "tier" });
  const runBtn = h("button", { class: "btn accent", type: "button", title: "Run query  Ctrl+Enter" }, [
    icon("play", 13),
    h("span", { text: "Run" }),
  ]);
  const editBtn = h("button", {
    class: "btn",
    type: "button",
    text: "Run as edit",
    title: "Execute on a copy and stage the result",
  });

  code.value = typeof payload === "string" && payload.trim() ? payload : api.read("code", START);

  const setStatus = (text: string, isError = false): void => {
    status.textContent = text;
    status.classList.toggle("error", isError);
  };

  const syncTier = (): void => {
    const native = api.python.runsNatively();
    tier.replaceChildren(icon(native ? "server" : "cube", 12), h("span", { text: native ? "native" : "in this tab" }));
    tier.title = native
      ? "Runs in the local service with the full IfcOpenShell API"
      : "Runs in this tab with Pyodide; the first run downloads about 30 MB";
  };

  let busy = false;
  const setBusy = (value: boolean): void => {
    busy = value;
    runBtn.disabled = value;
    editBtn.disabled = value;
    runBtn.classList.toggle("busy", value);
  };

  const run = (mode: "query" | "edit"): void => {
    if (busy) return;
    api.write("code", code.value);
    setBusy(true);
    setStatus(mode === "edit" ? "Executing the edit on a copy" : "Running query");
    const call =
      mode === "edit"
        ? api.python.propose(code.value, setStatus)
        : api.python.query(code.value, setStatus);
    void call
      .then((text) => {
        output.textContent = text;
        setStatus(mode === "edit" ? "Edit staged: review it in the bar above" : "Query finished");
      })
      .catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        output.textContent = message;
        setStatus(message.split("\n")[0], true);
      })
      .finally(() => setBusy(false));
  };

  runBtn.addEventListener("click", () => run("query"));
  editBtn.addEventListener("click", () => run("edit"));
  code.addEventListener("change", () => api.write("code", code.value));
  code.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      return run("query");
    }
    // Tab indents instead of leaving the editor.
    if (e.key === "Tab") {
      e.preventDefault();
      const { selectionStart: from, selectionEnd: to, value } = code;
      code.value = `${value.slice(0, from)}    ${value.slice(to)}`;
      code.selectionStart = code.selectionEnd = from + 4;
    }
  });

  const snippets = h("select", { class: "snippets", title: "Insert a snippet" });
  snippets.append(
    h("option", { value: "", text: "Snippets" }),
    ...SNIPPETS.map(([label], i) => h("option", { value: String(i), text: label })),
  );
  snippets.addEventListener("change", () => {
    const entry = SNIPPETS[Number(snippets.value)];
    if (entry) code.value = entry[1];
    snippets.value = "";
    code.focus();
  });

  syncTier();
  host.appendChild(
    h("div", { class: "page" }, [
      code,
      h("div", { class: "row" }, [runBtn, editBtn, snippets, h("span", { class: "grow" }), tier]),
      status,
      h("div", { class: "out-wrap" }, [
        output,
        h("div", { class: "out-actions" }, [
          iconButton("copy", "Copy", () => {
            void navigator.clipboard?.writeText(output.textContent ?? "").then(() => toast("Copied", "success"));
          }, "icon-btn sm ghost"),
          iconButton("trash", "Clear output", () => (output.textContent = ""), "icon-btn sm ghost"),
        ]),
      ]),
    ]),
  );

  return {
    serviceChanged: syncTier,
    // Reopened with code from the assistant: take it, do not run it. The user
    // reads what was generated before anything executes.
    receive(next) {
      if (typeof next !== "string" || !next.trim()) return;
      code.value = next;
      setStatus("Code from the assistant. Review it, then Run.");
      code.focus();
    },
    dispose() {
      api.write("code", code.value);
    },
  };
}
