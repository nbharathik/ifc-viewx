# How the viewer works

You do not need any of this to write a plugin.

## The path a file takes

```
file  ->  parser worker  ->  mesh batches  ->  three.js scene
              (web-ifc)        (streamed)       (merged draws)
```

1. **Parse.** The bytes go to a worker running
   [web-ifc](https://github.com/ThatOpen/engine_web-ifc) compiled to
   WebAssembly, so the main thread never blocks.
2. **Stream.** Meshes arrive in batches while the file is still parsing, which
   is why a large model starts drawing before it finishes loading.
3. **Batch.** Meshes sharing a material merge into a few large draw calls, with
   per element colour and visibility as vertex attributes. This is what keeps a
   hundred thousand elements interactive.
4. **Draw.** A three.js scene with orbit camera, section planes, snapping and
   GPU picking.

Properties are not held in memory with the geometry. They are read from the
worker one element at a time, on demand, which keeps the heap flat on big
files. Anything needing every property builds the
[property index](plugins/api.md#the-property-index) once and shares it.

Merged chunks free their arrays once the GPU has them, so a drawn model only
exists in graphics memory. Analysis that needs real surfaces rather than boxes
reads a second and much leaner copy of the same triangles: positions and
indices, one entry per unique geometry, no normals or colours. It is handed to
one lazy geometry worker on the first query and never copied again. Clash,
shortest-distance, six-direction axis laser, and section-contour queries share
this representation. Geometry-aware compare also derives compact, sampled
shape, placement and bounds signatures there. New algorithms extend the
service rather than retaining another copy.

When a geometry tool asks for an exact viewport point, the existing GPU pick
patch probes at most once per animation frame and reports Vertex, Edge
midpoint, Edge or Face beside the cursor. The click reuses that hover result,
so tools receive a real snapped geometry point without adding hover work during
ordinary navigation.

Section contours apply every retained placement, origin shift, and federation
offset before intersecting the requested plane. The worker joins segments per
element and classifies open and closed paths. The synchronized
[Section Workspace](section-workspace.md) draws those paths without reaching
into the renderer.

Model Compare parses its baseline in a separate worker but never uploads it to
the renderer. Mesh batches become compact signatures and are released. The
current model stays as the only GPU model while property, containment,
placement, rotation, bounds and sampled shape changes are classified.

Assistant viewer tools, browser MCP actions, bundled extensions, and installed
extension RPC calls share a typed capability registry. Each operation declares
its schema, effect, cost,
availability, and cancellation behavior. Large structured outputs can live in
the bounded result store and be addressed by handles instead of being copied
into chat history.

## The parts

| Folder | Responsibility |
| --- | --- |
| `viewer-core/` | Parsing, geometry, scene, camera, picking |
| `ui/` | Shell, ribbon, commands, and the built in panels |
| `ifc/` | Model checks, typed edits, schedules, clash |
| `capabilities/` | Typed operations, policy checks, and result handles |
| `geometry/` | Shared retained-mesh worker and geometry queries |
| `extensions/` | Manifest validation, scoped resources, installed packages, and sandbox RPC |
| `python/` | Pyodide with IfcOpenShell |
| `assistant/` | Agent runtime, evidence, result tools, provider transports |
| `llm/` | Provider wire formats, prompts, and compatibility tools |
| `bridge/` | Talking to Local Studio |
| `sdk/` | The plugin contract |
| `plugins/` | The plugins |

## Two tiers

The same app runs in two places. In a browser tab it is bounded by what a tab
can do. Under Local Studio the page also talks to a local service, which adds
IfcOpenShell conversion, native Python, trusted native providers, the MCP
bridge and the key vault.

The hosted viewer never reaches your machine, so there is no pairing step. A
v2 extension with a declared companion can read its provider state through
`ctx.local.status()`. The raw service client and session token remain private
to the host.

## Rules the code holds to

- **The model file stays on the machine.** There is no model upload or
  telemetry. If you configure an assistant provider, compact viewer context and
  bounded tool reports are sent to it. A viewport image is sent only when you
  explicitly attach it for that turn. See [Assistant](assistant.md).
- **Edits are staged, never applied.** Every edit runs on a copy and comes back
  as a diff you approve. Undo restores the previous checkpoint.
- **The assistant cannot execute code.** It writes Python and hands it to the
  console. Pressing Run is yours.
- **One home per feature.** If the app already has a panel for something, the
  catalog points at it rather than shipping a second copy.
