import {
  bar, button, classCounts, classPicker, clashClassPair, CLASH_LIMIT, confirmAction, copyTable,
  emptyState, field, groupClashes, h, header, hint, idsOfTypes, MEP, note, number, OPENINGS, page,
  progress, resolvedClashes, reviewClashes, saveXlsx, select, STRUCTURE, toCsv, worstDepth,
} from "@ifcviewx/sdk";
import type {
  ClashDecision, ClashElementIdentity, ClashGroupMode, ClashIgnoreRule, ClashPair,
  ClashReviewRow, ExtensionContext, ExtensionInstance, ReportFinding, SweepResult,
} from "@ifcviewx/sdk";

const PRESETS: Array<[string, string[], string[]]> = [
  ["Structure vs services", STRUCTURE, MEP],
  ["Services vs services", MEP, MEP],
  ["Structure vs structure", STRUCTURE, STRUCTURE],
  ["Fit-out vs structure", OPENINGS, STRUCTURE],
];

const REPORT = [
  "Reference", "State", "Assignee", "Kind", "A id", "A GlobalId", "A class", "A name",
  "A level", "B id", "B GlobalId", "B class", "B name", "B level", "Value mm", "X", "Y", "Z",
];
const SEVERE_MM = 50;
const HISTORY_LIMIT = CLASH_LIMIT;
const HISTORY_FALLBACK = 1800;
const DECISION_LIMIT = 300;
const MAX_DEFINITIONS = 4;
const SHOWN_LIMIT = 500;

interface SavedClashDefinition {
  version: 1;
  id: string;
  name: string;
  aTypes: string[];
  bTypes: string[];
  aModels: number[];
  bModels: number[];
  toleranceMm: number;
  clearanceMm: number;
  engine: "browser-mesh";
  createdAt: string;
  updatedAt: string;
}

interface ClashHistory {
  version: 1;
  definitionId: string;
  /** Scope and thresholds used for this baseline. */
  signature?: string;
  runAt: string;
  fingerprints: string;
  total: number;
  partial: boolean;
}

type FilterMode = "active" | "all" | "new" | "assigned" | "ignored";

const uuid = (): string => crypto.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
const now = (): string => new Date().toISOString();
const shortType = (type: string): string => type.replace(/^Ifc/, "");
const docket = (fingerprint: string): string => `CL-${fingerprint.slice(-8)}`;

