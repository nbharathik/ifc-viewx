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
</p>

Everything runs directly in the browser: viewing, model checks, schedules, filters, IDS validation, issue management, and model editing. No installation or file upload is required. Connect your own Claude, OpenAI, OpenRouter, or local model.

## Features

* Model tree, properties, quantities, summaries, and schedules
* Measurements, section planes, 2D plans, and saved viewpoints
* Model quality checks and IDS validation
* Safe model editing with diffs, undo, and redo
* Clash detection, quantity takeoff, model comparison, and BCF issues
* Optional AI assistant with 16 predefined tools
* Python console, command palette, and light/dark themes

## Develop

```
npm install
npm run dev        # http://localhost:5173/ifc-viewx/
npm run build      # typecheck + production build into dist/
```

Push to `main` deploys to GitHub Pages.

## Local Studio (a separate app)

The same viewer, installed and run on your machine, where it adds the four
things a browser tab cannot do: IfcOpenShell conversion, native Python for the
console, an MCP bridge for AI clients, and a vault that keeps your assistant
key off the page.

```
pip install https://github.com/nbharathik/ifc-viewx/releases/latest/download/ifcviewx-0.1.0-py3-none-any.whl
ifcviewx                          # serves the viewer and opens the browser
ifcviewx path/to/model.ifc        # same, with that model opened
ifcviewx model.ifc --convert      # convert to .ifcx first, then open
ifcviewx mcp                      # expose the running viewer to MCP clients
```

It serves its own copy of the viewer from `127.0.0.1:8765` and opens it with
everything already on. The two are separate apps and never connect: the hosted
viewer does not reach your machine, so there is no pairing step and nothing to
paste. Use whichever one suits the job. See
[local-bridge/README.md](local-bridge/README.md).

## Shortcuts

`F` frame · `Shift+F` frame selection · `M` measure · `X` section · `G` 2D plan
`I` isolate · `H` hide · `A` show all · `S` screenshot · `V` viewpoint
`1/2/3/4` front, right, top, iso · `Ctrl+K` palette · `Ctrl+F1` ribbon · `?` all of them

## License

Apache License 2.0, see [LICENSE](LICENSE).

Bundled: three.js (MIT), web-ifc (MPL-2.0). Loaded from their upstream hosts at
runtime: Pyodide (MPL-2.0), IfcOpenShell (LGPL-3.0). Each keeps its own license.
