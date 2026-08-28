# Frozen feature inventory

This inventory is the acceptance baseline for structural refactoring. `Unit`
means a deterministic Vitest or pure-logic check exists. `Python` means pytest
covers the Local Studio path. `Browser` is required where jsdom cannot exercise
WebGL, workers, WASM, service workers, downloads or native file APIs.

## Viewer and model lifecycle

| ID | Frozen behavior | Existing evidence | Remaining gate |
| --- | --- | --- | --- |
| VIEW-01 | Open IFC, IFCX and the generated sample; replace, attach and close models | `format`, `sample`, `ifcEngine`, `ifcModel`, `federation` | Browser with licensed fixtures |
| VIEW-02 | Parse in a worker and retain the inline fallback | `ifcEngine`, `streaming`, `cacheFormat` | Browser in both modes |
| VIEW-03 | Render, frame, orbit, orthographic and axis views | `webglStartup`, `viewerActions`, `viewerControlsKeyboard` | Screenshot and camera-state baseline |
| VIEW-04 | Select, multi-select, clear and frame elements | `viewerActions`, `treeKeyboard` | Browser picking |
| VIEW-05 | Hide, isolate, show all, undo and redo visibility | `viewerActions`, `viewTransactions` | Browser rendering |
| VIEW-06 | Transparency, ghosting, edges, grids, spaces and openings | `viewerActions`, `gridAxes` | Browser rendering |
| VIEW-07 | Spatial tree, types, summary, organize and properties panels | `treeKeyboard`, `organizePane` | Browser panel smoke |
| VIEW-08 | Filters, color rules and computed properties | `colorBy`, `computedProperties`, `viewDefinition` | Browser rendering |
| VIEW-09 | Saved views preserve camera, visibility, sections, color and annotations | `viewDefinition`, `viewpoints`, `viewTransactions` | Browser round trip |
| VIEW-10 | Distance, shape and smart measurements remain editable and persistent | `distance`, `laser`, `measure`, `measurementWorkflow`, `measureOverlay` | Browser pointer flow |
| VIEW-11 | Section planes, section box, contours, plan view and plan export | `sectionBox`, `sectionContours`, `planLocator`, `planExport` | Browser clipping and PNG check |
| VIEW-12 | Fly, VR and AR modes retain input and lifecycle behavior | `flyStats`, `xr` | Supported-device manual check |
| VIEW-13 | Georeferencing, federation alignment, solar and GeoJSON behavior remain stable | `georeferencing`, `federation`, `solar`, `sun`, `geoPanel` | Browser map and scene check |
| VIEW-14 | Point-cloud import, placement and deviation remain available | `pointCloud`, `deviation`, `deviationQuery` | Browser large-file check |

## Review, editing and exchange

| ID | Frozen behavior | Existing evidence | Remaining gate |
| --- | --- | --- | --- |
| DATA-01 | Read IFC structure, properties, schedules, tasks and alignments | `ifcModel`, `schedules`, `taskGraph`, `alignment` | Licensed model corpus |
| DATA-02 | Stage attribute, property, rename and delete edits with apply, discard, undo and redo | `viewerActions`, `viewTransactions` | Browser and exported IFC round trip |
| DATA-03 | Structural, conformance, IDS and rule checks retain findings | `conformance`, `ids`, `ruleEngine` | Golden semantic results |
| DATA-04 | Clash, distance, volume, sun and classification analyses retain numeric results | `clash`, `distance`, `volumes`, `sun`, `classifyPlane` | Golden geometry results |
| DATA-05 | BCF topics preserve camera, section, selection, snapshot, import and export | `bcf`, `viewpoints` | Browser archive round trip |
| DATA-06 | OpenCDE projects, BCF topics, comments, viewpoints and documents retain request behavior | `openCdeClient`, `openCdeBridge`, `openCdeDocuments` | Staging-server smoke |
| DATA-07 | IFCX, share packages, schedules, XLSX, mesh, plan, image and report exports remain available | `cacheFormat`, `sharePackage`, `tabular`, `xlsx`, `meshExport`, `planExport`, `report` | Browser downloads and format opening |
| DATA-08 | Sheets retain import, calibration, overlay, markup and issue handoff | `sheets`, `sheetsPanel` | Browser drawing workflow |

## Bundled extensions

Every folder listed here is discovered from `extension.json` and loaded lazily.
The manifest, activation events, permissions and contribution IDs are also
frozen in `public-contracts.json`.

