# ifcviewx

The pip package behind IFCViewX **Local Studio**. One install serves the full
viewer at `http://127.0.0.1:8765` and adds everything a browser tab alone
cannot do:

- IFC to `.ifcx` conversion with IfcOpenShell, with live progress and cancel
- native IfcOpenShell Python, so the browser never downloads a runtime
- model checks and element schedules that need no generated code
- the viewer exposed to MCP clients (Claude Desktop, Claude Code) as tools
- an optional assistant proxy so the provider key never reaches the browser

Everything stays on your machine.

## Install and run

Until the package is on PyPI, install the wheel from the latest release by URL.
IfcOpenShell comes with it, so there is nothing else to add (~100 MB):

```
pip install https://github.com/nbharathik/ifc-viewx/releases/latest/download/ifcviewx-0.1.0-py3-none-any.whl
ifcviewx                            # serves the viewer and opens the browser
```

```
ifcviewx model.ifc                  # same, with the model staged and opened
ifcviewx model.ifc --convert        # convert to .ifcx first, then open
ifcviewx convert model.ifc          # terminal conversion (also: ifcx-convert)
ifcviewx mcp                        # MCP over stdio, for AI clients
```

IfcOpenShell is a plain dependency, so conversion, native Python and model
checks are there by default. On a Python it has no wheel for, the install still
succeeds and those three report themselves as not configured rather than
breaking the viewer. A second `ifcviewx model.ifc` while one instance runs
reuses it: the file is staged into the shared store and the browser opens on
the running service.

Local Studio is a self-contained app, not an add-on to the hosted viewer. It
carries its own copy of the viewer, serves it from `127.0.0.1`, and hands that
page its session token, so it opens with everything on and nothing to type. The
hosted copy is a separate app that never talks to this service: there is no
pairing step and no token to paste anywhere.

Working from a checkout: `cd local-bridge && pip install -e .`. The service
then serves the repo's `dist/` from `npm run build` at the root.

## CLI flags

| Flag | Meaning |
|---|---|
| `--port N` | serve on this port (default 8765) |
| `--token T` | fix the session token instead of a random one |
| `--convert` | convert the given model to `.ifcx` before opening |
| `--readonly` | refuse uploads, conversions and edits |
| `--no-python` | disable code execution entirely |
| `--no-browser` | do not open a browser |

## Configuration

Environment variables use the `IFCVIEWX_` prefix (the pre-rename
`IFC_BRIDGE_` names are still read as a fallback).

| Variable | Default | Purpose |
|---|---|---|
| `IFCVIEWX_TOKEN` | random 128-bit | fixes the session token across runs |
| `IFCVIEWX_PORT` | `8765` | HTTP/WebSocket port |
| `IFCVIEWX_APP` | packaged app / repo `dist/` | a built viewer to serve |
| `IFCVIEWX_MODELS` | `~/.cache/ifcviewx/models` | model store |
| `IFCVIEWX_STATE` | store parent | audit log location |
| `IFCVIEWX_ORIGINS` | (unset) | extra browser origins to trust besides localhost; only for hosting the viewer yourself |
| `IFCVIEWX_ROOTS` | (unset) | restrict `convert_model` to these directories |
| `IFCVIEWX_ALLOW_PYTHON` | `1` | set `0` to disable code execution entirely |
| `IFCVIEWX_READONLY` | `0` | set `1` to refuse uploads, conversions and edits |
| `IFCVIEWX_STORE_GB` | `20` | store quota; oldest models are evicted past it |
| `IFCVIEWX_MAX_UPLOAD_MB` | `2048` | per-upload ceiling |
| `IFCVIEWX_PYTHON_TIMEOUT` | `120` | seconds before generated code is killed |
| `IFCVIEWX_CONVERT_TIMEOUT` | `900` | seconds before a conversion is killed |
| `IFCVIEWX_MEMORY_GB` | `4` | address-space cap for child processes (POSIX) |
| `IFCVIEWX_RESULT_TTL_S` | `3600` | how long an unapplied edit result is kept |
| `IFCVIEWX_LLM_PROVIDER` | (unset) | `openai-compatible` or `anthropic` to enable the proxy |
| `IFCVIEWX_LLM_BASE_URL` / `_API_KEY` / `_MODEL` | (unset) | proxy target |

## HTTP API

