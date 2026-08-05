// Plugin ecosystem: one catalog, two tiers.
//
// Web plugins are whole tools that run inside this tab and load only when
// someone opens them, so the startup bundle never carries them. Local Studio
// plugins are listed in the same place but need the local service; the browser
// says so and points at the way to get it.
//
// Nothing is on screen until a plugin is opened: the only permanent trace is
// the toggle in the status bar.
import { h, icon, iconButton, toast } from "../ui/kit.js";
import { emptyState } from "../ui/shell.js";
import { PropertyIndex } from "./kit.js";
import type { ItemProperties, Viewer } from "../viewer-core/viewer.js";
import type { ServiceClient } from "../bridge/serviceClient.js";

export type PluginTier = "web" | "local";

export interface PluginManifest {
  id: string;
  name: string;
  tagline: string;
  about: string;
  icon: string;
  category: string;
  tier: PluginTier;
  /** Extra search terms, space separated. */
  keywords: string;
  /** Bullets shown in the detail view. */
  does: string[];
  /** Local tier: the service capability that backs it. */
  capability?: string;
  /** Local tier: the command that opens it in Local Studio. */
  command?: string;
  /** Web tier: the module holding the panel. */
  load?: () => Promise<PluginModule>;
  /** Named and described, but not built yet. Never offers an action. */
  soon?: boolean;
}

export interface PluginModule {
  mount: PluginMount;
}

export type PluginMount = (host: HTMLElement, api: PluginApi, payload?: unknown) => PluginInstance | void;

export interface PluginInstance {
  dispose?(): void;
  /** A different model, or an edit, landed in the viewer. */
  modelChanged?(): void;
  /** The local service was connected, dropped, or changed capabilities. */
  serviceChanged?(): void;
  /** Opened again while already running, with something to work on. */
  receive?(payload: unknown): void;
}

/**
 * The edit pipeline, handed to plugins so they never own execution. Both calls
 * route through the same tier choice the assistant uses, and an edit is always
 * staged for approval, never applied. The static guard is not on this path: it
 * checks generated code, and a plugin's caller is the user.
 */
export interface PluginPython {
  /** True when the local service runs this, not this tab. */
  runsNatively(): boolean;
  /** Read-only run; resolves with the text output. */
  query(code: string, onStatus?: (text: string) => void): Promise<string>;
  /** Run on a copy and stage the result; resolves with the proposal report. */
  propose(code: string, onStatus?: (text: string) => void): Promise<string>;
}

export interface PluginApi {
  viewer: Viewer;
  service: ServiceClient;
  python: PluginPython;
  /** Stable identity of the loaded model, for per-model storage. */
  modelKey(): string;
  modelName(): string;
  properties(expressID: number): Promise<ItemProperties | null>;
  /** Shared property index; every data plugin reuses one build. */
  index(): PropertyIndex;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  read<T>(key: string, fallback: T): T;
  write(key: string, value: unknown): void;
  close(): void;
}

