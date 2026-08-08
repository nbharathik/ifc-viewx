# SDK v1 compatibility reference

This surface keeps existing bundled plugins working. New extensions should use the [SDK v2 reference](api-v2.md), which has serializable manifests, explicit permissions, scoped contributions, and no viewer or service escape hatches.

Everything importable from `@ifcviewx/sdk`. If it is not here, it is internal
and will move.

```ts
import { definePlugin, page, bar, grid, type PluginContext } from "@ifcviewx/sdk";
```

## The manifest

| Field | Meaning |
| --- | --- |
| `id` | Must equal the folder name |
| `name`, `tagline` | Title and the line under it |
| `about` | A paragraph: what it reads, what it changes, anything surprising |
| `does` | Bullets shown when the entry is expanded |
| `icon`, `category`, `keywords` | Catalog display and search |
| `tier` | `web`, `local` or `core` in the v1 compatibility host |
| `author`, `url` | Optional, shown on the card |
| `capability` | `local` only: what the service must report |
| `command` | `local` and `core` only: the command that opens it |
| `soon` | Described but not built. Never offers an action |
| `load` | Optional. Defaults to `./panel.ts` in the same folder |

## The panel

```ts
export function mount(
  host: HTMLElement,
  ctx: PluginContext,
  payload?: unknown,
): PluginInstance | void;
```

`host` is yours to fill. `payload` is set when something opened you with data.

```ts
interface PluginInstance {
  dispose?(): void;                    // closing: release workers, timers, sections
  receive?(payload: unknown): void;    // opened again while already running
}
```

## Reading the model

