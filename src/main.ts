// IFCViewX shell: wires the viewer, the local service (conversion + native
// IfcOpenShell), the browser Python fallback, and the assistant.
// App-level state lives here: active model bytes, checkpoints, and the
// pending-edit lifecycle. Edits only land on an explicit Apply.
import "./styles.css";
import { createViewer, type FederatedModel } from "./viewer-core/viewer.js";
import { isFormatBytes, listCachedModels, loadCachedSource, storeSourceBytes, type CachedModel } from "./viewer-core/engine/cache.js";
import type { LoadProgress } from "./viewer-core/engine/types.js";
import { PythonEngine, type ProposedEdit } from "./python/pythonEngine.js";
import { IfcEngine, type EditOp, type ValidationReport } from "./ifc/ifcEngine.js";
import { clashReport } from "./ifc/clash.js";
import { isCompleteStepAsync, isStep, sniffSchema, worthConvertingAsync } from "./ifc/format.js";
import { findProvider, isConfigured, isVerified, loadSettings, type ChatMessage } from "./llm/llmClient.js";
import { systemPrompt } from "./llm/prompts.js";
import { buildModelBrief, elementCounts, elementsByType, type SemanticActions } from "./llm/actions.js";
import type { ToolAvailability } from "./llm/tools.js";
import { createViewerCapabilityRegistry } from "./capabilities/viewer.js";
import { VIEWER_POLICY } from "./capabilities/policy.js";
import { AgentRuntime } from "./assistant/agentRuntime.js";
import { AssistantCapabilityAdapter } from "./assistant/capabilityAdapter.js";
import { buildViewerContext, modelRevision } from "./assistant/context.js";
import { ExtensionToolApprovals } from "./assistant/extensionTools.js";
import { browserProviderTransport, localProviderTransport } from "./assistant/providerTransport.js";
import type { AssistantTraceEvent, EvidenceReference, ViewImageAttachment } from "./assistant/types.js";
import { ViewTransactionManager } from "./assistant/viewTransactions.js";
import { AssistantPanel, type PendingEditView } from "./ui/sidePanel.js";
import { TypesPane } from "./ui/typesPane.js";
import { OrganizePane } from "./ui/organizePane.js";
import { FilterChip, FilterPanel, FilterStore } from "./ui/filters.js";
import { clearDocket, docketChip, publishDocket, ResultsDock, type DocketRow } from "./ui/resultsDock.js";
import { clearFindings } from "./ui/findings.js";
import { FieldMode } from "./ui/fieldMode.js";
import { PrivacyPanel } from "./ui/privacy.js";
import { DrivePanel } from "./ui/drivePanel.js";
import { buildPackage, carriesState, isPackageName, readPackage, PACKAGE_EXTENSION } from "./share/package.js";
import type { ComputedPane, ViewsPane } from "./ui/viewsPane.js";
import { ViewStore, type ViewDefinition } from "./views/definition.js";
import { ComputedStore, type ComputedProperty } from "./data/computed.js";
import type { BcfPanel } from "./ui/bcf.js";
import type { GeoContextPanel } from "./ui/geo.js";
import { Shell, emptyState, type PaneId, type TabId } from "./ui/shell.js";
import { Dock, readViewpoints, saveViewpoint as storeViewpoint, viewpointKey } from "./ui/dock.js";
import { Connection } from "./ui/connection.js";
import { CommandRegistry } from "./ui/commands.js";
import { Ribbon, type RibbonControl, type RibbonTab } from "./ui/ribbon.js";
import type { SchedulePanel } from "./ui/schedules.js";
import { buildMenu, busyRow, CommandPalette, confirmAction, copyText, h, icon, iconButton, lightDismiss, menuKeys, openLayer, promptForm, safeStorageGet, safeStorageSet, showContextMenu, toast, type MenuItem } from "./ui/kit.js";
import { ageLabel, clearChats, readChats, saveChat, type Conversation } from "./llm/chatStore.js";
import { sampleModel, SAMPLE_NAME } from "./ui/sample.js";
import { download, elementsOf } from "./sdk/data.js";
import { buildIndex } from "./llm/retrieval.js";
import { saveMesh, type MeshFormat } from "./export/mesh.js";
import type { ExtensionIssueInput, ExtensionIssueResult } from "./sdk/types.js";
import type { PythonRunner } from "./plugins/runtime/context.js";
import { PluginHost } from "./plugins/runtime/host.js";
import { PluginBrowser } from "./plugins/runtime/browser.js";
import { CATALOG, setInstalledExtensions } from "./plugins/registry.js";
import { InstalledExtensionManager, activeInstalledVersion } from "./extensions/installed/manager.js";
import { ServiceClient, type EditDiff } from "./bridge/serviceClient.js";
import { BridgeClient } from "./bridge/bridgeClient.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

// Startup is straight-line module code behind a full-screen splash. If any of
// it throws (no WebGL, a blocked worker), the splash would spin forever over a
// dead page, so the first thing registered is the way out of that.
let booted = false;
const bootFailed = (message: string): void => {
  if (booted) return;
  booted = true;
  document.getElementById("splash")?.remove();
  const card = document.querySelector("#dropzone .dz-card");
  if (!card) return;
  document.getElementById("btn-open-first")?.classList.add("hidden");
  card.querySelector(".dz-hint")?.classList.add("hidden");
  const note = document.createElement("p");
  note.className = "dz-fatal";
  note.setAttribute("role", "alert");
  note.textContent = `IFCViewX could not start: ${message || "unknown error"}`;
  card.appendChild(note);
  const actions = document.createElement("div");
  actions.className = "dz-fatal-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "btn primary";
  retry.textContent = /webgl|3d graphics|gpu context/i.test(message) ? "Retry 3D viewer" : "Retry";
  retry.addEventListener("click", () => window.location.reload());
  actions.appendChild(retry);
  card.appendChild(actions);
};
window.addEventListener("error", (e) => bootFailed(e.message));
window.addEventListener("unhandledrejection", (e) =>
  bootFailed(e.reason instanceof Error ? e.reason.message : String(e.reason)),
);

const dropzone = $("dropzone");
const fileInput = $<HTMLInputElement>("file-input");
const attachInput = $<HTMLInputElement>("attach-input");
const settingsDialog = $<HTMLDialogElement>("settings-dialog");
const helpDialog = $<HTMLDialogElement>("help-dialog");

/** showModal throws on a dialog that is already open, so ask first. */
const openDialog = (dialog: HTMLDialogElement): void => {
  if (!dialog.open) dialog.showModal();
};

