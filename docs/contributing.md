# Working on the repo

```bash
npm install
npm run dev          # the viewer, with hot reload
npm run check        # typecheck plus the plugin boundary check
npm run build        # check, then a production build into dist/
npm run docs         # this site, with live reload
```

Any small IFC works for testing. The
[buildingSMART samples](https://github.com/buildingSMART/Sample-Test-Files) are
a good starting point.

## Layout

```
src/
  sdk/           the plugin contract, and the only thing plugins import
  plugins/       one folder per plugin, plus runtime/ that mounts them
  viewer-core/   parsing, geometry, scene, camera, picking
  ui/            shell, ribbon, commands, and the built in panels
  ifc/           model checks, typed edits, schedules, clash
  python/        Pyodide with IfcOpenShell
  llm/           the assistant
  bridge/        talking to Local Studio
local-bridge/    the ifcviewx Python package
docs/            this site
scripts/         the plugin scaffolder, the boundary check, the catalog generator
```

Adding a feature is usually a [plugin](plugins/index.md). Core is for what does
not fit in a panel, such as a new viewer capability or a change to how models
load.

`src/plugins/*/` may import `@ifcviewx/sdk` and its own files, nothing else,
and core may not import a plugin folder. `npm run check` fails otherwise. When
core has something new to offer plugins, it goes into `src/sdk/`.

## Style

Comments explain why, not what. No em-dashes, which `npm run check` also
covers. Strict TypeScript, with `noUnusedLocals` and `noUnusedParameters`.

## The docs

```bash
pip install -r docs/requirements.txt
npm run docs
```

Serves at `http://127.0.0.1:8010/ifc-viewx/docs/`. The path matters: it matches
where the site is published, and MkDocs prints the full URL when it starts.
Port 8010 rather than the MkDocs default of 8000, which collides with a lot.
Use `mkdocs serve -a 127.0.0.1:8011` if 8010 is busy too.

The catalog page is generated from the manifests on every `npm run docs`, so
edits to it are overwritten.

## Deploys

Push to `main` builds the viewer and this site and publishes both to GitHub
Pages: the app at the root, the docs under `/docs/`. The Python package
publishes from a tag.

## Releasing ifcviewx

```bash
npm run bump -- 0.2.0
git commit -am "release v0.2.0"
git tag -a v0.2.0 -m "IFCViewX 0.2.0"
git push origin main --follow-tags
```

`npm run bump` sets the same number in `package.json` and
`local-bridge/pyproject.toml`; the workflow refuses a tag that disagrees with
`pyproject.toml`, because PyPI never lets a version number be reused. The tag
push builds the viewer, bundles it into the wheel, uploads to PyPI through a
trusted publisher, and opens a GitHub release with the wheel and sdist
attached. Re-running it for a version already on PyPI fails; bump instead.