export const CATALOG: PluginManifest[] = [
  {
    id: "storeys",
    name: "Storey Navigator",
    tagline: "Walk the building one level at a time",
    about:
      "Lists every storey with its elevation and how much sits on it, and isolates one with a click. The camera stays put as you step up and down, which is what makes comparing levels readable, and the ceiling cut drops a section under the level above so you look into the storey instead of at its slab.",
    icon: "layers",
    category: "Navigation",
    keywords: "level floor storey plan section isolate walk elevation",
    tier: "web",
    does: [
      "Every storey with elevation and element count",
      "Isolate a level without moving the camera",
      "Ceiling cut for a plan style look into the level",
      "Step up and down through the building",
    ],
    load: () => import("./web/storeys.js"),
  },
  {
    id: "clash",
    name: "Clash Detection",
    tagline: "Find elements that fight for the same space",
    about:
      "Sweeps two sets of IFC classes against each other and reports every pair whose volumes overlap by more than the tolerance. It works off the bounding boxes the viewer already holds, so a full sweep of a large model takes about a second and no geometry leaves the tab.",
    icon: "alert",
    category: "Coordination",
    keywords: "collision interference coordination mep structure hit ducts pipes",
    tier: "web",
    does: [
      "Any class against any class, with structure and MEP presets",
      "Uniform grid broad phase; overlap volume and depth per hit",
      "Click a hit to isolate the pair and frame it",
      "Full report as CSV",
    ],
    load: () => import("./web/clash.js"),
  },
  {
    id: "takeoff",
    name: "Quantity Takeoff",
    tagline: "Volumes, areas and counts rolled up by class and storey",
    about:
      "Reads the base quantities authored in the file (Qto_*, plus quantity-shaped properties) for every placed element and aggregates them. Where an element carries no quantities the bounding box fills the gap, and each row says how much of the total is authored rather than estimated.",
    icon: "calculator",
    category: "Data",
    keywords: "qto quantities volume area boq bill of quantities cost estimate",
    tier: "web",
    does: [
      "Group by class, by storey, or by both",
      "Net and gross volume, area, length and count",
      "Coverage column: how much of the group carries real quantities",
      "Click a row to isolate the group; export the table as CSV",
    ],
    load: () => import("./web/takeoff.js"),
  },
  {
    id: "grid",
    name: "Element Explorer",
    tagline: "A spreadsheet over every element and property in the model",
    about:
      "Indexes every placed element with its class, name, storey and GlobalId, then lets you add any property set value as a column. Search across the whole table, sort on any column, and push what is left of the filter straight into the viewport.",
    icon: "table",
    category: "Data",
    keywords: "schedule table spreadsheet properties pset query filter export",
    tier: "web",
    does: [
      "Add any Pset property as a column, ranked by how common it is",
      "Search and per-class filtering across the whole model",
      "Isolate or hide everything the filter matched",
      "CSV export of the filtered rows, not just the visible page",
    ],
    load: () => import("./web/explorer.js"),
  },
  {
    id: "python",
    name: "Python Console",
    tagline: "Write IfcOpenShell against the open model",
    about:
      "A console for real IfcOpenShell code: queries return a value, edits run on a disposable copy and come back staged for approval. This is the only place Python runs, and only when you press Run. The assistant can write code for you and hand it here, but it can never execute it, on any tier. First Run in this tab downloads the runtime once (~30 MB); in Local Studio the same console runs natively instead, and says which before you press Run.",
    icon: "terminal",
    category: "Automation",
    keywords: "python ifcopenshell script console pyodide query edit snippet code",
    tier: "web",
    does: [
      "Queries assign to `result`; edits define `def edit(model)`",
      "Every edit runs on a copy and is staged, never applied silently",
      "Runs natively in Local Studio, in this tab otherwise",
      "Yours alone: the assistant writes Python, only you run it",
    ],
    load: () => import("./web/python.js"),
  },
  {
    id: "ids",
    name: "IDS Validation",
    tagline: "Check the model against a buildingSMART specification",
    about:
      "Loads an Information Delivery Specification and validates this model against it in the tab. Entity, attribute and property facets are evaluated element by element; facets that need data the viewer does not carry are listed as unchecked rather than quietly passed.",
    icon: "clipboard",
    category: "Quality",
    keywords: "ids buildingsmart validation qa compliance specification facets audit",
    tier: "web",
    command: "panel.ids",
    does: [
      "Entity, attribute and property facets, applicability and requirements",
      "Pass and fail counts per specification",
      "Isolate what failed, or raise it straight as an issue",
      "Nothing uploaded: the .ids file is parsed in this tab",
    ],
  },
  {
    id: "bcf",
    name: "Issue Tracker",
    tagline: "Capture issues on the model and export them as BCF",
    about:
      "Every topic stores the camera, the section planes, the selection and a snapshot of the viewport, so reopening one puts you back exactly where it was raised. Topics live in this browser beside the model and export as a BCF 2.1 archive other BIM tools can read.",
    icon: "flag",
    category: "Collaboration",
    keywords: "bcf topics comments markup review snapshot viewpoint coordination issues",
    tier: "web",
    command: "panel.bcf",
    does: [
      "One capture keeps view, section, selection and snapshot",
      "Status, priority and assignee, with filtering",
      "Reopen a topic to restore the exact viewpoint",
      "Export a BCF 2.1 zip for other tools",
    ],
  },
  {
    id: "filters",
    name: "Smart Filters",
    tagline: "Rule based visibility that you can stack and undo",
    about:
      "Builds visibility rules over class, name, storey and property values. Rules are the only writer of the visible set, so removing one restores exactly what it hid, and the viewport chip always says what is currently applied.",
    icon: "funnel",
    category: "Coordination",
    keywords: "filter isolate hide visibility rules query selection sets",
    tier: "web",
    command: "panel.filters",
    does: [
      "Filter by class, name, storey or any property value",
      "Stack rules; each one is reversible on its own",
      "Isolate or hide, with a live chip in the viewport",
    ],
  },
  {
    id: "compare",
    name: "Model Compare",
    tagline: "Diff the open model against an earlier IFC",
    about:
      "Parses a second IFC in a background worker without drawing it, then matches both models by GlobalId to report what was added, removed and changed. Changed elements list the exact attributes and property values that moved, and anything present in the open model can be isolated in place.",
    icon: "compare",
    category: "Quality",
    keywords: "diff revision version change baseline history delta review",
    tier: "web",
    does: [
      "Added, removed, changed and unchanged, matched on GlobalId",
      "Per element list of the attributes and properties that changed",
      "Isolate added or changed elements in the viewport",
      "CSV export of the change report",
    ],
    load: () => import("./web/compare.js"),
  },
  {
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
  },
  {
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
  },
  {
    id: "checks",
    name: "Model Checks",
    tagline: "Structural QA over the whole file",
    about:
      "Identity, containment, placement, unit and naming checks run over the entity graph in this tab, with no generated code involved and nothing to download. Results land in the summary pane next to the model facts.",
    icon: "check-circle",
    category: "Quality",
    keywords: "validate checks qa integrity containment placement units",
    tier: "web",
    command: "file.check",
    does: [
      "No generated code, so nothing to review before it runs",
      "Covers identity, containment, placement, units and naming",
      "Severity counts feed straight into the model summary",
    ],
  },
  {
    id: "schedules",
    name: "Element Schedules",
    tagline: "Tabular exports with resolved property columns",
    about:
      "Builds a row per element of a class with property set columns resolved through type inheritance, which is the part a plain instance read gets wrong. On real models most elements inherit their properties from their type, so this is the difference between a usable schedule and an empty one.",
    icon: "list",
    category: "Data",
    keywords: "schedule table export pset inheritance type properties",
    tier: "web",
    command: "file.schedule",
    does: [
      "Property values resolved through the element type",
      "Any class, any set of property columns",
      "Click a row to select and frame the element",
      "CSV export of the whole table",
    ],
  },
  {
    id: "edits",
    name: "Model Edits",
    tagline: "Rename, set properties and delete, with a measured diff",
    about:
      "Typed edit operations over the model: rename, substring rename, write an existing property, delete. Each one runs on a disposable copy and comes back staged with a diff measured from the result rather than reported by whatever made the change. Nothing is applied until you approve it, and undo restores the previous checkpoint.",
    icon: "edit",
    category: "Automation",
    keywords: "edit rename property delete modify write change bulk",
    tier: "web",
    command: "edit.rename",
    does: [
      "Rename one element or a whole selection",
      "Write a property that already exists on the element",
      "Delete elements, behind a typed confirmation",
      "Every change staged with a measured diff, applied only on approval",
    ],
  },
  {
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
  },
  {
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
  },
  /* Planned for Local Studio, hidden from the catalog until they are built.
  {
    id: "cobie",
    name: "COBie Export",
    tagline: "Handover spreadsheets straight from the model",
    about:
      "Walks spaces, types, components and their attributes into the COBie worksheet set. It needs the type inheritance and classification resolution that only a full IfcOpenShell has, so it belongs to Local Studio.",
    icon: "table",
    category: "Data",
    keywords: "cobie handover fm facility management spreadsheet export xlsx",
    tier: "local",
    capability: "inspect",
    soon: true,
    does: [
      "Contact, Facility, Floor, Space, Zone, Type and Component sheets",
      "Attributes resolved through the element type",
      "One workbook per model",
    ],
  },
  {
    id: "batch",
    name: "Batch Processing",
    tagline: "Run one script across a folder of models",
    about:
      "Points a Python recipe at a whole directory and collects the results in one report. The browser can only hold one model at a time, so this is a Local Studio job by nature.",
    icon: "folder",
    category: "Automation",
    keywords: "batch folder bulk many models pipeline overnight script",
    tier: "local",
    capability: "python",
    soon: true,
    does: [
      "Same recipe against every IFC in a folder",
      "One combined report, one row per model",
      "Runs off the main thread, so the viewer stays usable",
    ],
  },
  {
    id: "patch",
    name: "IfcPatch Recipes",
    tagline: "Named, reviewable fixes for common model problems",
    about:
      "The IfcPatch recipe library covers the repairs that come up again and again: purging unused entities, resetting placements, merging projects, converting length units. Each run lands as a staged edit you approve.",
    icon: "sliders",
    category: "Geometry",
    keywords: "ifcpatch repair fix purge merge units placement migrate",
    tier: "local",
    capability: "python",
    soon: true,
    does: [
      "Pick a recipe, set its arguments, review the diff",
      "Nothing is applied without an explicit approval",
      "Undo through the same checkpoint stack as any edit",
    ],
  },
  {
    id: "drawings",
    name: "Drawing Export",
    tagline: "Plans and sections out to DXF or PDF",
    about:
      "Cuts the model at the section planes you set and writes real 2D geometry rather than a screenshot. Exact section curves need the geometry kernel, which lives in Local Studio.",
    icon: "section",
    category: "Geometry",
    keywords: "dxf pdf drawing plan section sheet export cad 2d",
    tier: "local",
    capability: "convert",
    soon: true,
    does: [
      "True section curves, not a raster",
      "One file per plane, or a set of sheets",
      "Layers follow the IFC classes",
    ],
  },
  */
];