// ---------------------------------------------------------------------------
// Settings
interface Settings {
  scale: number;
  adaptive: boolean;
  doubleSided: boolean;
  antialias: boolean;
  hud: boolean;
  /** Skip instanced parts below a couple of pixels on screen. */
  lod: boolean;
  /** Say when Local Studio's IfcOpenShell conversion would pay off. */
  offerConvert: boolean;
}
const SETTINGS_KEY = "ifcviewx.settings";
/** Screen size below which a repeated part is not worth a draw call. */
const LOD_PIXELS = 2;
const DEFAULTS: Settings = {
  scale: 1,
  adaptive: true,
  doubleSided: true,
  antialias: true,
  hud: false,
  lod: true,
  offerConvert: true,
};
let settings: Settings = DEFAULTS;
try {
  settings = { ...DEFAULTS, ...(JSON.parse(safeStorageGet(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
} catch {
  settings = DEFAULTS;
}
const persistSettings = (): void => {
  safeStorageSet(SETTINGS_KEY, JSON.stringify(settings));
};

// ---------------------------------------------------------------------------
// App state
interface PendingEdit extends ProposedEdit {
  source: "user" | "ai" | "mcp";
  diff?: EditDiff;
}
const MAX_CHECKPOINTS = 10;
/** Past this, browser Python is worth a warning before the first boot. */
const PY_BROWSER_WARN_BYTES = 100e6;

let activeBytes: Uint8Array | null = null;
/** An IDS document is loaded, so the assistant's `ids` action has a target. */
let idsLoaded = false;
window.addEventListener("ifcviewx:ids-loaded", () => {
  idsLoaded = true;
  refreshAssistantEngine();
});
let fileName = "";
let schemaName: string | null = null;
let checkpoints: Uint8Array[] = [];
let redoStack: Uint8Array[] = [];
let pendingEdit: PendingEdit | null = null;
let pythonSynced = false;
let summaryDirty = true;

const service = new ServiceClient();

// ---------------------------------------------------------------------------
// Shell + viewer
const shell = new Shell({
  toggleTheme: () => toggleTheme(),
  openSettings: () => showSettings(),
  openHelp: () => openDialog(helpDialog),
  openPalette: () => palette.toggle(),
  clearSelection: () => viewer.clearSelection(),
  tabShown: (tab) => mountTab(tab),
  setOutlinerPane: (pane) => showPane(pane),
});

const viewer = createViewer(shell.viewerHost, {
  wasmPath: `${import.meta.env.BASE_URL}wasm/`,
  wasmAbsolute: true,
  antialias: settings.antialias,
  panels: { tree: $("pane-tree"), properties: $("tab-properties") },
  // The shell draws the loading screen: it also covers the drop card, which
  // the viewer's own card cannot, and it reports conversions the same way.
  progressCard: false,
  worker: {
    factory: () =>
      new Worker(new URL("./viewer-core/engine/worker.entry.ts", import.meta.url), { type: "module" }),
  },
});
viewer.warmup();
viewer.setRenderScale(settings.scale);
viewer.setAdaptiveResolution(settings.adaptive);
viewer.setLodThreshold(settings.lod ? LOD_PIXELS : 0);
viewer.setDoubleSided(settings.doubleSided);
viewer.setPerfHud(settings.hud);
applyTheme();

const dock = new Dock(shell.viewerHost, viewer);
// The dock lists the federated models; picking a file to add is the app's job.
dock.onAddModel = () => attachInput.click();

// Filters own the visible set; the pill in the bottom-right corner is where
// the user sees what is applied and drops it, one filter or all at once.
const filters = new FilterStore(viewer);
new FilterChip(shell.viewerHost, filters);

// One dock for every producer of results. Panels keep their setup; the list,
// the grouping, the assignment and the BCF handoff are shared.
const results = new ResultsDock(shell.viewerHost, {
  isolate: (ids, label) => viewer.isolate(ids, label),
  select: (ids) => viewer.selectMany(ids, "replace"),
  frameAt: (point) => viewer.fitToPoint(point, 2),
  frame: (id) => viewer.fitToElement(id),
  showAll: () => viewer.showAll(),
  raiseIssue: (title, ids, detail, point) =>
    void raiseIssue(title, ids, { description: detail, point }).catch(reportError),
  log: (message, kind) => shell.log(message, kind),
});
shell.statusSlot.appendChild(docketChip(() => results.setOpen(true)));

// Roads and rail: the alignment, driven, with the file's own chainage.
const drive = new DrivePanel(shell.viewerHost, viewer, { log: (message, kind) => shell.log(message, kind) });

// Field mode: installed, touch-sized and working with the radio off. The
// worker is registered only for a built site; a cached shell in development
// would hide the change that was just made.
const field = new FieldMode((message, kind) => shell.log(message, kind));
field.register(import.meta.env.BASE_URL, import.meta.env.PROD);
shell.statusSlot.appendChild(field.chip());

// Web Studio or Local Studio: a badge in the top bar saying which app this is,
// and one dialog explaining the difference. There is nothing to connect.
const connection = new Connection(service, { refresh: () => probeService() });
shell.barSlot.appendChild(connection.chip);

booted = true;
const splash = document.getElementById("splash");
splash?.classList.add("done");
setTimeout(() => splash?.remove(), 240);

/** Whoever asked for the current run gets the runtime's progress lines. */
let pyStatus: (text: string) => void = (text) => shell.log(text);
const python = new PythonEngine({ onInitProgress: (step) => pyStatus(step) });

// The semantic engine: checks, schedules and typed edits over web-ifc, in a
// worker, with nothing to download. What used to be the Local Studio tier.
const ifc = new IfcEngine(`${import.meta.env.BASE_URL}wasm/`);

// ---------------------------------------------------------------------------
// Inspector panels are built the first time their tab is shown: startup does
// no work for panels nobody opened.
let assistantUi: AssistantPanel | null = null;
let scheduleUi: SchedulePanel | null = null;
let scheduleDialog: HTMLDialogElement | null = null;
let scheduleMount: HTMLElement | null = null;
let filterUi: FilterPanel | null = null;
let viewsUi: ViewsPane | null = null;
let computedUi: ComputedPane | null = null;
let bcfUi: BcfPanel | null = null;
let geoUi: GeoContextPanel | null = null;
let idsUi: unknown = null;
let assistantAgent: AgentRuntime | null = null;

function agent(): AgentRuntime {
  if (!assistantAgent) throw new Error("The assistant runtime is still starting");
  return assistantAgent;
}

function assistant(): AssistantPanel {
  if (!assistantUi) {
    assistantUi = new AssistantPanel($("tab-assistant"), {
      onSend: (text) => void agent().run(text),
      onNewChat: () => newChat(),
      onStop: () => agent().stop(),
      onSettingsChange: () => refreshAssistantEngine(),
      onRetry: () => retryChat(),
      onHistory: (anchor) => showChatHistory(anchor),
      onAttachmentChange: () => syncAttachment(),
      onViewAttachmentChange: () => syncAttachment(),
      onEvidence: (references, action) => openEvidence(references, action),
      onIssueProposal: (payload) => void acceptIssueProposal(payload),
      onDefinitionProposal: (payload) => void acceptDefinitionProposal(payload).catch(reportError),
      extensionTools: () => plugins.assistantToolContributions().map(({ owner, contribution }) => ({
        owner,
        id: contribution.id,
        capability: contribution.capability,
        enabled: extensionToolApprovals.isEnabled(owner, contribution.id),
      })),
      onExtensionToolChange: (owner, id, enabled) => extensionToolApprovals.set(owner, id, enabled),
      openConsole: (code) => void plugins.open("python", true, code),
      openLocal: () => connection.open(),
    });
    refreshAssistantEngine();
    assistantUi.setSuggestions(modelSuggestions());
    assistantUi.setUsage(null, tokenTotals);
    syncAttachment();
  }
  return assistantUi;
}

/** The assistant cannot answer as configured, and the fix is in this panel. */
function needsAssistantSetup(): boolean {
  return !service.proxiesLlm() && !isConfigured(loadSettings());
}

/**
 * Say up front who answers and what it may run. The browser answers with
 * viewer actions only; generated Python needs Local Studio, where the code
 * runs natively and under the service's own guard.
 */
function refreshAssistantEngine(): void {
  if (!assistantUi) return;
  const proxied = service.proxiesLlm();
  const llm = loadSettings();
  const ready = isVerified(llm);
  assistantUi.setProxy(proxied);
  // Nothing to talk to yet: the fields belong in the panel, not in a dialog
  // that opens itself over the app before the user has asked for anything.
  assistantUi.setNeedsSetup(needsAssistantSetup(), proxied || ready);
  if (proxied) {
    assistantUi.setEngine("Local Studio", "The local service holds the provider key");
  } else {
    const provider = findProvider(llm.provider);
    assistantUi.setEngine(
      isConfigured(llm) ? `${provider.label} · ${llm.model}` : "Not configured",
      ready
        ? "This model answered a live check; the key stays in this browser"
        : isConfigured(llm)
          ? "Not verified yet. Verify the model id in the assistant settings."
          : "Choose a provider and model in the assistant settings",
      ready,
    );
  }
  const editing = assistantUi.activeMode() === "edit";
  assistantUi.setTools(
    editing ? "Tools + edits" : "Tools only",
    editing
      ? "Reads, checks, schedules, IDS, clash and property edits, all in this tab. Generated Python is never run for it."
      : "Reads, checks, schedules, IDS and clash, all in this tab. Switch to Edit for property changes.",
  );
  assistantUi.setToolState(toolAvailability());
}

/** What the assistant can actually reach right now, for the settings list. */
function toolAvailability(): ToolAvailability {
  return {
    mode: assistantMode(),
    model: activeBytes !== null,
    ids: idsLoaded,
    localCaps: service.mode() === "local" ? (service.getHealth()?.capabilities ?? []) : null,
  };
}

function ensureScheduleWorkspace(): HTMLElement {
  if (scheduleDialog && scheduleMount) return scheduleMount;
  scheduleMount = h("div", { class: "plug-expanded-body schedule-workspace-body" });
  const close = iconButton("x", "Close element schedules", () => scheduleDialog?.close(), "icon-btn");
  scheduleDialog = h("dialog", {
    class: "plug-expanded schedule-workspace hidden",
    "aria-label": "Element schedules",
  }, [
    h("div", { class: "plug-expanded-card" }, [
      h("div", { class: "plug-expanded-head" }, [
        h("div", { class: "plug-expanded-title" }, [
          icon("table", 16),
          h("span", { class: "grow" }, [
            h("b", { text: "Element schedules" }),
            h("small", { text: "Opened from Plugins" }),
          ]),
        ]),
        h("span", { class: "grow" }),
        h("kbd", { class: "plug-expanded-key", text: "Esc" }),
        close,
      ]),
      scheduleMount,
    ]),
  ]) as HTMLDialogElement;
  lightDismiss(scheduleDialog);
  scheduleDialog.addEventListener("close", () => scheduleDialog?.classList.add("hidden"));
  document.body.appendChild(scheduleDialog);
  return scheduleMount;
}

/** Element schedules are an occasional Plugins workspace, loaded on demand. */
async function schedulePanel(): Promise<SchedulePanel> {
  if (!scheduleUi) {
    const { SchedulePanel } = await import("./ui/schedules.js");
    scheduleUi = new SchedulePanel(ensureScheduleWorkspace(), {
      types: () => Object.entries(elementCounts(viewer)).sort((a, b) => b[1] - a[1]).map(([name]) => name),
      run: (type, properties) => ifc.schedule(type, properties),
      select: (id) => {
        viewer.select(id);
        viewer.fitToElement(id);
      },
      // An imported sheet stages like any other edit: one approval for the
      // whole batch, and the pending bar is what applies it.
      stageEdits: async (ops) => {
        await proposeIfcEdits(ops, "user");
        shell.selectTab("properties");
      },
    });
  }
  return scheduleUi;
}

async function openScheduleWorkspace(): Promise<void> {
  await schedulePanel();
  if (scheduleDialog) {
    scheduleDialog.classList.remove("hidden");
    openDialog(scheduleDialog);
  }
}

function filterPanel(): FilterPanel {
  if (!filterUi) filterUi = new FilterPanel($("tab-filters"), viewer, filters);
  return filterUi;
}

/**
 * Saved views are built lazily like every other panel. Their store can still
 * be read by commands before the pane itself has opened.
 */
async function viewsPane(): Promise<ViewsPane> {
  if (!viewsUi) {
    const { ViewsPane } = await import("./ui/viewsPane.js");
    viewsUi = new ViewsPane($("tab-views"), viewer, plugins.index(), {
      colorRule: () => dock.getColorRule(),
      setColorRule: (rule) => dock.setColorRule(rule),
      selectors: () => filters.selectors(),
      log: (message, kind) => shell.log(message, kind),
      applied: (name) => setActiveViewName(name),
      raiseIssue: (title, ids) => void raiseIssue(title, ids).catch(reportError),
    });
  }
  return viewsUi;
}

async function computedPane(): Promise<ComputedPane> {
  if (!computedUi) {
    const { ComputedPane } = await import("./ui/viewsPane.js");
    computedUi = new ComputedPane($("tab-computed"), viewer, plugins.index(), {
      log: (message, kind) => shell.log(message, kind),
    });
  }
  return computedUi;
}

async function bcfPanel(): Promise<BcfPanel> {
  if (!bcfUi) {
    const { BcfPanel } = await import("./ui/bcf.js");
    bcfUi = new BcfPanel($("tab-bcf"), {
      viewer,
      modelName: () => fileName,
      log: (message, kind) => shell.log(message, kind),
      // A revision pulled from the CDE lands in the viewer, not in a folder.
      openDocument: async (name, bytes, intent) => {
        if (intent === "compare") {
          const added = await viewer.addModel(bytes, { name });
          shell.log(`Added ${name} from the CDE as model ${added.index + 1}`, "success", true);
          summaryDirty = true;
          updateModelChrome();
          void plugins.open("compare");
          return;
        }
        if (!(await loadBytes(bytes, name, false, { attempt: beginLoadAttempt() }))) return;
        void storeSourceBytes(bytes, name).then(renderRecents);
        shell.log(`Opened ${name} from the CDE`, "success", true);
      },
    });
  }
  return bcfUi;
}

/** An issue is always raised on a view, so the elements are isolated first. */
async function raiseIssue(
  title: string,
  ids: number[],
  input: Omit<ExtensionIssueInput, "title" | "elementIds"> = {},
): Promise<ExtensionIssueResult> {
  if (!activeBytes) {
    toast("Open a model first", "info");
    throw new Error("Open a model before creating an issue");
  }
  if (ids.length) {
    filters.add({ label: title, mode: "keep", ids });
    viewer.selectMany(ids, "replace");
    const box = viewer.boxAround(ids, 0.35);
    if (box) viewer.setSectionBox(box);
  }
  if (input.point) viewer.fitToPoint(input.point, 1.2);
  const panel = await bcfPanel();
  const metadata = Object.entries(input.metadata ?? {}).map(([key, value]) => `${key}: ${String(value)}`);
  const description = [
    input.description ?? (ids.length ? `${ids.length} elements do not meet this specification.` : ""),
    metadata.length ? metadata.join("\n") : "",
  ].filter(Boolean).join("\n\n");
  const issueId = panel.capture(title, description, { elementIds: ids, priority: input.priority, point: input.point });
  if (!issueId) throw new Error("The issue could not be created");
  shell.selectTab("bcf");
  return { id: issueId, title: title || "New issue", status: "Open", snapshot: "pending" };
}

/**
 * IDS lives in its own panel: open a file, validate, walk the failures. The
 * authoring studio stays a plugin, one click away, for the rarer job of
 * writing the requirements in the first place.
 */
async function idsPanel(): Promise<unknown> {
  if (!idsUi) {
    const { IdsPanel } = await import("./ui/ids.js");
    idsUi = new IdsPanel($("tab-ids"), {
      viewer,
      isolate: (label, ids) => {
        viewer.isolate(ids, label);
        shell.log(`Isolated ${ids.length} element(s) from ${label}`, "info", true);
      },
      report: (title, ids) => void raiseIssue(title, ids).catch(reportError),
      log: (message, kind) => shell.log(message, kind),
      changed: () => ribbon.sync(),
      openStudio: () => void plugins.open("ids-studio"),
    });
  }
  return idsUi;
}

async function geoPanel(): Promise<GeoContextPanel> {
  if (!geoUi) {
    const { GeoContextPanel } = await import("./ui/geo.js");
    geoUi = new GeoContextPanel($("tab-geo"), {
      viewer,
      log: (message, kind) => shell.log(message, kind),
      createIssue: async (input) => {
        await raiseIssue(input.title, [], {
          description: input.description,
          point: input.point,
          metadata: input.metadata,
        });
      },
    });
  }
  return geoUi;
}

/** A panel that fails to arrive is not mounted, so opening the tab retries. */
function mountLazy(tab: TabId, build: () => Promise<unknown>): void {
  const host = $(`tab-${tab}`);
  if (!host.childElementCount) host.appendChild(busyRow("Loading the panel"));
  void build()
    .then(() => host.querySelector(".busy-row")?.remove())
    .catch((err: unknown) => {
      host.replaceChildren(emptyState("alert", "This panel did not load", "Open the tab again to retry."));
      shell.unmount(tab);
      reportError(err);
    });
}

function mountTab(tab: TabId): void {
  if (tab === "assistant") assistant();
  else if (tab === "filters") filterPanel();
  else if (tab === "views") mountLazy(tab, viewsPane);
  else if (tab === "computed") mountLazy(tab, computedPane);
  else if (tab === "geo") mountLazy(tab, geoPanel);
  else if (tab === "ids") mountLazy(tab, idsPanel);
  else if (tab === "bcf") mountLazy(tab, bcfPanel);
}

/** The type list is built the first time it is shown, like the tabs above. */
let typesUi: TypesPane | null = null;

function types(): TypesPane {
  if (!typesUi) typesUi = new TypesPane($("pane-types"), viewer, isolateByType);
  return typesUi;
}

/** The organize pane follows the same lazy build as the type list. */
let organizeUi: OrganizePane | null = null;

function organize(): OrganizePane {
  if (!organizeUi) organizeUi = new OrganizePane($("pane-organize"), viewer);
  return organizeUi;
}

const paneVisible = (pane: PaneId): boolean => !$(`pane-${pane}`).classList.contains("hidden");

function showPane(pane: PaneId): void {
  shell.setOutlinerPane(pane);
  if (pane === "summary") renderSummary();
  else if (pane === "types") types().render();
  else if (pane === "organize") organize().render();
}

// ---------------------------------------------------------------------------
// Theme
function applyTheme(): void {
  const dark = document.documentElement.dataset.theme !== "light";
  shell.setTheme(dark);
  viewer.updateTheme();
}

function toggleTheme(): void {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = next;
  safeStorageSet("ifcviewx.theme", next);
  applyTheme();
}

// ---------------------------------------------------------------------------
// Model lifecycle
/**
 * One loading screen for anything the viewport waits on: opening a file,
 * replaying a cached model, fetching one from Local Studio, or a conversion.
 * It covers the drop card on a first open, because that card looks idle while
 * a 200 MB file is being parsed behind it. Once a model is on screen it
 * shrinks to a top card, so the work is reported without hiding the model.
 */
const loadingUi = (() => {
  const host = $("loading");
  const name = $("load-name");
  const detail = $("load-detail");
  const fill = $("load-fill");
  const cancel = $<HTMLButtonElement>("load-cancel");
  let onCancel: (() => void) | null = null;
  cancel.addEventListener("click", () => onCancel?.());

  /** Null means nothing to count yet, and the bar sweeps instead of sitting at zero. */
  const bar = (percent: number | null): void => {
    host.classList.toggle("waiting", percent === null);
    fill.style.width = percent === null ? "" : `${percent}%`;
  };

  return {
    show(title: string, cancelWith: (() => void) | null = null): void {
      onCancel = cancelWith;
      name.textContent = title;
      detail.textContent = "Preparing";
      bar(null);
      cancel.classList.toggle("hidden", cancelWith === null);
      host.classList.toggle("compact", activeBytes !== null);
      host.classList.remove("hidden");
    },
    /** A step with no number behind it: conversion, or a fetch about to start. */
    step(text: string): void {
      detail.textContent = text;
    },
    update(progress: LoadProgress): void {
      if (progress.phase === "downloading") {
        const read = ((progress.bytesLoaded ?? 0) / 1e6).toFixed(1);
        const total = progress.bytesTotal;
        bar(total ? Math.min(100, Math.round(((progress.bytesLoaded ?? 0) / total) * 100)) : null);
        detail.textContent = total ? `${read} of ${(total / 1e6).toFixed(1)} MB` : `${read} MB read`;
        return;
      }
      const percent =
        progress.totalEntities > 0
          ? Math.min(100, Math.round((progress.entities / progress.totalEntities) * 100))
          : null;
      bar(progress.phase === "parsing" ? null : percent);
      detail.textContent =
        progress.phase === "parsing"
          ? "Reading entities"
          : `${progress.meshes.toLocaleString()} meshes${percent === null ? "" : ` · ${percent}%`}`;
    },
    hide(): void {
      onCancel = null;
      host.classList.add("hidden");
    },
  };
})();

/** Cleared by anything that shows the card again, so a drag cannot be eaten. */
let dropzoneTimer = 0;

function hideDropzone(animate: boolean): void {
  dropzone.classList.remove("dragging");
  clearTimeout(dropzoneTimer);
  if (animate) {
    dropzone.classList.add("closing");
    dropzoneTimer = window.setTimeout(() => dropzone.classList.add("hidden"), 200);
  } else {
    dropzone.classList.add("hidden");
  }
}

/** Bring the drop card back, cancelling a fade that has not landed yet. */
function showDropzone(): void {
  clearTimeout(dropzoneTimer);
  dropzone.classList.remove("hidden", "closing");
}

/** Forget the model at the app level. The viewer is the caller's business. */
function dropModelState(): void {
  activeBytes = null;
  fileName = "";
  schemaName = null;
  checkpoints = [];
  redoStack = [];
  lastReport = null;
  summaryDirty = true;
  pythonSynced = false;
  streamedCategories.clear();
  ifc.setModel(null);
  if (pendingEdit) discardPending();
  service.forgetModel();
  assistantCapabilities.results.clear();
  clearDocket();
  clearFindings();
  void import("./ui/ids.js").then(({ clearLastIdsReport }) => clearLastIdsReport());
  activeAssistantResult = "";
  focusedAssistantRow = undefined;
  showDropzone();
}

/** A second open supersedes the first; only the newest one owns the chrome. */
let loadSeq = 0;
/** Preflight also yields for large STEP files, so it needs its own ordering. */
let loadAttemptSeq = 0;
const beginLoadAttempt = (): number => ++loadAttemptSeq;
interface LoadRequestOptions {
  adoptSha?: string;
  attempt?: number;
  /** Only applyPending may keep the proposal while its own reload runs. */
  preservePending?: boolean;
}

async function loadBytes(
  bytes: Uint8Array,
  name: string,
  preserveCamera = false,
  options: LoadRequestOptions = {},
): Promise<boolean> {
  // Claim the attempt before the asynchronous STEP scan. Keep this separate
  // from load ownership: an invalid later file must not orphan a valid load
  // that is already inside the viewer.
  const attempt = options.attempt ?? beginLoadAttempt();
  const step = isStep(bytes);
  if (!step && !isFormatBytes(bytes)) {
    throw new Error("This file is not an IFC STEP model or an IFCViewX .ifcx file.");
  }
  if (step) {
    const complete = await isCompleteStepAsync(bytes);
    if (attempt !== loadAttemptSeq) return false;
    if (!complete) {
      throw new Error("This IFC STEP file is incomplete (the closing STEP marker is missing).");
    }
  }
  if (attempt !== loadAttemptSeq) return false;
  const mine = ++loadSeq;
  const previousBytes = activeBytes;
  const previousName = fileName;
  const previousPose = previousBytes ? viewer.getCamera() : null;
  const pose = preserveCamera ? viewer.getCamera() : null;
  shell.setStatus("Loading", "busy");
  loadingUi.show(name, () => viewer.cancelLoad());
  // Taken before the parser runs: viewer.load hands these bytes to a worker,
  // and a transferred buffer would leave the semantic engine with nothing.
  const semanticCopy = step ? bytes.slice() : null;
  try {
    await viewer.load(bytes, { name, onProgress: (progress) => loadingUi.update(progress) });
  } catch (err) {
    // A newer viewer load owns the viewport and its progress UI. Its expected
    // cancellation of this one is not an error to surface or roll back.
    if (mine !== loadSeq) return false;
    if (previousBytes && previousName) {
      try {
        loadingUi.step(`Restoring ${previousName}`);
        await viewer.load(previousBytes, { name: previousName, onProgress: (progress) => loadingUi.update(progress) });
        if (mine === loadSeq) {
          if (previousPose) viewer.setCamera(previousPose);
          updateModelChrome();
        }
      } catch {
        if (mine === loadSeq) {
          dropModelState();
          viewer.unload({ keepError: true });
          updateModelChrome();
        }
      }
    } else {
      dropModelState();
      viewer.unload({ keepError: true });
      updateModelChrome();
    }
    if (mine !== loadSeq) return false;
    throw err;
  } finally {
    if (mine === loadSeq) loadingUi.hide();
  }
  if (mine !== loadSeq) return false;
  if (pose) viewer.setCamera(pose);
  if (pendingEdit && !options.preservePending) discardPending();
  activeBytes = bytes;
  fileName = name;
  schemaName = sniffSchema(bytes);
  if (checkingLoad !== null && checkingLoad !== mine) checking = false;
  pythonSynced = false;
  summaryDirty = true;
  lastReport = null;
  assistantCapabilities.results.clear();
  // Every docket row points at element ids from one model revision. Keeping
  // it after a load would let an old finding select an unrelated new element.
  clearDocket();
  clearFindings();
  void import("./ui/ids.js").then(({ clearLastIdsReport }) => {
    if (mine === loadSeq) clearLastIdsReport();
  });
  activeAssistantResult = "";
  focusedAssistantRow = undefined;
  // .ifcx is our converted container, not STEP, so the semantic engine gets
  // the original bytes or nothing: it must never answer from a previous model.
  ifc.setModel(semanticCopy);
  streamedCategories.clear();
  if (!preserveCamera) { checkpoints = []; redoStack = []; }
  hideDropzone(true);
  updateModelChrome();
  const primaryGeo = viewer.getModels()[0];
  if (primaryGeo) reportGeoStatus(primaryGeo);
  // The tool catalog is gated on a model being open, so it has to be told.
  refreshAssistantEngine();
  if (python.isReady()) void syncPython().catch(() => undefined);
  // The service must hold whatever the viewer is showing, including after an
  // edit or an undo, so the hand-over lives on the single load path. A model
  // the service already stores (CLI-opened) is adopted instead of re-uploaded.
  service.forgetModel();
  if (options.adoptSha) {
    service.adoptModel(options.adoptSha);
    plugins.refresh();
  } else {
    void handOverModel();
  }
  return true;
}

/** `ifcviewx model.ifc` stages the file and opens the viewer at ?open=<sha>. */
async function openFromParam(): Promise<void> {
  const params = new URLSearchParams(location.search);
  const sha = params.get("open");
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return;
  const attempt = beginLoadAttempt();
  const given = params.get("name") ?? "model.ifc";
  shell.setStatus("Loading", "busy");
  loadingUi.show(given);
  loadingUi.step("Reading it from Local Studio");
  try {
    const sourceFlag = params.get("source");
    // v0.1.3 and older CLI links had no source flag. Preserve their filename
    // convention while new links use an explicit byte-classified 1/0 value.
    const hasSource = sourceFlag === "1"
      || (sourceFlag === null && !given.toLowerCase().endsWith(".ifcx"));
    let res = await fetch(`${service.origin}/models/${sha}.ifcx`);
    if (attempt !== loadAttemptSeq) return;
    const gotIfcx = res.ok;
    if (!res.ok) res = await fetch(`${service.origin}/models/${sha}.ifc`);
    if (attempt !== loadAttemptSeq) return;
    if (!res.ok) throw new Error("Local Studio no longer holds that model. Open it from disk instead.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (attempt !== loadAttemptSeq) return;
    const name = gotIfcx && !given.toLowerCase().endsWith(".ifcx") ? given.replace(/\.[^.]*$/, ".ifcx") : given;
    // The .ifc source in the store backs native Python and checks; a bare
    // .ifcx has no source, so nothing is adopted and the tier stays browser.
    if (await loadBytes(bytes, name, false, {
      adoptSha: hasSource || !gotIfcx ? sha : undefined,
      attempt,
    })) {
      shell.log(`Opened ${given} from Local Studio`, "success");
    }
  } catch (err) {
    if (attempt === loadAttemptSeq) {
      updateModelChrome();
      reportError(err);
    }
  } finally {
    if (attempt === loadAttemptSeq) loadingUi.hide();
  }
}

function updateModelChrome(): void {
  const stats = viewer.getStats();
  shell.setProject(fileName, schemaName);
  shell.setStatus(activeBytes ? "Ready" : "No model", activeBytes ? "live" : "idle");
  shell.setCounts(stats?.totalEntities ?? null, stats?.triangleCount ?? null);
  syncTools();
}

/**
 * The generated sample. It is not stored in recents: it is not the user's file
 * and it costs nothing to make again.
 */
async function openSample(): Promise<void> {
  if (await loadBytes(sampleModel(), SAMPLE_NAME)) {
    shell.log("Opened the sample building. Open your own file any time.", "success");
  }
}

/**
 * Add a file beside the open model instead of replacing it. The semantic
 * engine, the edit staging and the Python bridge all address one model, so
 * they stay pointed at the first one; everything the viewer owns (geometry,
 * tree, selection, properties, filters) is federated.
 */
async function attachFile(file: File): Promise<void> {
  // Adding during a load would land in a viewer that is about to be cleared,
  // and "no model yet" would silently turn the add into a replace.
  if (viewer.isLoading()) {
    toast("Wait for the current load to finish", "info");
    return;
  }
  if (!hasModel()) return void openFile(file);
  const targetLoad = loadSeq;
  const targetBytes = activeBytes;
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (loadSeq !== targetLoad || activeBytes !== targetBytes) {
    toast("The open model changed while the attachment was being read. Add it again.", "info");
    return;
  }
  shell.setStatus("Loading", "busy");
  loadingUi.show(file.name, () => viewer.cancelLoad());
  try {
    const added = await viewer.addModel(bytes, {
      name: file.name,
      onProgress: (progress) => loadingUi.update(progress),
    });
    shell.log(`Added ${file.name} as model ${added.index + 1}`, "success");
    reportGeoStatus(added);
    summaryDirty = true;
    updateModelChrome();
  } finally {
    loadingUi.hide();
    updateModelChrome();
  }
}

async function openFile(file: File): Promise<void> {
  if (isPackageName(file.name)) return openSharePackage(file);
  const attempt = beginLoadAttempt();
  // A startup/cache read may own the pre-load overlay; this request supersedes it.
  loadingUi.hide();
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (attempt !== loadAttemptSeq) return;
  if (!(await loadBytes(bytes, file.name, false, { attempt }))) return;
  void storeSourceBytes(bytes, file.name).then(renderRecents);
  shell.log(`Opened ${file.name}`, "success");
  // web-ifc draws every file here, so a multi-minute IfcOpenShell conversion
  // never blocks a load: the log only says when one would pay off.
  if (settings.offerConvert) {
    const openedLoad = loadSeq;
    void worthConvertingAsync(bytes, file.name).then((worthIt) => {
      if (!worthIt || activeBytes !== bytes || loadSeq !== openedLoad) return;
      shell.log(
        canLocal("convert")
          ? "Large or brep-heavy model: Model ▸ Convert makes every reopen instant."
          : "Large or brep-heavy model: Local Studio converts it with IfcOpenShell for instant reopens.",
      );
    });
  }
}

/**
 * Give the service a copy so native Python, checks and conversion can run.
 * Single-flight: the probe and the model load both reach here, and uploading
 * a large model twice is pure waste.
 */
let handingOver: Promise<void> | null = null;
function handOverModel(): Promise<void> {
  // Chained, not coalesced: a handover already running was started for the
  // model that was open then, and answering a second request with it would
  // leave the service holding something the viewer is no longer showing.
  const bytes = activeBytes;
  const name = fileName;
  const run = async (): Promise<void> => {
    if (!bytes || bytes !== activeBytes || service.mode() !== "local" || !isStep(bytes)) return;
    if (service.hasModel()) return;
    try {
      await service.uploadModel(bytes, name);
      if (bytes !== activeBytes) return service.forgetModel();
      shell.log("Model handed to the local service");
    } catch (err) {
      shell.log(err instanceof Error ? err.message : String(err), "error");
    }
    plugins.refresh();
    refreshAssistantEngine();
  };
  handingOver = (handingOver ?? Promise.resolve()).catch(() => undefined).then(run);
  return handingOver;
}

function closeModel(): void {
  // Closing is itself the newest model decision. Pending reads/preflights must
  // not reopen it, and a cancelled viewer load must not restore its snapshot.
  beginLoadAttempt();
  loadSeq += 1;
  viewer.cancelLoad();
  loadingUi.hide();
  dropModelState();
  // The viewer holds the scene, the tree, the properties and every cache keyed
  // to the model, so closing has to reach it or the panels keep describing a
  // file the app has already forgotten.
  viewer.unload();
  void renderRecents();
  updateModelChrome();
  refreshAssistantEngine();
  shell.log("Model closed");
}

/** Closing throws away edits that only live in this tab, so it asks first. */
function closeOrConfirm(): void {
  const staged = pendingEdit !== null;
  if (!staged && checkpoints.length === 0 && redoStack.length === 0) return closeModel();
  confirmAction(
    "Close this model?",
    staged
      ? "The staged edit and the undo/redo history are dropped. Export first to keep them."
      : "The undo/redo history is dropped. Export first to keep the edits you applied.",
    "Close",
    closeModel,
  );
}

function replaceOrConfirm(run: () => void): void {
  const staged = pendingEdit !== null;
  if (!staged && checkpoints.length === 0 && redoStack.length === 0) return run();
  confirmAction(
    "Open another model?",
    staged
      ? "The staged edit and undo/redo history belong to this model. Export first to keep applied edits."
      : "The undo/redo history belongs to this model. Export first to keep applied edits.",
    "Open model",
    run,
  );
}

// The stacks move only once the reload has landed: a load that fails or is
// cancelled would otherwise take a checkpoint with it and leave nothing shown.
async function undo(): Promise<void> {
  const previous = checkpoints[checkpoints.length - 1];
  const current = activeBytes;
  if (!previous || !current) return;
  if (!(await loadBytes(previous, fileName, true))) return;
  checkpoints.pop();
  redoStack.push(current);
  shell.log("Reverted to previous checkpoint", "info", true);
}

async function redo(): Promise<void> {
  const next = redoStack[redoStack.length - 1];
  const current = activeBytes;
  if (!next || !current) return;
  if (!(await loadBytes(next, fileName, true))) return;
  redoStack.pop();
  checkpoints.push(current);
  shell.log("Redid the edit", "info", true);
}

/**
 * Handover as one file: the model, the views authored on it, the properties
 * those views read, the drawings they were checked against and the issues
 * raised. Everything in it is readable without this application.
 */
async function exportSharePackage(): Promise<void> {
  if (!activeBytes) return void toast("Open a model first", "info");
  shell.setStatus("Building the share package", "busy");
  try {
    const { sheetStore } = await import("./sheets/sheet.js");
    const state: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key || !carriesState(key)) continue;
      const value = localStorage.getItem(key);
      if (value !== null) state[key] = value;
    }
    const preview = await viewer.captureImage(900, "image/png").catch(() => null);
    const bytes = await buildPackage({
      project: fileName || "model",
      app: `IFCViewX ${__APP_VERSION__}`,
      model: { name: fileName || "model.ifc", bytes: activeBytes },
      views: new ViewStore().list(),
      properties: new ComputedStore().list(),
      sheets: await sheetStore.all(),
      state,
      preview: preview ? new Uint8Array(await preview.arrayBuffer()) : null,
    });
    download(`${(fileName || "model").replace(/\.[^.]+$/, "")}${PACKAGE_EXTENSION}`, bytes as BlobPart, "application/zip");
    shell.log(`Share package written: ${(bytes.length / 1e6).toFixed(1)} MB`, "success", true);
  } finally {
    shell.setStatus(activeBytes ? "Ready" : "No model");
  }
}

/** Restore a package only after its model has loaded successfully. */
async function openSharePackage(file: File): Promise<void> {
  const contents = readPackage(new Uint8Array(await file.arrayBuffer()));
  const { sheetStore } = await import("./sheets/sheet.js");
  if (contents.model) {
    const loaded = await loadBytes(contents.model.bytes, contents.model.name, false, { attempt: beginLoadAttempt() });
    if (!loaded) throw new Error("The packaged model load was cancelled; no package state was restored.");
    void storeSourceBytes(contents.model.bytes, contents.model.name).then(renderRecents);
  }
  for (const [key, value] of Object.entries(contents.state)) {
    if (!carriesState(key)) continue;
    try {
      localStorage.setItem(key, value);
    } catch {
      shell.log(`No room left to restore ${key}`, "error");
    }
  }
  if (contents.views.length) {
    new ViewStore().merge(contents.views);
  }
  if (contents.properties.length) {
    new ComputedStore().merge(contents.properties);
  }
  for (const sheet of contents.sheets) {
    await sheetStore.put({ ...sheet.record, image: new Blob([sheet.image as BlobPart], { type: "image/png" }) });
  }
  viewsUi?.refresh();
  computedUi?.refresh();
  shell.log(
    `Opened package: ${contents.views.length} view(s), ${contents.properties.length} propert(ies), ${contents.sheets.length} sheet(s)`,
    "success",
    true,
  );
}

function exportModel(): void {
  if (!activeBytes) return;
  download(fileName || "model.ifc", activeBytes as BlobPart, "application/x-step");
  shell.log(`Exported ${fileName}`, "success", true);
}

/** The plan sheet, whether or not the inset is currently showing. */
async function savePlanImage(): Promise<void> {
  const saved = await viewer.downloadPlan(fileName).catch(reportError);
  if (saved) shell.log("Plan saved as PNG", "success", true);
  else if (saved === false) toast("No plan to save yet", "info");
}

/**
 * Mesh export. The format and the scope are one question, so they are one
 * prompt; the exporters themselves only load once a format is chosen.
 */
function exportMeshFile(): void {
  const selected = viewer.getSelectedIds().length;
  promptForm(
    "Export mesh",
    [
      { key: "format", label: "Format", value: "glb", options: ["glb", "gltf", "stl", "obj"] },
      {
        key: "scope",
        label: "Scope",
        value: selected ? "selection" : "visible",
        options: selected ? ["selection", "visible"] : ["visible"],
      },
    ],
    "Export",
    (values) => {
      const format = values.format as MeshFormat;
      const scope = values.scope === "selection" ? { selectedOnly: true } : { visibleOnly: true };
      shell.log(`Exporting ${format.toUpperCase()}...`);
      void saveMesh(viewer, format, scope)
        .then((result) => {
          shell.log(
            `Exported ${result.elements} element(s), ${result.triangles.toLocaleString()} triangles` +
              (result.truncated ? " (truncated at the size cap)" : ""),
            result.truncated ? "info" : "success",
            true,
          );
        })
        .catch(reportError);
    },
  );
}

/** The name of the last saved view applied, shown until something clears it. */
let activeViewName = "";

function setActiveViewName(name: string): void {
  activeViewName = name;
  syncViewState();
}

/**
 * The view-state bar. Everything currently modifying what is on screen, each
 * chip clearing exactly its own modifier: the permanent answer to "why can't
 * I see anything?".
 */
function syncViewState(): void {
  if (!viewer.getStats()) return shell.setViewState([]);
  const entries: Array<{ label: string; detail?: string; icon?: string; clear?: () => void }> = [];
  if (activeViewName) {
    entries.push({
      label: activeViewName,
      detail: "saved view applied",
      icon: "bookmark",
      clear: () => {
        activeViewName = "";
        syncViewState();
      },
    });
  }
  const rules = filters.list();
  if (rules.length) {
    entries.push({
      label: `${rules.length} filter${rules.length === 1 ? "" : "s"}`,
      detail: rules.map((rule) => `${rule.mode === "hide" ? "hides" : "shows"} ${rule.label}`).join(", "),
      icon: "funnel",
      clear: () => viewer.clearRules(),
    });
  }
  const hidden = viewer.getHiddenCount();
  if (hidden > 0) {
    entries.push({
      label: `${hidden.toLocaleString()} hidden`,
      detail: "hidden one at a time",
      icon: "eye-off",
      clear: () => viewer.setHidden(viewer.getHiddenIds(), false),
    });
  }
  const sections = viewer.getSections();
  if (sections.length) {
    entries.push({
      label: "Section",
      detail: sections.map((section) => (section.axis ? section.axis.toUpperCase() : section.name)).join(", "),
      icon: "section",
      clear: () => viewer.clearSection(),
    });
  }
  if (viewer.getSectionBox()) {
    entries.push({ label: "Box", detail: "six section planes", icon: "cube", clear: () => viewer.setSectionBox(null) });
  }
  const color = dock.getColorRule();
  if (color.kind !== "none") {
    entries.push({
      label: color.kind === "property" ? color.key : `Colour: ${color.kind}`,
      detail: "colour override",
      icon: "sparkle",
      clear: () => void dock.setColorRule(null).catch(reportError),
    });
  }
  const xray = viewer.getXrayCount();
  if (xray > 0) {
    entries.push({
      label: `${xray.toLocaleString()} see-through`,
      detail: "transparency override",
      icon: "eye",
      clear: () => {
        viewer.clearXray();
        ribbon.sync();
      },
    });
  }
  if (viewer.hasElementOffsets()) {
    entries.push({
      label: "Offsets",
      detail: "storey slide, explode or moved elements",
      icon: "layers",
      clear: () => viewer.clearElementOffsets(),
    });
  }
  const measures = viewer.getMeasureCount();
  if (measures > 0) {
    entries.push({
      label: `${measures.toLocaleString()} measured`,
      detail: "placed measurements",
      icon: "ruler",
      clear: () => viewer.resetMeasure(),
    });
  }
  shell.setViewState(entries);
}

/**
 * Enter or leave an immersive session. Raised from a command, which is a real
 * user gesture; every browser refuses a session started any other way.
 */
async function enterXr(mode: "immersive-vr" | "immersive-ar"): Promise<void> {
  if (viewer.xrMode() === mode) {
    await viewer.exitXr();
    return;
  }
  if (!(await viewer.xrSupported(mode))) {
    toast(
      mode === "immersive-vr"
        ? "No VR headset is available to this browser"
        : "This device cannot place the model in the room",
      "info",
    );
    return;
  }
  try {
    await viewer.startXr(mode);
    shell.log(mode === "immersive-vr" ? "VR session started" : "AR session started", "success");
  } catch (error) {
    reportError(error);
  }
}

function frameSelection(): void {
  const id = viewer.getSelection();
  if (id !== null) viewer.fitToElement(id);
  else viewer.fitToModel();
}

/** Mirror viewer-owned tool state (Esc and the dock can both change it). */
function syncTools(): void {
  dock.sync();
  ribbon.sync();
  // The measure card carries its own instructions, so the status bar stays out
  // of it; only transient guidance belongs here.
  shell.setHint("");
}

function toggleMeasure(): void {
  viewer.toggleMeasure();
  syncTools();
}

function reportGeoStatus(model: FederatedModel): void {
  if (model.geoStatus === "aligned") {
    shell.log(`Geo Context: automatically aligned ${model.name} to the federation CRS`, "success");
    return;
  }
  if (model.geoStatus !== "missing" && model.geoStatus !== "conflict") return;
  const label = model.geoStatus === "conflict" ? "conflicts with the federation CRS" : "has incomplete CRS information";
  shell.log(`Geo Context: ${model.name} ${label}. Open Geo Context for diagnostics.`, "info", true);
  toast(`${model.name} ${label}`, "info");
}

function openSmartMeasure(): void {
  viewer.setMeasuring(false);
  void plugins.open("smart-measure");
}

// The rail, the ribbon and Esc can all start or stop measuring, so the mode is
// mirrored from the viewer. Only the mode: the measurement itself changes on
// every hover frame, and repainting the ribbon that often would be wasteful.
let wasMeasuring = false;
viewer.onMeasureChange(() => {
  if (viewer.isMeasuring() === wasMeasuring) return;
  wasMeasuring = viewer.isMeasuring();
  syncTools();
});

/**
 * The box starts around the selection when there is one, because that is what
 * it is nearly always wanted for, and around the whole model otherwise so the
 * sliders in the section popover have somewhere to start.
 */
function toggleSectionBox(): void {
  if (viewer.getSectionBox()) {
    viewer.setSectionBox(null);
  } else {
    const selected = viewer.getSelectedIds();
    const box = (selected.length ? viewer.boxAround(selected) : null) ?? viewer.getModelBox();
    viewer.setSectionBox(box);
    shell.log(
      selected.length
        ? `Section box around ${selected.length} selected element(s). Section tool has the sliders.`
        : "Section box on. Drag the sliders in the Section tool to close it in.",
    );
  }
  syncTools();
}

function sectionBoxAroundSelection(): void {
  const selected = viewer.getSelectedIds();
  const box = viewer.boxAround(selected, 0.08);
  if (!box) return void toast("Select one or more elements first", "info");
  viewer.setSectionBox(box);
  shell.log(`Section box fitted to ${selected.length} selected element(s).`);
  syncTools();
}

function toggleSection(): void {
  if (viewer.getSections().length) {
    viewer.clearSection();
  } else {
    viewer.setSection({ axis: "y", offset: midOf(1), flip: false });
    shell.log("Section plane on. The 2D plan follows the cut; the viewport tools slice X, Y and Z.");
  }
  syncTools();
}

// The plan inset follows the section: cutting the model is what makes the
// top-down view a floorplan, so it appears with the first plane and leaves
// with the last. The explicit 2D plan button still overrides in between.
let hadSections = false;
viewer.onSectionChange(() => {
  const has = viewer.getSections().length > 0;
  if (has !== hadSections) {
    hadSections = has;
    if (viewer.isPlanView() !== has) viewer.setPlanView(has);
  }
  // Sections move from plugins, the assistant and the MCP bridge as well as
  // from the toolbar, so the pressed states are refreshed on every change
  // rather than only when the plan inset flips.
  syncTools();
});

const midOf = (axis: number): number => {
  const bounds = viewer.getSceneInfo().bounds;
  return (bounds.min[axis] + bounds.max[axis]) / 2;
};

/** The plan is a cut seen from above, so it needs a horizontal plane. */
function togglePlan(): void {
  const on = !viewer.isPlanView();
  if (on && !viewer.getSections().some((section) => section.axis === "y")) {
    viewer.setSections([...viewer.getSections(), { axis: "y", offset: midOf(1), flip: false }]);
  }
  viewer.setPlanView(on);
  syncTools();
}

function saveViewpoint(): void {
  const name = storeViewpoint(viewer);
  if (name) shell.log(`Saved ${name}`, "success", true);
  else toast("The browser could not save this viewpoint", "error");
}

function setHud(on: boolean): void {
  settings.hud = on;
  setHudInput.checked = on;
  viewer.setPerfHud(on);
  persistSettings();
  ribbon.sync();
}

/** Lazy categories already streamed for the model on screen. */
const streamedCategories = new Set<string>();

async function setCategory(category: "IfcSpace" | "IfcOpeningElement"): Promise<void> {
  const on = !viewer.isCategoryVisible(category);
  // The first time on, this geometry is parsed and streamed in, which on a
  // large model is a wait the button gives no sign of by itself. Later
  // toggles are instant and must not flash a card.
  const streaming = on && !streamedCategories.has(category);
  if (streaming) loadingUi.show(`Loading ${category.replace(/^Ifc/, "")} geometry`);
  try {
    await viewer.setCategoryVisible(category, on);
    if (on) streamedCategories.add(category);
  } finally {
    if (streaming) loadingUi.hide();
    ribbon.sync();
  }
}

// ---------------------------------------------------------------------------
// Python: native through the service when present, Pyodide otherwise
function useService(): boolean {
  return service.isAvailable() && service.can("python") && service.hasModel();
}

async function syncPython(): Promise<void> {
  if (!activeBytes) throw new Error("Load an IFC file first.");
  if (useService()) return;
  if (!pythonSynced || !python.isReady()) {
    // Pyodide is wasm32, so the runtime, the parsed model and an edit's copy
    // all share one 4 GB address space. Say so before the wait rather than
    // after the 120 s timeout a large file produces.
    if (activeBytes.length > PY_BROWSER_WARN_BYTES) {
      shell.log(
        `${(activeBytes.length / 1e6).toFixed(0)} MB is large for browser Python: an edit may hit the 4 GB wasm ceiling. Local Studio runs it natively.`,
        "error",
      );
    }
    pyStatus("Starting the browser Python runtime (first run downloads it)");
    await python.setModel(activeBytes, fileName);
    pythonSynced = true;
  }
}

async function runQuery(code: string): Promise<string> {
  if (useService()) {
    const outcome = await service.runPython(code, "query");
    if (outcome.error) throw new Error(outcome.violations?.join("; ") ?? outcome.message ?? outcome.error);
    return [outcome.stdout, outcome.resultJson].filter(Boolean).join("\n") || "(no output)";
  }
  await syncPython();
  const result = await python.runQuery(code);
  return [result.stdout, result.resultJson ?? ""].filter(Boolean).join("\n") || "(no output)";
}

/** Execute on a copy and stage the result. The report is what callers show. */
async function proposeEdit(code: string, source: "user" | "ai"): Promise<string> {
  if (useService()) {
    const outcome = await service.runPython(code, "edit");
    if (outcome.error || !outcome.resultUrl) {
      throw new Error(outcome.violations?.join("; ") ?? outcome.message ?? "The edit failed.");
    }
    const edit: ProposedEdit = {
      bytes: await service.fetchEditResult(outcome.resultUrl),
      stdout: outcome.stdout ?? "",
      summary: outcome.summary ?? "",
      affectedGuids: outcome.affectedGuids ?? [],
      entityCountBefore: outcome.entityCountBefore ?? 0,
      entityCountAfter: outcome.entityCountAfter ?? 0,
    };
    presentProposal({ ...edit, source, diff: outcome.diff });
    return proposalReport(edit, outcome.diff);
  }
  await syncPython();
  const edit = await python.proposeEdit(code);
  presentProposal({ ...edit, source });
  return proposalReport(edit);
}

/** Route the runtime's progress lines to whoever asked for this run. */
async function withPyStatus<T>(onStatus: ((text: string) => void) | undefined, run: () => Promise<T>): Promise<T> {
  const previous = pyStatus;
  const mine = onStatus ?? previous;
  pyStatus = mine;
  try {
    return await run();
  } finally {
    // Overlapping runs would restore each other's callback out of order and
    // leave a closed panel's one installed, so only the current owner resets.
    if (pyStatus === mine) pyStatus = previous;
  }
}

// ---------------------------------------------------------------------------
// Typed edits: no generated code, no runtime download. Every op runs on a
// disposable copy in the semantic worker and lands in the pending bar.
async function proposeIfcEdit(op: EditOp, source: "user" | "ai" | "mcp"): Promise<string> {
  return proposeIfcEdits([op], source);
}

/**
 * Stage a batch as one approval. A spreadsheet re-import is many operations,
 * and staging them one at a time would leave only the last one pending.
 */
async function proposeIfcEdits(ops: EditOp[], source: "user" | "ai" | "mcp"): Promise<string> {
  if (!activeBytes) throw new Error("Open a model first.");
  if (ops.length === 0 || ops.every((op) => op.ids.length === 0)) {
    throw new Error("No elements selected for this edit.");
  }
  const edit = await ifc.proposeBatch(ops);
  // A partial batch is a result, not a crash: say which elements refused and
  // why, so the pending bar's counts are never a mystery.
  for (const failure of edit.failures) shell.log(`Edit skipped ${failure}`, "error");
  presentProposal({
    bytes: edit.bytes,
    stdout: "",
    summary: edit.summary,
    affectedGuids: edit.affectedGuids,
    entityCountBefore: edit.entityCountBefore,
    entityCountAfter: edit.entityCountAfter,
    source,
    diff: edit.diff,
  });
  return editReport(edit);
}

function editReport(edit: {
  summary: string;
  affectedGuids: string[];
  diff: EditDiff;
  failures: string[];
}): string {
  return [
    `summary: ${edit.summary}`,
    `measured_diff: +${edit.diff.added} added, ~${edit.diff.modified} modified, -${edit.diff.removed} removed`,
    `affected_guids: ${edit.affectedGuids.slice(0, 20).join(", ") || "(none)"}`,
    edit.failures.length ? `failed:\n- ${edit.failures.slice(0, 10).join("\n- ")}` : "",
    "status: pending user approval (Apply/Discard)",
  ]
    .filter(Boolean)
    .join("\n");
}

/** An IFC attribute holds one value, so an object or array is a mistake. */
function scalar(value: unknown): string | number | boolean {
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  throw new Error("value must be a string, a number or a boolean");
}

/** Parse one ```edit block into a typed op, rejecting anything unknown. */
function parseEditOp(raw: string): EditOp {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error("an edit block must be a single valid JSON object");
  }
  const ids = Array.isArray(value.ids) ? value.ids.map(Number).filter(Number.isFinite) : [];
  if (ids.length === 0) throw new Error("ids is required; run a viewer find first");
  const op = String(value.op ?? "");
  if (op === "setAttribute") {
    return { op, ids, attribute: String(value.attribute ?? ""), value: scalar(value.value) };
  }
  if (op === "renameByPattern") {
    const find = String(value.find ?? "");
    // An empty separator splices the replacement between every character.
    if (!find) throw new Error('renameByPattern needs a non-empty "find"');
    return { op, ids, find, replace: String(value.replace ?? "") };
  }
  if (op === "setProperty") {
    return {
      op,
      ids,
      set: String(value.set ?? ""),
      property: String(value.property ?? ""),
      value: scalar(value.value),
    };
  }
  if (op === "deleteElements") return { op, ids };
  throw new Error(`unknown edit op "${op}"`);
}

/** Every direct edit acts on what is selected, so the target is never implied. */
function selectionOrWarn(): number[] {
  const ids = viewer.getSelectedIds();
  if (ids.length === 0) toast("Select an element first", "info");
  return ids;
}

function renameSelection(): void {
  const ids = selectionOrWarn();
  if (!ids.length) return;
  const first = viewer.getSelection();
  void viewer.getProperties(first ?? ids[0]).then((props) => {
    const current = String(props?.attributes.find((a) => a.name === "Name")?.value ?? "");
    promptForm(
      ids.length === 1 ? "Rename element" : `Rename ${ids.length} elements`,
      [{ key: "name", label: "Name", value: current, placeholder: "New name" }],
      "Stage edit",
      (values) => {
        if (!values.name) return void toast("A name is required", "info");
        void proposeIfcEdit({ op: "setAttribute", ids, attribute: "Name", value: values.name }, "user")
          .catch(reportError);
      },
    );
  });
}

function setPropertyOnSelection(): void {
  const ids = selectionOrWarn();
  if (!ids.length) return;
  promptForm(
    `Set a property on ${ids.length} element${ids.length === 1 ? "" : "s"}`,
    [
      { key: "set", label: "Property set", placeholder: "Pset_WallCommon" },
      { key: "property", label: "Property", placeholder: "IsExternal" },
      { key: "value", label: "Value", placeholder: "true", hint: "The property must already exist on the element." },
    ],
    "Stage edit",
    (values) => {
      if (!values.set || !values.property) {
        return void toast("Name the property set and the property", "info");
      }
      const raw = values.value;
      const parsed = raw === "true" ? true : raw === "false" ? false : Number(raw);
      void proposeIfcEdit(
        {
          op: "setProperty",
          ids,
          set: values.set,
          property: values.property,
          value: raw !== "" && !Number.isNaN(parsed) ? parsed : raw,
        },
        "user",
      ).catch(reportError);
    },
  );
}

function deleteSelection(): void {
  const ids = selectionOrWarn();
  if (!ids.length) return;
  promptForm(
    `Delete ${ids.length} element${ids.length === 1 ? "" : "s"}?`,
    [{ key: "confirm", label: "Type delete to confirm", placeholder: "delete" }],
    "Stage deletion",
    (values) => {
      if (values.confirm.toLowerCase() !== "delete") return toast("Deletion cancelled", "info");
      void proposeIfcEdit({ op: "deleteElements", ids }, "user").catch(reportError);
    },
  );
}

/** The guarded pipeline, as handed to plugins. The console is one of them. */
const pythonFacet: PythonRunner = {
  runsNatively: () => service.runsNatively(),
  query: (code, onStatus) => withPyStatus(onStatus, () => runQuery(code)),
  propose: (code, onStatus) => withPyStatus(onStatus, () => proposeEdit(code, "user")),
};

const ORIGIN_LABEL = { ai: "the assistant", user: "a direct edit", mcp: "an MCP client" };

/**
 * One pending edit, one place to approve it. It lives in app chrome rather
 * than inside a panel, so closing the console or switching tabs never hides
 * a change that is waiting on the user.
 */
const pendingBar = (() => {
  const host = $("pending-bar");
  const summary = h("span", { class: "summary" });
  const detail = h("span", { class: "detail" });
  const apply = h("button", { class: "btn accent sm", type: "button", text: "Apply edit" });
  const discard = h("button", { class: "btn sm", type: "button", text: "Discard" });
  apply.addEventListener("click", () => void applyPending().catch(reportError));
  discard.addEventListener("click", () => discardPending());
  host.append(icon("terminal", 13), summary, detail, h("span", { class: "grow" }), apply, discard);
  return {
    set(view: PendingEditView | null): void {
      host.classList.toggle("hidden", view === null);
      if (!view) return;
      summary.textContent = view.summary;
      detail.textContent = view.detail;
    },
  };
})();

function presentProposal(edit: PendingEdit): void {
  pendingEdit = edit;
  // The service measures the diff; the browser tier can only report counts.
  const parts = edit.diff
    ? [`${edit.diff.added} added`, `${edit.diff.modified} modified`, `${edit.diff.removed} removed`]
    : [`${edit.affectedGuids.length} element(s)`];
  const delta = edit.entityCountAfter - edit.entityCountBefore;
  if (delta !== 0) parts.push(`${delta > 0 ? "+" : ""}${delta} entities`);
  pendingBar.set({
    summary: edit.summary || "Python edit completed",
    detail: `${parts.join(" · ")} · from ${ORIGIN_LABEL[edit.source]}`,
  });
  ribbon.sync();
}

function proposalReport(edit: ProposedEdit, diff?: EditDiff): string {
  return [
    `summary: ${edit.summary || "(none)"}`,
    `entities: ${edit.entityCountBefore} -> ${edit.entityCountAfter}`,
    diff ? `measured_diff: +${diff.added} added, ~${diff.modified} modified, -${diff.removed} removed` : "",
    `affected_guids: ${edit.affectedGuids.join(", ") || "(none)"}`,
    edit.stdout ? `stdout:\n${edit.stdout}` : "",
    "status: pending user approval (Apply/Discard)",
  ]
    .filter(Boolean)
    .join("\n");
}

async function applyPending(): Promise<void> {
  if (!pendingEdit || !activeBytes) return;
  const edit = pendingEdit;
  const previous = activeBytes;
  // Staged until the reload lands: a failed apply that had already cleared the
  // bar would lose the edit and leave a checkpoint that changed nothing.
  const applied = await loadBytes(edit.bytes, fileName, true, { preservePending: true });
  if (!applied) return;
  pendingEdit = null;
  pendingBar.set(null);
  checkpoints.push(previous);
  redoStack = [];
  if (checkpoints.length > MAX_CHECKPOINTS) checkpoints.shift();
  shell.log(`Applied: ${edit.summary || "edit"}`, "success", true);
}

function discardPending(): void {
  pendingEdit = null;
  pendingBar.set(null);
  shell.log("Edit discarded");
  ribbon.sync();
}

// ---------------------------------------------------------------------------
// Assistant runtime. Provider transport, tool execution, result state and the
// transcript live behind one agent so every entry point observes one turn.
const semanticActions: SemanticActions = {
  check: () => ifc.validate(),
  schedule: (type, properties) => ifc.schedule(type, properties),
  ids: async () => {
    const { idsReport } = await import("./ui/ids.js");
    return idsReport(viewer);
  },
  clash: async (a, b, tolerance, clearance, signal) => {
    return clashReport(viewer, a, b, tolerance, clearance, signal);
  },
};

const viewerCapabilities = createViewerCapabilityRegistry();
let activeAssistantResult = "";
let focusedAssistantRow: number | undefined;
const viewerCapabilityContext = {
  viewer,
  semantic: semanticActions,
  viewport: shell.viewerHost,
  revision: () => modelRevision(viewer),
  setActiveResult: (id: string, row?: number) => {
    activeAssistantResult = id;
    focusedAssistantRow = row;
  },
  stageEdit: async (input: Record<string, unknown>) => {
    const op = parseEditOp(JSON.stringify(input));
    if (op.op === "deleteElements") throw new Error("Deleting geometry is not available to the assistant");
    return proposeIfcEdit(op, "ai");
  },
};
const assistantCapabilities = new AssistantCapabilityAdapter(viewerCapabilities, viewerCapabilityContext);
const extensionToolApprovals = new ExtensionToolApprovals();
const viewTransactions = new ViewTransactionManager(viewer);
const tokenTotals = { input: 0, output: 0 };
const assistantTrace: AssistantTraceEvent[] = [];
let assistantChatId: string = crypto.randomUUID();

const assistantMode = (): "query" | "edit" =>
  assistantUi ? assistantUi.activeMode() : loadSettings().mode;

function recordUsage(usage: { input: number; output: number }): void {
  tokenTotals.input += usage.input;
  tokenTotals.output += usage.output;
  assistant().setUsage(usage, tokenTotals);
}

function modelSuggestions(): string[] {
  const counts = elementCounts(viewer);
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return [];
  const plain = (type: string): string => type.replace(/^Ifc/, "").replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase();
  const out = [`How many ${plain(entries[0][0])}s are there, and on which storeys?`];
  const named = entries.find(([type]) => /Door|Window|Wall|Space|Slab/i.test(type));
  if (named) out.push(`List the ${plain(named[0])}s with their properties`);
  out.push("Run the checks and summarise what is wrong");
  out.push(idsLoaded ? "Validate this model against the loaded IDS" : "What is in this model? Break it down by class");
  return out.slice(0, 4);
}

function syncAttachment(): void {
  if (!assistantUi) return;
  const ids = viewer.getSelectedIds();
  const types = viewer.getElementTypes();
  assistantUi.setAttachment(
    ids.length,
    ids.slice(0, 12).map((id) => `${types.get(id) ?? "element"} #${id}`).join("\n"),
  );
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("Could not read the viewport image"));
    reader.readAsDataURL(blob);
  });
}

