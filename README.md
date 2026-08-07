<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo/lockup-dark.svg">
    <img src="assets/logo/lockup-light.svg" alt="IFCViewX" width="360">
  </picture>
</p>

<p align="center">
  Fast, private IFC viewing. Files never leave your machine.
  <br>
  <a href="https://nbharathik.github.io/ifc-viewx/"><strong>Open the viewer</strong></a>
  &middot;
  <a href="https://nbharathik.github.io/ifc-viewx/docs/">Docs</a>
</p>

Drop an IFC file on it. Nothing to install, nothing uploaded.

## What it does

* Model tree, properties, quantities and schedules
* Measure length, angle and area; section planes, 2D plans, saved viewpoints
* Colour the model by class, storey or any property, with a legend
* Ghost hidden elements instead of losing them, and undo any hide or isolate
* Named selection sets, saved per model
* Quality checks and IDS validation
* One offline HTML report: checks, IDS, clashes and issues, print it to PDF
* Editing with diffs, undo and redo
* Triangle-level clash detection with clearance checking, quantity takeoff,
  room book, model compare, BCF issues
* Python console with real IfcOpenShell
* Optional AI assistant, using your own Claude, OpenAI, OpenRouter or local
  model, with streaming replies, native tool calling and saved conversations

No file to hand? Open the viewer and pick **try a sample building**.

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

## Check a model in CI

```
pip install "ifcviewx[check]"
ifcviewx check model.ifc --ids spec.ids --json result.json --fail-on error
```

No browser and no network. Exit `0` clean, `1` findings at or above
`--fail-on`, `2` bad input or a crash, so a pipeline can tell a broken model
from a broken run.

## Plugins

Here are some of the plugins that ship with the viewer, and a few that need Local Studio. 

| In the browser | Local Studio | Built into the app |
| --- | --- | --- |
| Clash Detection, Element Explorer, Model Compare, Python Console, Quantity Takeoff, Room Book, Storey Navigator | Assistant Key Vault, IfcOpenShell Converter, MCP Bridge, Native Python | Element Schedules, IDS Validation, Issue Tracker, Model Checks, Model Edits, Smart Filters |

Want to build a plugin? See [Writing a plugin](https://nbharathik.github.io/ifc-viewx/docs/plugins/) and [working on the repo](https://nbharathik.github.io/ifc-viewx/docs/contributing/).

## License

Apache License 2.0, see [LICENSE](LICENSE).

Bundled: three.js (MIT), web-ifc (MPL-2.0). Loaded at runtime from their
upstream hosts: Pyodide (MPL-2.0), IfcOpenShell (LGPL-3.0). Each keeps its own
license.
