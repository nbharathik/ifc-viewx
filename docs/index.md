# IFCViewX

An IFC viewer that runs in a browser tab. Files are never uploaded: parsing,
geometry, checks, editing and export all happen on your machine.

[Open the viewer](https://nbharathik.github.io/ifc-viewx/){ .md-button .md-button--primary }

## Two ways to run it

**In a browser.** Open the link and drop a file on it.

**On your machine.** `pip install ifcviewx` serves the same viewer locally and
adds IfcOpenShell conversion, native Python, an MCP bridge for AI clients, and
a vault for your assistant key. See [Local Studio](local-studio.md).

## What it does

Model tree, properties, quantities and schedules. Measurements, section planes,
2D plans and saved viewpoints. Quality checks and IDS validation. Editing with
diffs, undo and redo. Clash detection, quantity takeoff, model compare and BCF
issues. A Python console running real IfcOpenShell, and an optional AI
assistant.

## Extending it

Most of those tools are plugins, and a plugin is one folder with two files.
Drop it in and it appears in the catalog.

```bash
npm run new-plugin -- my-tool "My Tool"
```

[Writing a plugin](plugins/index.md) takes about ten minutes.
[Browse what already exists](plugins/catalog.md).
