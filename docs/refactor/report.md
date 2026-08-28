# Refactor review report

Reviewed on 2026-08-28. The acceptance rule was unchanged behavior with fewer
ownership conflicts, not minimum physical line count.

## Outcome

- All 1,040 frontend tests and 214 Local Studio tests pass.
- TypeScript, Ruff, plugin isolation, public contracts and SDK declarations pass.
- The dependency graph moved from 12 reported cycle paths to zero cycles.
- All 18 bundled extensions, 42 capability IDs, 340 SDK exports, 97 emitted SDK
  declaration files, 24 HTTP routes and 32 MCP tools are frozen by generated checks.
- The production CSS is byte-for-byte unchanged.
- No feature-safe dead file was found. Dynamic entries and compatibility facades
  were retained rather than deleted from a raw unused-code report.

## Measurements

| Measure | Before | After | Result |
| --- | ---: | ---: | --- |
| Frontend source | 74,863 lines | 75,006 lines | +0.19% |
| Python source | 6,198 lines | 6,354 lines | +2.52% |
| Combined production source | 81,061 lines | 81,360 lines | +0.37% |
| Production app | 13,385,407 bytes | 13,386,130 bytes | +723 bytes |
| Main JavaScript | 817,516 bytes | 818,239 bytes | +723 bytes |
| CSS | 172,417 bytes | 172,417 bytes | unchanged |
| Wheel | 2,670,182 bytes | 2,673,245 bytes | +0.11% |
| Source archive | 2,602,107 bytes | 2,603,341 bytes | +0.05% |
| Circular dependency paths | 12 | 0 | removed |
| Duplicate lines | 791 | 791 | unchanged |
| Duplicate percentage | 1.37% | 1.35% | lower denominator ratio only |
| Preview startup median | 56.74 ms | 29.50 ms | -48.0% |
| Warm preview response median | 8.97 ms | 6.63 ms | -26.1% |
| WebIFC initialization | 36.10 ms | 23.85 ms | -33.9% |
| Warm generated-sample parse | 0.30 ms | 0.36 to 0.38 ms | sub-millisecond variance |

Source grew slightly because behavior contracts and explicit module seams were
added. The tracked diff alone is misleading because moved implementations are
new files until the maintainer stages them.

Build and pytest wall times were heavily affected by host contention. The final
build passed in 705.6 seconds versus a 110.5-second baseline, while a repeated
Vite-only build still waited for scheduler time. Python passed in 305.0 seconds
versus 46.8 seconds. These elapsed values are recorded but are not attributed to
application code. Startup medians and artifact bytes are the useful local
comparisons.

## Static-analysis decisions

Knip reported 16 unused files. Each is a dynamic entry or retained compatibility
surface: the service worker, two worker entries, bundled plugin panels, and old
SDK, findings and clash import paths. Its unused exports are predominantly the
intentional public SDK or symbols used inside their own module. `mkdocs` is a
Python executable invoked by an npm script, so its unlisted-binary warning is
also expected. None of these findings is deletion evidence.

The remaining 791 duplicated lines are below the 3% budget. The largest cluster
is the geometry worker protocol, where each branch carries distinct transfer,
cancellation, priority and result-message behavior. Other clusters occur twice
in provider streaming, cache boundaries or plugin panels. They were left intact
because merging them without the missing real-browser and worker harness would
trade visible duplication for higher behavioral risk.

## Large-file review

| File | Lines | Decision |
| --- | ---: | --- |
| `viewer-core/viewer.ts` | 3,884 | Section, measurement, federation and visibility contracts extracted; keep remaining coordinated viewer state until visual tests exist. |
| `main.ts` | 3,346 | Settings, browser bridge and input ownership extracted; keep remaining application composition together for now. |
| `viewer-core/scene/batcher.ts` | 2,249 | Leave; hot batching, scratch reuse and disposal code needs GPU and memory baselines. |
| `ui/dock.ts` | 1,894 | Candidate for a later characterized UI-only pass. |
| `viewer-core/scene/scene.ts` | 1,842 | Leave; rendering lifecycle and resource ownership are cohesive and high risk. |
| `ui/bcf.ts` | 1,413 | Candidate for later split by capture, storage and OpenCDE concerns. |
| `viewer-core/engine/adapter.ts` | 1,232 | Leave; one parser-adapter boundary. |
| `ui/sidePanel.ts` | 1,072 | Candidate for a later panel-state pass with browser interaction coverage. |
| `ui/kit.ts` | 1,004 | Leave; shared UI primitives form one public design-system surface. |
| `plugins/clash/panel.ts` | 964 | Leave; extension is isolated and lazily loaded. |
| `plugins/section-workspace/panel.ts` | 963 | Leave; extension is isolated and owns one workflow. |
| `llm/llmClient.ts` | 936 | Provider adapters are a later seam; streaming and cancellation must stay provider-specific. |
| `views/definition.ts` | 899 | Leave; one versioned saved-view contract. |
| `plugins/schedule-4d/panel.ts` | 888 | Leave; isolated extension workflow. |
| `plugins/ids-studio/panel.ts` | 883 | Leave; isolated extension workflow. |
| `data/computed.ts` | 863 | Leave; one computed-property language and evaluator. |
| `viewer-core/scene/controls.ts` | 850 | Leave; input ordering and camera lifecycle require browser coverage. |
| `viewer-core/engine/cache.ts` | 849 | Leave; one versioned binary cache boundary. |
| `viewer-core/panels/tree.ts` | 824 | Leave; keyboard behavior is characterized and cohesive. |
| `plugins/sheets/panel.ts` | 822 | Leave; isolated extension workflow. |

## Publication limitations

The approved in-app browser was unavailable during both attempts. No claim is
made for real WebGL interaction, screenshot parity, GPU memory, first-frame time,
service-worker lifecycle, native file APIs or manual feature-by-feature review.
Licensed small, medium and large IFC fixtures are also absent. The feature
inventory identifies every row that still needs a browser, device, corpus or
staging-service check before visual certification.

Remote GitHub Actions jobs have not run in this workspace. No files were staged,
committed or pushed.
