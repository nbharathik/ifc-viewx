# SDK v2 reference

SDK v2 is the public contract behind bundled and installed extensions. It separates declarative metadata from lazy runtime code, checks permissions at each domain service, and scopes everything created during activation to the extension lifetime.

```ts
import type { ExtensionContextV2, PluginInstance } from "@ifcviewx/sdk";

export function mount(
  host: HTMLElement,
  ctx: ExtensionContextV2,
  payload?: unknown,
): PluginInstance | void;
```

Bundled panels receive the TypeScript context below. Installed packages use the same manifest and permission model through the narrower [sandbox RPC API](installed.md#authoring-api). Trusted native work is available through a declared Local Studio companion.

## Manifest

`extension.json` is read and validated before the panel module is imported.

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Must be `2` |
| `id` | Stable lowercase ID. It must match the folder for bundled extensions |
| `name`, `description`, `version` | User-facing identity and semantic package version |
| `sdk` | Compatible SDK range, such as `>=2.0.0 <3` |
| `runtime` | `bundled` with a TypeScript entry, or `sandboxed` with a self-contained HTML entry |
| `activationEvents` | Events that may load code. `onPanel:<id>` is the normal panel event |
| `permissions` | Least-privilege access requested from the host |
| `contributes` | Panels, commands, analyses, result views, and other declarative entries |
| `catalog` | Search and explanatory text shown in the plugin browser |

Supported contribution points are `panels`, `commands`, `toolbarItems`, `contextActions`, `analyses`, `assistantTools`, `resultViews`, `overlays`, `importers`, `exporters`, and `settings`. IDs are unique within their contribution point. Command IDs must be namespaced. References such as an analysis `resultView` or toolbar `command` must resolve to another declared entry.

Supported activation events are:

- `onPanel:<id>`
- `onCommand:<id>`
- `onAssistantTool:<id>`
- `onFile:<extension>`
- `onLocalCapability:<id>`
- `onModel`
- `onStartup`, reserved for reviewed bundled extensions

## Permissions

| Permission | Allows |
| --- | --- |
| `model.summary.read` | Loaded model identity |
| `model.structure.read` | Elements, classes, tree, subtree, and federated IDs |
| `model.properties.read` | Properties for one element |
| `model.index.build` | Shared full property index |
| `geometry.query` | Bounds, boxes, clash, shortest distance, and axis laser |
| `view.read` | Selection, last surface pick, visibility, camera, sections, and measurements |
| `view.control` | Selection, visibility, camera, sections, measurements, and color overrides |
| `view.overlay` | Declared host-owned overlay contribution |
| `file.open` | Declared importer contribution |
| `file.export` | Declared exporter contribution |
| `storage.extension` | Namespaced extension storage and settings |
| `assistant.contribute` | Declared assistant tool contribution |

Permissions reserved for later hosts include `geometry.mesh.read`, `edit.propose`, and `viewport.capture`. Declaring a contribution that needs a permission without requesting it is a manifest error.

## Domain services

### Session and model

```ts
ctx.session.model()
ctx.model.elements()
ctx.model.classes()
ctx.model.tree()
ctx.model.subtree(id)
ctx.model.properties(id)
ctx.model.index()
ctx.model.bounds(id)
ctx.model.modelOf(id)
ctx.model.expressOf(id)
```

`ctx.model.index()` is shared across extensions and built once per model. Building it requires more access than reading a single property, so it has its own permission.

### Geometry

```ts
await ctx.geometry.clash(aIds, bIds, {
  toleranceMm: 10,
  clearanceMm: 25,
  signal: controller.signal,
  onProgress: ({ done, total }) => update(done, total),
});

await ctx.geometry.distance(aId, bId, { signal: controller.signal });

await ctx.geometry.laser([12.4, 3.1, -8.0], {
  source: picked.expressID,
  maxDistance: 30,
  signal: controller.signal,
});
```

All calls use the host-owned retained geometry and shared worker. They do not copy the model into the extension. Laser searches visible geometry by default and returns the nearest surface on both sides of X, Y, and Z. The host signal is linked to the optional call signal, so closing the extension cancels pending work.

### Local companion

With `local.invoke` permission and a declared `localCompanion`, an extension
can inspect companion status and invoke one of its typed capabilities:

```ts
if (ctx.local.status().state === "available") {
  const result = await ctx.local.invoke("geometry.exact-clearance", {
    a: [12],
    b: [44],
    toleranceMm: 5,
  }, ctx.signal);
}
```

The host fixes the provider ID and version range from the manifest. The
extension cannot supply a filesystem path, token, or model hash. Native
providers are trusted software installed separately in Local Studio. See
[Local Studio providers](../local-providers.md).

### View

Read state with `selection()`, `lastPick()`, `isVisible()`, `camera()`,
`measurements()`, `sections()`, and `sectionBox()`. Control the view with
`select`, `isolate`, `hide`, `showAll`, `frame`, `frameAt`, `viewFrom`,
`setCamera`, `addMeasurement`, `removeMeasurement`, `setSections`,
`setSectionBox`, and `colorBy`. `boxAround` is a geometry query.

### Events and lifetime

```ts
const off = ctx.events.on("selection", repaint);
```

The returned function unsubscribes early. The host also removes the listener automatically on close. Events are `model`, `selection`, `visibility`, `section`, `measure`, and `service`.

`ctx.signal` aborts before the panel instance is disposed. Use it for fetch-like work, workers, and long loops. Return `dispose()` for resources that are not signal-aware.

### Storage and feedback

```ts
const limit = ctx.storage.read("limit", 100);
ctx.storage.write("limit", 200);
ctx.feedback.log("Analysis complete", "success");
ctx.feedback.toast("Saved", "success");
ctx.feedback.publishFindings(summary, findings);
```

Storage is JSON serializable and namespaced by extension ID. The installed profile limits values to 64 KB, 64 keys, and 256 KB total per extension.

### Commands and contributions

Declare a command in `extension.json`, then attach its runtime handler:

```ts
const remove = ctx.commands.register("my-extension.run", () => run());
ctx.commands.run("my-extension.run");
```

The command appears in the shared command registry and palette. Closing the extension removes it and its shortcut. An extension cannot run an undeclared command through this service.

Use `ctx.contributions.register(kind, declaredContribution, cleanup)` to bind runtime resources to an already declared overlay, result view, exporter, or other entry. Cleanup runs on explicit removal or extension close. Manifest entries, handlers, listeners, jobs, and result resources therefore share one owner scope.

### Result handles

Store large, typed rows once and page them from panels or later assistant integrations:

```ts
const handle = ctx.results.create("my-extension.results", rows, {
  metadata: { fidelity: "mesh", engine: "browser-bvh" },
});
const firstPage = ctx.results.page(handle.id, 0, 100);
```

The result view ID must be declared. Handles are owned by the creating extension, pinned to the current model key by default, bounded by the host store, and removed when the extension closes. An owner may keep up to 16 handles and 10,000 rows. Another extension cannot guess an ID and read the rows.

## Capabilities

`ctx.capabilities.list()` returns only host capabilities permitted by the extension. `execute(id, input, signal?)` uses the same schema validation, policy, and result types as the assistant and MCP bridge. SDK v2 currently exposes read and reversible view capabilities when the matching manifest permissions are present.

## Reference extensions

- Storey Navigator is the small structure and view example.
- Element Explorer is the property-index and export example.
- Clash Detection is the geometry worker, cancellation, results, and export example.
- Smart Measure is the surface pick, axis laser, persistent measurement, and optional local fidelity example.

These bundled examples import only `@ifcviewx/sdk` and use no renderer, service client, or Python escape hatch.
