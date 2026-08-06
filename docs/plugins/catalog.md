# Plugin catalog

Everything in the viewer's plugin browser, generated from the manifests.
Yours belongs here too: see [writing a plugin](index.md).

## In the browser

These run in the tab. Nothing to install, nothing uploaded.

### Clash Detection

*Find elements that fight for the same space*

Sweeps two sets of IFC classes against each other and reports every pair whose volumes overlap by more than the tolerance. It works off the bounding boxes the viewer already holds, so a full sweep of a large model takes about a second and no geometry leaves the tab.

- Any class against any class, with structure and MEP presets
- Uniform grid broad phase; overlap volume and depth per hit
- Click a hit to isolate the pair and frame it
- Full report as CSV

<small>Category: Coordination</small>

### Element Explorer

*A spreadsheet over every element and property in the model*

Indexes every placed element with its class, name, storey and GlobalId, then lets you add any property set value as a column. Search across the whole table, sort on any column, and push what is left of the filter straight into the viewport.

- Add any Pset property as a column, ranked by how common it is
- Search and per-class filtering across the whole model
- Isolate or hide everything the filter matched
- CSV export of the filtered rows, not just the visible page

<small>Category: Data</small>

### Model Compare

*Diff the open model against an earlier IFC*

Parses a second IFC in a background worker without drawing it, then matches both models by GlobalId to report what was added, removed and changed. Changed elements list the exact attributes and property values that moved, and anything present in the open model can be isolated in place.

- Added, removed, changed and unchanged, matched on GlobalId
- Per element list of the attributes and properties that changed
- Isolate added or changed elements in the viewport
- CSV export of the change report

<small>Category: Quality</small>

### Python Console

*Write IfcOpenShell against the open model*

A console for real IfcOpenShell code: queries return a value, edits run on a disposable copy and come back staged for approval. This is the only place Python runs, and only when you press Run. The assistant can write code for you and hand it here, but it can never execute it, on any tier. First Run in this tab downloads the runtime once (~30 MB); in Local Studio the same console runs natively instead, and says which before you press Run.

- Queries assign to `result`; edits define `def edit(model)`
- Every edit runs on a copy and is staged, never applied silently
- Runs natively in Local Studio, in this tab otherwise
- Yours alone: the assistant writes Python, only you run it

<small>Category: Automation</small>

### Quantity Takeoff

*Volumes, areas and counts rolled up by class and storey*

Reads the base quantities authored in the file (Qto_*, plus quantity-shaped properties) for every placed element and aggregates them. Where an element carries no quantities the bounding box fills the gap, and each row says how much of the total is authored rather than estimated.

- Group by class, by storey, or by both
- Net and gross volume, area, length and count
- Coverage column: how much of the group carries real quantities
- Click a row to isolate the group; export the table as CSV

<small>Category: Data</small>

### Storey Navigator

*Walk the building one level at a time*

Lists every storey with its elevation and how much sits on it, and isolates one with a click. The camera stays put as you step up and down, which is what makes comparing levels readable, and the ceiling cut drops a section under the level above so you look into the storey instead of at its slab.

- Every storey with elevation and element count
- Isolate a level without moving the camera
- Ceiling cut for a plan style look into the level
- Step up and down through the building

<small>Category: Navigation</small>

## Local Studio

These need the local service, which is one `pip install` away.

### Assistant Key Vault

*Keep the provider key off the browser*

The local service holds the assistant's provider key and proxies every turn, so the key never reaches this page or its local storage. The assistant panel switches over on its own once the service reports one is configured.

- The API key stays on your machine
- Same assistant, same tools, different key holder
- Falls back to the browser endpoint when absent

<small>Category: Automation &middot; Needs: `llm`</small>

### IfcOpenShell Converter

*Exact solids and instant reopens*

Converts the model with IfcOpenShell into the viewer's .ifcx format. Advanced breps come through exactly, threads do the work, and every later open of that model skips parsing entirely.

