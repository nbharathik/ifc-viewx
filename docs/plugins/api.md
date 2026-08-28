# SDK reference

`@ifcviewx/sdk` is the public API for bundled extensions. Installed extensions
use the same permission model through the asynchronous
[sandbox API](installed.md#write-the-panel).

```ts
import type { ExtensionContext, ExtensionInstance } from "@ifcviewx/sdk";

export function mount(
  host: HTMLElement,
  ctx: ExtensionContext,
  payload?: unknown,
): ExtensionInstance | void;
```

`manifestVersion: 2` identifies the manifest format. The `sdk` range declares
which versions of the current API the extension supports.

## Manifest

IFCViewX validates `extension.json` before it loads panel code.

| Field | Purpose |
| --- | --- |
| `manifestVersion` | Manifest schema marker. It must be `2` |
| `id` | Stable lowercase ID. For bundled extensions, it matches the folder |
| `name`, `description`, `version` | Package identity and semantic version |
| `sdk` | Compatible SDK range, such as `>=2.0.0 <3` |
| `runtime` | A bundled TypeScript or sandboxed HTML entry |
| `activationEvents` | Events that may load the extension |
| `permissions` | Host access requested by the extension |
| `contributes` | Panels, commands, results, and other UI entries |
| `catalog` | Text used in the extension browser and docs |

Contribution points are `panels`, `commands`, `toolbarItems`, `contextActions`,
`analyses`, `assistantTools`, `resultViews`, `overlays`, `importers`, `exporters`,
and `settings`. IDs must be unique within each contribution point. Command IDs
must be namespaced, and references must point to declared entries.

Activation events:

- `onPanel:<id>`
- `onCommand:<id>`
- `onAssistantTool:<id>`
- `onFile:<extension>`
- `onLocalCapability:<id>`
- `onModel`
- `onStartup`, for reviewed bundled extensions only

## Permissions

Request only what the extension uses.

| Permission | Allows |
| --- | --- |
| `model.summary.read` | Read loaded model identity |
| `model.structure.read` | Read elements, classes, tree, subtree, and federated IDs |
| `model.properties.read` | Read properties for one element |
| `model.index.build` | Build and read the shared property index |
| `geometry.query` | Read bounds, boxes, clash, distance, laser, contours, and signatures |
| `view.read` | Read picks, selection, visibility, camera, sections, and measurements |
| `view.control` | Change selection, visibility, camera, sections, measurements, and colors |
| `view.overlay` | Use a declared host-owned overlay |
| `review.issue.create` | Create a BCF review topic |
| `viewport.capture` | Add a host-rendered snapshot to a topic |
| `edit.propose` | Stage an edit for user approval |
| `automation.python` | Run user-authored Python in a reviewed bundled extension |
| `file.open` | Open a user-selected file through a declared importer |
| `file.export` | Export through a declared exporter |
| `storage.extension` | Use namespaced settings and storage |
| `assistant.contribute` | Add a declared assistant tool |
| `local.invoke` | Call a declared Local Studio companion |

Installed extensions cannot request `automation.python`. `geometry.mesh.read`
is reserved for a future host. A contribution without its required permission
is a manifest error.

## Context services

### Model and property index

```ts
ctx.session.model();
ctx.model.elements();
ctx.model.classes();
ctx.model.tree();
ctx.model.subtree(id);
await ctx.model.properties(id);
ctx.model.index();
ctx.model.bounds(id);
ctx.model.modelOf(id);
ctx.model.expressOf(id);
```

The property index is built once per model and shared by all extensions. It
requires `model.index.build` because it reads more data than one property call.

### Geometry

```ts
await ctx.geometry.clash(aIds, bIds, {
  toleranceMm: 10,
  clearanceMm: 25,
  signal: ctx.signal,
});

await ctx.geometry.distance(aId, bId, { signal: ctx.signal });

await ctx.geometry.laser([12.4, 3.1, -8.0], {
  source: picked.expressID,
  maxDistance: 30,
  signal: ctx.signal,
});

await ctx.geometry.sectionContours("y", 3.2, {
  maxSegments: 100_000,
  signal: ctx.signal,
});

await ctx.geometry.signatures(elementIds, { signal: ctx.signal });
```

Geometry calls use the host's retained geometry and shared worker. Signatures
contain sampled shape, placement, and bounds data, not raw triangles.

### View

Read with `selection()`, `lastPick()`, `measuring()`, `isVisible()`,
`categoryVisible()`, `camera()`, `measurements()`, `sections()`, and
`sectionBox()`.

Change the view with `select`, `setCategoryVisible`, `isolate`, `hide`,
`showAll`, `frame`, `frameAt`, `viewFrom`, `setCamera`, `addMeasurement`,
`removeMeasurement`, `setSections`, `setSectionBox`, `boxAround`, and `colorBy`.

`ctx.view.pickGuide(true)` shows Vertex, Edge midpoint, Edge, and Face feedback
for the next extension-owned pick. It cannot run at the same time as the normal
measurement tool and turns off when the extension closes.

### Events and cleanup

```ts
const off = ctx.events.on("selection", repaint);
```

Events are `model`, `selection`, `visibility`, `section`, `measure`, and
`service`. Call the returned function to unsubscribe early.

The host aborts `ctx.signal` and removes listeners when the panel closes. Return
`dispose()` only for resources that do not support an abort signal.

### Storage and feedback

```ts
const limit = ctx.storage.read("limit", 100);
ctx.storage.write("limit", 200);
ctx.feedback.log("Analysis complete", "success");
ctx.feedback.toast("Saved", "success");
ctx.feedback.publishFindings(summary, findings);
```

Storage must be JSON serializable and is namespaced by extension ID. Installed
extensions can store 64 KB per value, 64 keys, and 256 KB in total.

### Files and issues

File calls must use declared contributions:

```ts
const opened = await ctx.files.open("my-extension.rules");
const rules = JSON.parse(opened.text);

ctx.files.export("my-extension.report", "report.csv", csv, "text/csv");
```

Importers define accepted file types. Exporters define allowed MIME types.
Text imports are limited to 240 KB.

With `review.issue.create` and `viewport.capture`, an extension can create a BCF
topic:

```ts
await ctx.issues.create({
  title: "Wall and pipe clash",
  description: "Penetration: 64 mm",
  elementIds: [wallId, pipeId],
  point: [12.4, 3.1, -8.0],
  priority: "Critical",
});
```

The host owns the viewpoint, snapshot, BCF storage, and issue navigation.

### Commands and contributions

```ts
const remove = ctx.commands.register("my-extension.run", run);
ctx.commands.run("my-extension.run");
```

Commands must be declared before they can be registered or run.
`ctx.contributions.register()` binds other declared runtime resources to the
same extension lifetime.

### Result handles

```ts
const handle = ctx.results.create("my-extension.results", rows, {
  metadata: { fidelity: "mesh", engine: "browser-bvh" },
});

const firstPage = ctx.results.page(handle.id, 0, 100);
```

The result view must be declared. Handles belong to their extension, default to
the current model revision, and disappear when the extension closes.

### Local companion

An extension with `local.invoke` and `localCompanion` can call a native
capability:

```ts
if (ctx.local.status().state === "available") {
  await ctx.local.invoke(
    "geometry.exact-clearance",
    { a: [12], b: [44] },
    ctx.signal,
  );
}
```

The manifest fixes the provider ID and version range. See
[Native providers](../local-providers.md).

### Python

Reviewed bundled extensions can use the scoped Python service:

```ts
const output = await ctx.python.query(code, onStatus);
const proposal = await ctx.python.propose(editCode, onStatus);
```

Both calls require `automation.python`. Proposals also require `edit.propose`
and always enter the user approval flow.

### Capabilities

`ctx.capabilities.list()` returns the host capabilities allowed by the manifest.
`execute(id, input, signal?)` uses the same schemas, policy, and result types as
the assistant and browser bridge. Extensions receive only read and reversible
view capabilities.

## Examples in the repo

- Storey Navigator: model structure and view control
- Element Explorer: property index and file export
- Clash Detection: geometry, results, files, and BCF issues
- Smart Measure: precision picks, laser, and local fidelity
- Section Workspace: contours, linked selection, and SVG export
- Python Console: reviewed Python and staged edits

Every bundled example imports only `@ifcviewx/sdk`. Renderer and service-client
internals are not part of the extension API.
