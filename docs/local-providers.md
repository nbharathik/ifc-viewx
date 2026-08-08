# Local Studio providers

Local providers add exact geometry kernels, large batch workflows, conversion,
and other native operations without widening the browser extension sandbox.
They are Python packages installed into the same environment as Local Studio.
They are trusted native software and run with the permissions of the Local
Studio process.

## How a browser extension uses one

An extension declares one companion and requests the `local.invoke`
permission:

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

The extension management screen reports whether that provider is installed,
whether its version matches, and which native capabilities are available. A
required mismatch prevents activation. An optional companion leaves the
browser-only part usable.

The SDK binds calls to the declared provider. Extension code cannot select a
different native package:

```ts
const state = ctx.local.status();
const capabilities = ctx.local.capabilities();
const result = await ctx.local.invoke("geometry.exact-clearance", {
  a: [120, 121],
  b: [880],
  toleranceMm: 5,
}, controller.signal);
```

Closing the extension or aborting the supplied signal requests cancellation
of the Local Studio job. The sandbox receives only typed JSON results. It does
not receive the session token, a model path, raw model bytes, or the provider
object.

## Provider package contract

Register an entry point in the provider package:

```toml
[project.entry-points."ifcviewx.providers"]
clearance = "example_clearance:provider"
```

The entry point returns an object with a `manifest` mapping and a `run`
method. Provider and capability IDs are stable, lowercase, and namespaced.
The manifest uses schema version 1:

```python
class ClearanceProvider:
    manifest = {
        "schemaVersion": 1,
        "id": "org.example.clearance-native",
        "version": "1.2.0",
        "name": "Exact clearance",
        "description": "Exact BRep clearance checks.",
        "limits": {
            "maxConcurrency": 1,
            "timeoutSeconds": 900,
            "memoryBytes": 4 * 1024**3,
            "resultTtlSeconds": 3600,
        },
        "capabilities": [{
            "id": "geometry.exact-clearance",
            "title": "Exact clearance",
            "description": "Measure exact clearance between element sets.",
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
        model = context["modelPath"]
        progress({
            "phase": "geometry",
            "done": 0,
            "total": len(inputs["a"]),
            "message": "Building exact shapes",
        })
        return {"pairs": [], "modelSha": context["modelSha"]}


provider = ClearanceProvider()
```

The service validates manifests during discovery. Unsupported schemas,
duplicate capabilities, invalid effects, missing limits, and any input schema
that asks for a path are rejected. Browser inputs are checked against the
declared schema again before a job is created. Provider output is checked
against the result schema before it is stored or returned.

`context["modelPath"]` is resolved by Local Studio from the content hash. It
is never supplied by the browser. Capabilities that do not need a model use
`modelRequirement: "none"` and receive no model path.

Install a provider with the Python package manager, then restart Local Studio:

```bash
python -m pip install example-clearance-provider
ifcviewx
```

The browser extension installer never installs or updates native providers.

## Job protocol

The authenticated version 1 API is:

```text
GET  /api/v1/providers
POST /api/v1/jobs
GET  /api/v1/jobs/{id}
POST /api/v1/jobs/{id}/cancel
GET  /api/v1/jobs/{id}/result
```

A job moves through `queued`, `running`, then `succeeded`, `failed`, or
`cancelled`. Progress has `phase`, `done`, `total`, and `message`. Results use
a versioned envelope and expire after the provider or service TTL, whichever
is shorter.

Jobs and results are persisted under the Local Studio state directory. If the
service restarts during a job, the next process changes it to `failed` with
the `service_restarted` code. A browser disconnect does not apply or discard a
completed result.

The service applies both global and per-provider concurrency limits. Each job
runs in a killable child process with a timeout and memory ceiling. These
limits contain mistakes and runaway work. They do not make an installed
provider untrusted or safe to install from an unknown publisher.

## Built-in compatibility provider

`org.ifcviewx.core` exposes conversion, validation, schedules, guarded Python
queries, and staged Python edits through the job protocol. The existing
`/convert`, `/validate`, `/schedule`, `/python`, and `/jobs/{id}` routes remain
available and delegate to the same provider jobs. This allows an older viewer
and a newer Local Studio package to overlap during migration.

It also exposes `geometry.precise-distance`. The capability builds a BVH from
a tightly tessellated pair of IfcOpenShell product shapes and returns the
shortest surface distance, witness points, intersection state, fidelity, and
engine. The Smart Measure extension uses it only when the user selects local
precise mode; the browser mesh path remains the responsive default.

The result is deliberately labeled `native-mesh`. IfcOpenShell clearance
queries operate on iterator triangulation, so this built-in capability does
not claim exact BRep fidelity. A separate provider with a true topology-kernel
distance operation may advertise exact fidelity through the same job model.