- Exact advanced breps, no tessellation guesswork
- Multi-threaded, with no 4 GB browser memory ceiling
- Reopens become instant for that model

<small>Category: Geometry &middot; Needs: `convert`</small>

### MCP Bridge

*Let Claude and other AI clients drive this viewer*

Exposes the loaded model and the viewport as MCP tools, so an external AI client can query the model and select, isolate and frame elements. It is read and view control only: there is no tool that runs code or writes to the model, so an AI client cannot change anything you are looking at.

- Model queries, selection and visibility as tools
- Read and view only: no code execution, no model writes
- Works with Claude Desktop and Claude Code

<small>Category: Automation &middot; Needs: `mcp`</small>

### Native Python

*Full IfcOpenShell scripting with no runtime download*

Runs your Python against the model in the local service instead of in this tab. The full IfcOpenShell API is available, nothing is downloaded to the browser, and edits come back as a staged proposal you approve before it touches the model.

- Whole IfcOpenShell API, not the browser subset
- No 30 MB Pyodide download on first run
- Edits are executed on a copy and staged for approval

<small>Category: Automation &middot; Needs: `python`</small>

## Built into the app

These have their own panel on the rail rather than being opened from the catalog.

### Element Schedules

*Tabular exports with resolved property columns*

Builds a row per element of a class with property set columns resolved through type inheritance, which is the part a plain instance read gets wrong. On real models most elements inherit their properties from their type, so this is the difference between a usable schedule and an empty one.

- Property values resolved through the element type
- Any class, any set of property columns
- Click a row to select and frame the element
- CSV export of the whole table

<small>Category: Data</small>

### IDS Validation

*Check the model against a buildingSMART specification*

Loads an Information Delivery Specification and validates this model against it in the tab. Entity, attribute and property facets are evaluated element by element; facets that need data the viewer does not carry are listed as unchecked rather than quietly passed.

- Entity, attribute and property facets, applicability and requirements
- Pass and fail counts per specification
- Isolate what failed, or raise it straight as an issue
- Nothing uploaded: the .ids file is parsed in this tab

<small>Category: Quality</small>

### Issue Tracker

*Capture issues on the model and export them as BCF*

Every topic stores the camera, the section planes, the selection and a snapshot of the viewport, so reopening one puts you back exactly where it was raised. Topics live in this browser beside the model and export as a BCF 2.1 archive other BIM tools can read.

- One capture keeps view, section, selection and snapshot
- Status, priority and assignee, with filtering
- Reopen a topic to restore the exact viewpoint
- Export a BCF 2.1 zip for other tools

<small>Category: Collaboration</small>

### Model Checks

*Structural QA over the whole file*

Identity, containment, placement, unit and naming checks run over the entity graph in this tab, with no generated code involved and nothing to download. Results land in the summary pane next to the model facts.

- No generated code, so nothing to review before it runs
- Covers identity, containment, placement, units and naming
- Severity counts feed straight into the model summary

<small>Category: Quality</small>

### Model Edits

*Rename, set properties and delete, with a measured diff*

Typed edit operations over the model: rename, substring rename, write an existing property, delete. Each one runs on a disposable copy and comes back staged with a diff measured from the result rather than reported by whatever made the change. Nothing is applied until you approve it, and undo restores the previous checkpoint.

- Rename one element or a whole selection
- Write a property that already exists on the element
- Delete elements, behind a typed confirmation
- Every change staged with a measured diff, applied only on approval

<small>Category: Automation</small>

### Smart Filters

*Rule based visibility that you can stack and undo*

Builds visibility rules over class, name, storey and property values. Rules are the only writer of the visible set, so removing one restores exactly what it hid, and the viewport chip always says what is currently applied.

- Filter by class, name, storey or any property value
- Stack rules; each one is reversible on its own
- Isolate or hide, with a live chip in the viewport

<small>Category: Coordination</small>

