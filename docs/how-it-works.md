# How IFCViewX works

This page is for contributors who want a quick map of the app. You do not need
it to use IFCViewX or build a basic extension.

## Loading a model

```text
IFC file -> web-ifc worker -> streamed mesh batches -> three.js scene
```

1. A Web Worker parses the file with web-ifc and WebAssembly.
2. Meshes stream to the viewer while parsing continues.
3. Meshes with the same material are merged to reduce draw calls.
4. The scene handles navigation, sections, snapping, and GPU picking.

Properties stay in the worker and are read when needed. Tools that need every
property share one full property index.

After a merged mesh reaches the GPU, the viewer releases the temporary CPU
arrays. This keeps large files responsive and avoids storing the same display
data twice.

## Geometry analysis

The renderer releases its temporary mesh arrays after uploading them to the
GPU. Geometry tools use one smaller retained copy containing positions and
indices only. Clash checks, distance, axis laser, section contours, and model
compare share this worker-side data.

Model Compare parses the baseline in a separate worker, creates compact
signatures, and releases its meshes. Only the current model reaches the GPU.

Precision picking uses the existing GPU pick pass at most once per animation
frame. It can report a vertex, edge midpoint, edge, or face. Tools reuse that
hover result when the user clicks, so normal navigation does not gain extra
geometry work.

Section contours apply placements, origin shifts, and federation offsets before
intersecting the plane. The geometry worker joins segments by element and marks
paths as open or closed. Section Workspace draws the returned contours without
accessing renderer internals.

## Shared capabilities

The assistant, browser bridge, and extensions call the same typed capability
registry. Each capability declares its input schema, effect, cost, availability,
and cancellation behavior. Large outputs stay in a bounded result store and are
passed around by handle.

## Main folders

| Folder | Purpose |
| --- | --- |
| `src/viewer-core/` | Parsing, scene, camera, and picking |
| `src/geometry/` | Retained geometry and worker queries |
| `src/capabilities/` | Typed operations, policy, and results |
| `src/ui/` | App shell, commands, and built-in panels |
| `src/ifc/` | Checks, schedules, edits, and clash logic |
| `src/extensions/` | Manifests, permissions, packages, and sandbox calls |
| `src/sdk/` | Public extension contract |
| `src/plugins/` | Bundled extensions |
| `src/assistant/` and `src/llm/` | Assistant runtime and provider formats |
| `src/bridge/` | Local Studio connection |
| `src/python/` | Browser Python through Pyodide |

## Browser and Local Studio

The hosted viewer runs fully in a browser tab. Local Studio serves the same app
with native conversion, Python, providers, MCP, and assistant key storage. The
hosted viewer never connects to Local Studio, so there is no pairing step.

## Safety rules

- Model files stay on the machine. Only configured assistant data leaves it.
- Edits run on a copy and wait for user approval.
- The assistant can write Python, but only the user can run it.
- Features use the public SDK instead of importing viewer internals.

See [Working on the repo](contributing.md) for setup and code rules.
