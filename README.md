<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="IFCViewX" width="360">
  </picture>
</p>

<p align="center">
  Fully private IFC viewing. No uploads, analytics or tracking.
  <br>
  Everything runs locally and files never leave your machine. Drop an IFC file to get started.
  <br>
  <a href="https://nbharathik.github.io/ifc-viewx/"><strong>Open the viewer</strong></a>
  &middot;
  <a href="https://nbharathik.github.io/ifc-viewx/docs/">Docs</a>
</p>

## What it does

* Model tree, properties, quantities and schedules
* Measurements, section planes, 2D plans and saved viewpoints
* Quality checks, IFC conformance and IDS validation
* Editing with diffs, undo and redo
* Quantity takeoff, room data and BCF issues
* Python console with real IfcOpenShell
* Optional AI assistant using your own provider

## Install it locally

```
pip install ifcviewx
ifcviewx                     # opens the viewer in your browser
ifcviewx model.ifc           # with that model already open
```

Serves the same viewer from `127.0.0.1:8765` and adds what a browser tab
cannot do: IfcOpenShell conversion, native Python, an MCP bridge for AI
clients, and a vault that keeps your assistant key off the page.
See [Local Studio](https://nbharathik.github.io/ifc-viewx/docs/local-studio/).

## Plugins

These are the plugins and built-in tools available in this release.

| In the browser | Local Studio | Built into the app |
| --- | --- | --- |
| Element Explorer, Python Console, Quantity Takeoff, Room Book, Storey Navigator | Assistant Key Vault, IfcOpenShell Converter, MCP Bridge, Native Python | Element Schedules, IDS Validation, Issue Tracker, Model Checks, Model Edits, Smart Filters |

See the [available tools](https://nbharathik.github.io/ifc-viewx/docs/plugins/catalog/).

## License

Apache License 2.0, see [LICENSE](LICENSE).

Bundled: three.js (MIT), web-ifc (MPL-2.0). Loaded at runtime from their
upstream hosts: Pyodide (MPL-2.0), IfcOpenShell (LGPL-3.0). Each keeps its own
license.
