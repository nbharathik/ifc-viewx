# Native providers

A native provider is a trusted Python package that adds a capability to Local
Studio. Use one for exact geometry, large batch work, conversion, or another
task that should not run in the browser sandbox.

!!! warning
    Providers run with the permissions of Local Studio. Install them only from
    a source you trust.

## Connect an extension

Declare one companion and request `local.invoke`:

```json
{
  "permissions": ["local.invoke"],
  "localCompanion": {
    "id": "org.example.clearance-native",
    "version": ">=1.2 <2",
    "required": true
  }
}
```

The extension manager shows whether the provider is installed and compatible.
A required mismatch blocks the extension. An optional mismatch leaves its
browser-only features available.

Call a capability through the bound companion:

```ts
const result = await ctx.local.invoke(
  "geometry.exact-clearance",
  { a: [120, 121], b: [880], toleranceMm: 5 },
  ctx.signal,
);
```

The extension cannot choose another provider or read its model path, session
token, or Python object.

## Create a provider package

Register an entry point in `pyproject.toml`:

```toml
[project.entry-points."ifcviewx.providers"]
clearance = "example_clearance:provider"
```

The entry point returns an object with `manifest` and `run`:

```python
class ClearanceProvider:
    manifest = {
        "schemaVersion": 1,
        "id": "org.example.clearance-native",
        "version": "1.2.0",
        "name": "Exact clearance",
        "description": "Measures clearance with a native geometry kernel.",
        "limits": {
            "maxConcurrency": 1,
            "timeoutSeconds": 900,
            "memoryBytes": 4 * 1024**3,
            "resultTtlSeconds": 3600,
        },
        "capabilities": [{
            "id": "geometry.exact-clearance",
            "title": "Exact clearance",
            "description": "Measure clearance between element sets.",
            "effect": "read",
            "modelRequirement": "ifc-source",
            "available": True,
            "inputSchema": {
                "type": "object",
                "properties": {
                    "a": {"type": "array", "items": {"type": "integer"}},
                    "b": {"type": "array", "items": {"type": "integer"}},
                    "toleranceMm": {"type": "number", "minimum": 0},
                },
                "required": ["a", "b"],
                "additionalProperties": False,
            },
            "resultSchema": {
                "type": "object",
                "additionalProperties": True,
            },
        }],
    }

    def run(self, capability_id, context, inputs, progress):
        model_path = context["modelPath"]
        progress({
            "phase": "geometry",
            "done": 0,
            "total": len(inputs["a"]),
            "message": "Building shapes",
        })
        return {"pairs": [], "modelPathUsed": bool(model_path)}


provider = ClearanceProvider()
```

Local Studio checks manifests, browser inputs, and provider results against
their schemas. Capability IDs must be lowercase and namespaced. Input schemas
cannot accept file paths.

Discovery also rejects unsupported schema versions, duplicate capabilities,
invalid effects, and missing resource limits. A malformed provider is shown as
unavailable instead of being called.

For `modelRequirement: "ifc-source"`, Local Studio finds the source from the
model content hash and adds `context["modelPath"]`. The browser never supplies
that path. Use `modelRequirement: "none"` when no model is needed.

Install the package in the Local Studio environment, then restart:

```bash
python -m pip install example-clearance-provider
ifcviewx
```

## Job lifecycle

The authenticated API uses these routes:

```text
GET  /api/v1/providers
POST /api/v1/jobs
GET  /api/v1/jobs/{id}
POST /api/v1/jobs/{id}/cancel
GET  /api/v1/jobs/{id}/result
```

A job moves from `queued` to `running`, then to `succeeded`, `failed`, or
`cancelled`. Progress includes `phase`, `done`, `total`, and `message`. Results
expire after the shorter provider or service time limit.

Jobs run in child processes with concurrency, memory, timeout, and result-size
limits. These limits contain mistakes, but they do not make an unknown package
safe. A service restart marks interrupted jobs as `failed` with the
`service_restarted` code.

Job metadata and results are stored under the Local Studio state directory.
A browser disconnect does not delete a completed result. Closing the extension
or aborting `ctx.signal` requests cancellation of its active job.

??? info "Security boundary"
    Browser calls carry typed JSON only. The service resolves model paths from
    the authenticated model hash and checks the input schema before starting a
    process. The result is checked again before it is stored or returned.

    Global and per-provider concurrency limits protect the service from a large
    queue. Per-job memory and time limits stop runaway work where the operating
    system supports them. These controls reduce damage from mistakes, but the
    package itself remains trusted native code.

## Built-in provider

`org.ifcviewx.core` provides conversion, validation, schedules, guarded Python,
staged Python edits, and `geometry.precise-distance`. The distance capability
uses a tightly tessellated IfcOpenShell mesh, so it reports `native-mesh`, not
exact BRep fidelity.

Older `/convert`, `/validate`, `/schedule`, `/python`, and `/jobs/{id}` routes
delegate to the same built-in jobs. This lets older viewer and Local Studio
versions overlap during upgrades.
