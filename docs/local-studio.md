# Local Studio

Local Studio runs IFCViewX on your computer and adds tools that a browser tab
cannot provide.

## Install and start

```bash
pip install ifcviewx
ifcviewx
```

It opens the viewer at `http://127.0.0.1:8765`.

Common commands:

```bash
ifcviewx model.ifc             # open a model
ifcviewx model.ifc --convert   # convert first, then open
ifcviewx check model.ifc       # run checks in a terminal
ifcviewx mcp                   # start the MCP bridge
```

## What it adds

| Tool | What it does |
| --- | --- |
| IFC conversion | Converts IFC to `.ifcx` with IfcOpenShell for faster reopening |
| Native Python | Runs the full IfcOpenShell API without a browser runtime download |
| MCP bridge | Lets supported AI clients read the model and control the view |
| Assistant key vault | Keeps the provider key in the local service |
| Command-line checks | Runs structural and IDS checks without a browser or network |
| Native providers | Adds trusted Python packages for native workflows |

Local Studio is a separate copy of the app. The hosted viewer does not connect
to it, and there is no pairing code or token to paste.

Conversion keeps a cached `.ifcx` copy, so later opens can skip IFC parsing.
Native Python runs against the full IfcOpenShell API. Edits still run on a copy
and return to the viewer as a diff that you must approve.

The MCP bridge can query the loaded model and change the view by selecting,
isolating, or framing elements. It does not expose a tool that runs Python or
writes directly to the model.

The assistant proxy uses the same tools and streaming events as browser
providers. A viewport image is sent only when you attach it and the configured
provider supports images.

## Check a model in CI

```bash
pip install "ifcviewx[check]"
ifcviewx check model.ifc --ids spec.ids --json result.json --fail-on error
```

| Exit code | Meaning |
| --- | --- |
| `0` | No finding reached the selected level |
| `1` | At least one finding reached the selected level |
| `2` | Bad input, missing dependency, or a crash |

`--fail-on` accepts `error`, `warning`, `info`, or `none`. Use `--ids` more than
once to check several IDS files. Use `--json -` to write JSON to standard output.

The JSON result includes a schema version, model SHA-256, check counts, and the
elements that failed each rule. This makes the result suitable for CI artifacts
and later comparison.

IDS checks use the optional `ifctester` package. If it is missing, the command
stops with exit code `2` instead of silently skipping IDS checks.

## Add native tools

A native provider is a separate Python package registered in the
`ifcviewx.providers` entry-point group. Install it into the same Python
environment, restart Local Studio, and let an extension call it through a
declared companion.

Read [Native providers](local-providers.md) for the package contract. See the
[Local Studio package reference](https://github.com/nbharathik/ifc-viewx/blob/main/local-bridge/README.md)
for flags, environment variables, API routes, and security details.