async function captureAssistantContext(includeImage: boolean): Promise<{
  snapshot: ReturnType<typeof buildViewerContext>;
  image: ViewImageAttachment | null;
}> {
  let image: ViewImageAttachment | null = null;
  if (includeImage) {
    const blob = await viewer.captureImage(1280, "image/jpeg", 0.78);
    if (!blob) throw new Error("The current view could not be captured");
    const rect = shell.viewerHost.getBoundingClientRect();
    const scale = Math.min(1, 1280 / Math.max(1, rect.width));
    image = {
      mimeType: "image/jpeg",
      dataUrl: await blobDataUrl(blob),
      width: Math.max(1, Math.round(rect.width * scale)),
      height: Math.max(1, Math.round(rect.height * scale)),
      explicit: true,
    };
  }
  const snapshot = buildViewerContext(viewer, {
    fileName,
    schema: schemaName,
    panel: shell.currentTab(),
    activeExtension: plugins.activeId() || undefined,
    activeResult: activeAssistantResult || undefined,
    focusedRow: focusedAssistantRow,
    image,
  });
  if (assistantUi && !assistantUi.attachmentEnabled()) snapshot.selection = [];
  return { snapshot, image };
}

function assistantTransport() {
  return service.proxiesLlm()
    ? localProviderTransport(service)
    : browserProviderTransport(loadSettings());
}

