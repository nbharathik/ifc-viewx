# Build an extension

Extensions add tools to IFCViewX without importing viewer internals. Start by
choosing the right type.

| Type | Best for | Runtime |
| --- | --- | --- |
| Bundled extension | First-party tools built with IFCViewX | TypeScript in the app |
| Installed extension | A package users install without rebuilding | Isolated browser iframe |
| Native provider | Exact geometry or trusted machine work | Python in Local Studio |

This guide creates a bundled extension. For the other options, see
[installed extensions](installed.md) or [native providers](../local-providers.md).

## Create it

```bash
npm install
npm run new-plugin -- class-list "Class List"
npm run dev
```

Open **Plugins** in the viewer. The new extension appears automatically.

```text
src/plugins/class-list/
  extension.json
  panel.ts
```

`extension.json` declares identity, activation, permissions, and UI entries.
`panel.ts` loads only when its panel opens.

## Minimal manifest

```json
{
  "manifestVersion": 2,
  "id": "class-list",
  "name": "Class List",
  "version": "0.1.0",
  "sdk": ">=2.0.0 <3",
  "description": "Lists IFC classes and element counts.",
  "runtime": { "kind": "bundled", "entry": "panel.ts" },
  "activationEvents": ["onPanel:class-list"],
  "permissions": ["model.structure.read", "view.control"],
  "contributes": {
    "panels": [{ "id": "class-list", "title": "Class List", "icon": "table" }]
  },
  "catalog": {
    "tagline": "Browse every IFC class",
    "about": "Lists classes and isolates their elements.",
    "icon": "table",
    "category": "Data",
    "keywords": "class type count",
    "does": ["Count placed elements", "Isolate a class"]
  }
}
```

## Minimal panel

```ts
import { grid, page, type ExtensionContext } from "@ifcviewx/sdk";

export function mount(host: HTMLElement, ctx: ExtensionContext): void {
  const rows = ctx.model.classes().map(([name, count]) => ({
    cells: [name, count],
    pick: () => ctx.view.isolate(
      ctx.model.elements()
        .filter((element) => element.type === name)
        .map((element) => element.id),
      name,
    ),
  }));

  host.appendChild(page(grid(["Class", "Count"], rows)));
}
```

The host checks every call against the declared permissions. When the panel
closes, IFCViewX aborts `ctx.signal` and removes its listeners and resources.

## Rules

- Import `@ifcviewx/sdk` and files in your own extension folder only.
- Request only the permissions you need.
- Keep the manifest serializable so it can be checked before code loads.
- Run `npm run check` before submitting a change.

Read the [SDK reference](api.md) for permissions and services. Browse the
[tool catalog](catalog.md) for working examples.