export function findPlugin(id: string): PluginManifest | undefined {
  return CATALOG.find((p) => p.id === id);
}

/**
 * A web entry with nothing to mount is already a panel of this app, so it is
 * listed as a shortcut rather than as something to install. One home per
 * feature: the catalog points at it, it does not reimplement it.
 */
export const isBuiltIn = (plugin: PluginManifest): boolean => plugin.tier === "web" && !plugin.load;

/** Local plugins only work in Local Studio, and only if it offers the capability. */
export const isLive = (plugin: PluginManifest, service: ServiceClient): boolean =>
  plugin.tier === "web" ||
  (service.mode() === "local" && (!plugin.capability || service.can(plugin.capability)));

/** About paragraph and does-list, shared by the panel entry and the browser card. */
export function pluginDetails(plugin: PluginManifest): HTMLElement {
  return h("div", { class: "plug-inline" }, [
    h("p", { class: "plug-about", text: plugin.about }),
    h("ul", { class: "plug-does" }, plugin.does.map((line) => h("li", { text: line }))),
  ]);
}

export interface HostActions {
  showPanel(): void;
  setPanelVisible(visible: boolean): void;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  modelKey(): string;
  modelName(): string;
  python: PluginPython;
  /** Something opened or closed; repaint the status toggle. */
  changed(): void;
}