function assistantSystem(messages: ChatMessage[], native: boolean, mode: "query" | "edit"): ChatMessage[] {
  const brief = buildModelBrief(viewer, fileName, schemaName);
  return [{ role: "system", content: systemPrompt(brief, mode, native) }, ...messages];
}

assistantAgent = new AgentRuntime({
  ui: () => assistant(),
  mode: assistantMode,
  transport: assistantTransport,
  tools: assistantCapabilities,
  viewTransactions,
  captureContext: captureAssistantContext,
  attachView: () => assistant().viewAttachmentEnabled(),
  approvals: () => extensionToolApprovals.list(plugins.assistantToolContributions()),
  system: assistantSystem,
  onUsage: recordUsage,
  onPersist: (messages) => saveChat(chatModelKey(), assistantChatId, messages, Date.now()),
  onTrace: (event) => {
    assistantTrace.push(event);
    if (assistantTrace.length > 200) assistantTrace.splice(0, assistantTrace.length - 200);
  },
});

function chatModelKey(): string {
  const stats = viewer.getStats();
  return stats ? `${stats.totalEntities}-${stats.triangleCount}` : "none";
}

function persistChat(): void {
  saveChat(chatModelKey(), assistantChatId, agent().history(), Date.now());
}

function openChat(chat: Conversation): void {
  assistantChatId = chat.id;
  agent().replaceHistory(chat.messages);
  const ui = assistant();
  ui.reset();
  ui.setBusy(false);
  for (const message of chat.messages) {
    if ((message.role === "user" && !message.context) || message.role === "assistant") {
      ui.addMessage(message.role, message.content);
    }
  }
  shell.selectTab("assistant");
}

function showChatHistory(anchor: HTMLElement): void {
  const model = chatModelKey();
  const chats = readChats(model);
  if (chats.length === 0) return void toast("No saved chats for this model yet", "info");
  const now = Date.now();
  const items: MenuItem[] = chats.map((chat) => ({
    label: `${chat.title}  (${ageLabel(chat.at, now)})`,
    run: () => openChat(chat),
  }));
  items.push({ separator: true });
  items.push({
    label: "Delete all saved chats",
    run: () => confirmAction(
      "Delete saved chats",
      `${chats.length} conversation(s) for this model will be removed from this browser.`,
      "Delete",
      () => {
        clearChats(model);
        shell.log("Saved chats deleted");
      },
    ),
  });
  const menu = buildMenu(items);
  const rect = anchor.getBoundingClientRect();
  menu.style.position = "fixed";
  menu.style.top = `${rect.bottom + 4}px`;
  menu.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  openLayer([menu], () => undefined);
  menuKeys(menu);
}

function retryChat(): void {
  const ui = assistant();
  if (agent().busy) return void toast("The assistant is still answering", "info");
  const last = ui.lastPrompt();
  if (!last) return void toast("Nothing to ask again", "info");
  agent().rewind(last);
  void agent().run(last).catch(reportError);
}

function newChat(): void {
  persistChat();
  assistantChatId = crypto.randomUUID();
  agent().clear();
  assistant().reset();
  assistant().setBusy(false);
  shell.selectTab("assistant");
}

/**
 * Follow a citation back into the model. Selecting is all a click does: the
 * camera holds still and the assistant stays on screen, because the reader is
 * mid-conversation and being thrown into the Properties tab loses their place.
 * Moving the camera is a separate, named request.
 */
function openEvidence(references: EvidenceReference[], action: "select" | "isolate" | "focus"): void {
  const first = references[0];
  if (!first) return;
  if (first.resultId) {
    activeAssistantResult = first.resultId;
    focusedAssistantRow = first.row;
  }
  const ids = [...new Set(references.flatMap((reference) => reference.elementIds ?? []))]
    .filter((id) => viewer.hasGeometry(id));
  if (ids.length) {
    if (action === "isolate") viewer.isolate(ids, "Assistant evidence");
    else viewer.selectMany(ids, "replace");
    if (action === "focus") {
      const box = viewer.boxAround(ids, 0.15);
      if (box) viewer.fitToPoint([
        (box.min[0] + box.max[0]) / 2,
        (box.min[1] + box.max[1]) / 2,
        (box.min[2] + box.max[2]) / 2,
      ]);
    }
  } else if (action === "focus" && first.point) {
    viewer.fitToPoint(first.point);
  }
  const what = references.length === 1 ? `${first.id}: ${first.label}` : `${references.length} references`;
  const verb = action === "focus" ? "Zoomed to" : action === "isolate" ? "Isolated" : "Selected";
  shell.log(`${verb} evidence ${what}`, "info", true);
}

