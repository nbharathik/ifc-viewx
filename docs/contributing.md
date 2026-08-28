# Work on the repo

## Set up the project

```bash
npm install
npm run dev
```

Use any small IFC file for testing. The
[buildingSMART samples](https://github.com/buildingSMART/Sample-Test-Files) are
a good starting point.

## Useful commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the viewer with hot reload |
| `npm test` | Run the Vitest suite |
| `npm run check` | Run TypeScript, extension, architecture, contract and test gates |
| `npm run build` | Check and build the production app in `dist/` |
| `npm run boundaries` | Reject new import violations or dependency cycles |
| `npm run contracts:check` | Compare public and dynamic entry points with the reviewed snapshot |
| `npm run metrics` | Print deterministic source and production-build metrics |
| `npm run eval` | Evaluate assistant tool choice against a real model |
| `npm run docs` | Start this documentation site with live reload |

## Repository map

| Path | Purpose |
| --- | --- |
| `src/sdk/` | Public extension contract |
| `src/plugins/` | One folder for each bundled extension |
| `src/viewer-core/` | Parsing, geometry, scene, camera, and picking |
| `src/ui/` | Shell, commands, and built-in panels |
| `src/ifc/` | Checks, edits, schedules, and clash logic |
| `src/python/` | Browser IfcOpenShell through Pyodide |
| `src/assistant/` and `src/llm/` | Assistant runtime and providers |
| `src/bridge/` | Local Studio connection |
| `local-bridge/` | The `ifcviewx` Python package |
| `docs/` | This site |

Most new UI tools should be [extensions](plugins/index.md). Add a core feature
only when it cannot live behind the SDK, such as model loading or a new viewer
capability.

An extension may import `@ifcviewx/sdk` and files in its own folder. It must not
import viewer internals. Core code must not import an extension folder. Add new
shared APIs to `src/sdk/`.

## Code style

- Use strict TypeScript.
- Remove unused locals and parameters.
- Write comments that explain why.

`npm run check` enforces these rules.

Structural changes also follow the [feature-frozen refactor contract](refactor/index.md).
If a public contract intentionally changes, review the generated diff before
running `npm run contracts:update`.

## Work on the docs

```bash
pip install -r docs/requirements.txt
npm run docs
```

Open `http://127.0.0.1:8010/ifc-viewx/docs/`. If port 8010 is busy, run:

```bash
mkdocs serve -a 127.0.0.1:8011
```

The extension catalog is generated from manifests. Edit the manifest or catalog
generator instead of editing `docs/plugins/catalog.md` by hand.

Before submitting a docs change, run:

```bash
npm run docs:build
```

## Release `ifcviewx`

```bash
npm run bump -- 0.1.4
git status --short
git add -A
git diff --cached --check
git commit -m "release v0.1.4"
git tag -a v0.1.4 -m "IFCViewX 0.1.4"
git push origin main --follow-tags
```

`npm run bump` updates `package.json`, `package-lock.json`, and
`local-bridge/pyproject.toml`. The tag must match the Python package version.
Review every staged path before committing;
`git commit -am` omits newly added release files. A tag builds the viewer, creates
the wheel and source archive, publishes to PyPI, and creates a GitHub release.

Before creating the release commit, run the complete
[publication gate](refactor/verification.md#publication-gate).
