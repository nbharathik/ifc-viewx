# Installed extensions

An installed extension is a local `.ifcviewx-extension` package. Its UI runs in
an isolated iframe and reaches IFCViewX through a permission-checked API.

Use this format when users should install a tool without rebuilding IFCViewX.
Use a [bundled extension](index.md) for reviewed first-party code, or a
[native provider](../local-providers.md) for trusted machine access.

## Install a package

1. Open **Plugins**.
2. Select **Install file**.
3. Choose the `.ifcviewx-extension` file.
4. Review the publisher, hash, permissions, and runtime details.
5. Confirm the installation.

You can enable, disable, roll back, audit, or uninstall the package later.
IFCViewX keeps two versions for rollback. New permissions always require
another review.

Validated packages and settings are stored in browser OPFS. If OPFS is not
available, IFCViewX uses session memory and records that fallback in the audit.
Uninstalling removes both saved package versions and namespaced settings.

There is no automatic update or automatic trust decision. A release may also
enable a read-only registry browser by pinning one publisher key at build time.
Every registry index must be signed by that key, and every downloaded package
must match the exact size and SHA-256 hash in the signed index before the normal
permission review opens. Builds without a pinned key keep the registry disabled;
local file installation remains available.

Maintainers enable a registry by setting `VITE_PLUGIN_REGISTRY_JWK` to the JSON
encoding of a public P-256 JWK during the production build. Registry URLs must
use HTTPS (plain HTTP is accepted only on localhost for development). The key is
not fetched from the registry, so changing publishers requires a new app build.

## Package layout

```text
my-extension/
  extension.json
  panel.html
```

The package uses manifest version 2, a reverse-domain ID, one panel, and one
self-contained HTML entry.

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

Scripts and styles must be inline. Network resources, imports, forms, frames,
popups, navigation, and symbolic links are not allowed.

The package is limited to 5 MB compressed, 12 MB unpacked, 2 MB per file,
1 MB for `panel.html`, and 128 files. Encrypted ZIP files, ZIP64, unsafe paths,
and unsupported compression formats are rejected before installation.

## Write the panel

Wait for `IFCViewX.ready()` before calling the host:

```html
<main class="ifcx-page">
  <h1>Model Summary</h1>
  <div id="counts"></div>
</main>
<script>
  IFCViewX.ready().then(async (api) => {
    const paint = async () => {
      const classes = await api.model.classes();
      document.getElementById("counts").textContent =
        `${classes.length} IFC classes`;
    };

    api.on("model", paint);
    await paint();
  });
</script>
```

Available API groups:

| Group | Main calls |
| --- | --- |
| Session | `session.model()` |
| Model | Elements, classes, properties, and bounds |
| Geometry | Distance, clash, laser, and section contours |
| View | Read or change selection, visibility, camera, and sections |
| Storage | Read and write namespaced settings |
| Feedback | Logs and toast messages |
| Commands and overlays | Run declared commands and manage declared lines |
| Results | Create, page, inspect, and dispose result sets |
| Files and issues | Use declared importers, exporters, and BCF issue creation |

Events include `model`, `selection`, `visibility`, `section`, `activation`, and
`ready`. The host also injects design tokens and basic `.ifcx-*` layout classes.
See `examples/extensions/hello-sandbox` for a complete example.

## Build and test

```bash
npm run extension:package -- ./my-extension
npm run extension:package -- ./my-extension --output ./dist/my-extension.ifcviewx-extension
```

For live development:

```bash
npm run extension:dev -- ./my-extension --port 4178
```

Open the viewer with the query printed by the command. The development bridge
accepts only `http://127.0.0.1` or `http://localhost`. File changes rebuild and
reload the package. A first install or new permission opens the normal review.

## Security boundary

The iframe has an opaque origin and cannot read the parent page, cookies,
service credentials, model bytes, Three.js objects, or host globals. The host
checks the iframe, protocol, nonce, method, parameters, and manifest permission
for each call.

Its content security policy blocks connections, workers, child frames, objects,
and external resources. Host calls use a dedicated `MessagePort` after the
initial window handshake. There is no general viewer, service, token, mesh, or
network method.

Disabling or closing an extension aborts its work and removes its listeners,
results, overlays, commands, and storage access for that session.

Changing the model cancels pending geometry calls. Updating, rolling back,
uninstalling, crashing, or closing the package disposes the same owner scope so
old calls cannot update a later session.

??? info "Package and runtime limits"
    - 5 MB compressed, 12 MB unpacked, and 128 files
    - 2 MB per file and 1 MB for the HTML entry
    - 256 KB per message or result
    - 4 concurrent calls and 120 calls per 10 seconds
    - 5,000 element IDs per view or geometry input
    - 10,000 live result rows and 16 handles per extension
    - 500 result rows per page
    - 500 declared overlay primitives
    - 240 KB for a user-selected text import
    - 16 KB for an issue, with 200 element IDs and 24 metadata fields
    - 64 KB per stored value and 256 KB total storage

Malformed, oversized, replayed, or repeated rate-limited messages can disable
the extension for the session. Sensitive calls and failures appear in the
local audit.

## Add a Local Studio companion

`localCompanion` binds the extension to one native provider. The host checks
the provider ID and version before every call. The browser installer never
installs native code. Read [Native providers](../local-providers.md) for the
separate installation and trust model.