| Call | Returns |
| --- | --- |
| `ctx.model()` | `{ key, name, loaded }`. `key` changes with the model |
| `ctx.elements()` | Every placed element as `{ id, type, name, storey }`. Cached |
| `ctx.classes()` | `[className, count]` pairs, largest first |
| `ctx.tree()` | The spatial hierarchy, or `null` |
| `ctx.subtree(id)` | Element ids under a spatial node |
| `ctx.properties(id)` | One element's attributes and property sets. Async |
| `ctx.bounds(id)` | Axis aligned bounds, or `null` without geometry |
| `ctx.clash(a, b, options?)` | Triangle-level clash detection between two id sets. Async |
| `ctx.distance(a, b, options?)` | Exact shortest mesh distance with closest points. Async |
| `ctx.index()` | The shared [property index](#the-property-index) |

`ctx.clash` runs in a worker over the geometry the viewer already loaded, and
decides every hit from real mesh intersection rather than from bounding boxes.
Options are `toleranceMm` (intersections thinner than this are grazes),
`clearanceMm` (above zero, pairs that miss are also checked for a tight gap),
`limit` and `onProgress`. Each result carries both element ids, the kind
(`hard` or `clearance`), the distance in metres, and the point to zoom to.

`ctx.distance` uses that same retained geometry and worker. Its result includes
the closest point on each element, their midpoint, whether the solids
intersect, and the browser geometry engine and fidelity that produced it.

## Capabilities

`ctx.capabilities.list()` describes the host operations available to a bundled
plugin. `ctx.capabilities.execute(id, input, signal?)` invokes one through the
same schema validation, policy checks, and cancellation path used by the
assistant and browser MCP bridge. The v1 compatibility SDK grants only read
and reversible view effects. SDK v2 also checks each call against the
extension's manifest permissions.

## Driving the viewport

| Call | Effect |
| --- | --- |
| `ctx.select(id \| ids \| null)` | Select one, select many, or clear |
| `ctx.selection()` | The selected element ids |
| `ctx.isolate(ids, label?)` | Show only these; the label becomes the viewport chip |
| `ctx.hide(ids)` | Hide these |
| `ctx.showAll()` | Release everything hidden or isolated |
| `ctx.frame(id?)` | Frame one element, or the whole model |
| `ctx.frameAt(point, radius?)` | Frame a point in space, such as a collision |
| `ctx.viewFrom(view)` | `front`, `right`, `top` or `iso` |
| `ctx.sections()`, `ctx.setSections(states)` | Read and write section planes |

Sections and visibility are shared with the rest of the app, so `setSections`
replaces whatever else was there. Filter the existing array rather than
overwriting it, and restore in `dispose()`.

## Events

```ts
ctx.on("model", () => rebuild());
```

`model`, `selection`, `visibility`, `section`, `measure`, `service`. All are
released when the panel closes, so do not unsubscribe in `dispose`.

`model` fires on a new file, an applied edit and an undo. `service` fires when
Local Studio connects, drops or changes what it offers.

## The app

| Call | Effect |
| --- | --- |
| `ctx.log(text, kind?)` | A line in the activity log |
| `ctx.toast(text, kind?)` | A transient message over the viewport |
| `ctx.run(commandId)` | Run an app command, such as `file.check` |
| `ctx.read(key, fallback)` | Your settings, namespaced by plugin id |
| `ctx.write(key, value)` | Same. JSON serialisable values only |
| `ctx.close()` | Close yourself |

`ctx.viewer` is the full `Viewer` interface and `ctx.service` is the Local
Studio client, for what the helpers do not cover. Using them is the one thing
in a plugin that can break when core moves.

## Running Python

```ts
const text = await ctx.python.query('result = len(model.by_type("IfcWall"))');
const report = await ctx.python.propose(code, (status) => log(status));
```

`query` is read only. `propose` runs on a disposable copy and stages the result
for the user to approve, so nothing you pass is applied silently.
`ctx.python.runsNatively()` says whether the local service or this tab will run
it, worth showing before a first run downloads about 30 MB.

## The property index

Properties are read from the worker on demand, so getting all of them is the
expensive thing a data plugin does. One index per model, shared.

```ts
const bar = progress();
const rows = await ctx.index().build((done, total) => bar.set(done, total));
bar.hide();
```

Each row is `{ id, type, name, storey, globalId, attrs, props }`, with `props`
keyed `"SetName.PropertyName"`.

`ctx.index().propertyKeys()` gives every property key with how many elements
carry it, most common first.

## Reading a second file

```ts
const side = await openSideModel(new Uint8Array(await file.arrayBuffer()));
try {
  for (const element of elementsOf(side.tree)) {
    const properties = await side.properties(element.id);
  }
} finally {
  side.close();
}
```

Parses another IFC in its own worker with geometry skipped, so it costs parse
time and nothing on the GPU. Always `close()`, including on failure: the worker
holds the whole file.

## Panel parts

Build from these and the panel matches the app in both themes and at every UI
scale, with no CSS of your own.

**Layout**: `page(...children)`, `bar(...controls)`, `field(label, control)`,
`note(text)`, `hint(icon, text)`, `emptyState(icon, title, sub?)`

**Controls**: `button(label, onClick, kind?)`, `select(options, value, onChange)`,
`number(value, onChange, step?, min?)`, `search(placeholder, onInput)`,
`classPicker(counts, selected, onChange)`, `iconButton(icon, title, onClick)`

**Results**: `grid(headers, rows, onSort?)`, `stats(items)`, `progress()`,
`spinner()`, `busyRow(text)`

**Feedback**: `toast`, `confirmAction`, `promptForm`, `showContextMenu`,
`attachPopover`, `attachTip`, `infoIcon`

**Anything else**: `h(tag, attrs, children)`. `kind` on `button` takes `accent`
or `danger`.

A `grid` row is `{ cells, pick?, tone?, title? }`. Numbers right align and
format themselves. `tone` is `ok`, `warn` or `err`.

## Getting data out

| Call | What it does |
| --- | --- |
| `saveCsv(name, headers, rows)` | Downloads a CSV, with the BOM a spreadsheet needs |
| `copyTable(headers, rows)` | Tab separated to the clipboard, pastes into a sheet |
| `toCsv(headers, rows)` | The string, to do something else with |
| `download(name, data, type)` | Any blob |

## Helpers

| Call | What it does |
| --- | --- |
| `elementsOf(tree)` | Placed elements under any tree, viewer or side model |
| `classCounts(rows)` | Groups anything with a `type` field, largest first |
| `formatNumber(value)` | The app's number formatting |
| `nextFrame()` | Await between slices of a long job to keep the panel responsive |
| `detectClashes`, `clashReport`, `idsOfTypes` | The clash sweep the app itself runs |
| `measureDistance` | The shortest-distance query the app and assistant use |
| `STRUCTURE`, `MEP`, `OPENINGS` | The class sets behind the clash presets |
