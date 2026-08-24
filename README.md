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

* Local-first IFC viewer: runs on your machine, with no uploads, no tracking, and no cloud dependency
* Private by default: your models stay local, with secure local tools and offline reporting
* Built for BIM workflows: model tree, measurements, sections, filters, legends, and selection sets
* A definitions layer: saved views and computed properties stored as rules, so one file re-runs on the next
  revision and can be handed to the rest of the team
* Quality and coordination: IDS validation, a rule engine for the geometric checks IDS cannot express, offline
  IFC conformance checking, clash detection, model compare, quantity takeoff and a free-form report builder
* The drawing set: import the issued PDF, calibrate it, overlay the model's own plan cut, click through to 3D
  and raise BCF from a markup
* Installable and offline: add it to a tablet's home screen and open a cached model with no connection, or hand
  over one share package holding the model, the views, the drawings and the issues
* Extensible platform: plugin support for browser and local studio workflows, plus Python and IfcOpenShell tools

No file to hand? Open the viewer and pick **try a sample building** to check out the viewer and its tools.

## Run it locally

```
pip install ifcviewx
ifcviewx                     # opens the viewer in your browser
ifcviewx model.ifc           # with that model already open
```

Serves the same viewer from `127.0.0.1:8765` and adds what a browser tab
cannot do: IfcOpenShell conversion, native Python, an MCP bridge for AI
clients, and a vault that keeps your assistant key off the page.
See [Local Studio](https://nbharathik.github.io/ifc-viewx/docs/local-studio/).

Building the browser viewer from source requires Node.js 22.13 or newer. The
hosted viewer and the Python CLI do not require Node.js.

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
Bundled and installable extensions share one permission-scoped SDK contract.

| In the browser | Local Studio | Built into the app |
| --- | --- | --- |
| Clash Detection, Element Explorer, Model Compare, Point Cloud, Presentation, Python Console, Quantity Takeoff, Report Builder, Room Book, Rule Studio, Sheets, Storey Navigator, Sun and Shadow | Assistant Key Vault, IfcOpenShell Converter, MCP Bridge, Native Python | Element Schedules, IDS Validation, IFC Conformance, Issue Tracker, Model Checks, Model Edits, Results Dock, Saved Views, Smart Filters |

Want to build an extension? See [Writing an extension](https://nbharathik.github.io/ifc-viewx/docs/plugins/), the [SDK reference](https://nbharathik.github.io/ifc-viewx/docs/plugins/api/), and [working on the repo](https://nbharathik.github.io/ifc-viewx/docs/contributing/).

## License

Apache License 2.0, see [LICENSE](LICENSE).

Browser dependencies: three.js and three-mesh-bvh (MIT), fflate (MIT), PDF.js /
pdfjs-dist (Apache-2.0), and web-ifc (MPL-2.0). Loaded separately at runtime:
Pyodide (MPL-2.0) and IfcOpenShell (LGPL-3.0). Each keeps its own license.
