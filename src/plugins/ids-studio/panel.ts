import {
  BUILTIN_IDS_TEMPLATES, button, cloneFacet, confirmAction, emptyState, h, icon, iconButton,
  lastIdsReport, loadIds, newFacet, newIdsDocument, page, parseIdsDocument, progress, runIds,
  searchBsdd, serializeIdsDocument, stats,
} from "@ifcviewx/sdk";
import type {
  BsddHit, BsddKind, ExtensionContext, ExtensionInstance, IdsFacetDraft, IdsFacetKind,
  IdsReport, IdsRequirementTemplate, IdsSpecificationDraft, IdsValueRule, SpecResult, Viewer,
} from "@ifcviewx/sdk";

type StudioView = "author" | "validate" | "compare";

interface ComplianceBaseline {
  modelKey: string;
  modelName: string;
  savedAt: string;
  idsTitle: string;
  report: IdsReport;
}

interface StagedCorrection {
  specification: string;
  expressID: number;
  reason: string;
  suggestion: string;
}

interface OverflowAction {
  label: string;
  icon: string;
  run: () => void;
  title?: string;
  disabled?: boolean;
  danger?: boolean;
}

const FACETS: Array<[IdsFacetKind, string]> = [
  ["entity", "Entity"], ["attribute", "Attribute"], ["property", "Property"],
  ["partOf", "Part of"], ["classification", "Classification"], ["material", "Material"],
];

const RELATIONS = [
  "", "IFCRELAGGREGATES", "IFCRELASSIGNSTOGROUP", "IFCRELCONTAINEDINSPATIALSTRUCTURE",
  "IFCRELNESTS", "IFCRELVOIDSELEMENT IFCRELFILLSELEMENT",
];

const facetName = (facet: IdsFacetDraft): string => {
  const exact = (rule?: IdsValueRule): string => rule?.simple || rule?.enumeration?.join(", ") || rule?.pattern?.join(", ") || "Any";
  if (facet.kind === "entity") return exact(facet.name);
  if (facet.kind === "attribute") return exact(facet.name);
  if (facet.kind === "property") return `${exact(facet.propertySet)}.${exact(facet.baseName)}`;
  if (facet.kind === "partOf") return exact(facet.entityName);
  if (facet.kind === "classification") return `${exact(facet.system)} : ${exact(facet.value)}`;
  return exact(facet.value);
};

const textInput = (
  value: string,
  onInput: (value: string) => void,
  placeholder = "",
  className = "ids-input",
): HTMLInputElement => {
  const input = h("input", { class: className, type: "text", value, placeholder, spellcheck: "false" });
  input.addEventListener("input", () => onInput(input.value));
  return input;
};

const selectInput = (
  choices: Array<[string, string]>,
  value: string,
  onChange: (value: string) => void,
): HTMLSelectElement => {
  const select = h("select", { class: "ids-input" }, choices.map(([key, label]) => h("option", { value: key, text: label })));
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  return select;
};

const field = (label: string, input: HTMLElement, hint = ""): HTMLElement => h("label", { class: "ids-field" }, [
  h("span", { text: label }), input, ...(hint ? [h("small", { text: hint })] : []),
]);

