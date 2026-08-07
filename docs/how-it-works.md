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
exists in graphics memory. Analysis that needs real surfaces rather than boxes,
clash detection today, reads a second and much leaner copy of the same
triangles: positions and indices, one entry per unique geometry, no normals or
colours. It is handed to the clash worker on the first sweep and never copied
again, and it is never a second geometry pipeline: the triangles are the ones
the renderer was given.

## The parts

| Folder | Responsibility |
| --- | --- |
| `viewer-core/` | Parsing, geometry, scene, camera, picking |
| `ui/` | Shell, ribbon, commands, and the built in panels |
| `ifc/` | Model checks, typed edits, schedules, clash |
| `python/` | Pyodide with IfcOpenShell |
| `llm/` | The assistant |
| `bridge/` | Talking to Local Studio |
| `sdk/` | The plugin contract |
| `plugins/` | The plugins |

## Two tiers

The same app runs in two places. In a browser tab it is bounded by what a tab
can do. Under Local Studio the page also talks to a local service, which adds
IfcOpenShell conversion, native Python, the MCP bridge and the key vault.

The hosted viewer never reaches your machine, so there is no pairing step. A
plugin can ask which tier it is on with `ctx.service.mode()`.

## Rules the code holds to

- **Nothing leaves the machine.** No upload, no telemetry. The only network
  calls are the WASM binary, the Pyodide runtime on first Python run, and your
  own assistant provider if you configure one.
- **Edits are staged, never applied.** Every edit runs on a copy and comes back
  as a diff you approve. Undo restores the previous checkpoint.
- **The assistant cannot execute code.** It writes Python and hands it to the
  console. Pressing Run is yours.
- **One home per feature.** If the app already has a panel for something, the
  catalog points at it rather than shipping a second copy.
