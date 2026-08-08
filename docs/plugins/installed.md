# Installed browser extensions

An installed extension is a local `.ifcviewx-extension` package. Its UI runs in an opaque-origin iframe and can reach the viewer only through a small, permission-checked message API.

Use an installed extension when the tool should be distributed without rebuilding IFCViewX and does not need direct renderer or native machine access. Use a [bundled extension](index.md) for reviewed first-party code that needs the full SDK surface. Exact BRep work, large batch jobs, format conversion, and trusted native automation belong in a separately installed [Local Studio provider](../local-providers.md).

## Install and manage

Open **Plugins**, select **Install file**, and choose a package. The review screen shows:

- publisher, version, package size, and SHA-256 hash;
- every requested permission, including permissions added by an update;
- the isolated runtime profile;
- assistant data disclosure when assistant tools are declared;
- optional or required Local Studio companion metadata.

Confirming writes the validated package and state to OPFS. If OPFS is unavailable, the manager falls back to session-only memory and records that fallback in the audit log.

Installed entries have controls for enable, disable, rollback, audit, and uninstall. Two package versions are retained, so the previous one can be restored. Disabling closes the iframe, aborts pending geometry calls, removes events, result handles, overlays, and commands, and leaves no extension runtime active. Uninstall also removes the package versions and namespaced saved settings.

There is no URL installer, marketplace, automatic update, or signature trust decision in this release. Reinstalling or updating always begins with a local file. Added permissions require a new review.

## Package layout

The initial package profile is deliberately small:

```text
my-extension/
  extension.json
  panel.html
```

`extension.json` uses SDK manifest version 2 with `runtime.kind` set to `sandboxed`. Installed IDs use reverse-domain notation. The package must declare exactly one panel and include its `onPanel:<id>` activation event.

```json
{
  "manifestVersion": 2,
  "id": "org.example.model-summary",
  "name": "Model Summary",
  "version": "1.0.0",
  "sdk": ">=2.0.0 <3",
  "description": "Shows IFC class counts and the active selection.",
  "publisher": { "name": "Example" },
  "runtime": { "kind": "sandboxed", "entry": "panel.html" },
  "activationEvents": ["onPanel:summary"],
  "permissions": ["model.structure.read", "view.read"],
  "contributes": {
    "panels": [{ "id": "summary", "title": "Model Summary", "icon": "table" }]
  },
  "catalog": {
    "tagline": "IFC class and selection counts",
    "about": "Reads model structure through the sandbox API.",
    "icon": "table",
    "category": "Data",
    "keywords": "ifc class summary",
    "does": ["Count IFC classes", "Track the active selection"]
  }
}
```

The first package format requires a self-contained HTML entry. Scripts and styles must be inline. Network script, stylesheet, media, and CSS imports are rejected. Frames, objects, forms, base URLs, refresh navigation, symbolic links, unsafe paths, encrypted ZIP entries, ZIP64, and unsupported compression profiles are also rejected.

Package limits are 5 MB compressed, 12 MB unpacked, 2 MB per file, 1 MB for the HTML entry, and 128 ZIP entries. The validator reads central-directory sizes before decompression to reject oversized or inconsistent archives early.

## Authoring API

IFCViewX injects a bootstrap before the package scripts. Wait for the dedicated message channel before calling the host:

```html
<main class="ifcx-page">
  <h1>Model Summary</h1>
  <div id="counts"></div>
</main>
<script>
  IFCViewX.ready().then(async (api) => {
    const paint = async () => {
      const classes = await api.model.classes();
      document.getElementById("counts").textContent = `${classes.length} IFC classes`;
    };
    api.on("model", paint);
    await paint();
  });
</script>
```

The injected `IFCViewX` object provides:

| Domain | Calls |
| --- | --- |
| Session | `session.model()` |
| Model | paged `model.elements()`, `classes()`, `properties(id)`, `bounds(id)` |
| Geometry | `geometry.distance(a, b, options)`, `geometry.clash(aIds, bIds, options)` |
| View | selection, select, isolate, hide, show all, frame, section reads and writes |
| Storage | `storage.read(key, fallback)`, `storage.write(key, value)` |
| Feedback | `feedback.log`, `feedback.toast` |
| Commands | `commands.run(id)` for a declared command |
| Overlays | declared line creation, removal, and clear |
| Results | create, inspect, page, and dispose declared result views |
| Files | export a string through a declared exporter and MIME type |

`IFCViewX.on(name, listener)` receives `model`, `selection`, `visibility`, `section`, `activation`, and `ready` events when the corresponding data permission permits them. The small `IFCViewX.ui.element()` helper creates elements inside the isolated document. Host design tokens and basic `.ifcx-*` layout classes are injected for visual consistency.

The example at `examples/extensions/hello-sandbox` is a complete package source.

## Runtime boundary

The iframe has `sandbox="allow-scripts"` without `allow-same-origin`, forms, popups, navigation, or downloads. Its CSP denies connections, workers, child frames, objects, and all resources except inline code plus data or blob media. This prevents extension code from reading the parent DOM, the host origin's local storage or cookies, service credentials, model bytes, or Three.js objects.

The window handshake validates the owned iframe, protocol version, and a random nonce. All later traffic uses a dedicated `MessagePort`. The host validates every method and parameter again, then the SDK context enforces the installed manifest permission at the operation boundary.

There is no generic viewer, service, token, mesh, network, or host-global method. Handcrafted calls to undeclared or unpermitted operations fail without changing the viewer.

Runtime limits include:

- 256 KB per message or result;
- four concurrent calls and 120 calls per ten seconds;
- replay detection for request IDs;
- 5,000 IDs per view or geometry input;
- 1,000 result rows created per call, 10,000 live rows and 16 handles per owner;
- 500 result rows per page;
- declared overlay quotas, capped at 500 primitives;
- 64 KB per stored value, 64 keys, and 256 KB total per extension.

Three malformed, oversized, replayed, or rate-limited protocol messages disable the extension for the session. Sensitive calls and failures are recorded in the local audit. Changing the model aborts pending geometry requests. Closing, disabling, crashing, updating, rolling back, or uninstalling disposes the extension owner scope.

## Build and development bridge

Validate and build a package with:

```bash
npm run extension:package -- ./my-extension
npm run extension:package -- ./my-extension --output ./dist/my-extension.ifcviewx-extension
```

The CLI validates manifest links, common JSON schema shapes, permissions, contribution requirements, paths, symlinks, HTML restrictions, and size limits before producing the ZIP and SHA-256.

For local development:

```bash
npm run extension:dev -- ./my-extension --port 4178
```

The command prints a viewer query such as:

```text
?extensionDev=http%3A%2F%2F127.0.0.1%3A4178%2F
```

Open the viewer with that query. The bridge is accepted only over HTTP on `127.0.0.1` or `localhost`. File changes rebuild the package and send a reload event. An already installed extension updates automatically only when it requests no new permission. A first install or any permission addition opens the normal review screen.

## Browser and local split

Installed browser extensions can perform model reads, host-owned mesh distance and clash queries, reversible view changes, declarative overlays, bounded result handling, storage, and user-initiated exports fully in the browser.

`localCompanion` binds `ctx.local` to one separately installed Local Studio provider. The host checks the declared version range before invocation, shows missing and incompatible states, and cancels native jobs when the extension closes. The browser installer does not install native code. Native providers remain outside the browser sandbox and must be installed and trusted separately. See [Local Studio providers](../local-providers.md).
