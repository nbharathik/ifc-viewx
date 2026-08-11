# IFCViewX

Open an IFC model in your browser. Nothing is uploaded. Parsing, viewing,
checks, edits, and exports run on your machine.

[Open IFCViewX](https://nbharathik.github.io/ifc-viewx/){ .md-button .md-button--primary }
[Browse the tools](plugins/catalog.md){ .md-button }

## Start in three steps

1. Open the viewer.
2. Drop in an IFC file, or choose the sample model.
3. Select an element to see its properties, then open a tool from the viewer.

!!! tip
    Start with the browser version. Install Local Studio only if you need
    native Python, conversion, command-line checks, or an MCP bridge.

## Choose how to run it

| Browser | Local Studio |
| --- | --- |
| No installation | Install with `pip install ifcviewx` |
| Best for everyday viewing and review | Adds native IfcOpenShell tools |
| Files stay in the browser tab | Files stay on your computer |

[Learn about Local Studio](local-studio.md)

## Main tools

<div class="grid cards" markdown>

-   **Inspect and organize**

    Browse the model tree, properties, quantities, schedules, and saved
    selection sets.

-   **Review geometry**

    Measure, cut sections, build 2D plans, compare revisions, and check clashes.

-   **Check and report**

    Run model checks and IDS validation. Export an offline report or BCF issues.

-   **Extend the viewer**

    Add a bundled or installed extension through the permission-scoped SDK.

</div>

## Where to go next

- Use [Smart Measure](smart-measure.md) for gaps and axis measurements.
- Use [Section Workspace](section-workspace.md) for plans and elevations.
- Read the [Assistant guide](assistant.md) before connecting an AI provider.
- See [Extensions](plugins/index.md) if you want to add a tool.