interface Running {
  manifest: PluginManifest;
  host: HTMLElement;
  instance: PluginInstance | null;
}

const OPEN_KEY = "ifcviewx.plugins.open";

/** Owns the inspector panel that every running web plugin lives in. */
export class PluginHost {
  private readonly strip: HTMLElement;
  private readonly body: HTMLElement;
  private readonly blank: HTMLElement;
  private readonly running = new Map<string, Running>();
  private readonly propertyIndex: PropertyIndex;
  private active = "";

  constructor(
    container: HTMLElement,
    private readonly viewer: Viewer,
    private readonly service: ServiceClient,
    private readonly actions: HostActions,
    private readonly browse: (id?: string) => void,
  ) {
    this.propertyIndex = new PropertyIndex(viewer, () => actions.modelKey());
    this.strip = h("div", { class: "plug-strip" });
    this.body = h("div", { class: "plug-body" });
    this.blank = h("div", { class: "page plug-page scroll" });
    container.append(this.strip, this.body, this.blank);
    this.buildCatalog();
    this.paint();
  }

  /**
   * The panel is the catalog when nothing is running. Local Studio entries stay
   * on the list, greyed: hiding them would teach nobody that they exist. What
   * the app already carries as its own panel is a row of shortcuts at the
   * bottom, so nothing here looks like a second copy of it.
   */
  private buildCatalog(): void {
    const browse = h("button", { class: "link-btn", type: "button", text: "Browse all" });
    browse.addEventListener("click", () => this.browse());
    const shortcuts = CATALOG.filter(isBuiltIn).map((plugin) => {
      const chip = h("button", { class: "chip", type: "button", title: plugin.tagline }, [
        icon(plugin.icon, 13),
        h("span", { text: plugin.name }),
      ]);
      chip.addEventListener("click", () => plugin.command && this.actions.runCommand(plugin.command));
      return chip;
    });
    this.blank.replaceChildren(
      h("div", { class: "group-title" }, [h("span", { text: "In this browser" }), browse]),
      ...CATALOG.filter((plugin) => plugin.tier === "web" && !isBuiltIn(plugin)).map((plugin) => this.entry(plugin)),
      h("div", { class: "tier-split" }, [
        h("span", { class: "tier-title", text: "Local Studio" }),
        h("span", { class: "tier-note", text: "These need the local service. Everything above runs in this tab." }),
      ]),
      ...CATALOG.filter((plugin) => plugin.tier === "local").map((plugin) => this.entry(plugin)),
      h("div", { class: "tier-split" }, [
        h("span", { class: "tier-title", text: "Already in this app" }),
        h("span", { class: "tier-note", text: "These have their own panel on the rail. The catalog points at them rather than repeating them." }),
      ]),
      h("div", { class: "chips" }, shortcuts),
    );
  }

