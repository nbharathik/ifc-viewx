// Catalog entries for tools that are not extension folders.
//
// Two kinds live here. `core` entries are panels the app already carries on
// its own rail, so the catalog points at them rather than mounting a second
// copy. `local` entries need the Local Studio service, which means they ship
// with the Python package rather than as a panel in this repo. Neither can be
// a folder under src/plugins because neither has a panel to mount, and one
// honest catalog is worth more than a tidy rule.
//
// Everything else, including anything you write, is a folder. See docs/plugins.
interface CatalogShortcut {
  id: string;
  name: string;
  tagline: string;
  about: string;
  icon: string;
  category: string;
  tier: "web" | "local" | "core";
  keywords: string;
  does: string[];
  author?: string;
  url?: string;
  capability?: string;
  command?: string;
  soon?: boolean;
}
const defineShortcut = (shortcut: CatalogShortcut): CatalogShortcut => shortcut;

export const SHORTCUTS: CatalogShortcut[] = [
  defineShortcut({
    id: "ids",
    name: "IDS Validation",
    tagline: "Check the model against a buildingSMART specification",
    about:
      "Loads an Information Delivery Specification and validates this model against it in the tab. Entity, attribute and property facets are evaluated element by element; facets that need data the viewer does not carry are listed as unchecked rather than quietly passed.",
    icon: "clipboard",
    category: "Quality",
    keywords: "ids buildingsmart validation qa compliance specification facets audit",
    tier: "core",
    command: "panel.ids",
    does: [
      "Entity, attribute and property facets, applicability and requirements",
      "Pass and fail counts per specification",
      "Isolate what failed, or raise it straight as an issue",
      "Nothing uploaded: the .ids file is parsed in this tab",
    ],
  }),
  defineShortcut({
    id: "bcf",
    name: "Issue Tracker",
    tagline: "Keep BCF local or sync it with an OpenCDE project",
    about:
      "Every topic stores the camera, section planes, selection and viewport snapshot, so reopening one returns to the place it was raised. Review locally, export a BCF 2.1 archive, or connect a buildingSMART OpenCDE BCF 3.0 project. Server changes stay in a visible queue until you press Sync.",
    icon: "flag",
    category: "Collaboration",
    keywords: "bcf opencde cde topics comments markup review snapshot viewpoint coordination issues sync",
    tier: "core",
    command: "panel.bcf",
    does: [
      "One capture keeps view, section, selection and snapshot",
      "OpenCDE BCF 3.0 projects, server fields and assignees",
      "Explicit, retryable sync with a visible offline queue",
      "BCF 2.1 zip import and export for other BIM tools",
    ],
  }),
  defineShortcut({
    id: "filters",
    name: "Smart Filters",
    tagline: "Rule based visibility that you can stack and undo",
    about:
      "Builds visibility rules over class, name, storey and property values. Rules are the only writer of the visible set, so removing one restores exactly what it hid, and the viewport chip always says what is currently applied.",
    icon: "funnel",
    category: "Coordination",
    keywords: "filter isolate hide visibility rules query selection sets",
    tier: "core",
    command: "panel.filters",
    does: [
      "Filter by class, name, storey or any property value",
      "Stack rules; each one is reversible on its own",
      "Isolate or hide, with a live chip in the viewport",
    ],
  }),
  defineShortcut({
    id: "checks",
    name: "Model Checks",
    tagline: "Structural QA over the whole file",
    about:
      "Identity, containment, placement, unit and naming checks run over the entity graph in this tab, with no generated code involved and nothing to download. Results land in the summary pane next to the model facts.",
    icon: "check-circle",
    category: "Quality",
    keywords: "validate checks qa integrity containment placement units",
    tier: "core",
    command: "file.check",
    does: [
      "No generated code, so nothing to review before it runs",
      "Covers identity, containment, placement, units and naming",
      "Severity counts feed straight into the model summary",
    ],
  }),
  defineShortcut({
    id: "schedules",
    name: "Element Schedules",
    tagline: "Tabular exports with resolved property columns",
    about:
      "Builds a row per element of a class with property set columns resolved through type inheritance, which is the part a plain instance read gets wrong. On real models most elements inherit their properties from their type, so this is the difference between a usable schedule and an empty one.",
    icon: "list",
    category: "Data",
    keywords: "schedule table export pset inheritance type properties",
    tier: "core",
    command: "file.schedule",
    does: [
      "Property values resolved through the element type",
      "Any class, any set of property columns",
      "Click a row to select and frame the element",
      "CSV export of the whole table",
    ],
  }),
  defineShortcut({
    id: "edits",
    name: "Model Edits",
    tagline: "Rename, set properties and delete, with a measured diff",
    about:
      "Typed edit operations over the model: rename, substring rename, write an existing property, delete. Each one runs on a disposable copy and comes back staged with a diff measured from the result rather than reported by whatever made the change. Nothing is applied until you approve it, and undo restores the previous checkpoint.",
    icon: "edit",
    category: "Automation",
    keywords: "edit rename property delete modify write change bulk",
    tier: "core",
    command: "edit.rename",
    does: [
      "Rename one element or a whole selection",
      "Write a property that already exists on the element",
      "Delete elements, behind a typed confirmation",
      "Every change staged with a measured diff, applied only on approval",
    ],
  }),

  defineShortcut({
    id: "convert",
    name: "IfcOpenShell Converter",
    tagline: "Exact solids and instant reopens",
    about:
      "Converts the model with IfcOpenShell into the viewer's .ifcx format. Advanced breps come through exactly, threads do the work, and every later open of that model skips parsing entirely.",
    icon: "refresh",
    category: "Geometry",
    keywords: "ifcopenshell convert ifcx cache brep exact geometry native",
    tier: "local",
    capability: "convert",
    command: "file.convert",
    does: [
      "Exact advanced breps, no tessellation guesswork",
      "Multi-threaded, with no 4 GB browser memory ceiling",
      "Reopens become instant for that model",
    ],
  }),
  defineShortcut({
    id: "native-python",
    name: "Native Python",
    tagline: "Full IfcOpenShell scripting with no runtime download",
    about:
      "Runs your Python against the model in the local service instead of in this tab. The full IfcOpenShell API is available, nothing is downloaded to the browser, and edits come back as a staged proposal you approve before it touches the model.",
    icon: "terminal",
    category: "Automation",
    keywords: "python ifcopenshell script automation edit console pyodide",
    tier: "local",
    capability: "python",
    command: "panel.py",
    does: [
      "Whole IfcOpenShell API, not the browser subset",
      "No 30 MB Pyodide download on first run",
      "Edits are executed on a copy and staged for approval",
    ],
  }),
  defineShortcut({
    id: "mcp",
    name: "MCP Bridge",
    tagline: "Let Claude and other AI clients drive this viewer",
    about:
      "Exposes the loaded model and the viewport as MCP tools, so an external AI client can query the model and select, isolate and frame elements. It is read and view control only: there is no tool that runs code or writes to the model, so an AI client cannot change anything you are looking at.",
    icon: "plug",
    category: "Automation",
    keywords: "mcp claude desktop code agent tools bridge automation",
    tier: "local",
    capability: "mcp",
    command: "app.connection",
    does: [
      "Model queries, selection and visibility as tools",
      "Read and view only: no code execution, no model writes",
      "Works with Claude Desktop and Claude Code",
    ],
  }),
  defineShortcut({
    id: "llm-proxy",
    name: "Assistant Key Vault",
    tagline: "Keep the provider key off the browser",
    about:
      "The local service holds the assistant's provider key and proxies every turn, so the key never reaches this page or its local storage. The assistant panel switches over on its own once the service reports one is configured.",
    icon: "sparkle",
    category: "Automation",
    keywords: "llm api key secret proxy assistant privacy provider",
    tier: "local",
    capability: "llm",
    command: "app.connection",
    does: [
      "The API key stays on your machine",
      "Same assistant, same tools, different key holder",
      "Falls back to the browser endpoint when absent",
    ],
  }),
];
