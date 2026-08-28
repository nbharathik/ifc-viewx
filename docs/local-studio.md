# Local Studio

Local Studio runs IFCViewX as a local service on your computer. It is useful
when you need native IfcOpenShell features that a normal browser tab cannot
provide.

## Install

```bash
pip install ifcviewx
ifcviewx
```

Running `ifcviewx` opens the viewer at `127.0.0.1:8765`. You can also open a
model directly, convert it first, run a terminal check or start the MCP bridge.

```bash
ifcviewx model.ifc
ifcviewx model.ifc --convert
ifcviewx check model.ifc --ids spec.ids
ifcviewx mcp
```

## What it adds

Local Studio converts IFC files to the optimized `.ifcx` format and provides
native Python with the full IfcOpenShell installation. Command-line checks can
run without a browser, which is useful for repeatable model validation.

The MCP bridge lets supported AI clients inspect the loaded model and control
the view. A local key vault can also hold the assistant API key so it does not
need to be stored by the browser.

The service accepts local connections only. Model edits run on a copy and wait
for your approval in the viewer, leaving the original file unchanged until you
decide to save a result.
