# SDK reference

`@ifcviewx/sdk` is the single public extension contract. It is used by every
bundled extension and provides the same manifest and permission model used by
installed sandboxed extensions. There is no separate v1 compatibility API.

The `manifestVersion: 2` value in `extension.json` identifies the manifest file
format. It does not select a second SDK. The `sdk` range declares which releases
of the current SDK an extension accepts.

```ts
import type { ExtensionContext, ExtensionInstance } from "@ifcviewx/sdk";

export function mount(
  host: HTMLElement,
  ctx: ExtensionContext,
  payload?: unknown,
): ExtensionInstance | void;
```

Bundled panels receive the TypeScript context below. Installed packages use the
same domains through the asynchronous [sandbox API](installed.md#authoring-api).
Trusted native work is available only through a declared Local Studio companion.

## Manifest

`extension.json` is read and validated before panel code is imported.

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Manifest schema marker. It must be `2` |
| `id` | Stable lowercase ID. It must match the folder for bundled extensions |
| `name`, `description`, `version` | User-facing identity and semantic package version |
| `sdk` | Compatible SDK range, such as `>=2.0.0 <3` |
| `runtime` | `bundled` with a TypeScript entry, or `sandboxed` with a self-contained HTML entry |
| `activationEvents` | Events that may load code. `onPanel:<id>` is the normal panel event |
| `permissions` | Least-privilege access requested from the host |
| `contributes` | Panels, commands, analyses, result views, and other declarative entries |
| `catalog` | Search and explanatory text shown in the extension browser |

Contribution points are `panels`, `commands`, `toolbarItems`, `contextActions`,
`analyses`, `assistantTools`, `resultViews`, `overlays`, `importers`, `exporters`,
and `settings`. IDs are unique inside their contribution point. Command IDs must
be namespaced. References such as an analysis `resultView` or toolbar `command`
must resolve to another declared entry.

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
| `geometry.query` | Bounds, boxes, clash, distance, laser, contours, and compact signatures |
| `view.read` | Selection, precision pick, visibility, camera, sections, and measurements |
| `view.control` | Selection, lazy categories, camera, sections, measurements, and colors |
| `view.overlay` | A declared host-owned overlay |
| `review.issue.create` | Create a BCF review topic |
| `viewport.capture` | Include a host-rendered snapshot with a review topic |
| `edit.propose` | Stage an edit for explicit user approval |
| `automation.python` | Run user-authored Python in a reviewed bundled extension |
| `file.open` | Ask the user to choose a file through a declared importer |
| `file.export` | Export through a declared exporter |
| `storage.extension` | Namespaced extension storage and settings |
| `assistant.contribute` | A declared assistant tool |
| `local.invoke` | A declared Local Studio companion capability |

`geometry.mesh.read` is reserved for a later host. Installed extensions cannot
request `geometry.mesh.read` or `automation.python`. Declaring a contribution
without its required permission is a manifest error.

## Domain services

### Session and model

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

`ctx.model.index()` is shared across extensions and built once per model.
Building it requires more access than reading one property, so it has its own
permission.

### Geometry

```ts
await ctx.geometry.clash(aIds, bIds, {
  toleranceMm: 10,
  clearanceMm: 25,
  signal: controller.signal,
});

await ctx.geometry.distance(aId, bId, { signal: controller.signal });

await ctx.geometry.laser([12.4, 3.1, -8.0], {
  source: picked.expressID,
  maxDistance: 30,
  signal: controller.signal,
});

await ctx.geometry.sectionContours("y", 3.2, {
  maxSegments: 100_000,
  signal: controller.signal,
});

const revisionGeometry = await ctx.geometry.signatures(elementIds, {
  signal: controller.signal,
});
```

Signatures contain compact sampled shape, placement, and bounds data, not raw
triangles. All geometry calls use host-owned retained geometry and the shared
worker. Closing the extension aborts linked work.

### View

Read state with `selection()`, `lastPick()`, `measuring()`, `isVisible()`,
`categoryVisible()`, `camera()`, `measurements()`, `sections()`, and
`sectionBox()`. Control the view with `select`, `setCategoryVisible`, `isolate`,
`hide`, `showAll`, `frame`, `frameAt`, `viewFrom`, `setCamera`, `addMeasurement`,
`removeMeasurement`, `setSections`, `setSectionBox`, and `colorBy`.
`boxAround` is a geometry query.

`ctx.view.pickGuide(true)` enables frame-throttled Vertex, Edge midpoint, Edge,
and Face feedback for the next extension-owned viewport pick. The guide and the
ordinary measurement tool are mutually exclusive. The host turns the guide off
when the extension closes.

### Events and lifetime

```ts
const off = ctx.events.on("selection", repaint);
```

Events are `model`, `selection`, `visibility`, `section`, `measure`, and
`service`. The returned function unsubscribes early. The host also removes all
listeners automatically on close.

`ctx.signal` aborts before the panel instance is disposed. Use it for geometry,
workers, and long loops. Return `dispose()` for resources that are not
signal-aware.

### Storage and feedback

```ts
const limit = ctx.storage.read("limit", 100);
ctx.storage.write("limit", 200);
ctx.feedback.log("Analysis complete", "success");
ctx.feedback.toast("Saved", "success");
ctx.feedback.publishFindings(summary, findings);
```

Storage is JSON serializable and namespaced by extension ID. The installed
profile limits values to 64 KB, 64 keys, and 256 KB total per extension.

### Files and review issues

File access always uses a declared contribution:

```ts
const opened = await ctx.files.open("my-extension.rules");
const rules = JSON.parse(opened.text);

ctx.files.export("my-extension.report", "report.csv", csv, "text/csv");
```

The importer controls accepted file types. Exporters are restricted to their
declared MIME types. Bundled and installed extensions share a 240 KB text import
limit.

An extension with `review.issue.create` and `viewport.capture` can create a BCF
topic:

```ts
const issue = await ctx.issues.create({
  title: "Wall and pipe clash",
  description: "Penetration: 64 mm",
  elementIds: [wallId, pipeId],
  point: [12.4, 3.1, -8.0],
  priority: "Critical",
});
```

The host owns viewpoint capture, snapshots, BCF storage, and issue navigation.

### Commands and contributions

Declare a command in `extension.json`, then register its handler:

```ts
const remove = ctx.commands.register("my-extension.run", run);
ctx.commands.run("my-extension.run");
```

An extension cannot register or run an undeclared command. Closing it removes
handlers and shortcuts. `ctx.contributions.register()` binds other declared
runtime resources to the same owner scope.

### Result handles

Store typed rows once and page them where needed:

```ts
const handle = ctx.results.create("my-extension.results", rows, {
  metadata: { fidelity: "mesh", engine: "browser-bvh" },
});
const firstPage = ctx.results.page(handle.id, 0, 100);
```

The result view must be declared. Handles belong to the creating extension,
default to the current model revision, and are removed on close.

### Local companion

With `local.invoke` and a declared `localCompanion`, an extension can invoke a
typed native capability:

```ts
if (ctx.local.status().state === "available") {
  const result = await ctx.local.invoke("geometry.exact-clearance", {
    a: [12],
    b: [44],
  }, ctx.signal);
}
```

The host fixes the provider ID and version range from the manifest. See
[Local Studio providers](../local-providers.md).

### Python automation

The reviewed bundled Python Console uses the scoped Python service:

```ts
const output = await ctx.python.query(code, onStatus);
const proposal = await ctx.python.propose(editCode, onStatus);
```

Both calls require `automation.python`. Proposals also require `edit.propose`
and always return through the staged approval flow. Sandboxed installed
extensions cannot receive Python access.

## Capabilities

`ctx.capabilities.list()` returns only host capabilities allowed by the
manifest permissions. `execute(id, input, signal?)` uses the same schema
validation, policy, and result types as the assistant and browser bridge. Only
read and reversible view capabilities are exposed here.

## Reference extensions

- Storey Navigator is the small structure and view example.
- Element Explorer shows the property index and file export.
- Clash Detection shows geometry, results, file exchange, and BCF issues.
- Smart Measure shows precision picks, laser queries, and local fidelity.
- Section Workspace shows contours, synchronized selection, and SVG export.
- Python Console shows the reviewed Python permission and staged edits.

Every bundled example imports only `@ifcviewx/sdk`. Renderer and service-client
internals are not part of the extension contract.