async function acceptIssueProposal(payload: Record<string, unknown>): Promise<void> {
  const ids = Array.isArray(payload.elementIds)
    ? payload.elementIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  await raiseIssue(String(payload.title ?? "Assistant issue"), ids);
}

/**
 * Keep a definition the assistant wrote. Saving it is the whole point: the
 * answer stops being a message in a transcript and becomes a file the team
 * can open, edit and re-run on the next revision.
 */
async function acceptDefinitionProposal(payload: Record<string, unknown>): Promise<void> {
  const kind = String(payload.staged ?? "");
  if (kind === "view") {
    const body = payload.view as Record<string, unknown>;
    const store = new ViewStore();
    store.save({
      ...(body as unknown as ViewDefinition),
      id: `view-${Date.now().toString(36)}`,
      updatedAt: new Date().toISOString(),
      thumbnail: "",
    });
    viewsUi?.refresh();
    shell.selectTab("views");
    shell.log(`Saved the view "${String(body.name)}" the assistant wrote`, "success", true);
    return;
  }
  if (kind === "property") {
    const body = payload.property as ComputedProperty;
    if (!new ComputedStore().save({ ...body, id: `cp-${Date.now().toString(36)}` })) {
      throw new Error("The assistant returned an invalid computed-property definition");
    }
    computedUi?.refresh();
    shell.selectTab("computed");
    shell.log(`Saved the computed property "${String(body.name)}"`, "success", true);
    return;
  }
  if (kind === "ruleset") {
    const ruleset = payload.ruleset as { name?: unknown };
    // Rule Studio reads its ruleset from its own extension storage, so the
    // ruleset is handed over the way the panel itself stores one.
    localStorage.setItem("ifcviewx.plug.rule-studio.ruleset", JSON.stringify(payload.ruleset));
    await plugins.open("rule-studio");
    shell.log(`Loaded the ruleset "${String(ruleset.name ?? "")}" into Rule Studio`, "success", true);
    return;
  }
  toast("That proposal is not something this build can save", "error");
}

function reportError(err: unknown): void {
  if (err instanceof Error && err.name === "CancelledError") return shell.log("Load cancelled");
  shell.log(err instanceof Error ? err.message : String(err), "error", true);
}
// ---------------------------------------------------------------------------
// Summary pane
function renderSummary(): void {
  const host = $("pane-summary");
  if (!summaryDirty && host.childElementCount > 0) return;
  summaryDirty = false;
  const stats = viewer.getStats();
  host.replaceChildren();
  if (!stats) {
    host.appendChild(emptyState("cube", "No model loaded", "The summary lists totals, timings and model checks."));
    return;
  }

  const page = h("div", { class: "page scroll" });
  // A cache replay never parses, so a bare "0 ms" reads as a broken timer.
  const replayed = stats.parseMs === 0 && stats.geometryMs === 0;
  const facts: Array<[string, string]> = [
    ["File", fileName],
    ["Schema", schemaName ?? "unknown"],
    ["Entities", stats.totalEntities.toLocaleString()],
    ["Meshes", stats.meshCount.toLocaleString()],
    ["Triangles", stats.triangleCount.toLocaleString()],
    ["Parse", replayed ? "replayed from cache" : `${stats.parseMs.toFixed(0)} ms`],
    ...(replayed
      ? []
      : [["Geometry", `${stats.geometryMs.toFixed(0)} ms`] as [string, string]]),
  ];
  const list = h("dl", { class: "kv" });
  for (const [key, value] of facts) {
    list.append(h("dt", { text: key, title: key }), h("dd", { text: value, title: value }));
  }
  page.append(h("div", { class: "group-title", text: "Model" }), list);
  renderChecks(page);
  host.appendChild(page);
}

/** Repaint the summary; `reveal` brings it forward, for work that lands there. */
function refreshSummary(reveal = false): void {
  summaryDirty = true;
  if (reveal) showPane("summary");
  else if (paneVisible("summary")) renderSummary();
}

/**
 * Show one class: on its own, or added to what is already shown when the user
 * asks for more (Ctrl-click). Covers every placed element of the class, not
 * just the ones a query would list.
 */
function isolateByType(type: string, add = false): void {
  const ids = (elementsByType(viewer).get(type) ?? []).filter((id) => viewer.hasGeometry(id));
  if (ids.length === 0) return toast(`No placed geometry for ${type}`, "info");
  const label = type.replace(/^Ifc/, "");
  if (add) filters.add({ label, mode: "keep", ids });
  else viewer.isolate(ids, label);
  shell.log(`${add ? "Added" : "Isolated"} ${ids.length} ${type}`, "info", true);
}

// ---------------------------------------------------------------------------
// Local service
let lastMode = "";

async function probeService(): Promise<void> {
  const health = await service.probe();
  const mode = service.mode();
  connection.render();
  const state = $("service-state");
  state.textContent = health
    ? `Running · ${health.capabilities.join(", ")}`
    : "Web Studio: everything happens in this tab. Local Studio is a separate app.";
  if (mode !== lastMode) {
    lastMode = mode;
    if (mode === "local") shell.log(`Local Studio · ${health?.capabilities.join(", ")}`, "success");
  }

  if (mode === "local") {
    void handOverModel();
    // The service that served this page is also the MCP bridge, so plug this
    // tab in and AI clients can see the model it is showing.
    if (!bridge.isConnected()) bridge.connect(service.getToken(), service.origin.replace(/^http/, "ws"));
  }
  refreshAssistantEngine();
  plugins.refresh();
  ribbon.sync();
}

/** This is Local Studio, and the service offers this capability. */
function canLocal(capability: string): boolean {
  return service.mode() === "local" && service.can(capability);
}

/** Local Studio actions share one refusal, and it points at the way in. */
function requireLocal(capability: string, what: string): boolean {
  if (canLocal(capability)) return true;
  toast(`${what} only runs in Local Studio, a separate app`, "info");
  connection.open();
  return false;
}

async function convertWithService(): Promise<void> {
  if (!activeBytes) return toast("Open a model first", "info");
  if (!requireLocal("convert", "Conversion")) return;
  const sourceBytes = activeBytes;
  const sourceName = fileName;
  const sourceLoad = loadSeq;
  let commitLoad = 0;
  try {
    shell.setStatus("Converting", "busy");
    shell.log("Converting with IfcOpenShell, this can take minutes");
    loadingUi.show(`Converting ${sourceName}`);
    await handOverModel();
    if (activeBytes !== sourceBytes || loadSeq !== sourceLoad) return;
    const source = service.getSha();
    const converted = await service.convert((text) => {
      if (activeBytes !== sourceBytes || loadSeq !== sourceLoad) return;
      shell.setHint(text);
      loadingUi.step(text);
    });
    if (activeBytes !== sourceBytes || loadSeq !== sourceLoad) return;
    commitLoad = sourceLoad + 1;
    if (!(await loadBytes(converted, sourceName.replace(/\.ifc$/i, ".ifcx")))) return;
    // The viewer now shows the .ifcx; native tools keep using the stored source.
    if (source) service.adoptModel(source);
    plugins.refresh();
    shell.log("Converted. This model now opens instantly.", "success", true);
  } catch (err) {
    if (activeBytes === sourceBytes && (loadSeq === sourceLoad || loadSeq === commitLoad)) {
      reportError(err);
      updateModelChrome();
    }
  } finally {
    if (loadSeq === sourceLoad) loadingUi.hide();
  }
}

// ---------------------------------------------------------------------------
// Model checks (native, no generated code)
let lastReport: ValidationReport | null = null;
let checking = false;
let checkingLoad: number | null = null;

async function validateModel(): Promise<void> {
  if (!activeBytes || (checking && checkingLoad === loadSeq)) {
    return toast(activeBytes ? "The checks are already running" : "Open a model first", "info");
  }
  const sourceBytes = activeBytes;
  const sourceLoad = loadSeq;
  shell.setStatus("Checking", "busy");
  // Shown before the wait, not after it: a pass over every entity takes
  // seconds, and the pane it lands in is where the user should be watching.
  checking = true;
  checkingLoad = sourceLoad;
  refreshSummary(true);
  ribbon.sync();
  try {
    const report = await ifc.validate();
    if (activeBytes !== sourceBytes || loadSeq !== sourceLoad) return;
    lastReport = report;
    publishChecksDocket(report);
    const { error, warning } = report.counts;
    shell.log(
      `Model checks: ${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}`,
      error ? "error" : "success",
      true,
    );
  } finally {
    if (checkingLoad === sourceLoad) {
      checking = false;
      checkingLoad = null;
      if (activeBytes === sourceBytes && loadSeq === sourceLoad) {
        refreshSummary();
        updateModelChrome();
      }
    }
  }
}

/**
 * The offline report. Nothing here runs a check of its own: it prints the
 * checks, IDS run and plugin findings this session already produced, and marks
 * the rest "not run". A report that quietly re-ran the work under different
 * settings would not describe what the user saw.
 */
async function buildReport(): Promise<void> {
  if (!viewer.getStats()) return toast("Open a model first", "info");
  shell.setStatus("Building the report", "busy");
  try {
    const { buildReport: render, collectReport } = await import("./ui/report.js");
    const { lastIdsReport } = await import("./ui/ids.js");
    const model = await collectReport({
      viewer,
      title: fileName.replace(/\.[^.]+$/, "") || "Model report",
      app: `IFCViewX ${__APP_VERSION__}`,
      checks: () => lastReport,
      ids: () => lastIdsReport(),
      issues: () => bcfUi?.reportIssues() ?? null,
    });
    const html = render(model);
    download(`${model.title.replace(/[^\w.-]+/g, "-")}-report.html`, html, "text/html;charset=utf-8");
    shell.log(`Report saved (${Math.round(html.length / 1024)} kB). Open it and print to PDF.`, "success", true);
  } finally {
    updateModelChrome();
  }
}

/** Read the alignments this file carries and open drive mode on them. */
async function openDriveMode(): Promise<void> {
  if (!activeBytes) return void toast("Open a model first", "info");
  if (drive.isOpen()) return drive.hide();
  shell.setStatus("Reading alignments", "busy");
  try {
    await handOverModel();
    const report = await ifc.alignments();
    // The schema is what tells a user their file simply cannot carry an
    // alignment, so pass the one the loader sniffed rather than a blank.
    drive.present(report.alignments, schemaName ?? "");
    if (report.alignments.length) {
      shell.log(
        `${report.alignments.length} alignment(s), ${report.alignments.reduce((total, entry) => total + entry.length, 0).toFixed(0)} m in total`,
        "success",
      );
    }
  } finally {
    shell.setStatus(activeBytes ? "Ready" : "No model");
  }
}

/**
 * The conformance pass buildingSMART's own service runs, run here instead.
 * Their service is free and online only; this one never sees the file, which
 * is the only claim in the app that no other product can make.
 */
let conformanceRunning = false;
async function runConformance(): Promise<void> {
  if (!activeBytes) return void toast("Open a model first", "info");
  if (conformanceRunning) return;
  conformanceRunning = true;
  shell.setStatus("Checking conformance", "busy");
  try {
    await handOverModel();
    const report = await ifc.conformance();
    const { FAMILY_LABEL } = await import("./ifc/conformance.js");
    publishDocket({
      id: "conformance",
      producer: "Conformance",
      title: "IFC conformance",
      summary: `${report.passed} passed, ${report.failed} failed, ${report.notRun} need Local Studio. Schema ${report.schema}`,
      rows: report.checks.map((check) => ({
        id: check.id,
        severity: check.outcome === "fail" ? "error" : check.outcome === "not_run" ? "info" : "info",
        title: `${check.id}  ${check.title}`,
        detail: check.outcome === "pass" ? "passes" : check.outcome === "fail" ? `${check.count} failing` : check.detail,
        group: FAMILY_LABEL[check.family],
        ids: check.sample.map((entry) => entry.expressID).filter((id) => viewer.hasGeometry(id)),
      })),
    });
    results.setOpen(true);
    shell.log(
      `Conformance: ${report.failed} rule(s) failed, ${report.passed} passed, nothing uploaded`,
      report.failed ? "error" : "success",
      true,
    );
  } finally {
    conformanceRunning = false;
    shell.setStatus(activeBytes ? "Ready" : "No model");
  }
}

/**
 * The built-in checks, as rows on the shared dock. A check names a sample of
 * the entities it failed on, so the rows carry those ids and nothing more:
 * claiming an id the check never looked at would send a reviewer somewhere
 * the finding does not apply.
 */
function publishChecksDocket(report: ValidationReport): void {
  const rows: DocketRow[] = report.checks.map((check) => ({
    id: check.id,
    severity: check.severity,
    title: `${check.title} (${check.count.toLocaleString()})`,
    detail: check.hint,
    group: check.severity === "error" ? "Errors" : check.severity === "warning" ? "Warnings" : "Notes",
    ids: (check.sample ?? [])
      .map((entry) => Number(entry.expressID ?? entry.id))
      .filter((id) => Number.isFinite(id) && viewer.hasGeometry(id)),
  }));
  publishDocket({
    id: "checks",
    producer: "Model checks",
    title: "Model checks",
    summary: `${report.counts.error} error(s), ${report.counts.warning} warning(s), schema ${report.schema}`,
    rows,
  });
}

function renderChecks(page: HTMLElement): void {
  const head = h("div", { class: "group-title" }, [
    h("span", { text: "Model checks" }),
    (() => {
      const run = h("button", {
        class: "link-btn",
        type: "button",
        text: lastReport ? "Re-run" : "Run",
        disabled: checking,
      });
      run.addEventListener("click", () => void validateModel().catch(reportError));
      return run;
    })(),
  ]);
  page.appendChild(head);
  if (checking) {
    page.appendChild(busyRow("Checking every entity"));
    return;
  }
  if (!lastReport) {
    page.appendChild(
      h("div", { class: "note", text: "Structural QA: identity, containment, placement, units, naming." }),
    );
    return;
  }
  if (lastReport.checks.length === 0) {
    page.appendChild(h("div", { class: "note", text: "No issues found." }));
    return;
  }
  for (const check of lastReport.checks) {
    const row = h("div", { class: `check ${check.severity}`, title: check.hint ?? "" }, [
      h("span", { class: "dot" }),
      h("span", { class: "grow", text: check.title }),
      h("span", { class: "n", text: check.count.toLocaleString() }),
    ]);
    page.appendChild(row);
  }
}

// ---------------------------------------------------------------------------
// Recent models
let recents: CachedModel[] = [];

async function renderRecents(): Promise<void> {
  recents = (await listCachedModels()).slice(0, 6);
  $("recent").classList.toggle("hidden", recents.length === 0);
  const list = $("recent-list");
  list.replaceChildren();
  for (const model of recents) {
    const row = h("button", { class: "recent-row", type: "button", title: model.name }, [
      icon("file", 13),
      h("span", { class: "name", text: model.name }),
      h("span", { class: "meta", text: `${(model.bytes / 1e6).toFixed(1)} MB` }),
    ]);
    row.addEventListener("click", () => openRecent(model.sha, model.name));
    list.appendChild(row);
  }
  ribbon.sync();
}

function openRecent(sha: string, name: string): void {
  replaceOrConfirm(() => {
    const attempt = beginLoadAttempt();
    loadingUi.show(name);
    loadingUi.step("Reading it from browser storage");
    void loadCachedSource(sha)
      .then(async (bytes) => {
        if (attempt !== loadAttemptSeq) return;
        if (!bytes) {
          toast(`${name} is no longer cached. Open it from disk.`, "info");
          return renderRecents();
        }
        if (await loadBytes(bytes, name, false, { attempt })) {
          shell.log(`Opened ${name}`, "success");
        }
      })
      .catch((err) => {
        if (attempt === loadAttemptSeq) reportError(err);
      })
      .finally(() => {
        if (attempt === loadAttemptSeq) loadingUi.hide();
      });
  });
}

function recentMenu(): MenuItem[] {
  if (recents.length === 0) return [{ label: "No cached models yet", disabled: true }];
  return recents.map((model) => ({
    label: model.name,
    shortcut: `${(model.bytes / 1e6).toFixed(0)} MB`,
    run: () => openRecent(model.sha, model.name),
  }));
}

// ---------------------------------------------------------------------------
// Settings dialog: the same values the ribbon edits, with their explanations
const setScale = $<HTMLSelectElement>("set-scale");
const setAdaptive = $<HTMLInputElement>("set-adaptive");
const setLod = $<HTMLInputElement>("set-lod");
const setDoubleside = $<HTMLInputElement>("set-doubleside");
const setAa = $<HTMLInputElement>("set-aa");
const setHudInput = $<HTMLInputElement>("set-hud");
const setConvert = $<HTMLInputElement>("set-convert");

setScale.value = String(settings.scale);
setAdaptive.checked = settings.adaptive;
setLod.checked = settings.lod;
setDoubleside.checked = settings.doubleSided;
setAa.checked = settings.antialias;
setHudInput.checked = settings.hud;
setConvert.checked = settings.offerConvert;

setScale.addEventListener("change", () => {
  settings.scale = Number(setScale.value) || 1;
  viewer.setRenderScale(settings.scale);
  persistSettings();
  ribbon.sync();
});
setLod.addEventListener("change", () => {
  settings.lod = setLod.checked;
  viewer.setLodThreshold(settings.lod ? LOD_PIXELS : 0);
  persistSettings();
});
setAdaptive.addEventListener("change", () => {
  settings.adaptive = setAdaptive.checked;
  viewer.setAdaptiveResolution(settings.adaptive);
  persistSettings();
});
setDoubleside.addEventListener("change", () => {
  settings.doubleSided = setDoubleside.checked;
  viewer.setDoubleSided(settings.doubleSided);
  persistSettings();
});
setAa.addEventListener("change", () => {
  settings.antialias = setAa.checked;
  persistSettings();
  toast("Antialiasing applies after a reload", "info");
});
setHudInput.addEventListener("change", () => setHud(setHudInput.checked));
setConvert.addEventListener("change", () => {
  settings.offerConvert = setConvert.checked;
  persistSettings();
});
$("open-connection").addEventListener("click", () => {
  settingsDialog.close();
  connection.open();
});
$("open-assistant").addEventListener("click", () => {
  settingsDialog.close();
  shell.selectTab("assistant");
  assistant().openSettings();
});
$("settings-close").addEventListener("click", () => settingsDialog.close());
$("settings-done").addEventListener("click", () => settingsDialog.close());
$("help-close").addEventListener("click", () => helpDialog.close());
$("help-done").addEventListener("click", () => helpDialog.close());
// The markup leaves these two empty; every other dialog close is an iconButton.
for (const id of ["settings-close", "help-close"]) $(id).appendChild(icon("x"));
lightDismiss(settingsDialog);
lightDismiss(helpDialog);

