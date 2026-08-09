// IFCViewX shell: wires the viewer, the local service (conversion + native
// IfcOpenShell), the browser Python fallback, and the assistant.
// App-level state lives here: active model bytes, checkpoints, and the
// pending-edit lifecycle. Edits only land on an explicit Apply.
import "./styles.css";
import { createViewer } from "./viewer-core/viewer.js";
import { listCachedModels, loadCachedSource, storeSourceBytes, type CachedModel } from "./viewer-core/engine/cache.js";
import type { LoadProgress } from "./viewer-core/engine/types.js";
import { PythonEngine, type ProposedEdit } from "./python/pythonEngine.js";
import { IfcEngine, type EditOp, type ValidationReport } from "./ifc/ifcEngine.js";
import { clashReport } from "./ifc/clash.js";
import { isStep, sniffSchema, worthConverting } from "./ifc/format.js";
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
import { FilterChip, FilterPanel, FilterStore } from "./ui/filters.js";
import type { IdsPanel } from "./ui/ids.js";
import type { BcfPanel } from "./ui/bcf.js";
import { Shell, emptyState, type PaneId, type TabId } from "./ui/shell.js";
import { Dock, readViewpoints, saveViewpoint as storeViewpoint, viewpointKey } from "./ui/dock.js";
import { Connection } from "./ui/connection.js";
import { CommandRegistry } from "./ui/commands.js";
import { Ribbon, type RibbonControl, type RibbonTab } from "./ui/ribbon.js";
import type { SchedulePanel } from "./ui/schedules.js";
import { buildMenu, busyRow, CommandPalette, confirmAction, h, icon, lightDismiss, menuKeys, openLayer, promptForm, showContextMenu, toast, type MenuItem } from "./ui/kit.js";
import { ageLabel, clearChats, readChats, saveChat, type Conversation } from "./llm/chatStore.js";
import { sampleModel, SAMPLE_NAME } from "./ui/sample.js";
import { download } from "./sdk/data.js";
import type { PluginPython } from "./sdk/types.js";
import type { ExtensionIssueInput, ExtensionIssueResult } from "./sdk/v2/types.js";
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
  settings = { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? "{}") as Partial<Settings>) };
} catch {
  settings = DEFAULTS;
}
const persistSettings = (): void => localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));

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
let filterUi: FilterPanel | null = null;
let idsUi: IdsPanel | null = null;
let bcfUi: BcfPanel | null = null;
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
      onEvidence: (reference) => openEvidence(reference),
      onIssueProposal: (payload) => void acceptIssueProposal(payload),
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

