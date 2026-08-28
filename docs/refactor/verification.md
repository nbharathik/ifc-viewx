# Refactor verification

## Fast gates

Run the smallest relevant gate while editing, then the full gate before handing
off a pass.

| Command | Protects |
| --- | --- |
| `npm run typecheck` | Strict TypeScript and unused locals or parameters |
| `node scripts/check-plugins.mjs` | Manifest validity and bundled extension isolation |
| `npm run boundaries` | Import direction and no new dependency cycles |
| `npm run contracts:check` | SDK, manifests, IDs, persistence, REST, MCP, CLI and dynamic entries |
| `npm run contracts:types:check` | Emitted SDK declarations and external TypeScript signatures |
| `npm test` | Deterministic browser-domain logic in Vitest and jsdom |
| `npm run build` | All frontend gates, production chunks, WASM copy and offline shell budget |
| `npm run docs:build` | Generated catalog plus strict documentation links |
| `python -m ruff check src tests` | Python static checks from `local-bridge/` |
| `python -m pytest tests -q` | Local Studio, CLI, HTTP, jobs, providers, WebSocket and MCP behavior |

Run `npm run metrics` after a production build to emit deterministic source and
artifact metrics. CI uploads the JSON report for comparison. Source lines and
file counts provide context, but they are not acceptance budgets.

## Contract changes

`npm run contracts:check` does not decide whether a change is acceptable. It
forces the decision into review. The snapshot includes surfaces that static
unused-code tools often misclassify:

- `import.meta.glob` plugin manifests and panel entries
- literal and computed dynamic imports
- Vite worker entry points and runtime worker URLs
- the `@ifcviewx/sdk` export barrel
- manifest activation, contribution, command and capability IDs
- persistence namespaces
- browser bridge registrations
- FastAPI routes, MCP decorators, Python CLI entries and provider entry points

For an intentional contract change, inspect the diff and run
`npm run contracts:update`. A feature-frozen refactor should normally change
only dynamic entry file locations, never names or behavior.

## Dependency boundaries

The boundary gate prevents core code from importing bundled plugins, prevents
non-plugin code from consuming the SDK alias, isolates the application entry,
keeps workers out of DOM application layers and protects the SDK from runtime
plugin dependencies.

Five dependency cycles existed when the gate was introduced and were removed
during the refactor. `architecture-baseline.json` is now empty, so any new cycle
fails.

## Required pass protocol

1. Link the change to one or more IDs in the feature inventory.
2. Add characterization coverage if the row lacks relevant evidence.
3. Make one bounded conceptual change.
4. Run type, boundary, contract and affected test gates.
5. Build and compare project metrics.
6. Run the applicable manual or real-browser flow.
7. Run the full frontend and Python gates before publication.

Three.js and WebIFC changes additionally require worker and inline-parser runs,
semantic model-result comparison, screenshots, repeated load and unload, and
performance measurement. Disposal, clipping state, GlobalId mapping, cache
format and scratch-object reuse are behavior, not cleanup opportunities.

## Publication gate

The automated publication candidate must pass:

```bash
npm ci
npm audit --audit-level=moderate
npm run build
npm run contracts:types:check
npm run docs:build
node scripts/bump-version.mjs --check 0.1.4

cd local-bridge
python -m ruff check src tests
python -m pytest tests -q
cd ..
python -m build local-bridge
twine check local-bridge/dist/*
```

CI also checks the declared minimum Node version, supported Python versions,
Python 3.14 degraded mode, Windows CLI/API behavior, wheel contents and a fresh
wheel installation.

## Baselines still required

The repository does not yet have a reproducible real-browser, visual or
performance harness. Vitest uses jsdom, so it cannot validate WebGL, worker and
WASM startup, installed service-worker lifecycle, native file APIs or downloaded
artifacts. The development IFC models are gitignored and cannot serve as CI
fixtures.

Before changing viewer or parser hot paths, add licensed, hashed small, medium
and large fixtures plus:

- semantic digests for entity counts, GlobalIds, spatial structure and geometry
- Chromium, Firefox and WebKit workflow smoke tests
- stable screenshots for representative viewer and panel states
- cold parse and time-to-first-frame measurements
- repeated load and unload memory checks
- export round trips opened by an independent parser where practical

No browser, visual or performance result is claimed until that harness exists
and runs in CI.