/**
 * The dialog no longer owns the assistant fields, so it says where they went
 * and what state they are in: configured is not the same as proven to work.
 */
function showSettings(): void {
  const llm = loadSettings();
  const provider = findProvider(llm.provider);
  $("llm-summary").textContent = service.proxiesLlm()
    ? "Local Studio holds the provider key."
    : !isConfigured(llm)
      ? "Not configured yet."
      : `${provider.label} · ${llm.model}, ${isVerified(llm) ? "verified" : "not verified yet"}.`;
  // Measured off the disk each time it is opened: these numbers are worth
  // nothing if they are stale, and nobody opens Settings often enough for a
  // background poll to pay for itself.
  void privacyPanel().refresh();
  openDialog(settingsDialog);
}

let privacy: PrivacyPanel | null = null;

/** The "Your data" block: what has been kept, and one button per thing. */
function privacyPanel(): PrivacyPanel {
  if (!privacy) {
    privacy = new PrivacyPanel({
      paths: () => service.storagePaths(),
      reveal: (which) => service.revealFolder(which),
      changed: () => {
        // Deleting the key or the cache changes what the assistant header
        // claims and what the dropzone offers to reopen.
        refreshAssistantEngine();
        void renderRecents();
      },
    });
    $("privacy-panel").appendChild(privacy.root);
  }
  return privacy;
}

// ---------------------------------------------------------------------------
// Commands: one definition each, used by the ribbon, palette and keyboard
const hasModel = (): boolean => activeBytes !== null;
const registry = new CommandRegistry();

registry.add([
  { id: "file.open", label: "Open", icon: "folder", section: "File", shortcut: "Ctrl+O", hint: "Open an IFC or .ifcx file", run: () => fileInput.click() },
  { id: "file.attach", label: "Add model", icon: "layers", section: "File", hint: "Load a second model beside this one", enabled: hasModel, run: () => attachInput.click() },
  { id: "file.sample", label: "Sample model", icon: "cube", section: "File", hint: "A small two-storey building, generated here, to try the viewer on", run: () => replaceOrConfirm(() => void openSample().catch(reportError)) },
  { id: "file.export", label: "Export", icon: "download", section: "File", hint: "Download the active IFC", enabled: hasModel, run: exportModel },
  { id: "file.mesh", label: "Export mesh", icon: "cube", section: "File", hint: "glTF, GLB, STL or OBJ of what is on screen, or of the selection", enabled: hasModel, run: exportMeshFile },
  { id: "file.plan", label: "Export plan", icon: "section", section: "File", hint: "The 2D plan as a PNG, cut where the section is", enabled: hasModel, run: () => void savePlanImage() },
  { id: "file.package", label: "Share package", icon: "download", section: "File", hint: "Model, views, properties, drawings and issues as one file that opens with no account and no network", enabled: hasModel, run: () => void exportSharePackage().catch(reportError) },
  { id: "file.close", label: "Close", icon: "x", section: "File", enabled: hasModel, run: closeOrConfirm },
  { id: "file.screenshot", label: "Screenshot", icon: "camera", section: "File", shortcut: "S", enabled: hasModel, run: () => { viewer.screenshot(); shell.log("Screenshot saved", "success", true); } },
  { id: "file.viewpoint", label: "Viewpoint", icon: "bookmark", section: "File", shortcut: "V", enabled: hasModel, run: saveViewpoint },
  { id: "view.save", label: "Save view", icon: "bookmark", section: "Views", shortcut: "Shift+V", hint: "Store filters, colour, cuts, notes and camera as a definition that re-runs on any revision", enabled: hasModel, run: () => void viewsPane().then((pane) => pane.saveCurrent()).catch(reportError) },
  { id: "view.open", label: "Views", icon: "bookmark", section: "Views", shortcut: "W", hint: "Saved model views", run: () => shell.selectTab("views") },
  { id: "file.convert", label: "Convert", icon: "refresh", section: "Local Studio", tier: "local", available: () => canLocal("convert"), hint: "IfcOpenShell → .ifcx, then reopens are instant", enabled: hasModel, run: () => void convertWithService() },
  { id: "file.conformance", label: "Conformance", icon: "shield", section: "Review", hint: "Schema, implementer agreements and informal propositions, checked on this machine with nothing uploaded", enabled: () => hasModel() && !conformanceRunning, run: () => void runConformance().catch(reportError) },
  { id: "file.check", label: "Checks", icon: "shield", section: "Review", hint: "Structural QA in this tab, no generated code", enabled: () => hasModel() && !checking, run: () => void validateModel().catch(reportError) },
  { id: "file.schedule", label: "Element schedules", icon: "table", section: "Plugins", hint: "Tabular export of a class, with pset columns resolved through the type", enabled: hasModel, run: () => void openScheduleWorkspace().catch(reportError) },
  { id: "file.report", label: "Report", icon: "clipboard", section: "Review", hint: "One offline HTML page: checks, IDS, findings and issues. Print it for PDF", enabled: hasModel, run: () => void buildReport().catch(reportError) },

  { id: "edit.undo", label: "Undo", icon: "undo", section: "Edit", shortcut: "Ctrl+Z", enabled: () => checkpoints.length > 0, run: () => void undo().catch(reportError) },
  { id: "edit.redo", label: "Redo", icon: "redo", section: "Edit", shortcut: "Ctrl+Y", enabled: () => redoStack.length > 0, run: () => void redo().catch(reportError) },
  { id: "edit.apply", label: "Apply", icon: "check", section: "Edit", hint: "Apply the pending edit", enabled: () => pendingEdit !== null, run: () => void applyPending().catch(reportError) },
  { id: "edit.discard", label: "Discard", icon: "trash", section: "Edit", enabled: () => pendingEdit !== null, run: discardPending },
  { id: "edit.rename", label: "Rename", icon: "edit", section: "Edit", hint: "Rename the selection; staged for approval", enabled: () => viewer.getSelection() !== null, run: renameSelection },
  { id: "edit.property", label: "Set property", icon: "sliders", section: "Edit", hint: "Write an existing property on the selection", enabled: () => viewer.getSelection() !== null, run: setPropertyOnSelection },
  { id: "edit.delete", label: "Delete", icon: "trash", section: "Edit", hint: "Remove the selection from the model", enabled: () => viewer.getSelection() !== null, run: deleteSelection },

  { id: "vis.isolate", label: "Isolate", icon: "focus", section: "Visibility", shortcut: "I", binding: "", enabled: () => viewer.getSelection() !== null, run: () => viewer.isolateSelected() },
  { id: "vis.hide", label: "Hide", icon: "eye-off", section: "Visibility", shortcut: "H", binding: "", enabled: () => viewer.getSelection() !== null, run: () => viewer.hideSelected() },
  { id: "vis.all", label: "Show all", icon: "eye", section: "Visibility", shortcut: "A", binding: "", run: () => viewer.showAll() },
  { id: "vis.undo", label: "Undo visibility", icon: "undo", section: "Visibility", shortcut: "Ctrl+Shift+Z", hint: "Step back through hide and isolate", enabled: () => viewer.canUndoVisibility(), run: () => { if (!viewer.undoVisibility()) toast("Nothing to undo", "info"); } },
  { id: "vis.redo", label: "Redo visibility", icon: "redo", section: "Visibility", shortcut: "Ctrl+Shift+Y", enabled: () => viewer.canRedoVisibility(), run: () => { if (!viewer.redoVisibility()) toast("Nothing to redo", "info"); } },
  { id: "vis.ghost", label: "Ghost hidden", icon: "eye-off", section: "Visibility", hint: "Hidden elements stay as a faint hatch instead of vanishing", pressed: () => viewer.isGhostHidden(), run: () => { viewer.setGhostHidden(!viewer.isGhostHidden()); shell.log(viewer.isGhostHidden() ? "Hidden elements are ghosted" : "Hidden elements are fully hidden"); ribbon.sync(); } },
  { id: "vis.xray", label: "Transparent", icon: "eye", section: "Visibility", hint: "Draw the selection see-through; click again to make it solid", enabled: () => viewer.getSelection() !== null, run: () => { const ids = viewer.getSelectedIds(); const on = !ids.every((id) => viewer.isElementXray(id)); viewer.setXray(ids, on); ribbon.sync(); } },
  { id: "vis.xrayrest", label: "Transp. unselected", icon: "eye", section: "Visibility", hint: "Keep the selection solid; everything else goes see-through", enabled: () => viewer.getSelection() !== null, run: () => { viewer.xrayAllExcept(viewer.getSelectedIds()); ribbon.sync(); } },
  { id: "vis.xrayclear", label: "Opaque all", icon: "eye", section: "Visibility", enabled: () => viewer.getXrayCount() > 0, run: () => { viewer.clearXray(); ribbon.sync(); } },
  { id: "vis.picksolid", label: "Ignore transparent", icon: "focus", section: "Visibility", hint: "Clicks and measurements pass through see-through elements", pressed: () => viewer.getPickIgnoreXray(), run: () => { viewer.setPickIgnoreXray(!viewer.getPickIgnoreXray()); ribbon.sync(); } },
  { id: "vis.showthrough", label: "Show through", icon: "sparkle", section: "Visibility", hint: "The selection stays visible through walls", pressed: () => viewer.getShowThroughSelection(), run: () => { viewer.setShowThroughSelection(!viewer.getShowThroughSelection()); ribbon.sync(); } },
  { id: "vis.grids", label: "Grid axes", icon: "table", section: "Visibility", hint: "IfcGrid axis lines with their bubble labels", enabled: hasModel, pressed: () => viewer.areGridsVisible(), run: () => { void viewer.setGridsVisible(!viewer.areGridsVisible()).then(() => { if (viewer.areGridsVisible() && viewer.getSceneInfo().meshCount > 0 && !document.querySelector(".ifc-grid-bubble")) toast("This model has no grid axes", "info"); ribbon.sync(); }).catch(reportError); } },
  { id: "vis.edges", label: "Edges", icon: "section", section: "Visibility", hint: "Feature edge lines over the shading", enabled: hasModel, pressed: () => viewer.areEdgesVisible(), run: () => { viewer.setEdgesVisible(!viewer.areEdgesVisible()); ribbon.sync(); } },
  { id: "sel.clear", label: "Deselect", icon: "x", section: "Visibility", shortcut: "Esc", binding: "", enabled: () => viewer.getSelection() !== null, run: () => viewer.clearSelection() },
  { id: "vis.spaces", label: "Spaces", icon: "layers", section: "Visibility", hint: "IfcSpace geometry loads on demand", pressed: () => viewer.isCategoryVisible("IfcSpace"), run: () => void setCategory("IfcSpace").catch(reportError) },
  { id: "vis.openings", label: "Openings", icon: "layers", section: "Visibility", pressed: () => viewer.isCategoryVisible("IfcOpeningElement"), run: () => void setCategory("IfcOpeningElement").catch(reportError) },
  { id: "vis.filters", label: "Filters", icon: "funnel", section: "Visibility", hint: "Build a filter from class, name, storey or property", run: () => shell.selectTab("filters") },
  { id: "vis.clear", label: "Clear filters", icon: "funnel", section: "Visibility", hint: "Drop every filter, section and manual hide", enabled: () => filters.entries().length > 0, run: () => filters.clear() },

  { id: "cam.fit", label: "Frame", icon: "frame", section: "Camera", shortcut: "F", binding: "", run: () => viewer.fitToModel() },
  { id: "cam.fitsel", label: "Frame sel.", icon: "focus", section: "Camera", shortcut: "Shift+F", run: frameSelection },
  { id: "cam.front", label: "Front", icon: "cube", section: "Camera", shortcut: "1", run: () => viewer.viewFrom("front") },
  { id: "cam.right", label: "Right", icon: "cube", section: "Camera", shortcut: "2", run: () => viewer.viewFrom("right") },
  { id: "cam.top", label: "Top", icon: "cube", section: "Camera", shortcut: "3", run: () => viewer.viewFrom("top") },
  { id: "cam.iso", label: "Iso", icon: "cube", section: "Camera", shortcut: "4", run: () => viewer.viewFrom("iso") },
  { id: "cam.back", label: "Back", icon: "cube", section: "Camera", run: () => viewer.viewFrom("back") },
  { id: "cam.left", label: "Left", icon: "cube", section: "Camera", run: () => viewer.viewFrom("left") },
  { id: "cam.bottom", label: "Bottom", icon: "cube", section: "Camera", run: () => viewer.viewFrom("bottom") },
  { id: "cam.ortho", label: "Orthographic", icon: "ortho", section: "Camera", shortcut: "5", hint: "Parallel projection; toggling keeps the framing", pressed: () => viewer.getProjection() === "orthographic", run: () => { viewer.setProjection(viewer.getProjection() === "orthographic" ? "perspective" : "orthographic"); ribbon.sync(); } },
  { id: "cam.rotl", label: "Rotate left", icon: "undo", section: "Camera", shortcut: "[", hint: "Quarter turn about the up axis", run: () => viewer.rotateView(90) },
  { id: "cam.rotr", label: "Rotate right", icon: "redo", section: "Camera", shortcut: "]", run: () => viewer.rotateView(-90) },
  { id: "cam.perp", label: "Perpendicular", icon: "focus", section: "Camera", shortcut: "N", hint: "Face the last-picked surface head on", enabled: hasModel, run: () => { if (!viewer.viewPerpendicular()) toast("No picked face; snapped to the nearest axis", "info"); } },
  { id: "analysis.alignment", label: "Drive alignment", icon: "walk", section: "Analyze", hint: "Follow an IFC 4.3 alignment with the file's own chainage, height and grade", enabled: hasModel, pressed: () => drive.isOpen(), run: () => void openDriveMode().catch(reportError) },
  { id: "cam.vr", label: "VR review", icon: "walk", section: "Camera", hint: "Walk the model in a headset. The same tab, no second application", enabled: hasModel, pressed: () => viewer.xrMode() === "immersive-vr", run: () => void enterXr("immersive-vr") },
  { id: "cam.ar", label: "AR on site", icon: "globe", section: "Camera", hint: "Place the model in the room through a passthrough headset or an Android phone", enabled: hasModel, pressed: () => viewer.xrMode() === "immersive-ar", run: () => void enterXr("immersive-ar") },
  { id: "cam.fly", label: "Fly mode", icon: "walk", section: "Camera", shortcut: "6", hint: "First person: WASD moves, Q/E down and up, Shift is faster, wheel zooms, Shift+wheel sets speed, Esc exits", enabled: hasModel, pressed: () => viewer.isFlyMode(), run: () => viewer.setFlyMode(!viewer.isFlyMode()) },

  { id: "tool.measure", label: "Measure", icon: "ruler", section: "Tools", shortcut: "M", pressed: () => viewer.isMeasuring(), run: toggleMeasure },
  { id: "tool.section", label: "Section", icon: "section", section: "Tools", shortcut: "X", hint: "Slice on X, Y and Z", pressed: () => viewer.getSections().length > 0, run: toggleSection },
  { id: "tool.box", label: "Section box", icon: "cube", section: "Tools", shortcut: "B", hint: "Six planes at once, around the selection", enabled: hasModel, pressed: () => viewer.getSectionBox() !== null, run: toggleSectionBox },
  { id: "tool.plan", label: "2D plan", icon: "layers", section: "Tools", shortcut: "G", hint: "Floorplan inset, cut by the horizontal section. Click it to select in 3D", enabled: hasModel, pressed: () => viewer.isPlanView(), run: togglePlan },
  { id: "tool.hud", label: "Perf HUD", icon: "gauge", section: "Tools", pressed: () => settings.hud, run: () => setHud(!settings.hud) },

  { id: "analysis.smart-measure", label: "Smart measure", icon: "ruler", section: "Analyze", hint: "Shortest clearance between two elements or a six-axis surface scan", enabled: hasModel, run: openSmartMeasure },
  { id: "analysis.section-workspace", label: "Section drawing", icon: "section", section: "Analyze", hint: "Synchronized plans and sections from the active cut", enabled: hasModel, run: () => void plugins.open("section-workspace") },
  { id: "sheets.open", label: "Sheets", icon: "layers", section: "Sheets", hint: "The issued drawing set: import, calibrate, overlay, mark up and raise BCF from 2D", run: () => void plugins.open("sheets") },
  { id: "analysis.clash", label: "Clash detection", icon: "alert", section: "Analyze", hint: "Find mesh intersections and clearance failures", enabled: hasModel, run: () => void plugins.open("clash") },
  { id: "analysis.health", label: "Model health", icon: "shield", section: "Analyze", hint: "Check identity, geometry and model quality", enabled: hasModel, run: () => void plugins.open("model-health") },
  { id: "analysis.rules", label: "Rule Studio", icon: "shield", section: "Analyze", hint: "Geometric, topological and relational rules, saved as one ruleset the project shares", enabled: hasModel, run: () => void plugins.open("rule-studio") },
  { id: "analysis.compare", label: "Compare models", icon: "compare", section: "Analyze", hint: "Classify geometry and property changes", enabled: hasModel, run: () => void plugins.open("compare") },
  { id: "analysis.ids", label: "IDS", icon: "clipboard", section: "Analyze", hint: "Open an IDS file and check the model against it", run: () => shell.selectTab("ids") },
  { id: "analysis.ids-studio", label: "IDS authoring", icon: "clipboard", section: "Analyze", hint: "Write IDS 1.0 requirements, bind bSDD concepts and compare compliance", run: () => void plugins.open("ids-studio") },
  { id: "analysis.schedule-4d", label: "4D Schedule", icon: "clock", section: "Analyze", hint: "IFC task graph, schedule CSV overlay, Gantt and construction timeline", enabled: hasModel, run: () => void plugins.open("schedule-4d") },
  { id: "analysis.takeoff", label: "Takeoff", icon: "calculator", section: "Analyze", hint: "Extract quantities from the model", enabled: hasModel, run: () => void plugins.open("takeoff") },
  { id: "analysis.report-builder", label: "Report builder", icon: "clipboard", section: "Review", hint: "Your columns, your grouping, saved as a template that reproduces on the next revision", enabled: hasModel, run: () => void plugins.open("report-builder") },
  { id: "analysis.point-cloud", label: "Point cloud", icon: "cube", section: "Analyze", hint: "Overlay a laser scan and colour it by its deviation from the model", enabled: hasModel, run: () => void plugins.open("point-cloud") },
  { id: "analysis.presentation", label: "Presentation", icon: "walk", section: "Review", hint: "Saved views as an ordered walkthrough, played or recorded", enabled: hasModel, run: () => void plugins.open("presentation") },
  { id: "analysis.geo", label: "Geo Context", icon: "globe", section: "Analyze", hint: "Inspect CRS metadata, align models and exchange GeoJSON", enabled: hasModel, run: () => shell.selectTab("geo") },

  { id: "panel.tree", label: "Structure", icon: "panel-left-close", section: "Panels", shortcut: "Ctrl+B", pressed: () => shell.isPanelOpen("outliner"), run: () => { shell.togglePanel("outliner"); ribbon.sync(); } },
  { id: "panel.insp", label: "Inspector", icon: "panel-right-close", section: "Panels", shortcut: "\\", pressed: () => shell.isPanelOpen("inspector"), run: () => { shell.togglePanel("inspector"); ribbon.sync(); } },
  { id: "panel.props", label: "Properties", icon: "info", section: "Panels", shortcut: "P", run: () => shell.selectTab("properties") },
  { id: "panel.views", label: "Views", icon: "bookmark", section: "Panels", hint: "Saved model views", run: () => shell.selectTab("views") },
  { id: "panel.computed", label: "Computed", icon: "sliders", section: "Panels", hint: "Derived properties used by filters, colours, schedules and reports", run: () => shell.selectTab("computed") },
  { id: "panel.filters", label: "Filters", icon: "funnel", section: "Panels", shortcut: "R", run: () => shell.selectTab("filters") },
  { id: "panel.geo", label: "Geo Context", icon: "globe", section: "Panels", hint: "CRS diagnostics, federation alignment and GeoJSON", run: () => shell.selectTab("geo") },
  { id: "panel.ids", label: "IDS", icon: "clipboard", section: "Panels", hint: "Check the model against a buildingSMART IDS file", run: () => shell.selectTab("ids") },
  { id: "panel.schedule-4d", label: "4D Schedule", icon: "clock", section: "Panels", hint: "Construction timeline, Gantt and task-to-product mapping", run: () => void plugins.open("schedule-4d") },
  { id: "panel.bcf", label: "Issues", icon: "flag", section: "Panels", hint: "Local or OpenCDE BCF topics with viewpoints", run: () => shell.selectTab("bcf") },
  { id: "panel.ai", label: "Assistant", icon: "sparkle", section: "Panels", shortcut: "C", run: () => shell.selectTab("assistant") },
  { id: "panel.py", label: "Python console", icon: "terminal", section: "Panels", shortcut: "Y", hint: "Write IfcOpenShell yourself; opens as a plugin", run: () => void plugins.open("python") },
  { id: "panel.log", label: "Activity", icon: "activity", section: "Panels", shortcut: "L", run: () => shell.selectTab("activity") },
  { id: "panel.results", label: "Results dock", icon: "list", section: "Panels", shortcut: "D", hint: "One dock for clash, rules, IDS and checks, with the same grouping and BCF handoff", pressed: () => results.isOpen(), run: () => { results.toggle(); ribbon.sync(); } },
  { id: "panel.summary", label: "Summary", icon: "list", section: "Panels", run: () => showPane("summary") },
  { id: "panel.types", label: "Types", icon: "layers", section: "Panels", hint: "Browse the model by IFC class", run: () => showPane("types") },
  { id: "panel.organize", label: "Organize", icon: "layers", section: "Panels", hint: "Groups, layers, classifications and materials", run: () => showPane("organize") },
  { id: "panel.structure", label: "Structure tree", icon: "layers", section: "Panels", run: () => showPane("tree") },

  { id: "bcf.new", label: "Raise issue", icon: "flag", section: "Review", hint: "Keeps the camera, the section and a snapshot", enabled: hasModel, run: () => void raiseIssue("", []).catch(reportError) },
  { id: "ids.open", label: "IDS check", icon: "clipboard", section: "Review", hint: "Load an IDS 1.0 file and validate the model", run: () => shell.selectTab("ids") },

  { id: "ai.new", label: "New chat", icon: "message", section: "Assistant", run: newChat },

  { id: "app.plugins", label: "Plugins", icon: "blocks", section: "Application", hint: "Python console, clash detection, takeoff, explorer, compare and the Local Studio add-ons", run: () => pluginBrowser.open() },
  { id: "app.connection", label: "Studio", icon: "plug", section: "Application", hint: "Web Studio or Local Studio", run: () => connection.open() },
  { id: "app.install", label: "Install app", icon: "walk", section: "Application", hint: "Install IFCViewX so it opens from the home screen and works with no connection", run: () => void field.install() },
  { id: "app.touch", label: "Touch mode", icon: "walk", section: "Application", hint: "Bigger hit targets for a tablet on site", pressed: () => field.isTouch(), run: () => { field.setTouch(!field.isTouch()); ribbon.sync(); shell.log(field.isTouch() ? "Touch mode on" : "Touch mode off"); } },
  { id: "app.theme", label: "Theme", icon: "moon", section: "Application", run: toggleTheme },
  { id: "app.settings", label: "Settings", icon: "settings", section: "Application", shortcut: "Ctrl+,", run: () => showSettings() },
  { id: "app.help", label: "Shortcuts", icon: "help", section: "Application", shortcut: "?", run: () => openDialog(helpDialog) },
  { id: "app.palette", label: "Command palette", icon: "command", section: "Application", shortcut: "Ctrl+K", run: () => palette.toggle() },
  { id: "app.ribbon", label: "Collapse ribbon", icon: "chevron", section: "Application", shortcut: "Ctrl+F1", run: () => ribbon.setCollapsed(!ribbon.isCollapsed()) },
]);