/** The schedule panel only exists in Local Studio, so it loads on demand. */
async function schedulePanel(): Promise<SchedulePanel> {
  if (!scheduleUi) {
    const { SchedulePanel } = await import("./ui/schedules.js");
    scheduleUi = new SchedulePanel($("tab-schedule"), {
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

function filterPanel(): FilterPanel {
  if (!filterUi) filterUi = new FilterPanel($("tab-filters"), viewer, filters);
  return filterUi;
}

/** IDS and BCF are dead weight until asked for, so they arrive on demand. */
async function idsPanel(): Promise<IdsPanel> {
  if (!idsUi) {
    const { IdsPanel } = await import("./ui/ids.js");
    idsUi = new IdsPanel($("tab-ids"), {
      viewer,
      isolate: (label, ids) => void filters.add({ label, mode: "keep", ids }),
      report: (title, ids) => void raiseIssue(title, ids).catch(reportError),
      log: (message, kind) => shell.log(message, kind),
      // The assistant's `ids` action checks whatever is loaded here, so the
      // tool list has to learn about it the moment the file lands.
      changed: () => {
        idsLoaded = true;
        refreshAssistantEngine();
      },
    });
  }
  return idsUi;
}

async function bcfPanel(): Promise<BcfPanel> {
  if (!bcfUi) {
    const { BcfPanel } = await import("./ui/bcf.js");
    bcfUi = new BcfPanel($("tab-bcf"), {
      viewer,
      modelName: () => fileName,
      log: (message, kind) => shell.log(message, kind),
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
  const issueId = panel.capture(title, description, { elementIds: ids, priority: input.priority });
  if (!issueId) throw new Error("The issue could not be created");
  shell.selectTab("bcf");
  return { id: issueId, title: title || "New issue", status: "Open", snapshot: "pending" };
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
  else if (tab === "ids") mountLazy(tab, idsPanel);
  else if (tab === "bcf") mountLazy(tab, bcfPanel);
  else if (tab === "schedule") mountLazy(tab, schedulePanel);
}

/** The type list is built the first time it is shown, like the tabs above. */
let typesUi: TypesPane | null = null;

function types(): TypesPane {
  if (!typesUi) typesUi = new TypesPane($("pane-types"), viewer, isolateByType);
  return typesUi;
}

const paneVisible = (pane: PaneId): boolean => !$(`pane-${pane}`).classList.contains("hidden");

function showPane(pane: PaneId): void {
  shell.setOutlinerPane(pane);
  if (pane === "summary") renderSummary();
  else if (pane === "types") types().render();
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
  localStorage.setItem("ifcviewx.theme", next);
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
  activeAssistantResult = "";
  focusedAssistantRow = undefined;
  showDropzone();
}

/** A second open supersedes the first; only the newest one owns the chrome. */
let loadSeq = 0;
/** applyPending reloads with its own edit staged; every other load drops it. */
let applying = false;

async function loadBytes(bytes: Uint8Array, name: string, preserveCamera = false, adoptSha?: string): Promise<void> {
  const mine = ++loadSeq;
  // An edit staged against the model being replaced can never be applied to
  // the one arriving, so it goes with the model it was written for.
  if (pendingEdit && !applying) discardPending();
  const pose = preserveCamera ? viewer.getCamera() : null;
  shell.setStatus("Loading", "busy");
  loadingUi.show(name, () => viewer.cancelLoad());
  // Taken before the parser runs: viewer.load hands these bytes to a worker,
  // and a transferred buffer would leave the semantic engine with nothing.
  const step = isStep(bytes);
  const semanticCopy = step ? bytes.slice() : null;
  try {
    await viewer.load(bytes, { name, onProgress: (progress) => loadingUi.update(progress) });
  } catch (err) {
    // viewer.load drops whatever was on screen before it parses, so a failure
    // leaves an empty viewport. App state has to follow it down instead of
    // going on describing a model nobody can see any more.
    if (mine === loadSeq) {
      dropModelState();
      // The panels read the viewer, so they only follow the model down if the
      // viewer says it is gone. The error card is the one thing kept.
      viewer.unload({ keepError: true });
      updateModelChrome();
    }
    throw err;
  } finally {
    if (mine === loadSeq) loadingUi.hide();
  }
  if (mine !== loadSeq) return;
  if (pose) viewer.setCamera(pose);
  activeBytes = bytes;
  fileName = name;
  schemaName = sniffSchema(bytes);
  pythonSynced = false;
  summaryDirty = true;
  lastReport = null;
  assistantCapabilities.results.clear();
  activeAssistantResult = "";
  focusedAssistantRow = undefined;
  // .ifcx is our converted container, not STEP, so the semantic engine gets
  // the original bytes or nothing: it must never answer from a previous model.
  ifc.setModel(semanticCopy);
  streamedCategories.clear();
  if (!preserveCamera) { checkpoints = []; redoStack = []; }
  hideDropzone(true);
  updateModelChrome();
  // The tool catalog is gated on a model being open, so it has to be told.
  refreshAssistantEngine();
  if (python.isReady()) void syncPython().catch(() => undefined);
  // The service must hold whatever the viewer is showing, including after an
  // edit or an undo, so the hand-over lives on the single load path. A model
  // the service already stores (CLI-opened) is adopted instead of re-uploaded.
  service.forgetModel();
  if (adoptSha) {
    service.adoptModel(adoptSha);
    plugins.refresh();
  } else {
    void handOverModel();
  }
}

/** `ifcviewx model.ifc` stages the file and opens the viewer at ?open=<sha>. */
async function openFromParam(): Promise<void> {
  if (pendingEdit) discardPending();
  const params = new URLSearchParams(location.search);
  const sha = params.get("open");
  if (!sha || !/^[0-9a-f]{64}$/.test(sha)) return;
  const given = params.get("name") ?? "model.ifc";
  shell.setStatus("Loading", "busy");
  loadingUi.show(given);
  loadingUi.step("Reading it from Local Studio");
  try {
    const wasIfcx = given.toLowerCase().endsWith(".ifcx");
    let res = await fetch(`${service.origin}/models/${sha}.ifcx`);
    const gotIfcx = res.ok;
    if (!res.ok) res = await fetch(`${service.origin}/models/${sha}.ifc`);
    if (!res.ok) throw new Error("Local Studio no longer holds that model. Open it from disk instead.");
    const bytes = new Uint8Array(await res.arrayBuffer());
    const name = gotIfcx && !wasIfcx ? given.replace(/\.[^.]*$/, ".ifcx") : given;
    // The .ifc source in the store backs native Python and checks; a bare
    // .ifcx has no source, so nothing is adopted and the tier stays browser.
    await loadBytes(bytes, name, false, wasIfcx ? undefined : sha);
    shell.log(`Opened ${given} from Local Studio`, "success");
  } catch (err) {
    updateModelChrome();
    reportError(err);
  } finally {
    loadingUi.hide();
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
  if (pendingEdit) discardPending();
  await loadBytes(sampleModel(), SAMPLE_NAME);
  shell.log("Opened the sample building. Open your own file any time.", "success");
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
  const bytes = new Uint8Array(await file.arrayBuffer());
  shell.setStatus("Loading", "busy");
  loadingUi.show(file.name, () => viewer.cancelLoad());
  try {
    const added = await viewer.addModel(bytes, {
      name: file.name,
      onProgress: (progress) => loadingUi.update(progress),
    });
    shell.log(`Added ${file.name} as model ${added.index + 1}`, "success");
    summaryDirty = true;
    updateModelChrome();
  } finally {
    loadingUi.hide();
    shell.setStatus("Ready", "idle");
  }
}

async function openFile(file: File): Promise<void> {
  if (pendingEdit) discardPending();
  const bytes = new Uint8Array(await file.arrayBuffer());
  await loadBytes(bytes, file.name);
  void storeSourceBytes(bytes, file.name).then(renderRecents);
  shell.log(`Opened ${file.name}`, "success");
  // web-ifc draws every file here, so a multi-minute IfcOpenShell conversion
  // never blocks a load: the log only says when one would pay off.
  if (!settings.offerConvert || !worthConverting(bytes, file.name)) return;
  shell.log(
    canLocal("convert")
      ? "Large or brep-heavy model: Model ▸ Convert makes every reopen instant."
      : "Large or brep-heavy model: Local Studio converts it with IfcOpenShell for instant reopens.",
  );
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
  if (!staged && checkpoints.length === 0) return closeModel();
  confirmAction(
    "Close this model?",
    staged
      ? "The staged edit and the undo history are dropped. Export first to keep them."
      : "The undo history is dropped. Export first to keep the edits you applied.",
    "Close",
    closeModel,
  );
}

// The stacks move only once the reload has landed: a load that fails or is
// cancelled would otherwise take a checkpoint with it and leave nothing shown.
async function undo(): Promise<void> {
  const previous = checkpoints[checkpoints.length - 1];
  const current = activeBytes;
  if (!previous || !current) return;
  await loadBytes(previous, fileName, true);
  checkpoints.pop();
  redoStack.push(current);
  shell.log("Reverted to previous checkpoint", "info", true);
}

async function redo(): Promise<void> {
  const next = redoStack[redoStack.length - 1];
  const current = activeBytes;
  if (!next || !current) return;
  await loadBytes(next, fileName, true);
  redoStack.pop();
  checkpoints.push(current);
  shell.log("Redid the edit", "info", true);
}

function exportModel(): void {
  if (!activeBytes) return;
  download(fileName || "model.ifc", activeBytes as BlobPart, "application/x-step");
  shell.log(`Exported ${fileName}`, "success", true);
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
const pythonFacet: PluginPython = {
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
  applying = true;
  try {
    await loadBytes(edit.bytes, fileName, true);
  } finally {
    applying = false;
  }
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

function assistantSystem(messages: ChatMessage[], native: boolean): ChatMessage[] {
  const brief = buildModelBrief(viewer, fileName, schemaName);
  return [{ role: "system", content: systemPrompt(brief, assistantMode(), native) }, ...messages];
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

function openEvidence(reference: EvidenceReference): void {
  if (reference.resultId) {
    activeAssistantResult = reference.resultId;
    focusedAssistantRow = reference.row;
  }
  const ids = reference.elementIds?.filter((id) => viewer.hasGeometry(id)) ?? [];
  if (ids.length) {
    viewer.selectMany(ids, "replace");
    const box = viewer.boxAround(ids, 0.15);
    if (box) viewer.fitToPoint([
      (box.min[0] + box.max[0]) / 2,
      (box.min[1] + box.max[1]) / 2,
      (box.min[2] + box.max[2]) / 2,
    ]);
    shell.selectTab("properties");
  } else if (reference.point) {
    viewer.fitToPoint(reference.point);
  }
  shell.log(`Opened evidence ${reference.id}: ${reference.label}`, "info", true);
}

async function acceptIssueProposal(payload: Record<string, unknown>): Promise<void> {
  const ids = Array.isArray(payload.elementIds)
    ? payload.elementIds.map(Number).filter((id) => Number.isFinite(id) && id > 0)
    : [];
  await raiseIssue(String(payload.title ?? "Assistant issue"), ids);
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
  try {
    shell.setStatus("Converting", "busy");
    shell.log("Converting with IfcOpenShell, this can take minutes");
    loadingUi.show(`Converting ${fileName}`);
    await handOverModel();
    const source = service.getSha();
    const converted = await service.convert((text) => {
      shell.setHint(text);
      loadingUi.step(text);
    });
    await loadBytes(converted, fileName.replace(/\.ifc$/i, ".ifcx"));
    // The viewer now shows the .ifcx; native tools keep using the stored source.
    if (source) service.adoptModel(source);
    plugins.refresh();
    shell.log("Converted. This model now opens instantly.", "success", true);
  } catch (err) {
    reportError(err);
    updateModelChrome();
  } finally {
    loadingUi.hide();
  }
}

// ---------------------------------------------------------------------------
// Model checks (native, no generated code)
let lastReport: ValidationReport | null = null;
let checking = false;

async function validateModel(): Promise<void> {
  if (!activeBytes || checking) return toast(checking ? "The checks are already running" : "Open a model first", "info");
  shell.setStatus("Checking", "busy");
  // Shown before the wait, not after it: a pass over every entity takes
  // seconds, and the pane it lands in is where the user should be watching.
  checking = true;
  refreshSummary(true);
  ribbon.sync();
  try {
    lastReport = await ifc.validate();
    const { error, warning } = lastReport.counts;
    shell.log(
      `Model checks: ${error} error${error === 1 ? "" : "s"}, ${warning} warning${warning === 1 ? "" : "s"}`,
      error ? "error" : "success",
      true,
    );
  } finally {
    checking = false;
    refreshSummary();
    updateModelChrome();
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
  if (pendingEdit) discardPending();
  void loadCachedSource(sha)
    .then((bytes) => {
      if (!bytes) {
        toast(`${name} is no longer cached. Open it from disk.`, "info");
        return renderRecents();
      }
      return loadBytes(bytes, name).then(() => shell.log(`Opened ${name}`, "success"));
    })
    .catch(reportError);
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
  openDialog(settingsDialog);
}

// ---------------------------------------------------------------------------
// Commands: one definition each, used by the ribbon, palette and keyboard
const hasModel = (): boolean => activeBytes !== null;
const registry = new CommandRegistry();

registry.add([
  { id: "file.open", label: "Open", icon: "folder", section: "File", shortcut: "Ctrl+O", hint: "Open an IFC or .ifcx file", run: () => fileInput.click() },
  { id: "file.attach", label: "Add model", icon: "layers", section: "File", hint: "Load a second model beside this one", enabled: hasModel, run: () => attachInput.click() },
  { id: "file.sample", label: "Sample model", icon: "cube", section: "File", hint: "A small two-storey building, generated here, to try the viewer on", run: () => void openSample().catch(reportError) },
  { id: "file.export", label: "Export", icon: "download", section: "File", hint: "Download the active IFC", enabled: hasModel, run: exportModel },
  { id: "file.close", label: "Close", icon: "x", section: "File", enabled: hasModel, run: closeOrConfirm },
  { id: "file.screenshot", label: "Screenshot", icon: "camera", section: "File", shortcut: "S", enabled: hasModel, run: () => { viewer.screenshot(); shell.log("Screenshot saved", "success", true); } },
  { id: "file.viewpoint", label: "Viewpoint", icon: "bookmark", section: "File", shortcut: "V", enabled: hasModel, run: saveViewpoint },
  { id: "file.convert", label: "Convert", icon: "refresh", section: "Local Studio", tier: "local", available: () => canLocal("convert"), hint: "IfcOpenShell → .ifcx, then reopens are instant", enabled: hasModel, run: () => void convertWithService() },
  { id: "file.check", label: "Checks", icon: "shield", section: "Review", hint: "Structural QA in this tab, no generated code", enabled: () => hasModel() && !checking, run: () => void validateModel().catch(reportError) },
  { id: "file.schedule", label: "Schedule", icon: "table", section: "Review", hint: "Tabular export of a class, with pset columns resolved through the type", enabled: hasModel, run: () => shell.selectTab("schedule") },
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

  { id: "tool.measure", label: "Measure", icon: "ruler", section: "Tools", shortcut: "M", pressed: () => viewer.isMeasuring(), run: toggleMeasure },
  { id: "tool.section", label: "Section", icon: "section", section: "Tools", shortcut: "X", hint: "Slice on X, Y and Z", pressed: () => viewer.getSections().length > 0, run: toggleSection },
  { id: "tool.box", label: "Section box", icon: "cube", section: "Tools", shortcut: "B", hint: "Six planes at once, around the selection", enabled: hasModel, pressed: () => viewer.getSectionBox() !== null, run: toggleSectionBox },
  { id: "tool.plan", label: "2D plan", icon: "layers", section: "Tools", shortcut: "G", hint: "Floorplan inset, cut by the horizontal section. Click it to select in 3D", enabled: hasModel, pressed: () => viewer.isPlanView(), run: togglePlan },
  { id: "tool.hud", label: "Perf HUD", icon: "gauge", section: "Tools", pressed: () => settings.hud, run: () => setHud(!settings.hud) },

  { id: "panel.tree", label: "Structure", icon: "panel-left-close", section: "Panels", shortcut: "Ctrl+B", pressed: () => shell.isPanelOpen("outliner"), run: () => { shell.togglePanel("outliner"); ribbon.sync(); } },
  { id: "panel.insp", label: "Inspector", icon: "panel-right-close", section: "Panels", shortcut: "\\", pressed: () => shell.isPanelOpen("inspector"), run: () => { shell.togglePanel("inspector"); ribbon.sync(); } },
  { id: "panel.props", label: "Properties", icon: "info", section: "Panels", shortcut: "P", run: () => shell.selectTab("properties") },
  { id: "panel.filters", label: "Filters", icon: "funnel", section: "Panels", shortcut: "R", run: () => shell.selectTab("filters") },
  { id: "panel.ids", label: "IDS checks", icon: "clipboard", section: "Panels", hint: "Validate against a buildingSMART IDS", run: () => shell.selectTab("ids") },
  { id: "panel.bcf", label: "Issues", icon: "flag", section: "Panels", hint: "BCF topics with viewpoints and snapshots", run: () => shell.selectTab("bcf") },
  { id: "panel.ai", label: "Assistant", icon: "sparkle", section: "Panels", shortcut: "C", run: () => shell.selectTab("assistant") },
  { id: "panel.py", label: "Python console", icon: "terminal", section: "Panels", shortcut: "Y", hint: "Write IfcOpenShell yourself; opens as a plugin", run: () => void plugins.open("python") },
  { id: "panel.log", label: "Activity", icon: "activity", section: "Panels", shortcut: "L", run: () => shell.selectTab("activity") },
  { id: "panel.summary", label: "Summary", icon: "list", section: "Panels", run: () => showPane("summary") },
  { id: "panel.types", label: "Types", icon: "layers", section: "Panels", hint: "Browse the model by IFC class", run: () => showPane("types") },
  { id: "panel.structure", label: "Structure tree", icon: "layers", section: "Panels", run: () => showPane("tree") },

  { id: "bcf.new", label: "Raise issue", icon: "flag", section: "Review", hint: "Keeps the camera, the section and a snapshot", enabled: hasModel, run: () => void raiseIssue("", []).catch(reportError) },
  { id: "ids.open", label: "IDS checks", icon: "clipboard", section: "Review", hint: "Load an .ids file and validate this model", enabled: hasModel, run: () => shell.selectTab("ids") },

  { id: "ai.new", label: "New chat", icon: "message", section: "Assistant", run: newChat },

  { id: "app.plugins", label: "Plugins", icon: "blocks", section: "Application", hint: "Python console, clash detection, takeoff, explorer, compare and the Local Studio add-ons", run: () => pluginBrowser.open() },
  { id: "app.connection", label: "Studio", icon: "plug", section: "Application", hint: "Web Studio or Local Studio", run: () => connection.open() },
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
        { kind: "cmd", id: "file.export" },
        { kind: "cmd", id: "file.screenshot", size: "sm" },
        { kind: "cmd", id: "file.viewpoint", size: "sm" },
      ] },
      { label: "App", items: [
        { kind: "cmd", id: "app.settings", size: "sm" },
        { kind: "cmd", id: "app.help", size: "sm" },
      ] },
    ],
  },
  // Each command has one ribbon home. Home follows the everyday loop from
  // selection to visibility, measurement and editing. The other tabs hold
  // role-specific controls without repeating that loop.
  {
    id: "home",
    label: "Home",
    groups: [
      { label: "Assistant", items: [
        { kind: "cmd", id: "panel.ai" },
        { kind: "cmd", id: "ai.new", size: "sm" },
      ] },
      { label: "Selection", items: [
        { kind: "cmd", id: "cam.fitsel" },
        { kind: "cmd", id: "sel.clear", size: "sm" },
      ] },
      { label: "Visibility", items: [
        { kind: "cmd", id: "vis.isolate" },
        { kind: "cmd", id: "vis.hide" },
        { kind: "cmd", id: "vis.all" },
        { kind: "cmd", id: "vis.undo", size: "sm" },
        { kind: "cmd", id: "vis.redo", size: "sm" },
      ] },
      { label: "Find", items: [
        { kind: "cmd", id: "vis.filters" },
        { kind: "cmd", id: "vis.clear", size: "sm" },
      ] },
      { label: "Measure", items: [
        { kind: "cmd", id: "tool.measure" },
      ] },
      { label: "Edit", items: [
        { kind: "cmd", id: "edit.undo", size: "sm" },
        { kind: "cmd", id: "edit.redo", size: "sm" },
        { kind: "cmd", id: "edit.rename", size: "sm" },
        { kind: "cmd", id: "edit.property", size: "sm" },
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
      ] },
      { label: "Display", items: [
        { kind: "cmd", id: "vis.ghost", size: "sm" },
        { kind: "cmd", id: "vis.spaces", size: "sm" },
        { kind: "cmd", id: "vis.openings", size: "sm" },
      ] },
      { label: "Section", items: [
        { kind: "cmd", id: "tool.section" },
        { kind: "cmd", id: "tool.box" },
        { kind: "cmd", id: "tool.plan", size: "sm" },
      ] },
      { label: "Render", items: [
        { kind: "control", build: buildScaleControl },
        { kind: "cmd", id: "tool.hud", size: "sm" },
        { kind: "cmd", id: "app.theme", size: "sm" },
      ] },
      { label: "Workspace", items: [
        { kind: "cmd", id: "panel.tree", size: "sm" },
        { kind: "cmd", id: "panel.insp", size: "sm" },
        { kind: "cmd", id: "panel.log", size: "sm" },
      ] },
    ],
  },
  {
    id: "model",
    label: "Model",
    groups: [
      { label: "Inspect", items: [
        { kind: "cmd", id: "panel.structure" },
        { kind: "cmd", id: "panel.types", size: "sm" },
        { kind: "cmd", id: "panel.summary", size: "sm" },
        { kind: "cmd", id: "panel.props", size: "sm" },
      ] },
      { label: "Convert", items: [
        { kind: "cmd", id: "file.convert" },
      ] },
      // The Python console is a plugin like any other, so it is opened from
      // the catalog rather than from a tile of its own up here.
      { label: "Plugins", items: [
        { kind: "cmd", id: "app.plugins" },
      ] },
    ],
  },
  {
    id: "review",
    label: "Review",
    groups: [
      { label: "Quality", items: [
        { kind: "cmd", id: "file.check" },
        { kind: "cmd", id: "file.schedule" },
        { kind: "cmd", id: "panel.ids", size: "sm" },
      ] },
      { label: "Issues", items: [
        { kind: "cmd", id: "bcf.new" },
        { kind: "cmd", id: "panel.bcf", size: "sm" },
      ] },
      { label: "Report", items: [
        { kind: "cmd", id: "file.report" },
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
]);

// ---------------------------------------------------------------------------
// Plugins. The panel is the catalog until something is running, and the status
// bar toggle opens the full browser. Plugin tools stay out of the ribbon; what
// is on the rail is one entry, like every other panel.
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
plugins.restore();
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
shell.viewerHost.addEventListener("pointerdown", (e) => {
  if (e.button === 2) rightDown = [e.clientX, e.clientY];
});

shell.viewerHost.addEventListener("contextmenu", (e) => {
  e.preventDefault();
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
      { label: `Isolate all ${type}`, run: () => isolateByType(type) },
      { label: "Show all", run: () => viewer.showAll() },
      { separator: true },
      { label: `Rename${scope}…`, run: renameSelection },
      { label: `Set property${scope}…`, run: setPropertyOnSelection },
      { label: `Delete${scope}…`, run: deleteSelection },
      { separator: true },
      { label: "Properties", run: () => shell.selectTab("properties") },
      {
        label: "Copy express ID",
        run: () => {
          void navigator.clipboard.writeText(String(pick.expressID));
          toast("Express ID copied", "success");
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
  if (!name) throw new Error("no model loaded");
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
  if (file) void openFile(file).catch(reportError);
  fileInput.value = "";
});
attachInput.addEventListener("change", () => {
  const file = attachInput.files?.[0];
  if (file) void attachFile(file).catch(reportError);
  attachInput.value = "";
});
$("btn-open-first").addEventListener("click", () => fileInput.click());
$("btn-sample").addEventListener("click", () => void openSample().catch(reportError));

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
  if (!file) return void toast("Drop an .ifc or .ifcx file", "info");
  if (!/\.(ifc|ifcx|ifczip)$/i.test(file.name)) {
    return void toast(`${file.name} is not an IFC file`, "error");
  }
  void openFile(file).catch(reportError);
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

  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
    e.preventDefault();
    return palette.toggle();
  }
  // Esc is handled inside viewer-core (close popover / clear selection / exit
  // measure); this only resyncs the controls that mirror that state.
  if (e.key === "Escape") return syncTools();
  if (typing || palette.isOpen()) return;
  registry.handleKey(e);
});

// F / H / I / A / Esc stay owned by viewer-core's own key handler.

updateModelChrome();
void renderRecents();
void openFromParam();
// The probe is a localhost round trip; keep it off the first-paint path.
if (window.requestIdleCallback) window.requestIdleCallback(() => void probeService(), { timeout: 1500 });
else setTimeout(() => void probeService(), 300);
