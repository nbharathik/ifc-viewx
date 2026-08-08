# Extensions

IFCViewX supports reviewed extensions bundled with the app and local packages installed at runtime. This page covers bundled TypeScript extensions. See [installed browser extensions](installed.md) for the isolated package format, permissions, CLI, and development bridge.

An SDK v2 extension is one lazy-loaded folder with a serializable manifest and a panel module.

```text
src/plugins/my-tool/
  extension.json   identity, permissions, activation, and contributions
  panel.ts         code loaded only when the panel opens
```

Drop the folder in and it appears in the catalog. No central registration file is required.

## Build one

```bash
npm install
npm run new-plugin -- class-list "Class List"
npm run dev
```

Open **Plugins** in the top bar. The generated extension is already listed.

The manifest is data, so it can be validated without executing extension code:

```json
{
  "manifestVersion": 2,
  "id": "class-list",
  "name": "Class List",
  "version": "0.1.0",
  "sdk": ">=2.0.0 <3",
  "description": "Lists IFC classes and their element counts.",
  "runtime": { "kind": "bundled", "entry": "panel.ts" },
  "activationEvents": ["onPanel:class-list"],
  "permissions": ["model.structure.read", "view.control"],
  "contributes": {
    "panels": [{ "id": "class-list", "title": "Class List", "icon": "table" }]
  },
  "catalog": {
    "tagline": "Every IFC class in the model, with counts",
    "about": "Groups placed elements by class and isolates one with a click.",
    "icon": "table",
    "category": "Data",
    "keywords": "class type count",
    "does": ["Count placed elements", "Isolate a class"]
  }
}
```

The panel receives grouped services rather than the renderer or service client:

```ts
import { grid, page, type ExtensionContextV2, type PluginInstance } from "@ifcviewx/sdk";

export function mount(host: HTMLElement, ctx: ExtensionContextV2): PluginInstance {
  const body = document.createElement("div");
  host.appendChild(page(body));

  const paint = (): void => {
    body.replaceChildren(grid(["Class", "Count"], ctx.model.classes().map(([name, count]) => ({
      cells: [name.replace(/^Ifc/, ""), count],
      pick: () => ctx.view.isolate(
        ctx.model.elements().filter((element) => element.type === name).map((element) => element.id),
        name,
      ),
    }))));
  };

  ctx.events.on("model", paint);
  paint();
  return {};
}
```

The host checks every service call against `permissions`. Missing permissions fail with the extension name and required permission. Closing the panel aborts `ctx.signal`, removes event listeners and contributions, cancels linked geometry jobs, and calls `dispose()`.

## The boundary

Import `@ifcviewx/sdk` and files inside your own extension folder. Do not import viewer internals. SDK v2 does not expose `ctx.viewer`, `ctx.service`, or `ctx.python`.

```ts
import { page, grid, type ExtensionContextV2 } from "@ifcviewx/sdk";
```

`npm run check` validates the manifest, import boundary, SDK context, types, and tests.

## SDK v1 compatibility

Existing bundled plugins with `manifest.ts` and `PluginContext` remain supported through an adapter. New extensions should use v2. A folder must not contain both manifest versions.

See the [installed extension guide](installed.md), the [SDK v2 reference](api-v2.md), the [SDK v1 compatibility reference](api.md), and the [catalog](catalog.md).
