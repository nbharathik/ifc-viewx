# Local Studio

The same viewer, running on your machine.

```bash
pip install ifcviewx
```

```bash
ifcviewx                     # serves the viewer and opens the browser
ifcviewx model.ifc           # with that model already open
ifcviewx model.ifc --convert # convert to .ifcx first, then open
ifcviewx check model.ifc     # checks in the terminal, for CI
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
turn, so the key never reaches the page or its storage. The proxy supports the
same native tools and streaming events as the browser transports. View images
are off unless both the user attaches one and the service declares multimodal
support. See [Assistant](assistant.md).

**Checks in CI.** `ifcviewx check` runs the same structural pass the viewer
runs, with no browser and no network.

**Native providers.** Separately installed trusted Python packages can add
exact geometry, large batch jobs, preprocessing, and future native workflows
through a versioned capability and job protocol.

## Checking a model from a terminal

```bash
pip install "ifcviewx[check]"
ifcviewx check model.ifc --ids spec.ids --json result.json --fail-on error
```

| exit | meaning |
| --- | --- |
| 0 | nothing at or above `--fail-on` |
| 1 | findings at or above `--fail-on` |
| 2 | bad input, a missing dependency, or a crash |

That split is the point. With one non-zero code a broken pipeline and a broken
model look identical, and the wrong person gets paged.

`--fail-on` takes `error` (the default), `warning`, `info` or `none`. `--ids`
is repeatable. `--json out.json` writes a versioned result carrying a
`schemaVersion`, the model's sha256, every check with its count, and the
elements that failed each specification; `--json -` writes it to stdout
instead of the summary.

IDS runs through [ifctester](https://pypi.org/project/ifctester/), the
buildingSMART reference implementation, so every facet is evaluated here,
including the classification and material ones the in-browser validator
reports as unsupported. It is an optional dependency: without it, `--ids`
exits 2 and says what to install rather than skipping the check quietly.

## They are separate apps

The hosted viewer does not reach your machine, so there is no pairing step and
nothing to paste. Local Studio is a second copy of the same app with a service
behind it. Your files stay on your machine either way.

## Writing a native provider

A provider is a separate Python package registered through the
`ifcviewx.providers` entry-point group. A browser extension declares its
provider ID and compatible version in `localCompanion`, then calls the
permission-checked `ctx.local` service. See [Local Studio providers](local-providers.md)
for the manifest, job, security, and installation contracts.

The browser extension installer never installs native code. Install the
provider into the Local Studio Python environment and restart the service.

Built-in Local Studio details remain in
[local-bridge/README.md](https://github.com/nbharathik/ifc-viewx/blob/main/local-bridge/README.md).