| ID | Extension | Frozen purpose | Existing evidence |
| --- | --- | --- | --- |
| EXT-01 | Clash | Coordination docket over clash and clearance results | `clash`, `clashWorkflow` |
| EXT-02 | Compare | Geometry and property revision comparison | `modelCompare`, `newPanels` |
| EXT-03 | Explorer | Tabular model and property exploration | `newPanels`, `tabular` |
| EXT-04 | Finder | Plain-language model search and result actions | `retrieval`, `newPanels` |
| EXT-05 | IDS Studio | IDS authoring and bSDD-assisted requirements | `idsDocument`, `idsStudioPanel` |
| EXT-06 | Model Health | Identity, geometry and quality checks | `newPanels`, `ruleEngine` |
| EXT-07 | Point Cloud | Scan overlay and deviation coloring | `pointCloudPanel`, `deviation` |
| EXT-08 | Presentation | Ordered saved-view playback and recording | `presentationPanel` |
| EXT-09 | Python | IfcOpenShell console through browser or Local Studio | `pluginRegistry`, `serviceClient`; Python tests |
| EXT-10 | Report Builder | Saved free-form schedules and grouped reports | `reportBuilder` |
| EXT-11 | Rule Studio | Geometric, placement, topology and quantity rules | `ruleEngine`, `newPanels` |
| EXT-12 | 4D Schedule | IFC tasks, CSV overlay, Gantt and timeline | `schedule4d`, `schedule4dPanel` |
| EXT-13 | Section Workspace | Synchronized section drawing from the live cut | `sectionWorkspace` |
| EXT-14 | Sheets | Issued drawing set linked to the model | `sheetsPanel` |
| EXT-15 | Smart Measure | Object clearance and surface-axis measurement | `smartMeasurePanel`, `measurementWorkflow` |
| EXT-16 | Spaces | Space area, volume and occupancy review | `newPanels`, `volumes` |
| EXT-17 | Storeys | Level-by-level model navigation | `newPanels`, `federation` |
| EXT-18 | Takeoff | Volume, area and count rollups | `newPanels`, `volumes` |

All extension panels still require a real-browser open, interact and close smoke
before publication.

## Platform, assistant and Local Studio

| ID | Frozen behavior | Existing evidence | Remaining gate |
| --- | --- | --- | --- |
| PLAT-01 | Bundled extensions import only `@ifcviewx/sdk` and their own files | `checkPlugins`, `boundaries` | None |
| PLAT-02 | Installed packages validate, persist, update, roll back, uninstall and run in a permissioned sandbox | `extensionManifest`, `installedExtensions`, `extensionSandbox` | Browser iframe smoke |
| PLAT-03 | Plugin commands, panels, results, overlays, storage and assistant contributions remain scoped | `extensionContext`, `extensionContributions`, `extensionResults`, `pluginHostPersistence` | Browser host smoke |
| PLAT-04 | Assistant provider settings, privacy, chat history, tool selection, approvals, evidence and stale-result handling remain stable | `privacy`, `chatStore`, `toolCalling`, `agentRuntime`, `assistantEvalTraces` | Optional live-provider evaluation |
| PLAT-05 | PWA registration, versioned shell and lazy runtime caching remain available | `pwa` and the build shell budget | Installed browser update and offline smoke |
| LOCAL-01 | `ifcviewx` serves the bundled viewer and health/capability API | Python `test_api`, `test_cli` | Built-wheel HTTP smoke |
| LOCAL-02 | Content-addressed model storage, pruning and reveal remain stable | Python `test_store`, `test_api` | Windows path smoke |
| LOCAL-03 | Conversion, checks, IDS and native Python jobs preserve cancellation and results | Python `test_convert_cache`, `test_check`, `test_jobs` | Licensed model corpus |
| LOCAL-04 | Native providers retain discovery, validation, isolation and capability jobs | Python `test_providers` | Third-party provider fixture |
| LOCAL-05 | LLM proxy chat and streaming preserve origin, secret and cancellation controls | Python `test_llm` | Provider staging smoke |
| LOCAL-06 | Browser WebSocket bridge and MCP tools preserve names and schemas | Python `test_ws`, `test_server`; `public-contracts.json` | Packaged end-to-end smoke |
| LOCAL-07 | Guard and sandbox restrictions remain at least as strict | Python `test_guard`, `test_jobs` | Security review after related changes |

## Public compatibility surfaces

The generated snapshots protect 340 SDK export names and their emitted type
declarations, all bundled manifests, command and capability IDs, persistence
namespaces, browser bridge methods, Local Studio routes, MCP tool names, CLI
entries and dynamic entries. Counts are descriptive only. The exact reviewed
values in `public-contracts.json` and `sdk-type-contracts.json` are the gate.