  /** One click runs it; the info toggle explains it without leaving the list. */
  private entry(plugin: PluginManifest): HTMLElement {
    const live = isLive(plugin, this.service);
    const off = plugin.soon || !live;
    const row = h("button", {
      class: `plug-entry${off ? " off" : ""}`,
      type: "button",
      title: plugin.soon
        ? `${plugin.name}: planned for Local Studio`
        : live
          ? `Open ${plugin.name}`
          : `${plugin.name} needs Local Studio`,
    }, [
      h("span", { class: `plug-icon sm ${plugin.tier}` }, [icon(plugin.icon, 14)]),
      h("span", { class: "grow" }, [
        h("span", { class: "nm" }, [
          h("b", { text: plugin.name }),
          ...(plugin.soon ? [h("span", { class: "pill", text: "planned" })] : []),
        ]),
        h("span", { class: "sub", text: plugin.tagline }),
      ]),
    ]);
    row.addEventListener("click", () => this.launch(plugin, live));

    const details = pluginDetails(plugin);
    details.classList.add("hidden");
    const info = iconButton("info", `What ${plugin.name} does`, () => {
      const open = details.classList.toggle("hidden");
      info.setAttribute("aria-pressed", String(!open));
    }, "icon-btn sm");
    info.setAttribute("aria-pressed", "false");
    return h("div", { class: "plug-entry-wrap" }, [
      h("div", { class: "plug-entry-row" }, [row, info]),
      details,
    ]);
  }

  /** Every surface launches the same way: mount it, run it, or say what it needs. */
  private launch(plugin: PluginManifest, live: boolean): void {
    if (plugin.soon) return void toast(`${plugin.name} is not built yet`, "info");
    if (plugin.load) return void this.open(plugin.id);
    if (!live) return this.browse(plugin.id);
    if (plugin.command) this.actions.runCommand(plugin.command);
  }

  index(): PropertyIndex {
    return this.propertyIndex;
  }

  count(): number {
    return this.running.size;
  }

  isOpen(id: string): boolean {
    return this.running.has(id);
  }

  /** Reopen whatever was running when the tab was last closed. */
  restore(): void {
    let ids: string[] = [];
    try {
      ids = JSON.parse(localStorage.getItem(OPEN_KEY) ?? "[]") as string[];
    } catch {
      ids = [];
    }
    for (const id of ids) void this.open(id, false);
  }