function defaultDefinition(toleranceMm: number, clearanceMm: number): SavedClashDefinition {
  const timestamp = now();
  return {
    version: 1,
    id: uuid(),
    name: "Structure vs services",
    aTypes: [...STRUCTURE],
    bTypes: [...MEP],
    aModels: [],
    bModels: [],
    toleranceMm,
    clearanceMm,
    engine: "browser-mesh",
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function validDefinition(value: unknown): value is SavedClashDefinition {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<SavedClashDefinition>;
  return item.version === 1 && typeof item.id === "string" && typeof item.name === "string" &&
    Array.isArray(item.aTypes) && Array.isArray(item.bTypes) && Array.isArray(item.aModels) &&
    Array.isArray(item.bModels) && Number.isFinite(item.toleranceMm) && Number.isFinite(item.clearanceMm);
}

function decodeHistory(history: ClashHistory | null): Set<string> {
  if (!history?.fingerprints) return new Set();
  return new Set(history.fingerprints.split(",").filter(Boolean).map((value) => `CL-${value}`));
}

function encodeHistory(
  definitionId: string,
  rows: readonly ClashReviewRow[],
  limit: number,
  signature: string,
): ClashHistory {
  const fingerprints = [...new Set(rows.map((row) => row.fingerprint))].sort();
  return {
    version: 1,
    definitionId,
    signature,
    runAt: now(),
    fingerprints: fingerprints.slice(0, limit).map((value) => value.replace(/^CL-/, "")).join(","),
    total: fingerprints.length,
    partial: fingerprints.length > limit,
  };
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  const migratedTolerance = ctx.storage.read("tolerance", 10);
  const migratedClearance = ctx.storage.read("clearance", 0);
  const loadedDefinitions = ctx.storage.read<unknown[]>("definitions", []).filter(validDefinition);
  let definitions = loadedDefinitions.length
    ? loadedDefinitions.slice(0, MAX_DEFINITIONS)
    : [defaultDefinition(migratedTolerance, migratedClearance)];
  let activeDefinitionId = ctx.storage.read("activeDefinition", definitions[0].id);
  if (!definitions.some((definition) => definition.id === activeDefinitionId)) activeDefinitionId = definitions[0].id;

  const setA = new Set<string>();
  const setB = new Set<string>();
  const modelsA = new Set<number>();
  const modelsB = new Set<number>();
  let tolerance = 10;
  let clearance = 0;
  let result: SweepResult | null = null;
  let reviewRows: ClashReviewRow[] = [];
  let identities = new Map<number, ClashElementIdentity>();
  let previousFingerprints = new Set<string>();
  let resolved: string[] = [];
  let previousRunAt = "";
  let historyPartial = false;
  let resultHandle = "";
  let resultSignature = "";
  let running = false;
  let sweepController: AbortController | null = null;
  let modelGeneration = 0;
  let groupMode = ctx.storage.read<ClashGroupMode>("groupMode", "status");
  if (!["status", "level", "class", "primary", "proximity"].includes(groupMode)) groupMode = "status";
  let filterMode = ctx.storage.read<FilterMode>("filterMode", "active");
  if (!["active", "all", "new", "assigned", "ignored"].includes(filterMode)) filterMode = "active";
  let clusterRadius = Math.max(0.25, ctx.storage.read("clusterRadius", 2));
  let reviewer = ctx.storage.read("reviewer", "me");
  const storedDecisions = ctx.storage.read<Array<[string, ClashDecision]>>("decisions", []);
  const decisions = new Map(storedDecisions.filter((entry) => Array.isArray(entry) && typeof entry[0] === "string"));
  let rules = ctx.storage.read<ClashIgnoreRule[]>("ignoreRules", []).filter((rule) => (
    rule && typeof rule.id === "string" && typeof rule.aType === "string" && typeof rule.bType === "string"
  ));

  const status = progress();
  const results = h("div", { class: "plug-results clash-results" });
  const summary = h("div", { class: "clash-summary" });
  const freshness = h("div", { class: "clash-freshness" });
  const pickers = h("div", { class: "plug-two" });
  const root = page();
  root.classList.add("clash-workflow");

  const definition = (): SavedClashDefinition => definitions.find((item) => item.id === activeDefinitionId) ?? definitions[0];

  const checkSignature = (): string => JSON.stringify({
    definition: definition().id,
    a: [...setA].sort(),
    b: [...setB].sort(),
    modelsA: [...modelsA].sort((a, b) => a - b),
    modelsB: [...modelsB].sort((a, b) => a - b),
    tolerance,
    clearance,
  });

  const resultIsStale = (): boolean => result !== null && resultSignature !== checkSignature();

  const loadDefinition = (): void => {
    const item = definition();
    setA.clear();
    setB.clear();
    modelsA.clear();
    modelsB.clear();
    item.aTypes.forEach((type) => setA.add(type));
    item.bTypes.forEach((type) => setB.add(type));
    item.aModels.forEach((model) => modelsA.add(model));
    item.bModels.forEach((model) => modelsB.add(model));
    tolerance = Math.max(0, item.toleranceMm);
    clearance = Math.max(0, item.clearanceMm);
  };

  const persist = (key: string, value: unknown): boolean => {
    try {
      ctx.storage.write(key, value);
      return true;
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      return false;
    }
  };

  const saveDefinitions = (): void => {
    persist("definitions", definitions);
    persist("activeDefinition", activeDefinitionId);
  };

  const saveDefinition = (announce = true): void => {
    const current = definition();
    current.aTypes = [...setA].sort();
    current.bTypes = [...setB].sort();
    current.aModels = [...modelsA].sort((a, b) => a - b);
    current.bModels = [...modelsB].sort((a, b) => a - b);
    current.toleranceMm = tolerance;
    current.clearanceMm = clearance;
    current.updatedAt = now();
    saveDefinitions();
    if (announce) ctx.feedback.toast(`Saved ${current.name}`, "success");
  };

  const clearResult = (): void => {
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = "";
    resultSignature = "";
    result = null;
    reviewRows = [];
    identities = new Map();
    previousFingerprints = new Set();
    resolved = [];
    previousRunAt = "";
    historyPartial = false;
  };

  const activateDefinition = (id: string): void => {
    if (!definitions.some((item) => item.id === id)) return;
    activeDefinitionId = id;
    persist("activeDefinition", id);
    clearResult();
    loadDefinition();
    build();
  };

  const newDefinition = (): void => {
    if (definitions.length >= MAX_DEFINITIONS) {
      ctx.feedback.toast(`Keep at most ${MAX_DEFINITIONS} saved checks so revision history stays within browser storage`, "info");
      return;
    }
    saveDefinition(false);
    const source = definition();
    const timestamp = now();
    const copy: SavedClashDefinition = {
      ...source,
      id: uuid(),
      name: `Coordination check ${definitions.length + 1}`,
      aTypes: [...source.aTypes],
      bTypes: [...source.bTypes],
      aModels: [...source.aModels],
      bModels: [...source.bModels],
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    definitions = [...definitions, copy];
    activeDefinitionId = copy.id;
    saveDefinitions();
    clearResult();
    loadDefinition();
    build();
  };

  const removeDefinition = (): void => {
    if (definitions.length === 1) return void ctx.feedback.toast("Keep at least one clash definition", "info");
    const current = definition();
    confirmAction(
      "Delete saved clash definition?",
      `"${current.name}" and its last revision baseline will no longer be available.`,
      "Delete",
      () => {
        definitions = definitions.filter((item) => item.id !== current.id);
        activeDefinitionId = definitions[0].id;
        saveDefinitions();
        persist(`history.${current.id}`, null);
        clearResult();
        loadDefinition();
        build();
      },
    );
  };

  const modelSetButton = (
    label: string,
    model: number,
    target: Set<number>,
    allModels: number[],
  ): HTMLButtonElement => {
    const selected = target.size === 0 || target.has(model);
    const control = h("button", {
      class: "clash-model-toggle",
      type: "button",
      text: label,
      "aria-pressed": String(selected),
    });
    control.addEventListener("click", () => {
      if (target.size === 0) allModels.forEach((entry) => target.add(entry));
      if (target.has(model)) target.delete(model);
      else target.add(model);
      if (target.size === allModels.length) target.clear();
      build();
    });
    return control;
  };

  const build = (): void => {
    const elements = ctx.model.elements();
    root.replaceChildren();
    if (elements.length === 0) {
      root.appendChild(emptyState("cube", "No model loaded", "Open an IFC file and the saved checks become runnable."));
      return;
    }
    const counts = classCounts(elements.filter((element) => ctx.model.bounds(element.id) !== null));
    const presets: Array<[string, string]> = [["", "Preset"], ...PRESETS.map(([label]) => [label, label] as [string, string])];
    const current = definition();
    const name = h("input", {
      class: "clash-definition-name",
      type: "text",
      value: current.name,
      maxlength: "80",
      "aria-label": "Clash definition name",
    });
    name.addEventListener("change", () => {
      current.name = name.value.trim() || "Untitled clash check";
      name.value = current.name;
    });

    const head = header(
      "Clash checks",
      "Test real mesh contact, track revisions, and turn coordination findings into issues.",
      "TRIANGLE BVH · LOCAL",
    );
    const definitionBar = bar(
      select(definitions.map((item) => [item.id, item.name]), activeDefinitionId, activateDefinition),
      name,
      button("Save", () => { saveDefinition(); build(); }),
    );
    definitionBar.classList.add("clash-definition-bar");

    const toleranceInput = number(tolerance, (value) => {
      tolerance = Number.isFinite(value) ? Math.max(0, value) : 0;
      build();
    }, 0.5);
    const clearanceInput = number(clearance, (value) => {
      clearance = Number.isFinite(value) ? Math.max(0, value) : 0;
      build();
    }, 5);
    const runBar = bar(
      select(presets, "", (value) => {
        const preset = PRESETS.find(([label]) => label === value);
        if (!preset) return;
        apply(setA, preset[1], counts);
        apply(setB, preset[2], counts);
        build();
      }),
      field("Ignore penetration ≤", toleranceInput),
      field("Required clearance", clearanceInput),
      running
        ? button("Stop", () => sweepController?.abort(), "warn")
        : button(resultIsStale() ? "Run updated check" : "Run check", () => void sweep(), "accent"),
    );
    runBar.classList.add("clash-run-bar");
    runBar.querySelectorAll("select, input").forEach((control) => {
      (control as HTMLInputElement | HTMLSelectElement).disabled = running;
    });

    const thresholdRail = h("div", { class: "clash-threshold-rail", "aria-label": "Clash classification thresholds" }, [
      h("span", { class: "graze" }, [
        h("b", { text: `≤ ${tolerance.toLocaleString()} mm` }),
        h("small", { text: "ignored penetration" }),
      ]),
      h("span", { class: "hard" }, [
        h("b", { text: "Mesh intersection" }),
        h("small", { text: `hard clash above ${tolerance.toLocaleString()} mm` }),
      ]),
      h("span", { class: clearance > 0 ? "clearance" : "clearance off" }, [
        h("b", { text: clearance > 0 ? `< ${clearance.toLocaleString()} mm` : "Off" }),
        h("small", { text: "clearance zone" }),
      ]),
    ]);

    const modelIndices = [...new Set(elements.map((element) => ctx.model.modelOf(element.id)))].sort((a, b) => a - b);
    const matrix = modelIndices.length > 1
      ? h("div", { class: "clash-model-matrix" }, [
          h("div", { class: "clash-matrix-head" }, [
            h("span", { text: "Federated model" }), h("span", { text: "A" }), h("span", { text: "B" }),
          ]),
          ...modelIndices.map((model, index) => h("div", { class: "clash-matrix-row" }, [
            h("span", { text: `Model slot ${model + 1}`, title: index === 0 ? ctx.session.model().name : `Federated model ${model + 1}` }),
            modelSetButton("A", model, modelsA, modelIndices),
            modelSetButton("B", model, modelsB, modelIndices),
          ])),
        ])
      : null;

    const advanced = h("details", { class: "clash-options" }, [
      h("summary", {}, [h("span", { text: "Check options" }), h("small", { text: `${rules.length} ignore rule${rules.length === 1 ? "" : "s"}` })]),
      h("div", { class: "clash-options-body" }, [
        bar(
          button("New check", newDefinition),
          button("Delete check", removeDefinition, "warn"),
          button("Import rules", () => void importRules()),
          button("Export rules", exportRules),
        ),
        ...(matrix ? [matrix] : []),
        hint("info", clearance > 0
          ? `Hard intersections plus surface gaps below ${clearance} mm. Decisions stay in this browser.`
          : "Triangle intersections use stable element references when GlobalIds are available."),
      ]),
    ]);
    if (running) advanced.inert = true;
    const resultBar = bar(
      button("Isolate open", isolateHits),
      button("Reset view", () => { ctx.view.setSectionBox(null); ctx.view.showAll(); }),
      button("Export CSV", () => void exportCsv()),
      button("XLSX", () => void exportXlsx()),
      button("Copy", () => void copyRows()),
    );
    resultBar.classList.add("clash-result-actions");

    const selectedCount = (selected: Set<string>): number => counts.reduce(
      (total, [type, count]) => total + (selected.has(type) ? count : 0), 0,
    );
    pickers.replaceChildren(
      h("div", { class: "plug-col clash-set-card set-a" }, [
        h("div", { class: "group-title" }, [
          h("span", { class: "clash-set-token", text: "A" }),
          h("span", { text: "Primary set" }),
          h("small", { text: `${setA.size} classes · ${selectedCount(setA).toLocaleString()} elements` }),
        ]),
        classPicker(counts, setA, build),
      ]),
      h("div", { class: "plug-col clash-set-card set-b" }, [
        h("div", { class: "group-title" }, [
          h("span", { class: "clash-set-token", text: "B" }),
          h("span", { text: "Compared set" }),
          h("small", { text: `${setB.size} classes · ${selectedCount(setB).toLocaleString()} elements` }),
        ]),
        classPicker(counts, setB, build),
      ]),
    );
    pickers.inert = running;
    definitionBar.inert = running;

    root.append(
      head,
      definitionBar,
      runBar,
      thresholdRail,
      advanced,
      h("div", { class: "clash-sets-head" }, [h("b", { text: "Comparison scope" }), h("span", { text: "Choose at least one class on each side" })]),
      pickers,
      status.root,
      freshness,
      summary,
      resultBar,
      results,
    );
    paint();
  };

  const apply = (target: Set<string>, wanted: string[], counts: Array<[string, number]>): void => {
    target.clear();
    for (const [type] of counts) if (wanted.includes(type)) target.add(type);
  };

  const modelAllowed = (target: Set<number>, id: number): boolean => target.size === 0 || target.has(ctx.model.modelOf(id));

  const resolveIdentities = async (hits: readonly ClashPair[]): Promise<Map<number, ClashElementIdentity>> => {
    const elements = new Map(ctx.model.elements().map((element) => [element.id, element]));
    const wanted = [...new Set(hits.flatMap((hit) => [hit.a, hit.b]))];
    const globalIds = new Map<number, string>();
    const index = ctx.model.index();
    if (index.ready()) {
      for (const row of index.all()) if (wanted.includes(row.id)) globalIds.set(row.id, row.globalId);
    } else {
      let next = 0;
      const pump = async (): Promise<void> => {
        for (let at = next++; at < wanted.length; at = next++) {
          const id = wanted[at];
          const properties = await ctx.model.properties(id).catch(() => null);
          const value = properties?.attributes.find((item) => item.name === "GlobalId")?.value;
          if (value !== undefined && value !== null) globalIds.set(id, String(value));
        }
      };
      await Promise.all(Array.from({ length: Math.min(12, wanted.length) }, pump));
    }
    return new Map(wanted.map((id) => {
      const element = elements.get(id);
      return [id, {
        id,
        model: ctx.model.modelOf(id),
        globalId: globalIds.get(id) ?? "",
        type: element?.type ?? "IfcElement",
        name: element?.name ?? "",
        storey: element?.storey ?? "",
      } satisfies ClashElementIdentity];
    }));
  };

  const writeHistory = (rows: readonly ClashReviewRow[], signature: string): ClashHistory => {
    const key = `history.${definition().id}`;
    const full = encodeHistory(definition().id, rows, HISTORY_LIMIT, signature);
    if (persist(key, full)) return full;
    const fallback = encodeHistory(definition().id, rows, HISTORY_FALLBACK, signature);
    persist(key, fallback);
    return fallback;
  };

  const refreshResultHandle = (): void => {
    if (resultHandle) ctx.results.dispose(resultHandle);
    resultHandle = "";
    if (!result || reviewRows.length === 0) return;
    resultHandle = ctx.results.create("clash.results", reviewRows, {
      metadata: {
        definitionId: definition().id,
        toleranceMm: tolerance,
        clearanceMm: clearance,
        pairsTested: result.pairsTested,
        fidelity: "mesh",
        engine: "browser-bvh",
        resolved: resolved.length,
      },
    }).id;
  };

  const sweep = async (): Promise<void> => {
    if (running) return;
    if (setA.size === 0 || setB.size === 0) {
      ctx.feedback.log("Pick at least one class in each set", "error");
      return;
    }
    saveDefinition(false);
    const runSignature = checkSignature();
    const generation = modelGeneration;
    const elements = ctx.model.elements();
    const has = (id: number): boolean => ctx.model.bounds(id) !== null;
    const a = idsOfTypes(elements, setA, has).filter((id) => modelAllowed(modelsA, id));
    const b = idsOfTypes(elements, setB, has).filter((id) => modelAllowed(modelsB, id));
    if (a.length === 0 || b.length === 0) {
      ctx.feedback.log("The saved class and model filters leave one side empty", "error");
      return;
    }
    const controller = new AbortController();
    sweepController = controller;
    running = true;
    build();
    status.set(0, 1, `Preparing ${a.length.toLocaleString()} against ${b.length.toLocaleString()} elements`);
    try {
      const swept = await ctx.geometry.clash(a, b, {
        toleranceMm: tolerance,
        clearanceMm: clearance,
        signal: controller.signal,
        onProgress: ({ done, total, hits }) =>
          status.set(done, total, `Testing geometry, ${hits.toLocaleString()} found so far`),
      });
      if (generation !== modelGeneration) return;
      status.set(1, 1, `Assigning stable references to ${swept.hits.length.toLocaleString()} results`);
      const nextIdentities = await resolveIdentities(swept.hits);
      if (generation !== modelGeneration || controller.signal.aborted) return;
      const stored = ctx.storage.read<ClashHistory | null>(`history.${definition().id}`, null);
      const comparable = stored?.definitionId === definition().id && stored.signature === runSignature;
      previousFingerprints = comparable ? decodeHistory(stored) : new Set();
      previousRunAt = comparable ? stored.runAt : "";
      result = swept;
      resultSignature = runSignature;
      identities = nextIdentities;
      reviewRows = reviewClashes(swept.hits, identities, previousFingerprints, decisions, rules);
      resolved = resolvedClashes(previousFingerprints, reviewRows);
      const written = writeHistory(reviewRows, runSignature);
      historyPartial = written.partial || Boolean(comparable && stored?.partial);
      refreshResultHandle();
    } catch (error) {
      if (generation === modelGeneration && (!(error instanceof DOMException) || error.name !== "AbortError")) {
        ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
      return;
    } finally {
      status.hide();
      running = false;
      if (sweepController === controller) sweepController = null;
      if (generation === modelGeneration) build();
    }
    const open = reviewRows.filter((row) => row.state !== "ignored");
    ctx.feedback.log(
      `${open.length.toLocaleString()} open result(s), ${resolved.length.toLocaleString()} resolved since the previous run`,
      open.length ? "info" : "success",
    );
    publish();
  };

  const persistDecisions = (): void => {
    const entries = [...decisions.entries()]
      .sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
      .slice(0, DECISION_LIMIT);
    decisions.clear();
    entries.forEach(([key, value]) => decisions.set(key, value));
    persist("decisions", entries);
  };

  const reclassify = (): void => {
    if (!result) return;
    reviewRows = reviewClashes(result.hits, identities, previousFingerprints, decisions, rules);
    resolved = resolvedClashes(previousFingerprints, reviewRows);
    refreshResultHandle();
    paint();
    publish();
  };

  const assign = (row: ClashReviewRow): void => {
    const decision = decisions.get(row.fingerprint);
    if (decision?.state === "assigned") decisions.delete(row.fingerprint);
    else decisions.set(row.fingerprint, { state: "assigned", assignee: reviewer.trim() || "me", updatedAt: now() });
    persistDecisions();
    reclassify();
  };

  const ignore = (row: ClashReviewRow): void => {
    const decision = decisions.get(row.fingerprint);
    if (decision?.state === "ignored") decisions.delete(row.fingerprint);
    else decisions.set(row.fingerprint, { state: "ignored", updatedAt: now() });
    persistDecisions();
    reclassify();
  };

  const publish = (): void => {
    if (!result) return;
    const open = reviewRows.filter((row) => row.state !== "ignored");
    const hard = open.filter((row) => row.kind === "hard");
    const near = open.filter((row) => row.kind === "clearance");
    const severe = hard.filter((row) => row.distance * 1000 > SEVERE_MM);
    const findings: ReportFinding[] = [];
    if (severe.length) findings.push({
      severity: "error", title: `Open hard clashes over ${SEVERE_MM} mm`, count: severe.length,
      detail: `deepest ${(worstDepth(severe) * 1000).toFixed(0)} mm`,
    });
    if (hard.length > severe.length) findings.push({
      severity: "warning", title: `Open hard clashes under ${SEVERE_MM} mm`, count: hard.length - severe.length,
    });
    if (near.length) findings.push({ severity: "warning", title: "Open clearance failures", count: near.length });
    if (resolved.length) findings.push({ severity: "info", title: "Resolved since the previous run", count: resolved.length });
    const ignored = reviewRows.length - open.length;
    if (ignored) findings.push({ severity: "info", title: "Ignored by decision or rule", count: ignored });
    if (result.missing) findings.push({
      severity: "info", title: "Elements without retained geometry, so they were not tested", count: result.missing,
    });
    if (result.truncated) findings.push({
      severity: "info", title: `Stopped at ${CLASH_LIMIT.toLocaleString()} results, so the check is incomplete`,
    });
    ctx.feedback.publishFindings(
      `${open.length.toLocaleString()} open coordination result(s) in ${definition().name}. ${resolved.length.toLocaleString()} resolved.`,
      findings,
    );
    // The same rows on the shared dock, so a coordination meeting can walk
    // clash and rule findings in one list instead of two panels.
    ctx.feedback.publishResults({
      title: definition().name,
      summary: `${open.length.toLocaleString()} open, ${resolved.length.toLocaleString()} resolved, ${ignored.toLocaleString()} ignored`,
      rows: open.slice(0, 1000).map((row) => ({
        id: row.fingerprint,
        severity: row.kind === "hard" && row.distance * 1000 > SEVERE_MM ? "error" : "warning",
        title: `${shortType(row.aType)} vs ${shortType(row.bType)}`,
        detail: `${row.kind === "hard" ? "penetration" : "gap"} ${Math.round(row.distance * 1000)} mm`,
        group: `${shortType(row.aType)} vs ${shortType(row.bType)}`,
        ids: [row.a, row.b],
        point: row.point,
        assignee: row.assignee,
      })),
    });
  };

  const visibleRows = (): ClashReviewRow[] => reviewRows.filter((row) => (
    filterMode === "all" ? true
    : filterMode === "active" ? row.state !== "ignored"
    : row.state === filterMode
  ));

  const show = (row: ClashReviewRow): void => {
    const ids = [row.a, row.b];
    ctx.view.isolate(ids, docket(row.fingerprint));
    ctx.view.select(ids);
    const box = ctx.view.boxAround(ids, 0.35);
    if (box) ctx.view.setSectionBox(box);
    const reach = Math.max(row.extent[0], row.extent[1], row.extent[2], 0.4);
    ctx.view.frameAt(row.point, reach * 2.5);
  };

  const issue = async (row: ClashReviewRow, control: HTMLButtonElement): Promise<void> => {
    show(row);
    control.disabled = true;
    control.textContent = "Creating";
    const depth = Math.round(row.distance * 1000);
    const title = `[${docket(row.fingerprint)}] ${shortType(row.aType)} vs ${shortType(row.bType)}`;
    const description = [
      `Saved check: ${definition().name}`,
      `Reference: ${row.fingerprint}`,
      `Review state: ${row.state}${row.assignee ? ` (${row.assignee})` : ""}`,
      `${row.kind === "hard" ? "Penetration" : "Gap"}: ${depth} mm`,
      `Element A: ${row.aIdentity.globalId || `#${ctx.model.expressOf(row.a)}`} ${row.aIdentity.name}`,
      `Element B: ${row.bIdentity.globalId || `#${ctx.model.expressOf(row.b)}`} ${row.bIdentity.name}`,
      `Contact: ${row.point.map((value) => value.toFixed(3)).join(", ")}`,
      ...(row.georeferenced ? [`Projected: ${row.georeferenced.coordinates.map((value) => value.toFixed(3)).join(", ")} (${row.georeferenced.crs})`] : []),
    ].join("\n");
    try {
      const created = await ctx.issues.create({
        title,
        description,
        elementIds: [row.a, row.b],
        point: row.point,
        priority: row.kind === "hard" && depth > SEVERE_MM ? "Critical" : row.kind === "hard" ? "High" : "Normal",
        metadata: {
          definition: definition().name,
          clashReference: row.fingerprint,
          engine: "browser-bvh",
          ...(row.georeferenced ? { crs: row.georeferenced.crs, projectedCoordinate: row.georeferenced.coordinates.join(",") } : {}),
        },
      });
      ctx.feedback.toast(`Created BCF issue ${created.id.slice(0, 8)}`, "success");
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      control.disabled = false;
      control.textContent = "Issue";
    }
  };

  const rowCard = (row: ClashReviewRow): HTMLElement => {
    const value = `${Math.round(row.distance * 1000)} mm`;
    const state = row.state === "assigned" && row.assignee ? `Assigned · ${row.assignee}` : row.state;
    const main = h("button", {
      class: "clash-docket-main",
      type: "button",
      title: `${row.aIdentity.name || row.aType} vs ${row.bIdentity.name || row.bType}`,
    }, [
      h("span", { class: "clash-docket-ref", text: docket(row.fingerprint), title: row.fingerprint }),
      h("span", { class: "clash-docket-pair", text: `${shortType(row.aType)} #${ctx.model.expressOf(row.a)} ↔ ${shortType(row.bType)} #${ctx.model.expressOf(row.b)}` }),
      h("span", { class: "clash-docket-meta", text: row.aIdentity.storey || row.bIdentity.storey || "No level" }),
      h("span", { class: `clash-docket-value ${row.kind}` }, [
        h("b", { text: value }), h("small", { text: row.kind === "hard" ? "penetration" : "gap" }),
      ]),
      h("span", { class: `clash-state state-${row.state}`, text: state }),
    ]);
    main.addEventListener("click", () => show(row));
    const issueControl = button("Issue", () => void issue(row, issueControl));
    const assigned = decisions.get(row.fingerprint)?.state === "assigned";
    const ignored = decisions.get(row.fingerprint)?.state === "ignored";
    const actions = h("div", { class: "clash-docket-actions" }, [
      issueControl,
      button(assigned ? "Unassign" : "Assign", () => assign(row)),
      button(ignored ? "Restore" : "Ignore", () => ignore(row)),
    ]);
    return h("article", { class: `clash-docket-row state-${row.state}` }, [main, actions]);
  };

  const paint = (): void => {
    const counts = {
      new: reviewRows.filter((row) => row.state === "new").length,
      unchanged: reviewRows.filter((row) => row.state === "unchanged").length,
      assigned: reviewRows.filter((row) => row.state === "assigned").length,
      ignored: reviewRows.filter((row) => row.state === "ignored").length,
    };
    const open = counts.new + counts.unchanged + counts.assigned;
    const openRows = reviewRows.filter((row) => row.state !== "ignored");
    const hard = openRows.filter((row) => row.kind === "hard").length;
    const near = openRows.length - hard;
    const stale = resultIsStale();
    freshness.replaceChildren(...(stale ? [h("div", { class: "clash-stale", role: "alert" }, [
      h("span", {}, [
        h("b", { text: "Settings changed" }),
        h("small", { text: "Results below belong to the previous scope or thresholds." }),
      ]),
      button("Run updated check", () => void sweep(), "accent"),
    ])] : []));
    summary.classList.toggle("is-stale", stale);
    summary.replaceChildren(h("div", { class: "clash-summary-line", role: "status" }, [
      h("span", { class: open ? "open" : "clean" }, [h("b", { text: open.toLocaleString() }), h("small", { text: "open" })]),
      h("span", { class: hard ? "hard" : "" }, [h("b", { text: hard.toLocaleString() }), h("small", { text: "hard" })]),
      h("span", { class: near ? "near" : "" }, [h("b", { text: near.toLocaleString() }), h("small", { text: "clearance" })]),
      h("span", {}, [h("b", { text: counts.new.toLocaleString() }), h("small", { text: "new" })]),
      h("span", {}, [h("b", { text: resolved.length.toLocaleString() }), h("small", { text: "resolved" })]),
      h("span", { class: "elapsed" }, [h("b", { text: result ? `${(result.elapsedMs / 1000).toFixed(1)} s` : "-" }), h("small", { text: "last run" })]),
    ]), ...(result ? [h("div", { class: "clash-run-meta" }, [
      h("span", { text: `${result.elementsA.toLocaleString()} A elements` }),
      h("span", { text: `${result.elementsB.toLocaleString()} B elements` }),
      h("span", { text: `${result.pairsTested.toLocaleString()} candidate pairs tested` }),
      h("span", { text: `${result.fidelity === "mesh" ? "triangle mesh" : "geometry"} · revision ${result.geometryRevision ?? "n/a"}` }),
    ])] : []));
    results.replaceChildren();
    if (reviewRows.length === 0) {
      const nothingTested = result !== null && result.pairsTested === 0;
      results.appendChild(emptyState(
        "check-circle",
        !result ? "No coordination run yet"
          : nothingTested ? "These sets never came close enough to test"
          : "No result crosses this check's thresholds",
        !result ? "Choose the A and B sets, save the definition, then run it."
          : nothingTested ? "Try another model or class pairing."
          : "This revision is clean for the saved definition.",
      ));
      return;
    }

    const reviewerInput = h("input", {
      class: "clash-reviewer",
      type: "text",
      value: reviewer,
      maxlength: "60",
      "aria-label": "Reviewer name",
    });
    reviewerInput.addEventListener("change", () => {
      reviewer = reviewerInput.value.trim() || "me";
      reviewerInput.value = reviewer;
      persist("reviewer", reviewer);
    });
    const triage = bar(
      field("Group", select([
        ["status", "Review state"], ["level", "Level"], ["class", "Class pair"],
        ["primary", "Primary element"], ["proximity", "Proximity cluster"],
      ], groupMode, (value) => {
        groupMode = value as ClashGroupMode;
        persist("groupMode", groupMode);
        paint();
      })),
      field("Show", select([
        ["active", "Open"], ["all", "All"], ["new", "New"], ["assigned", "Assigned"], ["ignored", "Ignored"],
      ], filterMode, (value) => {
        filterMode = value as FilterMode;
        persist("filterMode", filterMode);
        paint();
      })),
      ...(groupMode === "proximity" ? [field("Radius m", number(clusterRadius, (value) => {
        clusterRadius = Math.max(0.25, value);
        persist("clusterRadius", clusterRadius);
        paint();
      }, 0.25, 0.25))] : []),
      field("Reviewer", reviewerInput),
    );
    triage.classList.add("clash-triage-bar");
    results.appendChild(triage);

    const rows = visibleRows();
    const groups = groupClashes(rows, groupMode, clusterRadius);
    let shown = 0;
    for (const group of groups) {
      if (shown >= SHOWN_LIMIT) break;
      const remaining = SHOWN_LIMIT - shown;
      const groupRows = group.rows.slice(0, remaining);
      const location = group.point ? ` · ${group.point.map((value) => value.toFixed(1)).join(", ")} m` : "";
      results.appendChild(h("section", { class: "clash-docket-group" }, [
        h("div", { class: "clash-docket-group-head" }, [
          h("span", { text: group.label }),
          h("span", { class: "n", text: `${group.rows.length.toLocaleString()}${location}` }),
        ]),
        ...groupRows.map(rowCard),
      ]));
      shown += groupRows.length;
    }
    if (rows.length === 0) results.appendChild(note("No results match this review filter."));
    if (rows.length > shown) results.appendChild(note(`Showing ${shown.toLocaleString()} of ${rows.length.toLocaleString()} filtered results. CSV contains all rows.`));
    if (previousRunAt) results.appendChild(note(
      `Compared with ${new Date(previousRunAt).toLocaleString()}. ${resolved.length.toLocaleString()} recorded reference(s) disappeared.`,
    ));
    if (historyPartial) results.appendChild(note("The revision baseline was compacted to stay within browser storage, so resolved totals may be partial."));
    if (result?.truncated) results.appendChild(note(`Stopped at ${CLASH_LIMIT.toLocaleString()} results. Narrow the saved definition or raise its tolerance.`));
    if (result?.missing) results.appendChild(note(`${result.missing.toLocaleString()} element(s) had no retained geometry to test.`));
  };

  const isolateHits = (): void => {
    const open = reviewRows.filter((row) => row.state !== "ignored");
    if (open.length === 0) return void ctx.feedback.log("Run a check or include ignored results first", "error");
    const ids = new Set(open.flatMap((row) => [row.a, row.b]));
    ctx.view.setSectionBox(null);
    ctx.view.isolate([...ids], definition().name);
    ctx.feedback.log(`Isolated ${ids.size.toLocaleString()} element(s) from open results`);
  };

  const reportRows = (): Array<Array<string | number>> => reviewRows.map((row) => [
    row.fingerprint, row.state, row.assignee, row.kind,
    ctx.model.expressOf(row.a), row.aIdentity.globalId, row.aType, row.aIdentity.name, row.aIdentity.storey,
    ctx.model.expressOf(row.b), row.bIdentity.globalId, row.bType, row.bIdentity.name, row.bIdentity.storey,
    Number((row.distance * 1000).toFixed(1)),
    Number(row.point[0].toFixed(3)), Number(row.point[1].toFixed(3)), Number(row.point[2].toFixed(3)),
  ]);

  const copyRows = async (): Promise<void> => {
    if (reviewRows.length === 0) return void ctx.feedback.log("Run a check first", "error");
    await copyTable(REPORT, reportRows());
  };

  const exportCsv = async (): Promise<void> => {
    if (reviewRows.length === 0) return void ctx.feedback.log("Run a check first", "error");
    ctx.files.export(
      "clash.csv",
      `clashes-${ctx.session.model().name || "model"}.csv`,
      toCsv(REPORT, reportRows()),
      "text/csv",
    );
  };

  const exportXlsx = async (): Promise<void> => {
    if (reviewRows.length === 0) return void ctx.feedback.log("Run a check first", "error");
    const name = `clashes-${ctx.session.model().name || "model"}.xlsx`;
    try {
      await saveXlsx(name, REPORT, reportRows(), { sheet: "Clashes" });
    } catch {
      ctx.feedback.log("The spreadsheet could not be written", "error");
    }
  };

  const exportRules = (): void => {
    ctx.files.export(
      "clash.rules",
      "clash-ignore-rules.json",
      JSON.stringify({ version: 1, exportedAt: now(), rules }, null, 2),
      "application/json",
    );
  };

  const importRules = async (): Promise<void> => {
    try {
      const file = await ctx.files.open("clash.rules");
      const parsed = JSON.parse(file.text) as { version?: unknown; rules?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.rules)) throw new Error("That is not a Clash Workflow rule pack");
      const incoming = parsed.rules.slice(0, 200).flatMap((value): ClashIgnoreRule[] => {
        if (!value || typeof value !== "object") return [];
        const rule = value as Partial<ClashIgnoreRule>;
        if (typeof rule.aType !== "string" || typeof rule.bType !== "string") return [];
        if (rule.kind !== undefined && rule.kind !== "hard" && rule.kind !== "clearance") return [];
        return [{
          id: typeof rule.id === "string" ? rule.id : uuid(),
          aType: rule.aType,
          bType: rule.bType,
          ...(rule.kind ? { kind: rule.kind } : {}),
          createdAt: typeof rule.createdAt === "string" ? rule.createdAt : now(),
        }];
      });
      const key = (rule: ClashIgnoreRule): string => `${clashClassPair(rule.aType, rule.bType)}|${rule.kind ?? "all"}`;
      const merged = new Map(rules.map((rule) => [key(rule), rule]));
      incoming.forEach((rule) => merged.set(key(rule), rule));
      rules = [...merged.values()];
      persist("ignoreRules", rules);
      reclassify();
      ctx.feedback.toast(`Imported ${incoming.length.toLocaleString()} ignore rule(s) from ${file.name}`, "success");
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") return;
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
  };

  ctx.events.on("model", () => {
    modelGeneration += 1;
    sweepController?.abort();
    clearResult();
    build();
  });

  loadDefinition();
  saveDefinitions();
  build();
  host.appendChild(root);

  return {
    dispose: () => sweepController?.abort(),
  };
}