| Route | Purpose |
|---|---|
| `GET /health` | version and capabilities; store and posture with a token |
| `POST /model` | upload an IFC, stored by SHA-256 |
| `POST /convert` | start a conversion job |
| `GET /jobs/{id}` | job status with `percent` |
| `POST /jobs/{id}/cancel` | kill a running conversion |
| `GET /models/{sha}.ifcx` | the converted model (`.ifc` serves the source) |
| `POST /python` | run guarded code, `query` or `edit` |
| `GET /python/result/{id}` | download an edit result |
| `POST /guard` | check code without running it |
| `POST /validate` | structural QA, no code execution |
| `POST /schedule` | element/property table, no code execution |
| `GET /store`, `POST /store/prune` | model cache stats and cleanup |
| `POST /llm/chat` | assistant proxy (when configured) |
| `GET /audit` | recent activity |
| `WS /ws?token=` | MCP bridge to the browser |

Everything except `/health` and `/models/{sha}` requires the `X-IFC-Token`
header.

## Security

**Transport.** Bound to `127.0.0.1` only. The `Host` header must be localhost,
which blocks DNS rebinding that a token check alone would not. Browser origins
must be localhost. The only page this service answers is the copy of the viewer
it served itself, so no site on the internet is trusted, including the hosted
copy of this same viewer. `IFCVIEWX_ORIGINS` names extra origins for someone
hosting the viewer themselves; it is empty by default, and pointing it at a
page you do not control hands that page everything the token protects.

**Authentication.** A 128-bit per-run token gates every route that writes,
executes or describes this machine. Comparisons are constant time, and repeated
failures from one client are throttled.

**Generated code** passes through three layers, because any one of them can be
wrong:

1. an AST guard, not a regex scan, so `getattr(x, "__cla" + "ss__")` is caught
   like any other dunder access. Imports are allowlisted, and `eval`, `exec`,
   `compile`, `open`, `globals` and friends are rejected outright.
2. a throwaway subprocess with curated `__builtins__` (the dangerous names are
   simply absent), an import hook that re-checks the allowlist at runtime, a
   scrubbed environment, a temporary working directory, and address-space, CPU
   and file-descriptor limits where the platform provides them.
3. the edit contract: code never touches the stored source. It runs against a
   fresh handle, writes a separate result file, and the change only reaches the
   model after the user clicks Apply in the viewer.

The reply carries a **measured** diff (added / removed / modified GlobalIds)
computed by comparing the model before and after, not the summary the code
claims. `IFCVIEWX_ALLOW_PYTHON=0` removes the capability altogether.

**Data.** Uploads are content-addressed, sniffed for a STEP header before they
are kept, capped per file and in total, and evicted oldest-first past the quota.
Unapplied edit results expire. No filename ever comes from a client.

**Auditing.** Every guarded action appends one line to
`~/.cache/ifcviewx/audit.jsonl`: what ran, when, from where, and for code
its hash and first line, never the source itself.

**What this is not.** The service executes IfcOpenShell code on your machine by
design. The layers above make accidental and casual-hostile code fail closed;
they are not a substitute for an OS sandbox. Run with
`IFCVIEWX_ALLOW_PYTHON=0` if you only want viewing, conversion and checks.

## MCP client configuration (Claude Desktop example)

```json
{
  "mcpServers": {
    "ifcviewx": {
      "command": "ifcviewx",
      "args": ["mcp"],
      "env": { "IFCVIEWX_TOKEN": "choose-a-token" }
    }
  }
}
```

`ifcviewx mcp` serves the viewer and the HTTP API too, so the browser side of
the bridge is the same app at `http://127.0.0.1:8765`.

## Tools

Viewer: `get_status`, `get_model_info`, `get_spatial_tree`, `get_selection`,
`select_element`, `get_properties`, `set_visibility`, `show_all`, `fit_view`.

Analysis without generated code: `validate_model`, `element_schedule`.

Files and housekeeping: `convert_model`, `list_converted_models`,
`service_status`.

**No execution tool.** There is no `run_python` and no other way for an MCP
client to execute code. A client reads the model, drives the viewport and
stages typed edits, and every edit waits for the user to click Apply. Running
IfcOpenShell is the user's, in the viewer's Python Console, which only a human
click starts. The service still executes Python for that console over HTTP,
authenticated with the session token.

## Tests and packaging

```
python -m pytest tests -q
```

The suite covers guard bypasses, the route authorisation matrix, store quotas
and path safety, and sandbox behaviour end to end against a real IFC file.

Building the wheel bundles the viewer: `npm run build` at the repo root, then
`python -m build local-bridge`. The hatch hook copies `dist/` into the package
and refuses to pack without it. Tagging `v*` publishes to PyPI via
`.github/workflows/publish-pypi.yml` (trusted publishing).