  async open(id: string, reveal = true, payload?: unknown): Promise<void> {
    const manifest = findPlugin(id);
    if (!manifest?.load) return;
    if (this.running.has(id)) {
      this.select(id);
      if (reveal) this.actions.showPanel();
      this.running.get(id)?.instance?.receive?.(payload);
      return;
    }
    const host = h("div", { class: "plug-host" });
    const entry: Running = { manifest, host, instance: null };
    this.running.set(id, entry);
    this.body.appendChild(host);
    this.select(id);
    if (reveal) this.actions.showPanel();
    this.persist();
    try {
      const module = await manifest.load();
      if (!this.running.has(id)) return;
      entry.instance = module.mount(host, this.api(manifest), payload) ?? null;
    } catch (err) {
      host.replaceChildren(
        emptyState("alert", `${manifest.name} failed to start`, err instanceof Error ? err.message : String(err)),
      );
    }
  }

  close(id: string): void {
    const entry = this.running.get(id);
    if (!entry) return;
    try {
      entry.instance?.dispose?.();
    } catch {
      // a plugin that throws on the way out must not keep its panel alive
    }
    entry.host.remove();
    this.running.delete(id);
    if (this.active === id) this.active = [...this.running.keys()][0] ?? "";
    this.select(this.active);
    this.persist();
  }

  select(id: string): void {
    if (id && !this.running.has(id)) return;
    this.active = id;
    for (const [key, entry] of this.running) entry.host.classList.toggle("hidden", key !== id);
    this.paint();
  }

  /** Called after a load, an edit or an undo. */
  modelChanged(): void {
    this.propertyIndex.invalidate();
    for (const entry of this.running.values()) entry.instance?.modelChanged?.();
  }

  private persist(): void {
    localStorage.setItem(OPEN_KEY, JSON.stringify([...this.running.keys()]));
    this.actions.setPanelVisible(this.running.size > 0);
    this.actions.changed();
  }

  /** Repaint what the service can offer; called after every connection probe. */
  refresh(): void {
    if (this.running.size === 0) this.buildCatalog();
    for (const entry of this.running.values()) entry.instance?.serviceChanged?.();
  }

  private paint(): void {
    this.strip.replaceChildren();
    this.blank.classList.toggle("hidden", this.running.size > 0);
    this.strip.classList.toggle("hidden", this.running.size === 0);
    // An empty body still claims its share of the panel, which on a tall screen
    // pushes the catalog to the middle. Nothing running, nothing reserved.
    this.body.classList.toggle("hidden", this.running.size === 0);
    if (this.running.size === 0) this.buildCatalog();
    for (const [id, entry] of this.running) {
      const tab = h("button", {
        class: `plug-tab${id === this.active ? " active" : ""}`,
        type: "button",
        title: entry.manifest.tagline,
      }, [icon(entry.manifest.icon, 13), h("span", { text: entry.manifest.name })]);
      tab.addEventListener("click", () => this.select(id));
      const shut = iconButton("x", `Close ${entry.manifest.name}`, () => this.close(id), "icon-btn sm");
      this.strip.appendChild(h("span", { class: "plug-tab-wrap" }, [tab, shut]));
    }
    if (this.running.size > 0) {
      this.strip.append(
        h("span", { class: "grow" }),
        iconButton("blocks", "Browse plugins", () => this.browse(), "icon-btn sm"),
      );
    }
  }

  private api(manifest: PluginManifest): PluginApi {
    const scope = (key: string): string => `ifcviewx.plug.${manifest.id}.${key}`;
    return {
      viewer: this.viewer,
      service: this.service,
      python: this.actions.python,
      modelKey: () => this.actions.modelKey(),
      modelName: () => this.actions.modelName(),
      properties: (expressID) => this.viewer.getProperties(expressID),
      index: () => this.propertyIndex,
      log: (text, kind) => this.actions.log(text, kind),
      runCommand: (id) => this.actions.runCommand(id),
      read: <T,>(key: string, fallback: T): T => {
        try {
          const raw = localStorage.getItem(scope(key));
          return raw === null ? fallback : (JSON.parse(raw) as T);
        } catch {
          return fallback;
        }
      },
      write: (key, value) => {
        try {
          localStorage.setItem(scope(key), JSON.stringify(value));
        } catch {
          this.actions.log(`${manifest.name} could not save its state (storage is full)`, "error");
        }
      },
      close: () => this.close(manifest.id),
    };
  }
}
