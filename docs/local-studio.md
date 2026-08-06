# Local Studio

The same viewer, running on your machine.

```bash
pip install ifcviewx
```

```bash
ifcviewx                     # serves the viewer and opens the browser
ifcviewx model.ifc           # with that model already open
ifcviewx model.ifc --convert # convert to .ifcx first, then open
ifcviewx mcp                 # expose the running viewer to MCP clients
```

It serves from `127.0.0.1:8765` with everything already on.

## What it adds

**IfcOpenShell conversion.** Converts a model to the viewer's `.ifcx` format
with the real geometry kernel. Advanced breps come through exactly rather than
tessellated, and every later open of that model skips parsing.

**Native Python.** The console runs against the whole IfcOpenShell API instead
of the browser subset, with no 30 MB runtime download on first run.

**An MCP bridge.** Claude Desktop, Claude Code and other clients can query the
model and select, isolate and frame elements. Read and view only: no tool runs
code or writes to the model.

**A key vault.** The service holds your assistant provider key and proxies each
turn, so the key never reaches the page or its storage.

## They are separate apps

The hosted viewer does not reach your machine, so there is no pairing step and
nothing to paste. Local Studio is a second copy of the same app with a service
behind it. Your files stay on your machine either way.

## Writing a local tier plugin

A plugin needing the service is not a folder under `src/plugins`, because the
work is Python. It is:

1. A capability the service reports, in `local-bridge/src/ifcviewx/`.
2. An entry in `src/plugins/shortcuts.ts` with `tier: "local"`, the
   `capability` name, and the `command` that opens it.

The catalog then lists it for everyone: greyed with an install hint in a
browser tab, live in Local Studio. A `web` plugin can also check
`ctx.service.mode()` and use the service when it is there, which is what the
Python console does.

Details in [local-bridge/README.md](https://github.com/nbharathik/ifc-viewx/blob/main/local-bridge/README.md).
