# Plugins

A plugin is one folder with two files.

```
src/plugins/my-tool/
  manifest.ts    what the catalog shows
  panel.ts       what runs when someone opens it
```

Drop it in and it appears. Nothing else registers it.

## Build one

```bash
npm install
npm run new-plugin -- class-list "Class List"
npm run dev
```

Open the **Plugins** button in the top bar and it is already listed.

`manifest.ts` is what the catalog shows. Nothing in it runs.

```ts
import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "class-list",
  name: "Class List",
  tagline: "Every IFC class in the model, with counts",
  about: "Groups placed elements by class, and isolates one with a click.",
  icon: "table",
  category: "Data",
  keywords: "class type count",
  tier: "web",
  does: ["Every class with its element count", "Click a class to isolate it"],
});
```

`panel.ts` exports `mount`, called with an element to fill and the context.

```ts
import { grid, page, type PluginContext, type PluginInstance } from "@ifcviewx/sdk";

export function mount(host: HTMLElement, ctx: PluginContext): PluginInstance {
  const body = document.createElement("div");
  host.appendChild(page(body));
  let isolated = "";

  const paint = (): void => {
    body.replaceChildren(grid(["Class", "Count"], ctx.classes().map(([name, count]) => ({
      cells: [name.replace(/^Ifc/, ""), count],
      tone: name === isolated ? ("ok" as const) : undefined,
      pick: () => {
        isolated = name === isolated ? "" : name;
        if (isolated) ctx.isolate(ctx.elements().filter((e) => e.type === name).map((e) => e.id), name);
        else ctx.showAll();
        paint();
      },
    }))));
  };

  ctx.on("model", paint);
  paint();
  return {};
}
```

Save it. The panel reloads in place.

`grid` is styled by the app, so it matches both themes without any CSS.
`ctx.on("model", paint)` repaints when a file loads or an edit lands, and it is
released for you when the panel closes. Return `{}` when there is nothing to
clean up, or `{ dispose }` if you hold a worker or a timer.

## Reading properties

Properties are not in memory with the geometry. Ask for the shared index,
built once per model:

```ts
const rows = await ctx.index().build((done, total) => bar.set(done, total));
```

Each row has `attrs` and `props`, keyed `"SetName.PropertyName"`. The first
build takes a few seconds on a large model, so pass the progress callback.

[The SDK reference](api.md) lists everything on `ctx`.

## The one rule

Import `@ifcviewx/sdk` and nothing else from the app.

```ts
import { page, grid, type PluginContext } from "@ifcviewx/sdk";
```

`npm run check` fails the build otherwise. If the SDK is missing something,
`ctx.viewer` is the full viewer.

## Publish it

```bash
npm run check
git commit -am "add Class List plugin"
```

Open a pull request against `main`. Set `author` and `url` in the manifest and
both show on the card.

You can also keep it in a fork, which rebases cleanly across releases as long
as you only import the SDK. Plugins are compiled in, so there is no runtime
loading from a URL.

## Tiers

`tier` says where a plugin runs.

| Tier | Where | Folder |
| --- | --- | --- |
| `web` | In the tab. This is what you write | Yes |
| `local` | Needs the Local Studio service | No, `shortcuts.ts` |
| `core` | A panel the app already has; the catalog links to it | No, `shortcuts.ts` |

## What exists today

[The catalog](catalog.md) lists every plugin in the viewer.