const simple = (value: string): IdsValueRule => ({ simple: value });

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  let draft = newIdsDocument();
  let selectedSpec = draft.specifications[0].id;
  let selectedFacet = draft.specifications[0].requirements[0].id;
  let view: StudioView = "validate";
  let results: SpecResult[] = [];
  let report: IdsReport | null = null;
  let baseline = ctx.storage.read<ComplianceBaseline | null>("compliance-baseline", null);
  let staged = new Map<string, StagedCorrection>();
  let bsddHits: BsddHit[] = [];
  let bsddQuery = "";
  let bsddBusy = false;
  let bsddError = "";
  let bsddController: AbortController | null = null;
  let validating = false;
  let validationGeneration = 0;
  /** Set when a click moved the facet selection, so a stacked layout follows it. */
  let revealFacet = false;
  let edited = false;
  let sequence = 0;
  const customTemplates = ctx.storage.read<IdsRequirementTemplate[]>("requirement-templates", []);
  const runProgress = progress();
  const root = page();
  root.classList.add("ids-studio");
  host.appendChild(root);

  const setEdited = (value: boolean): void => {
    edited = value;
    root.classList.toggle("is-edited", value);
  };

  const currentSpec = (): IdsSpecificationDraft => draft.specifications.find((item) => item.id === selectedSpec) ?? draft.specifications[0];
  const facetSelection = (): { facet: IdsFacetDraft; requirements: boolean } | null => {
    const spec = currentSpec();
    const requirement = spec.requirements.find((item) => item.id === selectedFacet);
    if (requirement) return { facet: requirement, requirements: true };
    const applicability = spec.applicability.find((item) => item.id === selectedFacet);
    return applicability ? { facet: applicability, requirements: false } : null;
  };
  // Any edit to the draft outdates the last run, and marks the document as
  // worth confirming before it is thrown away.
  const invalidate = (): void => {
    setEdited(true);
    results = [];
    report = null;
    staged = new Map();
  };

  const overflowMenu = (label: string, actions: OverflowAction[], className = ""): HTMLElement => {
    const menu = h("details", { class: `ids-menu${className ? ` ${className}` : ""}` });
    const body = h("div", { class: "ids-menu-body" }, actions.map((action) => {
      const item = h("button", {
        type: "button",
        title: action.title ?? action.label,
        disabled: action.disabled,
        class: action.danger ? "danger" : "",
      }, [icon(action.icon, 13), h("span", { text: action.label })]);
      item.addEventListener("click", () => {
        menu.removeAttribute("open");
        action.run();
      });
      return item;
    }));
    menu.append(
      h("summary", { class: "btn sm" }, [h("span", { text: label }), icon("chevron", 12)]),
      body,
    );
    return menu;
  };

  const selectFacet = (id: string): void => {
    bsddController?.abort();
    bsddController = null;
    bsddBusy = false;
    selectedFacet = id;
    bsddHits = [];
    revealFacet = true;
    paint();
  };

  const openIds = async (): Promise<void> => {
    try {
      const opened = await ctx.files.open("ids-studio.open");
      draft = parseIdsDocument(opened.text, opened.name);
      loadIds(opened.text, opened.name);
      selectedSpec = draft.specifications[0].id;
      selectedFacet = draft.specifications[0].requirements[0]?.id ?? draft.specifications[0].applicability[0]?.id ?? "";
      invalidate();
      setEdited(false);
      // Land on Check: an opened IDS file is almost always about to be run.
      view = "validate";
      paint();
      ctx.feedback.log(`Opened ${opened.name}`, "success");
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "AbortError")) ctx.feedback.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const exportIds = (): void => {
    try {
      const xml = serializeIdsDocument(draft);
      loadIds(xml, draft.fileName);
      ctx.files.export("ids-studio.ids", draft.fileName.replace(/\.(xml|ids)$/i, "") + ".ids", xml, "application/xml");
      setEdited(false);
      paint();
      ctx.feedback.toast("IDS 1.0 file exported", "success");
    } catch (error) {
      ctx.feedback.toast(error instanceof Error ? error.message : String(error), "error");
    }
  };

  const source = (): Viewer => ({
    getElementTypes: () => new Map(ctx.model.elements().map((item) => [item.id, item.type])),
    getProperties: (id: number) => ctx.model.properties(id),
    getSpatialTree: () => ctx.model.tree(),
  }) as unknown as Viewer;

  const validate = async (): Promise<void> => {
    if (validating) return;
    if (!ctx.session.model().loaded) return void ctx.feedback.toast("Open an IFC model before validating", "error");
    validating = true;
    const generation = ++validationGeneration;
    try {
      view = "validate";
      results = [];
      report = null;
      staged = new Map();
      paint();
      loadIds(serializeIdsDocument(draft), draft.fileName);
      const nextResults = await runIds(
        source(),
        undefined,
        (spec, index, total, done, of) => {
          if (generation === validationGeneration) runProgress.set(done, Math.max(1, of), `${index + 1}/${total}  ${spec.name}`);
        },
      );
      if (generation !== validationGeneration) return;
      results = nextResults;
      report = lastIdsReport();
      if (report) {
        ctx.results.create("ids-studio.results", report.specifications, {
          metadata: { summary: `${report.failedSpecifications} failing specification(s)` },
        });
        ctx.feedback.publishFindings(
          `${report.failedSpecifications} of ${report.specifications.length} IDS specifications fail.`,
          report.specifications.filter((item) => item.status !== "pass").map((item) => ({
            severity: item.status === "fail" ? "error" : "warning",
            title: item.name,
            count: item.failed,
            detail: item.status === "not_run"
              ? `Not run: ${item.blockedBy.join(", ")}`
              : item.applicabilityIssue || `${item.failed} of ${item.applicable} applicable elements fail`,
          })),
        );
      }
      ctx.feedback.log(report?.failedSpecifications ? "IDS validation found failures" : "IDS validation passed", report?.failedSpecifications ? "error" : "success");
    } catch (error) {
      if (generation === validationGeneration) ctx.feedback.toast(error instanceof Error ? error.message : String(error), "error");
    } finally {
      validating = false;
      runProgress.hide();
      paint();
    }
  };

  const corrections = (): StagedCorrection[] => results.flatMap((result) => result.failures.map((failure) => ({
    specification: result.spec.name,
    expressID: failure.id,
    reason: failure.reason,
    suggestion: failure.suggestion ?? "Review this requirement",
  })));
  const correctionKey = (correction: StagedCorrection): string =>
    `${correction.specification}\u001f${correction.expressID}\u001f${correction.reason}`;
  const stage = (correction: StagedCorrection): void => {
    const key = correctionKey(correction);
    if (staged.has(key)) staged.delete(key);
    else staged.set(key, correction);
    paint();
  };
  const stageAll = (): void => {
    staged = new Map(corrections().map((item) => [correctionKey(item), item]));
    paint();
  };

  const exportResults = (): void => {
    if (!report) return void ctx.feedback.toast("Run validation first", "error");
    const payload = { generatedAt: new Date().toISOString(), model: ctx.session.model(), report, stagedCorrections: [...staged.values()] };
    ctx.files.export("ids-studio.results", "ids-compliance.json", JSON.stringify(payload, null, 2), "application/json");
  };
  const exportCorrections = (): void => {
    ctx.files.export("ids-studio.corrections", "ids-staged-corrections.json", JSON.stringify({
      model: ctx.session.model(), ids: draft.title, corrections: [...staged.values()],
    }, null, 2), "application/json");
  };

  const createBcf = async (): Promise<void> => {
    const failing = results.filter((item) => item.applicabilityIssue || item.failures.length > 0);
    if (!failing.length) return void ctx.feedback.toast("There are no failing specifications to send to BCF", "info");
    for (const result of failing) {
      const suggestions = [...new Set(result.failures.map((item) => item.suggestion).filter(Boolean))].slice(0, 8);
      await ctx.issues.create({
        title: `IDS: ${result.spec.name}`,
        description: `${result.applicabilityIssue ? `${result.applicabilityIssue}. ` : ""}${result.failures.length} element(s) do not meet the requirement.${suggestions.length ? `\n\nSuggested corrections:\n${suggestions.map((item) => `- ${item}`).join("\n")}` : ""}`,
        elementIds: result.failures.slice(0, 200).map((item) => item.id),
        priority: "High",
        metadata: { source: "IDS Requirements Studio", specification: result.spec.name, failed: result.failures.length + (result.applicabilityIssue ? 1 : 0) },
      });
    }
    ctx.feedback.toast(`Created ${failing.length} BCF topic${failing.length === 1 ? "" : "s"}`, "success");
  };

  const saveBaseline = (): void => {
    if (!report) return void ctx.feedback.toast("Run validation before saving a baseline", "error");
    baseline = {
      modelKey: ctx.session.model().key,
      modelName: ctx.session.model().name,
      savedAt: new Date().toISOString(),
      idsTitle: draft.title,
      report: structuredClone(report),
    };
    ctx.storage.write("compliance-baseline", baseline);
    view = "compare";
    paint();
  };

  /** Ids must stay unique even when two are made in the same millisecond. */
  const nextId = (prefix: string): string => `${prefix}-${Date.now()}-${++sequence}`;

  const selectSpecification = (spec: IdsSpecificationDraft): void => {
    bsddController?.abort();
    bsddController = null;
    bsddBusy = false;
    selectedSpec = spec.id;
    selectedFacet = spec.requirements[0]?.id ?? spec.applicability[0]?.id ?? "";
    bsddHits = [];
    bsddError = "";
    paint();
  };

  const addSpecification = (): void => {
    const template = newIdsDocument().specifications[0];
    template.id = nextId("spec");
    template.name = "New specification";
    template.identifier = `REQ-${String(draft.specifications.length + 1).padStart(3, "0")}`;
    draft.specifications.push(template);
    invalidate();
    selectSpecification(template);
  };

  const duplicateSpecification = (spec: IdsSpecificationDraft): void => {
    const copy: IdsSpecificationDraft = {
      ...structuredClone(spec),
      id: nextId("spec"),
      name: `${spec.name} copy`,
      identifier: `REQ-${String(draft.specifications.length + 1).padStart(3, "0")}`,
      applicability: spec.applicability.map(cloneFacet),
      requirements: spec.requirements.map(cloneFacet),
    };
    draft.specifications.splice(draft.specifications.indexOf(spec) + 1, 0, copy);
    invalidate();
    selectSpecification(copy);
  };

  const removeSpecification = (spec: IdsSpecificationDraft): void => {
    if (draft.specifications.length < 2) {
      return void ctx.feedback.toast("An IDS file needs at least one specification", "error");
    }
    const drop = (): void => {
      const at = draft.specifications.indexOf(spec);
      draft.specifications.splice(at, 1);
      invalidate();
      selectSpecification(draft.specifications[Math.min(at, draft.specifications.length - 1)]);
    };
    if (!spec.requirements.length && !spec.applicability.length) return drop();
    confirmAction(
      `Remove ${spec.name}?`,
      `${spec.applicability.length} applicability and ${spec.requirements.length} requirement facet(s) go with it. Nothing is written until you export the .ids file.`,
      "Remove",
      drop,
    );
  };

  const newDocument = (): void => {
    const reset = (): void => {
      draft = newIdsDocument();
      selectedSpec = draft.specifications[0].id;
      selectedFacet = draft.specifications[0].requirements[0].id;
      invalidate();
      setEdited(false);
      view = "author";
      paint();
    };
    if (!edited) return reset();
    confirmAction("Start a new IDS file?", `"${draft.title}" has unsaved edits. Export the .ids file first if you want to keep it.`, "Discard and start over", reset);
  };

  const addFacet = (kind: IdsFacetKind, requirements: boolean): void => {
    const facet = newFacet(kind);
    (requirements ? currentSpec().requirements : currentSpec().applicability).push(facet);
    invalidate();
    selectFacet(facet.id);
  };

  const removeFacet = (facet: IdsFacetDraft): void => {
    const spec = currentSpec();
    spec.applicability = spec.applicability.filter((item) => item.id !== facet.id);
    spec.requirements = spec.requirements.filter((item) => item.id !== facet.id);
    selectedFacet = spec.requirements[0]?.id ?? spec.applicability[0]?.id ?? "";
    invalidate();
    paint();
  };

  const insertTemplate = (id: string): void => {
    const template = [...BUILTIN_IDS_TEMPLATES, ...customTemplates].find((item) => item.id === id);
    if (!template) return;
    const added = template.requirements.map(cloneFacet);
    currentSpec().requirements.push(...added);
    invalidate();
    ctx.feedback.toast(`Added ${added.length} requirement facet${added.length === 1 ? "" : "s"} from ${template.name}`, "success");
    selectFacet(added[0]?.id ?? selectedFacet);
  };

  const saveTemplate = (name: string): void => {
    const clean = name.trim();
    if (!clean) return void ctx.feedback.toast("Name the template first", "error");
    customTemplates.push({
      id: `custom-${Date.now()}`,
      name: clean,
      description: `Saved from ${currentSpec().name}`,
      requirements: currentSpec().requirements.map(cloneFacet),
    });
    ctx.storage.write("requirement-templates", customTemplates);
    ctx.feedback.toast(`Saved template ${clean}`, "success");
    paint();
  };

  const runBsddSearch = async (kind: BsddKind | "All"): Promise<void> => {
    bsddController?.abort();
    bsddController = null;
    const query = bsddQuery.trim();
    if (query.length < 2) {
      bsddHits = [];
      bsddBusy = false;
      bsddError = "Enter at least two characters.";
      paint();
      return;
    }
    const runController = new AbortController();
    bsddController = runController;
    bsddBusy = true;
    bsddError = "";
    paint();
    try {
      const hits = await searchBsdd(query, kind, runController.signal);
      if (bsddController === runController) bsddHits = hits;
    } catch (error) {
      if (bsddController === runController && !(error instanceof DOMException && error.name === "AbortError")) {
        bsddError = error instanceof Error ? error.message : String(error);
      }
    } finally {
      if (bsddController === runController) {
        bsddController = null;
        bsddBusy = false;
        paint();
      }
    }
  };

  const bsddKindFor = (kind: IdsFacetKind): BsddKind =>
    kind === "property" ? "Property" : kind === "material" ? "Material" : "Class";

  /** Enter searches; retyping the query must not cost a repaint. */
  const bsddSearchInput = (kind: IdsFacetKind): HTMLInputElement => {
    const input = textInput(bsddQuery, (value) => { bsddQuery = value; }, "Search classes and properties");
    input.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      event.preventDefault();
      void runBsddSearch(bsddKindFor(kind));
    });
    return input;
  };

  const applyBsdd = (hit: BsddHit): void => {
    const selected = facetSelection();
    if (!selected) return;
    const facet = selected.facet;
    if (facet.kind === "property" && hit.kind === "Property") {
      facet.baseName = simple(hit.code);
      facet.uri = hit.uri;
    } else if (facet.kind === "material" && hit.kind === "Material") {
      facet.value = simple(hit.code);
      facet.uri = hit.uri;
    } else if (facet.kind === "classification") {
      facet.system = simple(hit.dictionaryName || hit.dictionaryUri);
      facet.value = simple(hit.code);
      facet.uri = hit.uri;
    } else if (facet.kind === "entity" && hit.relatedIfcEntities.length) {
      facet.name = simple(hit.relatedIfcEntities[0]);
    } else {
      ctx.feedback.toast(`Select a matching ${hit.kind.toLowerCase()} facet first`, "info");
      return;
    }
    invalidate();
    bsddHits = [];
    paint();
  };

  const ruleEditor = (label: string, rule: IdsValueRule | undefined, set: (rule: IdsValueRule) => void): HTMLElement => {
    const mode = rule?.simple !== undefined ? "exact"
      : rule?.enumeration?.length ? "list"
        : rule?.pattern?.length ? "pattern" : "range";
    const modeSelect = selectInput([
      ["exact", "Exact value"], ["list", "One of"], ["pattern", "Pattern"], ["range", "Number range"],
    ], mode, (next) => {
      set(next === "exact" ? simple("") : next === "list" ? { enumeration: [] } : next === "pattern" ? { pattern: [] } : {});
      invalidate();
      paint();
    });
    let control: HTMLElement;
    if (mode === "exact") control = textInput(rule?.simple ?? "", (value) => { set(simple(value)); invalidate(); });
    else if (mode === "list") control = textInput(rule?.enumeration?.join(", ") ?? "", (value) => {
      set({ enumeration: value.split(",").map((item) => item.trim()).filter(Boolean) }); invalidate();
    }, "Value A, Value B");
    else if (mode === "pattern") control = textInput(rule?.pattern?.[0] ?? "", (value) => { set({ pattern: [value] }); invalidate(); }, ".*pattern.*");
    else {
      const min = h("input", { class: "ids-input", type: "number", placeholder: "Minimum", value: rule?.minInclusive ?? "" });
      const max = h("input", { class: "ids-input", type: "number", placeholder: "Maximum", value: rule?.maxInclusive ?? "" });
      const update = (): void => {
        set({
          base: "xs:decimal",
          minInclusive: min.value === "" ? undefined : Number(min.value),
          maxInclusive: max.value === "" ? undefined : Number(max.value),
        });
        invalidate();
      };
      min.addEventListener("input", update);
      max.addEventListener("input", update);
      control = h("div", { class: "ids-range" }, [min, max]);
    }
    return h("div", { class: "ids-rule" }, [h("div", { class: "ids-rule-head" }, [h("span", { text: label }), modeSelect]), control]);
  };

  const facetEditor = (): HTMLElement => {
    const selected = facetSelection();
    if (!selected) return emptyState("sliders", "Select a facet", "Choose a facet from the definition to edit its criteria.");
    const { facet, requirements } = selected;
    const fields: HTMLElement[] = [];
    type RuleKey = "name" | "predefinedType" | "value" | "propertySet" | "baseName" | "system" | "entityName";
    const setRule = (key: RuleKey) => (rule: IdsValueRule): void => { facet[key] = rule; };
    if (facet.kind === "entity") {
      fields.push(ruleEditor("IFC class", facet.name, setRule("name")), ruleEditor("Predefined type", facet.predefinedType, setRule("predefinedType")));
    } else if (facet.kind === "attribute") {
      fields.push(ruleEditor("Attribute name", facet.name, setRule("name")), ruleEditor("Value", facet.value, setRule("value")));
    } else if (facet.kind === "property") {
      fields.push(
        ruleEditor("Property set", facet.propertySet, setRule("propertySet")),
        ruleEditor("Property name", facet.baseName, setRule("baseName")),
        ruleEditor("Value", facet.value, setRule("value")),
        field("IFC data type", textInput(facet.dataType ?? "", (value) => { facet.dataType = value.toUpperCase(); invalidate(); }, "IFCLABEL")),
      );
    } else if (facet.kind === "partOf") {
      fields.push(
        ruleEditor("Parent entity", facet.entityName, setRule("entityName")),
        field("Relation", selectInput(RELATIONS.map((item) => [item, item || "Any supported relation"]), facet.relation ?? "", (value) => {
          facet.relation = value; invalidate();
        })),
      );
    } else if (facet.kind === "classification") {
      fields.push(ruleEditor("System", facet.system, setRule("system")), ruleEditor("Code", facet.value, setRule("value")));
    } else fields.push(ruleEditor("Material", facet.value, setRule("value")));
    if (requirements && facet.kind !== "entity") {
      const cardinalities: Array<[string, string]> = facet.kind === "partOf"
        ? [["required", "Required"], ["prohibited", "Prohibited"]]
        : [["required", "Required"], ["optional", "Optional"], ["prohibited", "Prohibited"]];
      fields.push(field("Cardinality", selectInput(cardinalities, facet.cardinality, (value) => {
        facet.cardinality = value as IdsFacetDraft["cardinality"];
        invalidate();
      })));
    }
    if (requirements && ["classification", "property", "material"].includes(facet.kind)) {
      fields.push(field("Stable concept URI", textInput(facet.uri, (value) => { facet.uri = value; invalidate(); }, "https://identifier.buildingsmart.org/uri/..."), "Versioned bSDD URIs remain stable across exchanges."));
    }
    if (requirements) fields.push(field("Author instruction", textInput(facet.instructions, (value) => { facet.instructions = value; invalidate(); }, "How the model author should satisfy this")));
    // bSDD is one step of the job, not the point of the editor, so it stays
    // folded until it is asked for; a search reopens it.
    const bsdd = h("details", { class: "ids-bsdd", open: bsddBusy || bsddHits.length > 0 || Boolean(bsddError) }, [
      h("summary", {}, [h("span", { text: "Find a standard term (bSDD)" })]),
      h("div", { class: "ids-search-row" }, [
        bsddSearchInput(facet.kind),
        button(bsddBusy ? "Searching" : "Search", () => void runBsddSearch(bsddKindFor(facet.kind)), "accent"),
      ]),
      ...(bsddError ? [h("div", { class: "ids-inline-error", text: bsddError })] : []),
      h("div", { class: "ids-bsdd-results" }, bsddHits.slice(0, 20).map((hit) => {
        const pick = h("button", { class: "ids-bsdd-hit", type: "button", title: hit.description || hit.uri }, [
          h("span", { class: "ids-kind", text: hit.kind }),
          h("span", { class: "grow" }, [h("b", { text: hit.name }), h("small", { text: `${hit.dictionaryName} / ${hit.code}` })]),
          icon("chevron", 12),
        ]);
        pick.addEventListener("click", () => applyBsdd(hit));
        return pick;
      })),
    ]);
    return h("div", { class: "ids-inspector" }, [
      h("div", { class: "ids-inspector-head" }, [
        h("span", { class: `ids-facet-mark ${facet.kind}` }),
        h("div", { class: "grow" }, [
          h("b", { text: `Editing: ${FACETS.find(([kind]) => kind === facet.kind)?.[1] ?? facet.kind}` }),
          h("small", { text: requirements ? "A requirement every applicable element must meet" : "A filter that decides which elements are checked" }),
        ]),
        iconButton("trash", "Remove this facet", () => removeFacet(facet), "icon-btn sm"),
      ]),
      ...fields,
      bsdd,
    ]);
  };

  /**
   * The facet editor opens under the list holding the selection rather than in
   * a pane of its own, so the criteria are next to the facet they belong to at
   * every panel width.
   */
  const facetList = (title: string, hint: string, facets: IdsFacetDraft[], requirements: boolean): HTMLElement => {
    const list = h("div", { class: "ids-facet-list" }, facets.map((facet) => {
      const row = h("button", {
        class: `ids-facet-card ${facet.kind}${facet.id === selectedFacet ? " selected" : ""}`,
        type: "button",
        title: facet.instructions || facetName(facet),
      }, [
        h("span", { class: `ids-facet-mark ${facet.kind}` }),
        h("span", { class: "grow" }, [
          h("b", { text: FACETS.find(([kind]) => kind === facet.kind)?.[1] ?? facet.kind }),
          h("small", { text: facetName(facet) }),
        ]),
        ...(requirements && facet.kind !== "entity" ? [h("span", { class: "ids-cardinality", text: facet.cardinality[0].toUpperCase() })] : []),
      ]);
      row.addEventListener("click", () => selectFacet(facet.id));
      return row;
    }));
    const choices: Array<[string, string]> = [["", "+ Add facet"], ...FACETS.map(([kind, label]): [string, string] => [kind, label])];
    const add = selectInput(choices, "", (kind) => {
      if (kind) addFacet(kind as IdsFacetKind, requirements);
    });
    add.classList.add("ids-add-facet");
    const selected = facetSelection();
    const owns = Boolean(selected && selected.requirements === requirements);
    return h("section", { class: "ids-block" }, [
      h("div", { class: "group-title" }, [
        h("span", { text: title }),
        h("span", { class: "n", text: `${facets.length} facet${facets.length === 1 ? "" : "s"}` }),
      ]),
      h("div", { class: "note", text: hint }),
      ...(facets.length ? [list] : [h("div", { class: "note", text: "Nothing yet. Add a facet below." })]),
      add,
      ...(owns ? [facetEditor()] : []),
    ]);
  };

  const editView = (): HTMLElement => {
    const spec = currentSpec();
    const minOccurs = textInput(String(spec.minOccurs), (value) => {
      const parsed = Number(value);
      if (Number.isInteger(parsed) && parsed >= 0) spec.minOccurs = parsed;
      invalidate();
    }, "1");
    const maxOccurs = textInput(String(spec.maxOccurs), (value) => {
      const parsed = Number(value);
      if (value.trim().toLowerCase() === "unbounded") spec.maxOccurs = "unbounded";
      else if (Number.isInteger(parsed) && parsed >= 0) spec.maxOccurs = parsed;
      invalidate();
    }, "unbounded");
    let selectedTemplate = BUILTIN_IDS_TEMPLATES[0]?.id ?? "";
    let templateName = "";
    const templates = [...BUILTIN_IDS_TEMPLATES, ...customTemplates];
    const templateSelect = selectInput(templates.map((item) => [item.id, item.name]), selectedTemplate, (value) => { selectedTemplate = value; });
    // One picker instead of a sidebar: the list of specifications is rarely
    // long, and browsing it is not the job the panel is open for.
    const picker = selectInput(
      draft.specifications.map((item, index): [string, string] => [
        item.id,
        `${index + 1}. ${item.name}${item.identifier ? ` (${item.identifier})` : ""}`,
      ]),
      spec.id,
      (id) => {
        const next = draft.specifications.find((item) => item.id === id);
        if (next) selectSpecification(next);
      },
    );
    picker.classList.add("ids-spec-picker");

    return h("div", { class: "ids-page" }, [
      h("div", { class: "ids-spec-bar" }, [
        picker,
        iconButton("plus", "Add a specification", addSpecification, "icon-btn sm"),
        overflowMenu("Specification", [
          { label: "Duplicate", icon: "copy", title: "Duplicate this specification", run: () => duplicateSpecification(spec) },
          { label: "Remove", icon: "trash", title: "Remove this specification", run: () => removeSpecification(spec), danger: true },
        ], "ids-spec-menu"),
      ]),
      h("div", { class: "ids-meta-grid" }, [
        field("Name", textInput(spec.name, (value) => { spec.name = value; invalidate(); })),
        field("Identifier", textInput(spec.identifier, (value) => { spec.identifier = value; invalidate(); }, "REQ-001")),
        field("IFC version", selectInput([["IFC2X3", "IFC2X3"], ["IFC4", "IFC4"], ["IFC4X3_ADD2", "IFC4X3 ADD2"]], spec.ifcVersion, (value) => { spec.ifcVersion = value; invalidate(); })),
      ]),
      field("Description", textInput(spec.description, (value) => { spec.description = value; invalidate(); }, "What this specification delivers")),
      facetList("Applies to", "Which elements this specification is about.", spec.applicability, false),
      facetList("Must provide", "What those elements have to carry to pass.", spec.requirements, true),
      h("details", { class: "ids-more" }, [
        h("summary", { text: "More options" }),
        h("div", { class: "ids-more-body" }, [
          h("div", { class: "ids-meta-grid" }, [
            field("Minimum applicable elements", minOccurs, "IDS applicability minOccurs"),
            field("Maximum applicable elements", maxOccurs, "A number, or unbounded"),
          ]),
          h("div", { class: "ids-template-bar" }, [
            h("span", { text: "Requirement template" }), templateSelect,
            button("Insert", () => insertTemplate(selectedTemplate)),
            textInput(templateName, (value) => { templateName = value; }, "Save current as..."),
            button("Save", () => saveTemplate(templateName)),
          ]),
        ]),
      ]),
    ]);
  };

  const checkView = (): HTMLElement => {
    const totalApplicable = results.reduce((sum, item) => sum + item.applicable, 0);
    const totalFailed = results.reduce((sum, item) => sum + item.failures.length + (item.applicabilityIssue ? 1 : 0), 0);
    const cards = results.map((result) => {
      const tone = result.blocked.length ? "blocked" : result.applicabilityIssue || result.failures.length ? "fail" : "pass";
      const body = h("div", { class: "ids-result-body" });
      if (result.blocked.length) body.appendChild(h("p", { text: `Could not run because ${result.blocked.join(", ")} could not be evaluated.` }));
      if (result.applicabilityIssue) body.appendChild(h("p", { class: "ids-inline-error", text: result.applicabilityIssue }));
      for (const failure of result.failures.slice(0, 100)) {
        const correction: StagedCorrection = {
          specification: result.spec.name,
          expressID: failure.id,
          reason: failure.reason,
          suggestion: failure.suggestion ?? "Review this requirement",
        };
        const key = correctionKey(correction);
        const row = h("div", { class: "ids-failure" }, [
          h("button", { class: "ids-failure-pick", type: "button" }, [
            h("span", { class: "mono", text: `#${failure.id}` }),
            h("span", { class: "grow" }, [h("b", { text: failure.reason }), h("small", { text: correction.suggestion })]),
          ]),
          button(staged.has(key) ? "Staged" : "Stage", () => stage(correction), staged.has(key) ? "accent" : ""),
        ]);
        row.querySelector(".ids-failure-pick")?.addEventListener("click", () => {
          ctx.view.select(failure.id);
          ctx.view.frame(failure.id);
        });
        body.appendChild(row);
      }
      if (result.failures.length > 100) {
        body.appendChild(h("p", { class: "note", text: `Listing the first 100 of ${result.failures.length.toLocaleString()} failing elements. The JSON export carries all of them.` }));
      }
      const toggle = h("button", { class: `ids-result-head ${tone}`, type: "button", "aria-expanded": "false" }, [
        h("span", { class: "ids-result-state", text: tone === "pass" ? "PASS" : tone === "fail" ? "FAIL" : "NOT RUN" }),
        h("span", { class: "grow" }, [h("b", { text: result.spec.name }), h("small", { text: `${result.passed} of ${result.applicable} applicable elements pass` })]),
        h("span", { class: "mono", text: String(result.failures.length + (result.applicabilityIssue ? 1 : 0)) }), icon("chevron", 12),
      ]);
      body.classList.add("hidden");
      toggle.addEventListener("click", () => {
        const open = toggle.getAttribute("aria-expanded") !== "true";
        toggle.setAttribute("aria-expanded", String(open));
        body.classList.toggle("hidden", !open);
      });
      return h("section", { class: "ids-result-card" }, [toggle, body]);
    });
    const check = button(validating ? "Checking model" : results.length ? "Check again" : "Check the open model", () => void validate(), "accent");
    check.disabled = validating;
    return h("div", { class: "ids-page" }, [
      h("div", { class: "ids-actionbar" }, [
        check,
        ...(results.length ? [
          overflowMenu("Result actions", [
            { label: "Export results", icon: "download", run: exportResults },
            { label: "Raise BCF issues", icon: "flag", run: () => void createBcf() },
            { label: "Stage all fixes", icon: "check", run: stageAll },
            { label: "Save as baseline", icon: "bookmark", run: saveBaseline },
          ], "ids-result-menu"),
        ] : []),
      ]),
      runProgress.root,
      ...(results.length ? [stats([
        ["Specifications", String(results.length)],
        ["Applicable", totalApplicable.toLocaleString()],
        ["Failures", totalFailed.toLocaleString(), totalFailed ? "err" : "ok"],
        ["Staged", String(staged.size), staged.size ? "warn" : ""],
      ])] : []),
      ...(staged.size ? [h("div", { class: "ids-staged-bar" }, [
        h("span", { class: "grow", text: `${staged.size} fix${staged.size === 1 ? "" : "es"} staged for review. No IFC data has been changed.` }),
        button("Export fixes", exportCorrections),
      ])] : []),
      ...(cards.length ? cards : [emptyState(
        "clipboard",
        `${draft.specifications.length} requirement${draft.specifications.length === 1 ? "" : "s"} ready`,
        "Check reports which elements of the open model meet this IDS file and which do not. Nothing in the model is changed.",
      )]),
    ]);
  };

  const compareView = (): HTMLElement => {
    if (!baseline) return emptyState("compare", "No compliance baseline", "Validate a model and save its result as the revision baseline first.");
    const current = new Map((report?.specifications ?? []).map((item) => [item.name, item]));
    const rows = baseline.report.specifications.map((before) => {
      const after = current.get(before.name);
      const delta = after ? after.failed - before.failed : 0;
      return h("div", { class: "ids-compare-row" }, [
        h("span", { class: "grow" }, [h("b", { text: before.name }), h("small", { text: after ? `${before.status.replace("_", " ")} to ${after.status.replace("_", " ")}` : "Not present in current IDS run" })]),
        h("span", { class: "ids-before", text: String(before.failed) }),
        h("span", { class: "ids-delta", text: after ? (delta > 0 ? `+${delta}` : String(delta)) : "-" }),
        h("span", { class: "ids-after", text: after ? String(after.failed) : "-" }),
      ]);
    });
    const improved = baseline.report.specifications.filter((before) => (current.get(before.name)?.failed ?? before.failed) < before.failed).length;
    const regressed = baseline.report.specifications.filter((before) => (current.get(before.name)?.failed ?? before.failed) > before.failed).length;
    // A baseline saved against another file compares two different models, so
    // say so rather than presenting the deltas as a revision history.
    const otherModel = baseline.modelKey !== ctx.session.model().key;
    return h("div", { class: "ids-page" }, [
      ...(otherModel ? [h("div", { class: "ids-staged-bar" }, [
        h("span", { class: "grow", text: `The baseline was saved from ${baseline.modelName}, not the open model. These deltas compare two different files.` }),
      ])] : []),
      ...(baseline.idsTitle !== draft.title ? [h("div", { class: "ids-staged-bar" }, [
        h("span", { class: "grow", text: `The baseline used the IDS file "${baseline.idsTitle}". Specifications renamed since then compare as missing.` }),
      ])] : []),
      h("div", { class: "note", text: `Baseline ${baseline.modelName}, saved ${new Date(baseline.savedAt).toLocaleString()}, against ${ctx.session.model().name || "the open model"}${report ? "" : " (not checked yet)"}.` }),
      h("div", { class: "ids-actionbar" }, [
        button("Check this revision", () => void validate(), "accent"),
        overflowMenu("Baseline", [
          { label: "Replace baseline", icon: "refresh", run: saveBaseline, disabled: !report },
        ]),
      ]),
      stats([["Improved", String(improved), "ok"], ["Regressed", String(regressed), "err"], ["Unchanged", String(Math.max(0, baseline.report.specifications.length - improved - regressed))]]),
      h("div", { class: "ids-compare-head" }, [h("span", { class: "grow", text: "Specification" }), h("span", { text: "Before" }), h("span", { text: "Delta" }), h("span", { text: "Now" })]),
      ...rows,
    ]);
  };

  function paint(): void {
    const navigation = h("div", { class: "seg ids-nav", role: "tablist" }, ([
      ["validate", "Check"], ["author", "Edit"], ["compare", "Compare"],
    ] as Array<[StudioView, string]>).map(([id, label]) => {
      const tab = h("button", { type: "button", role: "tab", "aria-pressed": String(view === id), "aria-selected": String(view === id), tabindex: view === id ? "0" : "-1", text: label });
      tab.addEventListener("click", () => { view = id; paint(); });
      return tab;
    }));
    const title = textInput(draft.title, (value) => { draft.title = value; setEdited(true); }, "IDS title", "ids-title-input");
    title.setAttribute("aria-label", "IDS document title");
    const open = button("Open IDS", () => void openIds(), "accent");
    open.disabled = validating;
    root.replaceChildren(
      h("header", { class: "plug-head ids-head" }, [
        h("div", { class: "grow" }, [
          title,
          h("p", {}, [
            h("span", { text: `buildingSMART IDS 1.0 / ${draft.specifications.length} specification${draft.specifications.length === 1 ? "" : "s"}` }),
            h("span", { class: "ids-edited", text: "Unsaved changes" }),
          ]),
        ]),
        open,
        overflowMenu("File", [
          { label: "New IDS", icon: "file", run: newDocument },
          { label: "Export .ids", icon: "download", run: exportIds },
        ], "ids-file-menu"),
      ]),
      navigation,
      view === "author" ? editView() : view === "validate" ? checkView() : compareView(),
    );
    // The editor opens under a list that may already be off the fold.
    if (revealFacet) {
      revealFacet = false;
      const editor = root.querySelector(".ids-inspector");
      if (editor && typeof editor.scrollIntoView === "function") editor.scrollIntoView({ block: "nearest" });
    }
  }

  paint();
  const offModel = ctx.events?.on?.("model", () => {
    validationGeneration += 1;
    results = [];
    report = null;
    staged = new Map();
    runProgress.hide();
    view = "validate";
    paint();
  }) ?? (() => undefined);
  return {
    dispose: () => {
      validationGeneration += 1;
      bsddController?.abort();
      offModel();
    },
    receive: (payload) => {
      if (payload && typeof payload === "object" && (payload as { type?: string }).type === "validate") void validate();
    },
  };
}