/** Ribbon layout: pure data over command ids. */
const RIBBON: RibbonTab[] = [
  {
    id: "file",
    label: "File",
    groups: [
      { label: "Model", items: [
        { kind: "cmd", id: "file.open" },
        { kind: "menu", label: "Recent", icon: "clock", items: recentMenu },
        { kind: "cmd", id: "file.attach", size: "sm" },
        { kind: "cmd", id: "file.close", size: "sm" },
        { kind: "cmd", id: "app.connection", size: "sm" },
      ] },
      { label: "Output", items: [
        { kind: "cmd", id: "file.export", label: "IFC" },
        { kind: "cmd", id: "file.mesh", label: "Mesh" },
        { kind: "cmd", id: "file.screenshot", size: "sm", label: "Image" },
        { kind: "cmd", id: "file.plan", size: "sm", label: "Plan" },
        { kind: "cmd", id: "file.viewpoint", size: "sm", label: "View" },
        { kind: "cmd", id: "file.package", size: "sm", label: "Package" },
      ] },
      { label: "App", items: [
        { kind: "cmd", id: "app.plugins" },
        { kind: "cmd", id: "app.settings", size: "sm" },
        { kind: "cmd", id: "app.help", size: "sm" },
      ] },
      { label: "Field", items: [
        { kind: "cmd", id: "app.install", label: "Install" },
        { kind: "cmd", id: "app.touch", size: "sm", label: "Touch" },
      ] },
    ],
  },
  // Each command has one ribbon home. Everyday selection and edits stay on
  // Home, while geometry work has one dedicated Analyze tab.
  {
    id: "home",
    label: "Home",
    groups: [
      { label: "Assistant", items: [
        { kind: "cmd", id: "panel.ai" },
        { kind: "cmd", id: "ai.new", size: "sm", label: "New" },
      ] },
      { label: "Selection", items: [
        { kind: "cmd", id: "cam.fitsel" },
        { kind: "cmd", id: "sel.clear", size: "sm" },
      ] },
      { label: "Visibility", items: [
        { kind: "cmd", id: "vis.isolate" },
        { kind: "cmd", id: "vis.hide" },
        { kind: "cmd", id: "vis.all" },
        { kind: "cmd", id: "vis.undo", size: "sm", label: "Undo vis." },
        { kind: "cmd", id: "vis.redo", size: "sm", label: "Redo vis." },
      ] },
      { label: "Find", items: [
        { kind: "cmd", id: "vis.filters" },
        { kind: "cmd", id: "vis.clear", size: "sm", label: "Clear" },
      ] },
      { label: "Views", items: [
        { kind: "cmd", id: "view.open", label: "Views" },
        { kind: "cmd", id: "view.save", size: "sm", label: "Save" },
        { kind: "cmd", id: "file.viewpoint", size: "sm", label: "Viewpoint" },
      ] },
      { label: "Inspect", items: [
        { kind: "cmd", id: "panel.structure", label: "Structure" },
        { kind: "cmd", id: "panel.types", size: "sm" },
        { kind: "cmd", id: "panel.summary", size: "sm" },
        { kind: "cmd", id: "panel.props", size: "sm", label: "Props" },
      ] },
      { label: "Edit", items: [
        { kind: "cmd", id: "edit.undo", size: "sm" },
        { kind: "cmd", id: "edit.redo", size: "sm" },
        { kind: "cmd", id: "edit.rename", size: "sm" },
        { kind: "cmd", id: "edit.property", size: "sm", label: "Property" },
        { kind: "cmd", id: "edit.apply", size: "sm" },
        { kind: "cmd", id: "edit.discard", size: "sm" },
        { kind: "cmd", id: "edit.delete", size: "sm" },
      ] },
    ],
  },
  {
    id: "view",
    label: "View",
    groups: [
      { label: "Camera", items: [
        { kind: "cmd", id: "cam.fit" },
        { kind: "cmd", id: "cam.front", size: "sm" },
        { kind: "cmd", id: "cam.top", size: "sm" },
        { kind: "cmd", id: "cam.right", size: "sm" },
        { kind: "cmd", id: "cam.iso", size: "sm" },
        { kind: "cmd", id: "cam.back", size: "sm" },
        { kind: "cmd", id: "cam.left", size: "sm" },
        { kind: "cmd", id: "cam.bottom", size: "sm" },
      ] },
      // Ribbon labels are deliberately shorter than the command labels the
      // palette and tooltips show, so a tab fits without a scroll.
      { label: "Navigate", items: [
        { kind: "cmd", id: "cam.fly", label: "Fly" },
        { kind: "cmd", id: "cam.vr", label: "VR" },
        { kind: "cmd", id: "cam.ar", size: "sm", label: "AR" },
        { kind: "cmd", id: "cam.ortho", size: "sm", label: "Ortho" },
        { kind: "cmd", id: "cam.perp", size: "sm", label: "Perp." },
        { kind: "cmd", id: "cam.rotl", size: "sm", label: "Rot. left" },
        { kind: "cmd", id: "cam.rotr", size: "sm", label: "Rot. right" },
      ] },
      { label: "Display", items: [
        { kind: "cmd", id: "vis.ghost", size: "sm", label: "Ghost" },
        { kind: "cmd", id: "vis.spaces", size: "sm" },
        { kind: "cmd", id: "vis.openings", size: "sm" },
        { kind: "cmd", id: "vis.grids", size: "sm", label: "Grids" },
        { kind: "cmd", id: "vis.edges", size: "sm" },
      ] },
      { label: "Transparency", items: [
        { kind: "cmd", id: "vis.xray", label: "Transp." },
        { kind: "cmd", id: "vis.xrayrest", size: "sm", label: "Transp. rest" },
        { kind: "cmd", id: "vis.xrayclear", size: "sm", label: "Opaque" },
        { kind: "cmd", id: "vis.picksolid", size: "sm", label: "Ignore transp." },
        { kind: "cmd", id: "vis.showthrough", size: "sm", label: "See through" },
      ] },
      { label: "Render", items: [
        { kind: "control", build: buildScaleControl },
        { kind: "cmd", id: "tool.hud", size: "sm" },
        { kind: "cmd", id: "app.theme", size: "sm" },
      ] },
    ],
  },
  {
    id: "analyze",
    label: "Analyze",
    groups: [
      { label: "Measure", items: [
        { kind: "cmd", id: "tool.measure" },
        { kind: "cmd", id: "analysis.smart-measure", label: "Smart" },
      ] },
      { label: "Cut", items: [
        { kind: "cmd", id: "tool.section" },
        { kind: "cmd", id: "tool.box", label: "Box" },
        { kind: "cmd", id: "tool.plan", size: "sm" },
        { kind: "cmd", id: "analysis.section-workspace", size: "sm", label: "Drawing" },
      ] },
      { label: "Inspect", items: [
        { kind: "cmd", id: "cam.fitsel" },
        { kind: "cmd", id: "vis.isolate", size: "sm" },
        { kind: "cmd", id: "panel.props", size: "sm", label: "Props" },
      ] },
      { label: "Geometry", items: [
        { kind: "cmd", id: "analysis.clash", label: "Clash" },
        { kind: "cmd", id: "analysis.alignment", size: "sm", label: "Drive" },
        { kind: "cmd", id: "analysis.point-cloud", size: "sm", label: "Scan" },
        { kind: "cmd", id: "analysis.geo", size: "sm", label: "Geo" },
        { kind: "cmd", id: "analysis.health", size: "sm", label: "Health" },
        { kind: "cmd", id: "analysis.compare", size: "sm", label: "Compare" },
        { kind: "cmd", id: "analysis.takeoff", size: "sm" },
      ] },
      { label: "Requirements", items: [
        { kind: "cmd", id: "analysis.ids", label: "IDS" },
        { kind: "cmd", id: "analysis.rules", label: "Rules" },
        { kind: "cmd", id: "analysis.ids-studio", size: "sm", label: "Author" },
        { kind: "cmd", id: "analysis.schedule-4d", size: "sm", label: "4D" },
      ] },
    ],
  },
  {
    id: "sheets",
    label: "Sheets",
    groups: [
      { label: "Drawing set", items: [
        { kind: "cmd", id: "sheets.open", label: "Sheets" },
        { kind: "cmd", id: "analysis.section-workspace", size: "sm", label: "Section" },
        { kind: "cmd", id: "tool.plan", size: "sm" },
      ] },
      { label: "Output", items: [
        { kind: "cmd", id: "file.plan", label: "Plan PNG" },
        { kind: "cmd", id: "file.screenshot", size: "sm", label: "Image" },
      ] },
      { label: "Issues", items: [
        { kind: "cmd", id: "bcf.new" },
        { kind: "cmd", id: "panel.bcf", size: "sm" },
      ] },
    ],
  },
  {
    id: "review",
    label: "Review",
    groups: [
      { label: "Quality", items: [
        { kind: "cmd", id: "file.check" },
        { kind: "cmd", id: "analysis.rules", label: "Rules" },
        { kind: "cmd", id: "file.conformance", size: "sm", label: "Conformance" },
        { kind: "cmd", id: "panel.ids", size: "sm" },
      ] },
      { label: "Issues", items: [
        { kind: "cmd", id: "bcf.new" },
        { kind: "cmd", id: "panel.bcf", size: "sm" },
        { kind: "cmd", id: "analysis.presentation", size: "sm", label: "Present" },
      ] },
      { label: "Findings", items: [
        { kind: "cmd", id: "panel.results", label: "Results" },
      ] },
      { label: "Convert", items: [
        { kind: "cmd", id: "file.convert" },
      ] },
      { label: "Report", items: [
        { kind: "cmd", id: "analysis.report-builder", label: "Builder" },
        { kind: "cmd", id: "file.report", size: "sm", label: "Session" },
      ] },
    ],
  },
];

function buildScaleControl(): RibbonControl {
  const select = h("select", { class: "rib-select", title: "Render scale", "aria-label": "Render scale" });
  for (const [value, label] of [["0.5", "50%"], ["0.75", "75%"], ["1", "100%"], ["1.5", "150%"], ["2", "200%"]]) {
    select.appendChild(h("option", { value, text: label }));
  }
  select.value = String(settings.scale);
  select.addEventListener("change", () => {
    settings.scale = Number(select.value) || 1;
    setScale.value = select.value;
    viewer.setRenderScale(settings.scale);
    persistSettings();
  });
  return {
    el: h("div", { class: "rib-field" }, [h("label", { text: "Render scale" }), select]),
    // The same value lives in the Settings dialog; whichever is edited, this
    // reads the stored one back rather than showing the value it was built at.
    sync: () => {
      const stored = String(settings.scale);
      if (select.value !== stored) select.value = stored;
    },
  };
}

const ribbon = new Ribbon($("ribbon-tabs"), $("ribbon"), registry, RIBBON);
// The status bar mirrors the same state the ribbon reads, so it repaints with it.
ribbon.onSync = syncViewState;
filters.onChange(() => syncViewState());
viewer.onModelLoaded(() => setActiveViewName(""));
syncViewState();

viewer.onXrChange((mode) => {
  ribbon.sync();
  if (mode) shell.log("Immersive session running. Take the headset off or press the browser's exit control to come back.", "info", true);
});

viewer.onFlyChange((on) => {
  ribbon.sync();
  if (on) shell.log("Fly mode: WASD moves, Q/E down and up, wheel zooms, Shift+wheel sets speed, the plan shows where you are, Esc exits", "info", true);
});

// ---------------------------------------------------------------------------
// Command palette: registry commands plus the model's own element classes
const palette = new CommandPalette(() => [
  ...registry.all(),
  ...Object.entries(elementCounts(viewer))
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => ({
      id: `iso.${name}`,
      label: `Isolate ${name}`,
      icon: "focus",
      sub: count.toLocaleString(),
      section: "Model",
      run: () => isolateByType(name),
    })),
], (query) => universalSearch(query));

/**
 * Everything in the session, reachable from one keystroke: saved views,
 * element names and GlobalIds, property values, and the sheets that have been
 * imported. The property index answers the last two only once it exists, so
 * the palette never triggers a several-thousand-element read of its own.
 */
function universalSearch(query: string): Array<{ id: string; label: string; icon: string; sub?: string; section: string; run: () => void }> {
  const lower = query.toLowerCase();
  const out: Array<{ id: string; label: string; icon: string; sub?: string; section: string; run: () => void }> = [];

  for (const view of readSavedViews()) {
    if (!`${view.name} ${view.folder}`.toLowerCase().includes(lower)) continue;
    out.push({
      id: `view.${view.id}`,
      label: view.name,
      icon: "bookmark",
      sub: view.folder || "Saved view",
      section: "Views",
      run: () => void viewsPane().then((pane) => pane.run(view)).catch(reportError),
    });
    if (out.length > 6) break;
  }

  if (!viewer.getStats()) return out;

  const index = plugins.index();
  if (index.ready()) {
    let seen = 0;
    for (const row of index.all()) {
      if (seen >= 12) break;
      const hit =
        row.globalId.toLowerCase() === lower ? `GlobalId ${row.globalId}`
        : row.name.toLowerCase().includes(lower) ? row.storey || row.type
        : matchingProperty(row, lower);
      if (!hit) continue;
      seen++;
      out.push({
        id: `element.${row.id}`,
        label: row.name || `${row.type.replace(/^Ifc/, "")} #${row.id}`,
        icon: "cube",
        sub: hit,
        section: "Elements",
        run: () => {
          viewer.select(row.id);
          viewer.fitToElement(row.id);
          shell.selectTab("properties");
        },
      });
    }
    return out;
  }

  // Before the index exists, names from the spatial tree are the honest answer.
  const search = buildIndex(elementsOf(viewer.getSpatialTree()));
  for (const hit of search.search(query, 10)) {
    out.push({
      id: `element.${hit.id}`,
      label: hit.name || `${hit.type.replace(/^Ifc/, "")} #${hit.id}`,
      icon: "cube",
      sub: hit.storey || hit.type,
      section: "Elements",
      run: () => {
        viewer.select(hit.id);
        viewer.fitToElement(hit.id);
        shell.selectTab("properties");
      },
    });
  }
  return out;
}

/** The first property whose value contains the query, for the result subtitle. */
function matchingProperty(row: { props: Record<string, unknown> }, lower: string): string {
  for (const [key, value] of Object.entries(row.props)) {
    if (value === null || value === undefined || value === "") continue;
    const text = String(value);
    if (text.toLowerCase().includes(lower)) return `${key} = ${text}`;
  }
  return "";
}

/** Saved views without building the pane, so the palette works before it opens. */
function readSavedViews(): ViewDefinition[] {
  try {
    return new ViewStore().list();
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Plugins. The panel is the catalog until something is running, and the status
// bar toggle opens the full browser. First-party analysis workflows also have
// direct commands so they are discoverable without browsing the catalog.
/** A refused command explains itself; a silent chip teaches nothing. */
function runCommandOrExplain(id: string): void {
  if (registry.run(id)) return;
  toast(id.startsWith("edit.") ? "Select an element first" : "Open a model first", "info");
}

const installedExtensions = new InstalledExtensionManager();
installedExtensions.reserve(CATALOG.map((plugin) => plugin.id));

const plugins = new PluginHost(
  $("tab-plugins"),
  viewer,
  service,
  {
    list: () => viewerCapabilities.list((capability) => capability.exposure.sdk === true).map((capability) => ({
      id: capability.id,
      title: capability.title,
      description: capability.description,
      effect: capability.effect,
      cost: capability.cost,
      parallelSafe: capability.parallelSafe,
    })),
    execute: <T,>(id: string, input: Record<string, unknown> = {}, signal?: AbortSignal) =>
      viewerCapabilities.executeValue<T>(id, input, viewerCapabilityContext, {
        policy: VIEWER_POLICY,
        signal,
      }),
  },
  {
    showPanel: () => shell.selectTab("plugins"),
    setPanelVisible: () => undefined,
    log: (text, kind) => shell.log(text, kind),
    runCommand: runCommandOrExplain,
    registerCommand: (contribution, run) => registry.register({
      id: contribution.id,
      label: contribution.title,
      icon: contribution.icon,
      shortcut: contribution.shortcut,
      section: "Extensions",
      run,
    }),
    createIssue: (input) => raiseIssue(input.title, input.elementIds ?? [], input),
    setActiveResult: (id) => {
      activeAssistantResult = id;
      focusedAssistantRow = undefined;
    },
    // Match the assistant result revision exactly so extension-created rows
    // can be paged and grouped by follow-up tools without a false stale error.
    modelKey: () => viewer.isReady() ? modelRevision(viewer) : "",
    modelName: () => fileName,
    python: pythonFacet,
    setColorRule: (rule) => dock.setColorRule(rule),
    changed: () => {
      syncPluginToggle();
      refreshAssistantEngine();
    },
  },
  (id) => pluginBrowser.open(id),
  assistantCapabilities.results,
);

const pluginBrowser = new PluginBrowser(plugins, service, {
  runCommand: runCommandOrExplain,
  openConnection: () => connection.open(),
}, installedExtensions);

dock.onOpenSmartMeasure = openSmartMeasure;
dock.onOpenSectionWorkspace = () => void plugins.open("section-workspace");

const installedCommands = new Map<string, () => void>();

function syncInstalledExtensions(): void {
  setInstalledExtensions(installedExtensions.list(), (id) => installedExtensions.loadModule(id));
  for (const remove of installedCommands.values()) remove();
  installedCommands.clear();
  for (const installation of installedExtensions.list()) {
    if (!installation.enabled || installation.sessionDisabled) continue;
    const manifest = activeInstalledVersion(installation).manifest;
    for (const contribution of manifest.contributes.commands ?? []) {
      try {
        installedCommands.set(contribution.id, registry.register({
          id: contribution.id,
          label: contribution.title,
          icon: contribution.icon,
          shortcut: contribution.shortcut,
          section: "Extensions",
          run: () => void plugins.open(manifest.id, true, { type: "command", id: contribution.id }),
        }));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        installedExtensions.audit.record({ extensionId: manifest.id, action: "command.register", outcome: "failed", detail });
        shell.log(`${manifest.name}: ${detail}`, "error");
      }
    }
  }
  plugins.catalogChanged();
  pluginBrowser.refresh();
}

installedExtensions.onChange((change) => {
  const reload = change.id !== "*" && plugins.isOpen(change.id) &&
    (change.kind === "updated" || change.kind === "rolled-back");
  if (change.id !== "*" && (reload || change.kind === "disabled" || change.kind === "uninstalled" || change.kind === "session-disabled")) {
    plugins.close(change.id);
  }
  syncInstalledExtensions();
  // Saved installed panels are not discoverable until initialize() has
  // populated the runtime catalog. Restore only after that catalog sync;
  // PluginHost.open() is idempotent if startup is signalled more than once.
  if (change.kind === "initialized") plugins.restore();
  if (reload) void plugins.open(change.id, false, { type: "reload" });
});

void installedExtensions.initialize().then(() => {
  const devUrl = new URL(location.href).searchParams.get("extensionDev");
  if (devUrl) void installedExtensions.connectDevelopment(devUrl).catch((error) => {
    toast(error instanceof Error ? error.message : String(error), "error");
  });
}).catch((error) => {
  shell.log(`Installed extensions could not start: ${error instanceof Error ? error.message : String(error)}`, "error");
});

// One way in, in the top bar with the other app-wide controls: the catalog is
// not a per-model thing, so it does not belong in the status bar.
const pluginCount = h("span", { class: "plug-count hidden" });
const pluginToggle = h("button", {
  class: "icon-btn plug-btn",
  type: "button",
  title: "Plugins: Python console, clash detection, takeoff, explorer, compare and the Local Studio add-ons",
  "aria-label": "Plugins",
}, [icon("blocks"), pluginCount]);
pluginToggle.addEventListener("click", () => pluginBrowser.open());
shell.topSlot.append(pluginToggle);

function syncPluginToggle(): void {
  const count = plugins.count();
  pluginCount.textContent = String(count);
  pluginCount.classList.toggle("hidden", count === 0);
  pluginToggle.setAttribute("aria-pressed", String(count > 0));
  // Opening the console does not grant the assistant anything, but the chip
  // reads the same state, so keep it honest whenever plugins move.
  refreshAssistantEngine();
}

syncPluginToggle();
viewer.onModelLoaded(() => plugins.modelChanged());
dock.setPropertyIndex(() => plugins.index());
viewer.onModelLoaded(() => dock.resetColors());
viewer.onModelLoaded(() => assistantUi?.setSuggestions(modelSuggestions()));
viewer.onSelectionChange(() => syncAttachment());

// ---------------------------------------------------------------------------
// Selection, status, context menu
viewer.onModelLoaded(() => {
  summaryDirty = true;
  updateModelChrome();
  if (paneVisible("summary")) renderSummary();
  typesUi?.render();
  scheduleUi?.refreshTypes();
  void viewer.getCountsByType();
});

// The type list mirrors viewer state, so it repaints whenever that state moves.
viewer.onVisibilityChange(() => {
  if (typesUi && paneVisible("types")) typesUi.render();
});

viewer.onSelectionChange((id) => {
  ribbon.sync();
  if (id === null) return shell.setSelection(null);
  // One element reads by name; a set reads by count, with the last one named.
  const count = viewer.getSelectedIds().length;
  const many = count > 1 ? `${count} selected · ` : "";
  shell.setSelection(`${many}#${id}`);
  void viewer.getProperties(id).then((props) => {
    if (!props || viewer.getSelection() !== id) return;
    const name = props.attributes.find((a) => a.name === "Name")?.value;
    shell.setSelection(many + (name ? `${props.type} · ${String(name)}` : props.type));
  });
});

let lastFrameUpdate = 0;
viewer.onRenderTick(() => {
  const now = performance.now();
  if (now - lastFrameUpdate < 250) return;
  lastFrameUpdate = now;
  shell.setFrameTime(`${viewer.getRenderTiming().lastMs.toFixed(1)} ms`);
});

// Right-drag pans the camera; only a stationary right-click is a menu.
let rightDown: [number, number] = [0, 0];
let contextSeq = 0;
shell.viewerHost.addEventListener("pointerdown", (e) => {
  if (e.button === 2) rightDown = [e.clientX, e.clientY];
});

shell.viewerHost.addEventListener("contextmenu", (e) => {
  e.preventDefault();
  const mine = ++contextSeq;
  if (Math.hypot(e.clientX - rightDown[0], e.clientY - rightDown[1]) > 5) return;
  const pick = viewer.pickAt(e.clientX, e.clientY);
  if (!pick) {
    showContextMenu(e.clientX, e.clientY, null, [
      { label: "Frame model", run: () => viewer.fitToModel() },
      { label: "Show all", run: () => viewer.showAll() },
    ]);
    return;
  }
  // Right-clicking inside a multi-selection keeps it, so the verbs below act
  // on everything the user picked; right-clicking elsewhere selects that one.
  if (!viewer.getSelectedIds().includes(pick.expressID)) viewer.select(pick.expressID);
  void viewer.getProperties(pick.expressID).then((props) => {
    if (mine !== contextSeq || !viewer.getSelectedIds().includes(pick.expressID)) return;
    const type = props?.type ?? "Element";
    const count = viewer.getSelectedIds().length;
    const scope = count > 1 ? ` (${count})` : "";
    const title = h("span", {}, [
      h("b", { text: type }),
      h("span", { class: "mono", text: `#${pick.expressID}` }),
    ]);
    showContextMenu(e.clientX, e.clientY, title, [
      { label: "Frame element", run: () => viewer.fitToElement(pick.expressID) },
      { label: `Isolate${scope}`, run: () => viewer.isolateSelected() },
      { label: `Hide${scope}`, run: () => viewer.hideSelected() },
      { separator: true },
      ...(count === 2 ? [{ label: "Measure shortest clearance", run: openSmartMeasure }] : []),
      { label: `Section box around selection${scope}`, run: sectionBoxAroundSelection },
      { label: "Cut on this face", run: () => { if (!viewer.addSectionFromPick()) toast("No usable face normal here", "info"); } },
      {
        label: "Add note here",
        run: () => promptForm("Add note", [{ key: "text", label: "Note", value: "", placeholder: "What should this say?" }], "Add", (values) => {
          if (!values.text?.trim()) return void toast("A note needs text", "info");
          viewer.addAnnotation({ text: values.text, at: pick.point, elementId: pick.expressID });
          toast("Note added", "success");
        }),
      },
      { label: "Open section drawing", run: () => void plugins.open("section-workspace") },
      { separator: true },
      { label: `Isolate all ${type}`, run: () => isolateByType(type) },
      { label: "Show all", run: () => viewer.showAll() },
      { separator: true },
      { label: `Rename${scope}…`, run: renameSelection },
      { label: `Set property${scope}…`, run: setPropertyOnSelection },
      { label: `Delete${scope}…`, run: deleteSelection },
      { separator: true },
      { label: "Properties", run: () => shell.selectTab("properties") },
      ...((): Array<{ label: string; run: () => void }> => {
        const guid = props?.attributes.find((a) => a.name === "GlobalId")?.value;
        return typeof guid === "string" && guid
          ? [{
              label: "Copy GUID",
              run: () => {
                void copyText(guid, "GUID copied");
              },
            }]
          : [];
      })(),
      {
        label: "Copy express ID",
        run: () => {
          void copyText(String(pick.expressID), "Express ID copied");
        },
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// MCP bridge (browser as a tool backend for AI clients)
const bridge = new BridgeClient({
  onStatus: (status, detail) => {
    if (detail) shell.log(detail, status === "disconnected" ? "error" : "info");
  },
});
bridge.register("get_status", () => ({
  loaded: activeBytes !== null,
  fileName,
  schema: schemaName,
  // The sha tells the service it may run natively against its own copy.
  sha: service.getSha(),
  mode: service.mode(),
  pendingEdit: pendingEdit ? pendingEdit.summary : null,
}));
bridge.register("get_model_info", async () => ({
  fileName,
  schema: schemaName,
  stats: viewer.getStats(),
  countsByType: await viewer.getCountsByType(),
}));
bridge.register("get_spatial_tree", () => {
  const tree = viewer.getSpatialTree();
  if (!tree) throw new Error("no model loaded");
  return tree;
});
bridge.register("get_selection", () => ({ expressId: viewer.getSelection() }));
bridge.register("select_element", (params) => {
  const id = Number(params.express_id);
  if (!Number.isFinite(id)) throw new Error("express_id required");
  viewer.select(id);
  viewer.fitToElement(id);
  return { selected: id };
});
bridge.register("get_properties", async (params) => {
  const id = Number(params.express_id);
  const props = await viewer.getProperties(id);
  if (!props) throw new Error(`no properties for express_id ${id}`);
  return props;
});
bridge.register("set_visibility", (params) => {
  const id = Number(params.express_id);
  if (!Number.isFinite(id) || id <= 0) throw new Error("express_id required");
  viewer.setSubtreeVisible(id, Boolean(params.visible));
  return { expressId: id, visible: Boolean(params.visible) };
});
bridge.register("show_all", () => {
  viewer.showAll();
  return { ok: true };
});
bridge.register("fit_view", (params) => {
  const id = Number(params.express_id);
  if (Number.isFinite(id) && id > 0) viewer.fitToElement(id);
  else viewer.fitToModel();
  return { ok: true };
});
/**
 * Everything the in-tab assistant can do is reachable over the bridge too,
 * and through the same runner rather than a second copy of it, so an external
 * client and the panel cannot drift apart. Edit-tier actions are deliberately
 * absent: an MCP client stages nothing the user has not seen.
 */
const bridgedCapabilities = viewerCapabilities.list((capability) => capability.exposure.mcp === true);
for (const capability of bridgedCapabilities) {
  const name = capability.id;
  bridge.register(name, async (params) => {
    const value = await viewerCapabilities.executeValue(name, params, viewerCapabilityContext, {
      policy: VIEWER_POLICY,
    });
    return typeof value === "string" ? { report: value } : value;
  });
}
bridge.register("capture_view", async (params) => {
  const width = Number(params.max_width);
  const blob = await viewer.captureImage(Number.isFinite(width) && width > 0 ? Math.min(width, 2048) : 1024, "image/png");
  if (!blob) throw new Error("nothing to capture");
  const buffer = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (const byte of buffer) binary += String.fromCharCode(byte);
  const viewport = viewer.getViewport();
  return { mimeType: "image/png", base64: btoa(binary), width: viewport.width, height: viewport.height };
});
bridge.register("list_viewpoints", () => {
  const key = viewpointKey(viewer);
  return { viewpoints: key ? readViewpoints(key).map((view) => view.name) : [] };
});
bridge.register("save_viewpoint", (params) => {
  const name = storeViewpoint(viewer, typeof params.name === "string" ? params.name : undefined);
  if (!name) throw new Error(viewpointKey(viewer) ? "browser could not persist viewpoint" : "no model loaded");
  return { saved: name };
});
// No run_python here on purpose. An MCP client is an AI client, and generated
// code is never executed for one, in this tab or anywhere else. MCP reads the
// model and stages typed edits; arbitrary Python belongs to the user and to the
// Python Console, which only a human click starts.

// ---------------------------------------------------------------------------
// Input: files, drag and drop, keyboard
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) replaceOrConfirm(() => void openFile(file).catch(reportError));
  fileInput.value = "";
});

interface FileLaunchQueue {
  setConsumer(consumer: (params: { files: FileSystemFileHandle[] }) => void | Promise<void>): void;
}

const launchQueue = (globalThis as typeof globalThis & { launchQueue?: FileLaunchQueue }).launchQueue;
launchQueue?.setConsumer(async ({ files }) => {
  const handle = files[0];
  if (!handle) return;
  try {
    const file = await handle.getFile();
    if (!/\.(ifc|ifcx|ifcpkg)$/i.test(file.name)) throw new Error(`${file.name} is not a supported IFC file`);
    replaceOrConfirm(() => void openFile(file).catch(reportError));
  } catch (error) {
    reportError(error);
  }
});
attachInput.addEventListener("change", () => {
  const file = attachInput.files?.[0];
  if (file) void attachFile(file).catch(reportError);
  attachInput.value = "";
});
$("btn-open-first").addEventListener("click", () => fileInput.click());
$("btn-sample").addEventListener("click", () => replaceOrConfirm(() => void openSample().catch(reportError)));

let dragDepth = 0;
window.addEventListener("dragenter", (e) => {
  e.preventDefault();
  dragDepth += 1;
  showDropzone();
  dropzone.classList.add("dragging");
});
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("dragleave", () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) {
    dropzone.classList.remove("dragging");
    if (activeBytes) dropzone.classList.add("hidden");
  }
});
window.addEventListener("drop", (e) => {
  e.preventDefault();
  dragDepth = 0;
  dropzone.classList.remove("dragging");
  if (activeBytes) dropzone.classList.add("hidden");
  const file = e.dataTransfer?.files?.[0];
  if (!file) return void toast("Drop an .ifc, .ifcx or .ifcpkg file", "info");
  if (!/\.(ifc|ifcx|ifcpkg)$/i.test(file.name)) {
    return void toast(`${file.name} is not a supported IFC file`, "error");
  }
  replaceOrConfirm(() => void openFile(file).catch(reportError));
});

window.addEventListener("keydown", (e) => {
  const target = e.target as HTMLElement | null;
  // A modal dialog owns the keyboard: the app behind it is inert, so a stray
  // S would download a screenshot of a viewport nobody can see.
  if (document.querySelector("dialog[open]")) return;
  const typing =
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement ||
    target instanceof HTMLSelectElement ||
    target?.isContentEditable === true;
  const interactive = Boolean(target?.closest(
    "button, a[href], summary, [role='button'], [role='menu'], [role='listbox'], [role='tree']",
  ));

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return palette.toggle();
  }
  // Esc is handled inside viewer-core (close popover / clear selection / exit
  // measure); this only resyncs the controls that mirror that state.
  if (e.key === "Escape") return syncTools();
  if (typing || interactive || palette.isOpen()) return;
  registry.handleKey(e);
});

// F / H / I / A / Esc stay owned by viewer-core's own key handler.

updateModelChrome();
void renderRecents();
void openFromParam();
// The probe is a localhost round trip; keep it off the first-paint path.
if (window.requestIdleCallback) window.requestIdleCallback(() => void probeService(), { timeout: 1500 });
else setTimeout(() => void probeService(), 300);
