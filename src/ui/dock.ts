// The viewport rail: every camera, tool and visibility control as one column
// of icons floating in the top-left corner, clear of the structure panel and
// of the viewport floor. Each icon opens its options sideways, next to itself.
// It reads and writes the viewer directly, so no tool state is mirrored
// anywhere else.
import { attachPopover, busyRow, h, icon, iconButton, toast } from "./kit.js";
import { applyColors, colorableKeys, computeColors, computeColorsFromEntries, cssColor, CustomColors, materialColorEntries, type ColorResult, type ColorRule } from "./colorBy.js";
import { formatArea, formatLength, formatVolume, formatWeight } from "../viewer-core/viewer.js";
import type { PropertyIndex } from "../sdk/data.js";
import { isAxisSection } from "../viewer-core/viewer.js";
import { classifyByPlanes } from "../geometry/plane.js";
import { measureVolumes } from "../geometry/volumes.js";
import type {
  AnnotationState, AxisSectionState, CameraPose, ItemProperties, LazyCategory, MeasureConstraint, MeasurementFormat,
  MeasurementObject, MeasurementState, MeasureMode, PlaneSectionState, SectionBox, SectionState, ShapeMeasure, SnapMode,
  Viewer, ViewPreset,
} from "../viewer-core/viewer.js";
import {
  measurementTypeLabel,
  measurementValue,
  measurementsFromCsv,
  measurementsToCsv,
} from "./measurementLedger.js";

interface Viewpoint {
  name: string;
  pose: CameraPose;
  /** Kept for viewpoints saved before sections could combine. */
  section: SectionState | null;
  sections?: SectionState[];
  /** Absent on viewpoints saved before the box existed, which is not a box. */
  box?: SectionBox | null;
  measurements?: MeasurementState[];
  /** Display offsets (storey slide, explode, moved elements) at capture. */
  offsets?: Array<[number, [number, number, number]]>;
  annotations?: AnnotationState[];
}

const AXES: Array<AxisSectionState["axis"]> = ["x", "y", "z"];
const VIEWS: Array<[string, ViewPreset]> = [
  ["Front", "front"],
  ["Back", "back"],
  ["Right", "right"],
  ["Left", "left"],
  ["Top", "top"],
  ["Bottom", "bottom"],
  ["Iso", "iso"],
];
const CATEGORIES: Array<[LazyCategory, string]> = [
  ["IfcSpace", "Spaces"],
  ["IfcOpeningElement", "Openings"],
];
const DENSITIES: Array<[string, number]> = [
  ["Concrete", 2400],
  ["Steel", 7850],
  ["Aluminium", 2700],
  ["Timber", 500],
  ["Masonry", 1800],
];
const SURVEY_DENSITY_KEY = "ifcviewx.survey.density";
/** Elements read per survey run; selections beyond it are counted, not read. */
const SURVEY_CAP = 500;
/** Rail width plus the gutter the measure card starts after, in CSS px. */
const CARD_GUTTER = 42;
/** The section panel is the widest rail popover. */
const WIDEST_POP = 262;

/** First authored quantity under any of these names, quantity sets only. */
function readQuantity(props: ItemProperties | null, names: string[]): number | null {
  if (!props) return null;
  for (const name of names) {
    for (const pset of props.psets) {
      if (pset.kind !== "qto") continue;
      for (const prop of pset.properties) {
        if (prop.name !== name) continue;
        // Number(null) is 0; an unfilled quantity must not read as authored.
        if (prop.value === null || prop.value === undefined || prop.value === "") continue;
        const value = typeof prop.value === "number" ? prop.value : Number(prop.value);
        if (Number.isFinite(value) && value >= 0) return value;
      }
    }
  }
  return null;
}
/** Three is the whole choice: smart, corners only, or nothing. */
const SNAPS: Array<[SnapMode, string, string]> = [
  ["auto", "Auto", "Corners, midpoints and edges"],
  ["vertex", "Vertex", "Corners only"],
  ["off", "Off", "Any point on the surface"],
];
const MODES: Array<[MeasureMode, string, string]> = [
  ["distance", "Length", "Two points"],
  ["path", "Path", "Chained segments with a running total"],
  ["angle", "Angle", "Three points: arm, corner, arm"],
  ["area", "Area", "Click a ring of points, then close it"],
  ["count", "Count", "Click to place numbered tally markers"],
  ["coordinate", "Point", "Place a persistent XYZ coordinate"],
];
const CONSTRAINTS: Array<[MeasureConstraint, string, string]> = [
  ["free", "Free", "No axis constraint (0)"],
  ["x", "X", "Lock to world X (X)"],
  ["y", "Y", "Lock to world Y (Y)"],
  ["z", "Z", "Lock to world Z (Z)"],
  ["perpendicular", "⊥", "Lock perpendicular to the picked start surface (P)"],
  ["parallel", "∥", "Lock parallel to the picked start surface (L)"],
];
const UNIT_PRESETS: Array<[string, string, MeasurementFormat]> = [
  ["auto", "Auto", { unit: "auto", precision: { mode: "decimals", value: 2 }, zeroSuppression: 0 }],
  ["mm", "Millimetres", { unit: "millimetres", precision: { mode: "decimals", value: 0 }, zeroSuppression: 8 }],
  ["cm", "Centimetres", { unit: "centimetres", precision: { mode: "decimals", value: 1 }, zeroSuppression: 8 }],
  ["m", "Metres", { unit: "metres", precision: { mode: "decimals", value: 3 }, zeroSuppression: 8 }],
  ["ft", "Decimal feet", { unit: "decimal-feet", precision: { mode: "decimals", value: 3 }, zeroSuppression: 8 }],
  ["in", "Decimal inches", { unit: "decimal-inches", precision: { mode: "decimals", value: 2 }, zeroSuppression: 8 }],
  ["eng", "Engineering", { unit: "engineering", precision: { mode: "decimals", value: 2 }, zeroSuppression: 1 }],
  ["arch", "Architectural", { unit: "architectural", precision: { mode: "denominator", value: 16 }, zeroSuppression: 0 }],
];
const MEASURE_FORMAT_KEY = "ifcviewx.measure.format.v1";
/** Viewpoints are keyed by model shape so they follow the model, not the tab. */
export function viewpointKey(viewer: Viewer): string | null {
  const stats = viewer.getStats();
  return stats ? `ifcviewx.vp.${stats.totalEntities}-${stats.triangleCount}` : null;
}

/** First-class measurements live with the model shape, independently of viewpoints. */
export function measurementKey(viewer: Viewer): string | null {
  const stats = viewer.getStats();
  return stats ? `ifcviewx.measure.${stats.totalEntities}-${stats.triangleCount}` : null;
}

export function readMeasurements(key: string): MeasurementState[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as MeasurementState[] : [];
  } catch {
    return [];
  }
}

export function annotationKey(viewer: Viewer): string | null {
  const stats = viewer.getStats();
  return stats ? `ifcviewx.notes.${stats.totalEntities}-${stats.triangleCount}` : null;
}

export function readAnnotations(key: string): AnnotationState[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as unknown;
    return Array.isArray(parsed) ? parsed as AnnotationState[] : [];
  } catch {
    return [];
  }
}

/** Named element sets, keyed by model shape the same way viewpoints are. */
interface SelectionSet {
  name: string;
  ids: number[];
}

/** Enough to hold a storey of a large model without filling the quota. */
const SET_LIMIT = 20000;

export function selectionSetKey(viewer: Viewer): string | null {
  const stats = viewer.getStats();
  return stats ? `ifcviewx.sets.${stats.totalEntities}-${stats.triangleCount}` : null;
}

export function readSelectionSets(key: string): SelectionSet[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? "[]") as SelectionSet[];
    return Array.isArray(parsed) ? parsed.filter((set) => set && Array.isArray(set.ids)) : [];
  } catch {
    return [];
  }
}

function writeSelectionSets(key: string, sets: SelectionSet[]): boolean {
  try {
    localStorage.setItem(key, JSON.stringify(sets));
    return true;
  } catch {
    return false;
  }
}

export function readViewpoints(key: string): Viewpoint[] {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "[]") as Viewpoint[];
  } catch {
    return [];
  }
}

/** Save the current camera and section; returns the stored name. */
export function saveViewpoint(viewer: Viewer, name?: string): string | null {
  const key = viewpointKey(viewer);
  if (!key) return null;
  const views = readViewpoints(key);
  const label = name?.trim() || `View ${views.length + 1}`;
  views.push({
    name: label,
    pose: viewer.getCamera(),
    section: viewer.getSection(),
    sections: viewer.getSections(),
    box: viewer.getSectionBox(),
    measurements: viewer.getMeasurementStates(),
    offsets: viewer.getElementOffsets(),
    annotations: viewer.getAnnotationStates(),
  });
  localStorage.setItem(key, JSON.stringify(views));
  return label;
}

export class Dock {
  private readonly root: HTMLElement;
  private readonly measureBtn: HTMLButtonElement;
  private readonly sectionBtn: HTMLButtonElement;
  private readonly measureCard: HTMLElement;
  private readonly measureValue = h("div", { class: "mc-value" });
  private readonly measureSplit = h("div", { class: "mc-split" });
  private readonly measureList = h("div", { class: "mc-list" });
  private readonly measureHint = h("div", { class: "mc-hint" });
  private readonly measureAccuracySummary = h("span", { class: "mc-summary-note", text: "Auto snap / Free / Auto" });
  private readonly measureLedgerSummary = h("span", { class: "mc-summary-note", text: "0 saved" });
  /** Hover emits at frame rate; the ledger only rereads objects on a real revision. */
  private renderedMeasureRevision = -1;
  private renderedMeasureFormat = "";
  private renderedShapeRevision = -1;
  private latestShapes: ShapeMeasure[] = [];
  private readonly closeRing = h("button", { class: "btn sm grow hidden", type: "button", text: "Close ring" });
  private readonly finishPath = h("button", { class: "btn sm grow hidden", type: "button", text: "Finish path" });
  private readonly measureUnit = h("select", { class: "mc-unit", "aria-label": "Measurement units" });
  private readonly measureSearch = h("input", {
    class: "mc-filter", type: "search", placeholder: "Filter measurements", "aria-label": "Filter measurements",
  }) as HTMLInputElement;
  private readonly measureSort = h("select", { class: "mc-sort", "aria-label": "Sort measurements" }) as HTMLSelectElement;
  private readonly measureImport = h("input", { class: "hidden", type: "file", accept: ".csv,text/csv" });
  private readonly measureCount = h("span", { class: "mc-count", text: "0" });
  private measureVisibility!: HTMLButtonElement;
  private persistedMeasureRevision = -1;
  private restoringMeasurements = false;
  private persistedAnnotationRevision = -1;
  private restoringAnnotations = false;
  private readonly colorBtn: HTMLButtonElement;
  private readonly arrangeBtn: HTMLButtonElement;
  /** Sticky arrange state so the popover reopens where the user left it. */
  private slideAxis: "x" | "y" | "z" = "y";
  private slideSpacing = 0;
  private explodeFactor = 0;
  private colorRule: ColorRule = { kind: "none" };
  private readonly customColors = new CustomColors();
  private colorResult: ColorResult | null = null;
  /** Set once the plugin host exists; property rules read its shared index. */
  private indexProvider: (() => PropertyIndex) | null = null;

  /** Set by the app: opening a file picker is its business, not the dock's. */
  onAddModel: (() => void) | null = null;
  onOpenSmartMeasure: (() => void) | null = null;
  onOpenSectionWorkspace: (() => void) | null = null;

  constructor(host: HTMLElement, private readonly viewer: Viewer) {
    this.root = h("div", { id: "dock", role: "toolbar", "aria-label": "Viewport tools" });

    this.popTool("frame", "Camera and framing", (pop, close) => this.buildViews(pop, close));

    this.sep();
    // One click starts measuring; the card is the options panel and the
    // readout at once, so the tool never needs a second trip to the rail.
    this.measureBtn = this.tool("ruler", "Measure  M", () => {
      viewer.setMeasuring(!viewer.isMeasuring());
      this.sync();
    });
    this.sectionBtn = this.popTool("section", "Section planes  X", (pop) => this.buildSection(pop));
    this.popTool("eye", "Visibility", (pop, close) => this.buildVisibility(pop, close));
    this.colorBtn = this.popTool("palette", "Colour by", (pop) => this.buildColors(pop));
    this.arrangeBtn = this.popTool("move", "Arrange: storey slide, explode, offsets", (pop) => this.buildArrange(pop));

    this.sep();
    this.popTool("layers", "Models", (pop, close) => this.buildModels(pop, close));
    this.popTool("focus", "Selection sets", (pop) => this.buildSelectionSets(pop));
    this.popTool("bookmark", "Saved viewpoints", (pop) => this.buildViewpoints(pop));

    this.restoreMeasurementFormat();
    this.measureCard = this.buildMeasureCard();
    host.append(this.root, this.measureCard);
    // Dragging a handle in the viewport moves the same value the popover
    // shows, so keep any open slider honest.
    viewer.onSectionChange(() => this.syncSectionInputs());
    viewer.onMeasureChange(() => {
      this.persistMeasurements();
      this.syncMeasure();
    });
    viewer.onAnnotationChange(() => this.persistAnnotations());
    viewer.onModelLoaded(() => {
      this.restoreMeasurements();
      this.restoreAnnotations();
      // Offsets do not survive a model swap; neither should the sliders.
      this.slideSpacing = 0;
      this.explodeFactor = 0;
      this.syncArrange();
    });
    this.sync();
  }

  private syncSectionInputs(): void {
    const open = this.root.querySelector(".pop");
    if (!open) return;
    for (const section of this.viewer.getSections()) {
      if (isAxisSection(section)) {
        const slider = open.querySelector<HTMLInputElement>(`input[data-axis="${section.axis}"]`);
        if (slider) slider.value = String(section.offset);
        continue;
      }
      const input = open.querySelector<HTMLInputElement>(`input[data-plane="${section.id}"]`);
      if (input && document.activeElement !== input) input.value = section.offset.toFixed(2);
    }
    // The plan follows the section, so an axis toggle can flip it from afar.
    open
      .querySelector('button[data-plan]')
      ?.setAttribute("aria-pressed", String(this.viewer.isPlanView()));
  }

  /** Reflect tool state that other entry points (keys, palette) can change. */
  sync(): void {
    this.measureBtn.setAttribute("aria-pressed", String(this.viewer.isMeasuring()));
    // Optional call: partial viewers in tests predate the sections refactor.
    this.sectionBtn.setAttribute("aria-pressed", String((this.viewer.getSections?.() ?? []).length > 0));
    this.syncMeasure();
  }

  private sep(): void {
    this.root.appendChild(h("span", { class: "dock-sep" }));
  }

  private tool(name: string, title: string, run: () => void): HTMLButtonElement {
    const button = iconButton(name, title, run);
    this.root.appendChild(h("span", { class: "dock-item" }, [button]));
    return button;
  }

  private popTool(
    name: string,
    title: string,
    build: (pop: HTMLElement, close: () => void) => void,
  ): HTMLButtonElement {
    const button = iconButton(name, title, () => undefined);
    button.setAttribute("aria-expanded", "false");
    this.root.appendChild(h("span", { class: "dock-item" }, [button]));
    // Pinned: these drive the model, so clicking into the viewport to pick a
    // face or drag a handle must not take the panel away.
    attachPopover(button, build, "right", { onToggle: (open) => this.yieldMeasureCard(open), pinned: true });
    return button;
  }

  /**
   * The measure card and a rail panel share the strip beside the rail. Wide
   * enough and they sit side by side; narrower, the card steps aside for as
   * long as the panel is open rather than the two overlapping.
   */
  private yieldMeasureCard(open: boolean): void {
    if (!open || !this.viewer.isMeasuring()) {
      this.measureCard.classList.remove("yield");
      this.root.classList.toggle("card-open", this.viewer.isMeasuring());
      return;
    }
    const host = this.root.parentElement;
    const width = this.measureCard.offsetWidth;
    const tight = (host?.clientWidth ?? 0) - CARD_GUTTER - width - 9 < WIDEST_POP;
    this.measureCard.classList.toggle("yield", tight);
    this.root.classList.toggle("card-open", !tight);
    // Measured now rather than at card open: the card is width-responsive.
    if (!tight) this.root.style.setProperty("--mc-w", `${Math.round(width)}px`);
  }

  // -- measure ---------------------------------------------------------------
  /**
   * The measure card is not a popover: a popover would close on the first
   * click into the viewport, which is exactly when the tool starts being used.
   * It only exists while measuring, so nothing sits over the model otherwise.
   */
  private restoreMeasurementFormat(): void {
    try {
      const stored = JSON.parse(localStorage.getItem(MEASURE_FORMAT_KEY) ?? "null") as MeasurementFormat | null;
      const preset = stored && UNIT_PRESETS.find(([, , value]) => value.unit === stored.unit)?.[2];
      if (preset) this.viewer.setMeasurementFormat(preset);
    } catch { /* invalid preferences return to Auto */ }
  }

  private persistMeasurements(): void {
    if (this.restoringMeasurements) return;
    const key = measurementKey(this.viewer);
    if (!key) return;
    const revision = this.viewer.getMeasurementRevision();
    if (revision === this.persistedMeasureRevision) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.viewer.getMeasurementStates()));
      this.persistedMeasureRevision = revision;
    } catch {
      // A storage quota should never interrupt measuring; CSV remains available.
    }
  }

  private persistAnnotations(): void {
    if (this.restoringAnnotations) return;
    const key = annotationKey(this.viewer);
    if (!key) return;
    const revision = this.viewer.getAnnotationRevision();
    if (revision === this.persistedAnnotationRevision) return;
    try {
      localStorage.setItem(key, JSON.stringify(this.viewer.getAnnotationStates()));
      this.persistedAnnotationRevision = revision;
    } catch {
      // Quota again: notes stay in the session even when they cannot persist.
    }
  }

  private restoreAnnotations(): void {
    const key = annotationKey(this.viewer);
    if (!key) return;
    const states = readAnnotations(key);
    this.restoringAnnotations = true;
    if (states.length) this.viewer.setAnnotationStates(states);
    this.restoringAnnotations = false;
    this.persistedAnnotationRevision = this.viewer.getAnnotationRevision();
  }

  private restoreMeasurements(): void {
    const key = measurementKey(this.viewer);
    if (!key) return;
    const states = readMeasurements(key);
    this.restoringMeasurements = true;
    if (states.length) this.viewer.setMeasurementStates(states);
    this.restoringMeasurements = false;
    this.persistedMeasureRevision = this.viewer.getMeasurementRevision();
    this.syncMeasure();
  }

  private formatLength(value: number): string {
    return formatLength(value, this.viewer.getMeasurementFormat());
  }

  private copyMeasurement(item: MeasurementObject): void {
    const text = `${item.label}: ${measurementValue(item, this.viewer.getMeasurementFormat())}`;
    const fallback = (): void => {
      const input = h("textarea", { "aria-hidden": "true" });
      input.value = text;
      input.style.position = "fixed";
      input.style.opacity = "0";
      document.body.appendChild(input);
      input.select();
      document.execCommand("copy");
      input.remove();
      toast("Measurement copied", "success");
    };
    if (!navigator.clipboard?.writeText) return fallback();
    void navigator.clipboard.writeText(text).then(
      () => toast("Measurement copied", "success"),
      fallback,
    );
  }

  private exportMeasurements(): void {
    const items = this.listedMeasurements();
    if (!items.length) return void toast("There are no matching measurements to export", "info");
    const blob = new Blob([measurementsToCsv(items, this.viewer.getMeasurementFormat())], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: "ifc-measurements.csv" });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  private buildMeasureCard(): HTMLElement {
    const snaps = h("div", { class: "seg mc-snap" });
    for (const [mode, label, hint] of SNAPS) {
      const button = h("button", { type: "button", text: label, title: hint });
      button.addEventListener("click", () => {
        this.viewer.setSnapMode(mode);
        this.syncMeasure();
      });
      snaps.appendChild(button);
    }
    const modes = h("div", { class: "seg mc-mode" });
    for (const [mode, label, hint] of MODES) {
      const button = h("button", { type: "button", text: label, title: hint });
      button.addEventListener("click", () => {
        this.viewer.setMeasureMode(mode);
        this.syncMeasure();
      });
      modes.appendChild(button);
    }

    const constraints = h("div", { class: "mc-constraints", role: "group", "aria-label": "Axis constraint" });
    for (const [constraint, label, title] of CONSTRAINTS) {
      const button = h("button", {
        class: constraint === "free" ? "free" : `axis-${constraint}`,
        type: "button",
        text: label,
        title,
        "data-constraint": constraint,
      });
      button.addEventListener("click", () => this.viewer.setMeasureConstraint(constraint));
      constraints.appendChild(button);
    }

    const activeFormat = this.viewer.getMeasurementFormat();
    for (const [id, label] of UNIT_PRESETS) this.measureUnit.appendChild(h("option", { value: id, text: label }));
    this.measureUnit.value = UNIT_PRESETS.find(([, , format]) => format.unit === activeFormat.unit)?.[0] ?? "auto";
    this.measureUnit.addEventListener("change", () => {
      const format = UNIT_PRESETS.find(([id]) => id === this.measureUnit.value)?.[2];
      if (!format) return;
      this.viewer.setMeasurementFormat(format);
      localStorage.setItem(MEASURE_FORMAT_KEY, JSON.stringify(format));
      this.renderedMeasureRevision = -1;
      this.syncMeasure();
    });

    const reset = h("button", { class: "btn sm grow", type: "button", text: "Clear all" });
    reset.addEventListener("click", () => this.viewer.resetMeasure());
    this.closeRing.addEventListener("click", () => {
      if (!this.viewer.closeArea()) toast("Place at least three points first", "info");
    });
    this.finishPath.addEventListener("click", () => {
      if (!this.viewer.finishPath()) toast("Place at least two points first", "info");
    });
    const done = iconButton("x", "Close measure  Esc", () => {
      this.viewer.setMeasuring(false);
      this.sync();
    }, "icon-btn sm");

    this.measureVisibility = iconButton("eye", "Hide all measurements", () => {
      const items = this.listedMeasurements();
      const visible = items.some((item) => item.visible);
      this.viewer.setMeasurementsVisible(items.map((item) => item.id), !visible);
    }, "icon-btn sm");
    this.measureSearch.addEventListener("input", () => {
      this.renderedMeasureRevision = -1;
      this.syncMeasureLedger();
    });
    for (const [value, label] of [["created", "Created"], ["label", "Label"], ["type", "Type"], ["value", "Value"]]) {
      this.measureSort.appendChild(h("option", { value, text: label }));
    }
    this.measureSort.addEventListener("change", () => {
      this.renderedMeasureRevision = -1;
      this.syncMeasureLedger();
    });
    const importButton = iconButton("upload", "Import measurement CSV", () => this.measureImport.click(), "icon-btn sm");
    const exportButton = iconButton("download", "Export measurement CSV", () => this.exportMeasurements(), "icon-btn sm");
    this.measureImport.addEventListener("change", () => {
      const file = this.measureImport.files?.[0];
      this.measureImport.value = "";
      if (!file) return;
      void file.text().then((text) => {
        const imported = measurementsFromCsv(text);
        if (!imported.length) throw new Error("No valid measurements were found");
        this.viewer.setMeasurementStates([...this.viewer.getMeasurementStates(), ...imported]);
        toast(`Imported ${imported.length} measurement${imported.length === 1 ? "" : "s"}`, "success");
      }).catch((error: unknown) => toast(error instanceof Error ? error.message : "Could not import measurements", "error"));
    });

    const accuracy = h("details", { class: "mc-disclosure" }, [
      h("summary", {}, [h("span", { text: "Accuracy" }), this.measureAccuracySummary]),
      h("div", { class: "mc-disclosure-body" }, [
        h("div", { class: "mc-constraint-row" }, [
          h("span", { class: "mc-key", text: "Lock" }),
          constraints,
        ]),
        h("div", { class: "mc-settings" }, [
          h("label", {}, [h("span", { class: "mc-key", text: "Snap" }), snaps]),
          h("label", {}, [h("span", { class: "mc-key", text: "Units" }), this.measureUnit]),
        ]),
      ]),
    ]);
    const ledger = h("details", { class: "mc-disclosure mc-ledger" }, [
      h("summary", {}, [h("span", { text: "Saved measurements" }), this.measureLedgerSummary]),
      h("div", { class: "mc-disclosure-body" }, [
        h("div", { class: "mc-ledger-tools" }, [
          this.measureSearch,
          this.measureSort,
          this.measureVisibility,
          importButton,
          exportButton,
        ]),
        this.measureList,
        h("div", { class: "mc-row mc-ledger-actions" }, [reset]),
      ]),
    ]);
    // Quantity survey: authored quantity sums over the current selection.
    const surveyOut = h("div", { class: "mc-survey-out" });
    const densitySelect = h("select", { class: "pop-select" }) as HTMLSelectElement;
    for (const [label, value] of DENSITIES) {
      densitySelect.appendChild(h("option", { value: String(value), text: `${label} ${value} kg/m3` }));
    }
    const savedDensity = localStorage.getItem(SURVEY_DENSITY_KEY);
    if (savedDensity && DENSITIES.some(([, value]) => String(value) === savedDensity)) {
      densitySelect.value = savedDensity;
    }
    densitySelect.addEventListener("change", () => localStorage.setItem(SURVEY_DENSITY_KEY, densitySelect.value));
    const surveyRun = h("button", { class: "btn sm grow", type: "button", text: "Survey selection" });
    surveyRun.addEventListener("click", () => void this.runSurvey(surveyOut, Number(densitySelect.value) || 2400));
    const survey = h("details", { class: "mc-disclosure" }, [
      h("summary", {}, [h("span", { text: "Quantity survey" })]),
      h("div", { class: "mc-disclosure-body" }, [
        h("div", { class: "mc-row" }, [densitySelect, surveyRun]),
        surveyOut,
      ]),
    ]);

    const smart = h("button", {
      class: "mc-smart",
      type: "button",
      text: "Smart",
      title: "Open clearance and axis scan",
    });
    smart.addEventListener("click", () => {
      this.viewer.setMeasuring(false);
      this.onOpenSmartMeasure?.();
    });

    return h("div", { id: "measure-card", class: "hidden" }, [
      h("div", { class: "mc-head" }, [
        icon("ruler", 12),
        h("span", { class: "grow", text: "Measure" }),
        this.measureCount,
        smart,
        done,
      ]),
      modes,
      h("div", { class: "mc-readout" }, [this.measureValue, this.measureSplit]),
      this.measureHint,
      h("div", { class: "mc-row mc-finish" }, [this.closeRing, this.finishPath]),
      accuracy,
      ledger,
      survey,
      this.measureImport,
    ]);
  }

  /** Sequence token so a stale survey run never paints over a fresh one. */
  private surveyToken = 0;

  private async runSurvey(out: HTMLElement, density: number): Promise<void> {
    const token = ++this.surveyToken;
    const ids = this.viewer.getSelectedIds();
    if (ids.length === 0) {
      out.replaceChildren(h("div", { class: "empty", text: "Select elements first." }));
      return;
    }
    const scan = ids.slice(0, SURVEY_CAP);
    out.replaceChildren(busyRow(`Reading ${scan.length} element(s)`));
    const sums = { length: 0, area: 0, volume: 0 };
    const covered = { length: 0, area: 0, volume: 0 };
    const unquantified: number[] = [];
    for (const id of scan) {
      if (token !== this.surveyToken) return;
      const props = await this.viewer.getProperties(id).catch(() => null);
      const volume = readQuantity(props, ["NetVolume", "GrossVolume"]);
      const area = readQuantity(props, ["NetArea", "GrossArea", "NetSideArea", "GrossSideArea", "NetFloorArea"]);
      const length = readQuantity(props, ["Length", "Height", "Depth"]);
      if (volume !== null) {
        sums.volume += volume;
        covered.volume++;
      } else {
        unquantified.push(id);
      }
      if (area !== null) {
        sums.area += area;
        covered.area++;
      }
      if (length !== null) {
        sums.length += length;
        covered.length++;
      }
    }
    if (token !== this.surveyToken) return;
    // Elements without authored quantities get true mesh volumes from the
    // geometry worker; the bounding box only stands in when that fails.
    let meshVolume = 0;
    let meshCount = 0;
    let boxVolume = 0;
    let boxCount = 0;
    if (unquantified.length > 0) {
      try {
        const measured = await measureVolumes(this.viewer, unquantified);
        if (token !== this.surveyToken) return;
        for (const entry of measured.volumes) {
          meshVolume += entry.volume;
          meshCount++;
        }
      } catch {
        for (const id of unquantified) {
          const b = this.viewer.getElementBounds(id);
          if (!b) continue;
          boxVolume +=
            Math.max(0, b.max.x - b.min.x) * Math.max(0, b.max.y - b.min.y) * Math.max(0, b.max.z - b.min.z);
          boxCount++;
        }
      }
    }
    if (token !== this.surveyToken) return;
    const format = this.viewer.getMeasurementFormat();
    const row = (key: string, value: string, note: string): HTMLElement =>
      h("div", { class: "mc-survey-row" }, [
        h("span", { class: "mc-key", text: key }),
        h("span", { class: "mc-survey-value", text: value }),
        h("span", { class: "mc-survey-note", text: note }),
      ]);
    const total = sums.volume + meshVolume + boxVolume;
    const volumeNote =
      meshCount > 0
        ? `${covered.volume} authored, ${meshCount} from mesh`
        : boxCount > 0
          ? `${covered.volume} authored, ${boxCount} box estimate`
          : `${covered.volume}/${scan.length} authored`;
    out.replaceChildren(
      row("Count", String(ids.length), ids.length > SURVEY_CAP ? `first ${SURVEY_CAP} read` : ""),
      row("Length", formatLength(sums.length, format), `${covered.length}/${scan.length} authored`),
      row("Area", formatArea(sums.area, format), `${covered.area}/${scan.length} authored`),
      row("Volume", formatVolume(total, format), volumeNote),
      row("Weight", formatWeight(total * density, format), `at ${density} kg/m3`),
    );
  }

  private syncMeasure(): void {
    const on = this.viewer.isMeasuring();
    this.measureCard.classList.toggle("hidden", !on);
    // Rail popovers open past the card instead of stacking on top of it.
    this.root.classList.toggle("card-open", on);
    if (on) this.root.style.setProperty("--mc-w", `${Math.round(this.measureCard.offsetWidth)}px`);
    else this.root.style.removeProperty("--mc-w");
    if (!on) return;
    const snap = this.viewer.getSnapMode();
    const buttons = this.measureCard.querySelectorAll<HTMLButtonElement>(".mc-snap button");
    SNAPS.forEach(([value], index) =>
      buttons[index]?.setAttribute("aria-pressed", String(value === snap)),
    );
    const mode = this.viewer.getMeasureMode();
    const modeButtons = this.measureCard.querySelectorAll<HTMLButtonElement>(".mc-mode button");
    MODES.forEach(([value], index) =>
      modeButtons[index]?.setAttribute("aria-pressed", String(value === mode)),
    );
    const constraint = this.viewer.getMeasureConstraint();
    for (const button of this.measureCard.querySelectorAll<HTMLButtonElement>("[data-constraint]")) {
      button.setAttribute("aria-pressed", String(button.dataset.constraint === constraint));
    }
    const snapLabel = SNAPS.find(([value]) => value === snap)?.[1] ?? "Auto";
    const constraintLabel = CONSTRAINTS.find(([value]) => value === constraint)?.[1] ?? "Free";
    const unitLabel = UNIT_PRESETS.find(([id]) => id === this.measureUnit.value)?.[1] ?? "Auto";
    this.measureAccuracySummary.textContent = `${snapLabel} snap / ${constraintLabel} / ${unitLabel}`;
    this.closeRing.classList.toggle("hidden", mode !== "area");
    this.finishPath.classList.toggle("hidden", mode !== "path");
    this.finishPath.disabled = this.viewer.getPendingPoints().length < 2;
    this.syncMeasureLedger();

    if (mode === "distance") return this.syncDistance();
    this.syncShape(mode);
  }

  private syncDistance(): void {
    const found = this.viewer.getMeasurement();
    this.measureValue.textContent = found && found.distance > 0 ? this.formatLength(found.distance) : "-";
    this.measureValue.classList.toggle("live", !found?.complete);
    this.measureSplit.textContent =
      found && found.distance > 0
        ? `${this.formatLength(found.horizontal)} across · ${this.formatLength(found.vertical)} up · ${
          found.slopePercent === null ? "vertical" : `${found.slopePercent.toFixed(1)}% slope`
        }`
        : "";

    const pending = found !== null && !found.complete;
    this.measureHint.textContent = pending
      ? "Release or click on the second point"
      : found?.complete
        ? `${measurementTypeLabel(found!)} · click starts the next one`
        : "Click or drag from the first point · X/Y/Z axis · P/L surface";
  }

  /** Shape tools read their finished object and say exactly what the next click does. */
  private syncShape(mode: Exclude<MeasureMode, "distance">): void {
    const revision = this.viewer.getMeasurementRevision();
    if (revision !== this.renderedShapeRevision) {
      this.renderedShapeRevision = revision;
      this.latestShapes = this.viewer.getShapeMeasures();
    }
    const pending = this.viewer.getPendingPoints();
    let last: ShapeMeasure | undefined;
    for (let index = this.latestShapes.length - 1; index >= 0; index--) {
      if (this.latestShapes[index].kind === mode) {
        last = this.latestShapes[index];
        break;
      }
    }

    if (mode === "path" && pending.length) {
      let total = 0;
      for (let index = 1; index < pending.length; index++) {
        total += Math.hypot(
          pending[index][0] - pending[index - 1][0],
          pending[index][1] - pending[index - 1][1],
          pending[index][2] - pending[index - 1][2],
        );
      }
      this.measureValue.textContent = this.formatLength(total);
      this.measureValue.classList.add("live");
      this.measureSplit.textContent = `${pending.length - 1} segment${pending.length === 2 ? "" : "s"} · running total`;
    } else if (last && pending.length === 0) {
      this.measureValue.textContent = measurementValue(last, this.viewer.getMeasurementFormat());
      this.measureValue.classList.remove("live");
      this.measureSplit.textContent = last.kind === "area"
        ? `perimeter ${this.formatLength(last.perimeter)}`
        : last.kind === "angle"
          ? `arms ${this.formatLength(last.perimeter)}`
          : last.kind === "path"
            ? `${Math.max(0, last.points.length - 1)} segments`
            : "persistent model coordinate";
    } else {
      this.measureValue.textContent = pending.length ? `${pending.length} point(s)` : "-";
      this.measureValue.classList.toggle("live", pending.length > 0);
      this.measureSplit.textContent = "";
    }

    if (mode === "angle") {
      this.measureHint.textContent =
        pending.length === 0
          ? "Click the first arm, then the corner, then the second arm"
          : pending.length === 1
            ? "Click the corner the angle is measured at"
            : "Click the far end of the second arm";
      return;
    }
    if (mode === "path") {
      this.measureHint.textContent = pending.length < 2
        ? "Click at least two points · Enter finishes · X/Y/Z/P/L constrains"
        : "Continue the chain, or press Enter / Finish path";
      return;
    }
    if (mode === "coordinate") {
      this.measureHint.textContent = "Click any vertex, edge or face to keep its XYZ coordinate";
      return;
    }
    this.measureHint.textContent =
      pending.length === 0
        ? "Click around the outline, then close it"
        : pending.length < 3
          ? `${3 - pending.length} more point(s) before it can close`
          : "Click the first point again, or Close ring";
  }

  private beginMeasurementRename(button: HTMLButtonElement, item: MeasurementObject): void {
    const input = h("input", { class: "mc-rename", type: "text", value: item.label, maxlength: 80 });
    const commit = (): void => {
      if (!input.isConnected) return;
      this.viewer.updateMeasurement(item.id, { label: input.value });
      this.renderedMeasureRevision = -1;
      this.syncMeasureLedger();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") commit();
      if (event.key === "Escape") {
        event.preventDefault();
        this.renderedMeasureRevision = -1;
        this.syncMeasureLedger();
      }
    });
    input.addEventListener("blur", commit, { once: true });
    button.replaceWith(input);
    input.focus();
    input.select();
  }

  /** A mixed, persistent ledger; rebuilt only when objects or formatting change. */
  private listedMeasurements(): MeasurementObject[] {
    const format = this.viewer.getMeasurementFormat();
    const query = this.measureSearch.value.trim().toLocaleLowerCase();
    const items = this.viewer.getMeasurementObjects().filter((item) => {
      if (!query) return true;
      return `${item.label} ${measurementTypeLabel(item)} ${measurementValue(item, format)}`
        .toLocaleLowerCase()
        .includes(query);
    });
    const sort = this.measureSort.value;
    if (sort === "label") items.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
    if (sort === "type") items.sort((a, b) => measurementTypeLabel(a).localeCompare(measurementTypeLabel(b)) || a.id - b.id);
    if (sort === "value") {
      items.sort((a, b) => measurementValue(a, format).localeCompare(measurementValue(b, format), undefined, { numeric: true }));
    }
    return items;
  }

  private syncMeasureLedger(): void {
    const format = this.viewer.getMeasurementFormat();
    const revision = this.viewer.getMeasurementRevision();
    const formatSig = `${format.unit}:${format.precision.mode}:${format.precision.value}:${format.zeroSuppression}`;
    if (revision === this.renderedMeasureRevision && formatSig === this.renderedMeasureFormat) return;
    this.renderedMeasureRevision = revision;
    this.renderedMeasureFormat = formatSig;
    const total = this.viewer.getMeasurementObjects().length;
    const items = this.listedMeasurements();
    this.measureCount.textContent = items.length === total ? String(total) : `${items.length}/${total}`;
    this.measureLedgerSummary.textContent = `${total.toLocaleString()} saved`;
    const anyVisible = items.some((item) => item.visible);
    this.measureVisibility.setAttribute("aria-pressed", String(anyVisible));
    this.measureVisibility.title = anyVisible ? "Hide all measurements" : "Show all measurements";
    if (!items.length) {
      const text = total ? "No measurements match this filter." : "Placed measurements will stay with this model.";
      this.measureList.replaceChildren(h("div", { class: "mc-empty", text }));
      return;
    }
    const rows = items.map((item, index) => {
      const name = h("button", { class: "mc-label", type: "button", text: item.label, title: "Rename measurement" });
      name.addEventListener("click", () => this.beginMeasurementRename(name, item));
      const visibility = iconButton(
        item.visible ? "eye" : "eye-off",
        item.visible ? "Hide measurement" : "Show measurement",
        () => this.viewer.updateMeasurement(item.id, { visible: !item.visible }),
        "icon-btn sm",
      );
      const value = measurementValue(item, format);
      const row = h("div", { class: `mc-mrow${item.visible ? "" : " is-hidden"}`, "data-measure-id": item.id }, [
        h("span", { class: "idx", text: String(index + 1) }),
        visibility,
        h("div", { class: "mc-record grow" }, [
          name,
          h("span", { class: "ends", text: measurementTypeLabel(item) }),
        ]),
        h("span", { class: "d", text: value, title: value }),
        iconButton("copy", "Copy value", () => this.copyMeasurement(item), "icon-btn sm mc-copy"),
        iconButton("x", "Remove measurement", () => this.viewer.removeMeasurementObject(item.id), "icon-btn sm"),
      ]);
      row.addEventListener("dblclick", (event) => {
        if ((event.target as Element).closest("button,input")) return;
        this.viewer.focusMeasurement(item.id);
      });
      return row;
    });
    this.measureList.replaceChildren(...rows);
  }

  // -- popovers --------------------------------------------------------------
  private frameSelection(): void {
    const id = this.viewer.getSelection();
    if (id !== null) this.viewer.fitToElement(id);
    else this.viewer.fitToModel();
  }

  private buildViews(pop: HTMLElement, close: () => void): void {
    pop.append(h("div", { class: "pop-title", text: "Camera" }));
    const row = h("div", { class: "pop-row" });
    for (const [label, view] of VIEWS) {
      const button = h("button", { class: "btn", type: "button", text: label });
      button.addEventListener("click", () => this.viewer.viewFrom(view));
      row.appendChild(button);
    }
    const frame = h("button", { class: "btn grow", type: "button" }, [
      h("span", { class: "grow", text: "Frame model" }),
      h("kbd", { text: "F" }),
    ]);
    frame.addEventListener("click", () => {
      this.viewer.fitToModel();
      close();
    });
    const focus = h("button", { class: "btn grow", type: "button" }, [
      h("span", { class: "grow", text: "Frame selection" }),
      h("kbd", { text: "⇧F" }),
    ]);
    focus.addEventListener("click", () => {
      this.frameSelection();
      close();
    });
    pop.append(row, frame, focus);
  }

  /**
   * One row per axis, all three live at once, so a corner cut is three
   * clicks. The plan inset shares the same planes, which is what turns a
   * horizontal cut into a floorplan.
   */
  private buildSection(pop: HTMLElement): void {
    const bounds = this.viewer.getSceneInfo().bounds;
    const state = new Map<AxisSectionState["axis"], AxisSectionState>(
      this.viewer.getSections().filter(isAxisSection).map((section) => [section.axis, section]),
    );

    // Arbitrary planes live beside the axis sliders; the sliders must never
    // rebuild the list without them.
    const apply = (): void => {
      this.viewer.setSections([
        ...this.viewer.getSections().filter((section) => !isAxisSection(section)),
        ...state.values(),
      ]);
      this.sync();
    };

    pop.classList.add("section-pop");
    const planePanel = h("div", { class: "section-panel" });
    const boxPanel = h("div", { class: "section-panel" });
    const mode = h("div", { class: "seg section-mode", role: "tablist", "aria-label": "Section mode" }, [
      h("button", { type: "button", role: "tab", text: "Planes" }),
      h("button", { type: "button", role: "tab", text: "Box" }),
    ]);
    const modeButtons = mode.querySelectorAll<HTMLButtonElement>("button");
    const setMode = (next: "planes" | "box"): void => {
      const boxOn = next === "box";
      planePanel.classList.toggle("hidden", boxOn);
      boxPanel.classList.toggle("hidden", !boxOn);
      modeButtons[0].setAttribute("aria-selected", String(!boxOn));
      modeButtons[1].setAttribute("aria-selected", String(boxOn));
    };
    modeButtons[0].addEventListener("click", () => setMode("planes"));
    modeButtons[1].addEventListener("click", () => setMode("box"));
    pop.append(h("div", { class: "pop-title", text: "Section" }), mode, planePanel, boxPanel);

    for (const axis of AXES) {
      const index = AXES.indexOf(axis);
      const [min, max] = [bounds.min[index], bounds.max[index]];
      const current = state.get(axis);
      const toggle = h("button", {
        class: "btn axis",
        type: "button",
        text: axis.toUpperCase(),
        "aria-pressed": String(Boolean(current)),
      });
      const slider = h("input", {
        type: "range",
        step: "0.001",
        "data-axis": axis,
        min: String(min),
        max: String(max),
        value: String(current?.offset ?? (min + max) / 2),
        disabled: !current,
      });
      const flip = h("button", {
        class: "icon-btn sm",
        type: "button",
        title: "Flip side",
        "aria-pressed": String(current?.flip ?? false),
      }, [icon("section", 13)]);

      const read = (): AxisSectionState => ({
        axis,
        offset: Number(slider.value),
        flip: flip.getAttribute("aria-pressed") === "true",
      });
      toggle.addEventListener("click", () => {
        const on = toggle.getAttribute("aria-pressed") !== "true";
        toggle.setAttribute("aria-pressed", String(on));
        slider.disabled = !on;
        if (on) state.set(axis, read());
        else state.delete(axis);
        apply();
      });
      slider.addEventListener("input", () => {
        state.set(axis, read());
        toggle.setAttribute("aria-pressed", "true");
        slider.disabled = false;
        apply();
      });
      flip.addEventListener("click", () => {
        flip.setAttribute("aria-pressed", String(flip.getAttribute("aria-pressed") !== "true"));
        if (state.has(axis)) {
          state.set(axis, read());
          apply();
        }
      });
      planePanel.appendChild(h("div", { class: "pop-row section-plane-row" }, [toggle, slider, flip]));
    }

    // Arbitrary planes: cut on any picked face, managed as a named list.
    const planeList = h("div", { class: "section-plane-list" });
    const renderPlanes = (): void => {
      const planes = this.viewer.getSections().filter((s): s is PlaneSectionState => !isAxisSection(s));
      planeList.replaceChildren(
        ...planes.map((planeState) => {
          const nameInput = h("input", {
            class: "section-plane-name", type: "text", value: planeState.name, "aria-label": "Plane name",
          }) as HTMLInputElement;
          nameInput.addEventListener("change", () => this.viewer.renameSection(planeState.id, nameInput.value));
          const offsetInput = h("input", {
            type: "number", step: "0.01", value: planeState.offset.toFixed(2),
            "data-plane": planeState.id, "aria-label": `${planeState.name} offset in metres`,
          }) as HTMLInputElement;
          offsetInput.addEventListener("change", () => {
            const value = Number(offsetInput.value);
            if (!Number.isFinite(value)) return;
            this.viewer.setSections(this.viewer.getSections().map((s) =>
              !isAxisSection(s) && s.id === planeState.id ? { ...s, offset: value } : s));
          });
          const flipPlane = h("button", {
            class: "icon-btn sm", type: "button", title: "Flip side",
            "aria-pressed": String(planeState.flip),
          }, [icon("section", 13)]);
          flipPlane.addEventListener("click", () => {
            this.viewer.setSections(this.viewer.getSections().map((s) =>
              !isAxisSection(s) && s.id === planeState.id ? { ...s, flip: !s.flip } : s));
            renderPlanes();
          });
          const look = iconButton("frame", "Look at this plane", () => this.viewer.viewAlongSection(planeState.id), "icon-btn sm");
          const del = iconButton("x", "Delete plane", () => {
            this.viewer.removeSection(planeState.id);
            renderPlanes();
            this.sync();
          }, "icon-btn sm");
          return h("div", { class: "pop-row section-plane-row arbitrary" }, [nameInput, offsetInput, flipPlane, look, del]);
        }),
      );
    };
    const fromFace = h("button", {
      class: "btn grow", type: "button", text: "Plane from picked face",
      title: "Click a face in the model first, then cut on it",
    });
    fromFace.addEventListener("click", () => {
      if (this.viewer.getSections().length >= 8) return void toast("Plane limit reached (8)", "info");
      const added = this.viewer.addSectionFromPick();
      if (!added) return void toast("Click a surface in the model first", "info");
      renderPlanes();
      this.sync();
    });
    renderPlanes();
    const selectVisible = h("button", {
      class: "btn grow", type: "button", text: "Select visible",
      title: "Select every element the cut leaves at least partly visible",
    });
    selectVisible.addEventListener("click", () => void this.classifyAgainstCut(false));
    const hideClipped = h("button", {
      class: "btn grow", type: "button", text: "Hide clipped",
      title: "Hide elements the cut removes entirely",
    });
    hideClipped.addEventListener("click", () => void this.classifyAgainstCut(true));
    planePanel.append(
      planeList,
      h("div", { class: "pop-row" }, [fromFace]),
      h("div", { class: "pop-row" }, [selectVisible, hideClipped]),
    );

    const plan = h("button", {
      class: "btn grow",
      type: "button",
      text: "2D plan",
      title: "Floorplan inset, cut by the horizontal section",
      "data-plan": "1",
      "aria-pressed": String(this.viewer.isPlanView()),
    });
    plan.addEventListener("click", () => {
      const on = !this.viewer.isPlanView();
      // A plan with nothing cut away is just a roof; open Y if it is closed.
      if (on && !state.has("y")) {
        const mid = (bounds.min[1] + bounds.max[1]) / 2;
        state.set("y", { axis: "y", offset: mid, flip: false });
        this.viewer.setSections([
          ...this.viewer.getSections().filter((section) => !isAxisSection(section)),
          ...state.values(),
        ]);
      }
      this.viewer.setPlanView(on);
      plan.setAttribute("aria-pressed", String(on));
      this.sync();
    });
    const off = h("button", { class: "btn", type: "button", text: "Clear" });
    off.addEventListener("click", () => {
      state.clear();
      this.viewer.clearSection();
      for (const node of pop.querySelectorAll<HTMLElement>(".axis")) {
        node.setAttribute("aria-pressed", "false");
      }
      for (const node of pop.querySelectorAll("input[type=range]")) {
        (node as HTMLInputElement).disabled = true;
      }
      renderPlanes();
      this.sync();
    });
    planePanel.appendChild(h("div", { class: "pop-row section-actions" }, [plan, off]));
    this.buildSectionBox(boxPanel, bounds);
    const drawing = h("button", {
      class: "btn section-workspace-open",
      type: "button",
      text: "Open plans and sections",
      title: "Build a synchronized 2D drawing from the active cut",
    });
    drawing.addEventListener("click", () => this.onOpenSectionWorkspace?.());
    pop.appendChild(drawing);
    setMode(this.viewer.getSectionBox() ? "box" : "planes");
  }

  /**
   * The box is six planes on the same three axes as the sliders above, so the
   * two are mutually exclusive by construction and the viewer enforces it.
   * Two low sliders per axis rather than a dual-thumb control, which the
   * platform does not have.
   */
  private buildSectionBox(pop: HTMLElement, bounds: { min: number[]; max: number[] }): void {
    const model = this.viewer.getModelBox();
    let box = this.viewer.getSectionBox() ?? model;
    const rows: HTMLInputElement[] = [];
    const values: HTMLElement[] = [];
    const status = h("span", { class: "section-box-status" });

    const apply = (): void => {
      this.viewer.setSectionBox(box);
      this.sync();
      status.textContent = "Active";
      status.classList.add("active");
    };
    const paint = (): void => {
      rows.forEach((slider, i) => {
        const value = i % 2 === 0 ? box.min[i >> 1] : box.max[i >> 1];
        slider.value = String(value);
        if (values[i]) values[i].textContent = value.toFixed(2);
      });
    };

    status.textContent = this.viewer.getSectionBox() ? "Active" : "Not active";
    status.classList.toggle("active", Boolean(this.viewer.getSectionBox()));
    pop.append(h("div", { class: "section-box-head" }, [
      h("div", {}, [h("b", { text: "Section box" }), h("small", { text: "Trim the model from six sides" })]),
      status,
    ]));
    for (const axis of AXES) {
      const index = AXES.indexOf(axis);
      const [low, high] = [bounds.min[index], bounds.max[index]];
      const pair: HTMLElement[] = [];
      for (const end of ["min", "max"] as const) {
        const slider = h("input", {
          type: "range",
          step: "0.001",
          min: String(low),
          max: String(high),
          "aria-label": `${axis.toUpperCase()} ${end}`,
          value: String(box[end][index]),
        });
        slider.addEventListener("input", () => {
          box = { min: [...box.min], max: [...box.max] };
          box[end][index] = Number(slider.value);
          const other = end === "min" ? box.max[index] : box.min[index];
          box[end][index] = end === "min" ? Math.min(box[end][index], other) : Math.max(box[end][index], other);
          slider.value = String(box[end][index]);
          value.textContent = box[end][index].toFixed(2);
          apply();
        });
        const value = h("span", { class: "section-box-value", text: box[end][index].toFixed(2) });
        pair.push(slider);
        rows.push(slider);
        values.push(value);
        pair.push(value);
      }
      pop.appendChild(h("div", { class: `section-box-row axis-${axis}` }, [
        h("span", { class: "axis-tag", text: axis.toUpperCase() }),
        h("label", {}, [h("small", { text: "Min" }), pair[0], pair[1]]),
        h("label", {}, [h("small", { text: "Max" }), pair[2], pair[3]]),
      ]));
    }

    const around = h("button", { class: "btn primary grow", type: "button", text: "Fit to selection" });
    around.addEventListener("click", () => {
      const fitted = this.viewer.boxAround(this.viewer.getSelectedIds(), 0.08);
      if (!fitted) return toast("Select something first", "info");
      box = fitted;
      paint();
      apply();
    });
    const modelBox = h("button", { class: "btn", type: "button", text: "Fit model" });
    modelBox.addEventListener("click", () => {
      box = this.viewer.getModelBox();
      paint();
      apply();
    });
    const clear = h("button", { class: "btn", type: "button", text: "Clear" });
    clear.addEventListener("click", () => {
      box = this.viewer.getModelBox();
      paint();
      this.viewer.setSectionBox(null);
      this.sync();
      status.textContent = "Not active";
      status.classList.remove("active");
    });
    pop.appendChild(h("div", { class: "pop-row section-actions" }, [around, modelBox, clear]));
  }

  /**
   * The federated set: one row per open model, with the eye, a nudge for
   * files that disagree about placement, and a way to drop one. Ids carry
   * their model, so hiding a discipline never touches another's elements.
   */
  private buildModels(pop: HTMLElement, close: () => void): void {
    const render = (): void => {
      const models = this.viewer.getModels();
      const rows: HTMLElement[] = [];
      for (const model of models) {
        const eye = iconButton(
          model.visible ? "eye" : "eye-off",
          model.visible ? `Hide ${model.name}` : `Show ${model.name}`,
          () => {
            this.viewer.setModelVisible(model.index, !model.visible);
            render();
          },
          "icon-btn sm",
        );
        const label = h("span", { class: "grow", text: model.name, title: model.name });
        const count = h("span", { class: "n", text: `${model.elements.toLocaleString()} parts` });
        const row = h("div", { class: "filter-row" }, [eye, label, count]);
        // Only a federated model can be dropped on its own; the first one is
        // the app's model, and closing that is File > Close.
        if (model.index > 0) {
          row.appendChild(
            iconButton("x", `Unload ${model.name}`, () => {
              this.viewer.unloadModel(model.index);
              render();
            }, "icon-btn sm"),
          );
        }
        rows.push(row);

        const [ox, oy, oz] = model.offset;
        const nudge = h("div", { class: "pop-row" }, [
          h("span", { class: "axis-tag", text: "Move" }),
          ...(["x", "y", "z"] as const).map((axis, i) => {
            const input = h("input", {
              type: "number",
              step: "0.1",
              value: String([ox, oy, oz][i]),
              "aria-label": `${model.name} offset ${axis.toUpperCase()}`,
            });
            input.addEventListener("change", () => {
              const next: [number, number, number] = [...this.viewer.getModelTransform(model.index)];
              next[i] = Number(input.value) || 0;
              this.viewer.setModelTransform(model.index, next);
            });
            return input;
          }),
        ]);
        if (models.length > 1) rows.push(nudge);
      }

      const add = h("button", { class: "btn grow", type: "button", text: "Add a model" });
      add.addEventListener("click", () => {
        this.onAddModel?.();
        close();
      });
      pop.replaceChildren(
        h("div", { class: "pop-title", text: `Models (${models.length})` }),
        ...(models.length ? rows : [h("div", { class: "note", text: "No model open." })]),
        h("div", { class: "pop-row" }, [add]),
        h("div", { class: "note", text: "Architecture, structure and services load together; each keeps its own ids." }),
      );
    };
    render();
  }

  private buildVisibility(pop: HTMLElement, close: () => void): void {
    const hasSelection = this.viewer.getSelection() !== null;
    pop.append(h("div", { class: "pop-title", text: "Visibility" }));
    const actions: Array<[string, string, () => void, boolean]> = [
      ["Isolate selection", "I", () => this.viewer.isolateSelected(), hasSelection],
      ["Hide selection", "H", () => this.viewer.hideSelected(), hasSelection],
      ["Show all", "A", () => this.viewer.showAll(), true],
      ["Undo visibility", "Ctrl+Shift+Z", () => void this.viewer.undoVisibility(), this.viewer.canUndoVisibility()],
      ["Redo visibility", "Ctrl+Shift+Y", () => void this.viewer.redoVisibility(), this.viewer.canRedoVisibility()],
    ];
    for (const [label, key, run, enabled] of actions) {
      const button = h("button", { class: "btn", type: "button", disabled: !enabled }, [
        h("span", { class: "grow", text: label }),
        h("kbd", { text: key }),
      ]);
      button.style.justifyContent = "space-between";
      button.addEventListener("click", () => {
        run();
        close();
      });
      pop.appendChild(button);
    }

    const ghost = h("button", { class: "pop-check", type: "button", title: "Hidden elements stay as a faint hatch instead of vanishing" }, [
      icon("check", 14),
      h("span", { text: "Ghost hidden" }),
    ]);
    ghost.setAttribute("aria-pressed", String(this.viewer.isGhostHidden()));
    ghost.addEventListener("click", () => {
      this.viewer.setGhostHidden(!this.viewer.isGhostHidden());
      ghost.setAttribute("aria-pressed", String(this.viewer.isGhostHidden()));
    });
    pop.append(h("div", { class: "pop-title", text: "Hidden elements" }), ghost);

    pop.appendChild(h("div", { class: "pop-title", text: "Categories" }));
    for (const [category, label] of CATEGORIES) {
      const button = h("button", { class: "pop-check", type: "button" }, [
        icon("check", 14),
        h("span", { text: label }),
      ]);
      const paint = (): void =>
        button.setAttribute("aria-pressed", String(this.viewer.isCategoryVisible(category)));
      paint();
      button.addEventListener("click", () => {
        void Promise.resolve(this.viewer.setCategoryVisible(category, !this.viewer.isCategoryVisible(category)))
          .then(paint)
          .catch((err: Error) => toast(err.message, "error"));
        paint();
      });
      pop.appendChild(button);
    }
  }

  /** The app owns the property index; the dock only borrows it for colouring. */
  setPropertyIndex(provider: () => PropertyIndex): void {
    this.indexProvider = provider;
  }

  /** A colour rule points at express ids, so a new model has to drop it. */
  resetColors(): void {
    this.colorRule = { kind: "none" };
    this.colorResult = null;
    this.customColors.clear();
    this.syncColorButton();
  }

  /** Apply the active rule with the user's custom colours stacked on top. */
  private applyMergedColors(): ColorResult {
    const base = this.colorResult ?? { groups: [], assignment: new Map<number, number>(), unset: 0 };
    const merged = this.customColors.overlay(base);
    if (merged.groups.length === 0) this.viewer.clearColorOverride();
    else applyColors(this.viewer, merged);
    return merged;
  }

  private syncColorButton(): void {
    this.colorBtn.setAttribute("aria-pressed", String(this.colorRule.kind !== "none"));
  }

  private buildColors(pop: HTMLElement): void {
    pop.append(h("div", { class: "pop-title", text: "Colour by" }));
    const legend = h("div", { class: "pop-list legend" });
    const status = h("div", {});

    const paint = (merged?: ColorResult): void => {
      legend.replaceChildren();
      const result = merged ?? this.customColors.overlay(
        this.colorResult ?? { groups: [], assignment: new Map<number, number>(), unset: 0 },
      );
      if (result.groups.length === 0) {
        legend.appendChild(h("div", { class: "empty", text: "Pick a rule to colour the model." }));
        return;
      }
      for (const group of result.groups) {
        const row = h("button", { class: "legend-row", type: "button", title: `Isolate ${group.label}` }, [
          h("span", { class: "legend-dot", style: `background:${cssColor(group.color)}` }),
          h("span", { class: "grow", text: group.label }),
          h("span", { class: "legend-count", text: group.count.toLocaleString() }),
        ]);
        row.addEventListener("click", () => this.viewer.isolate(group.ids, `Colour: ${group.label}`));
        legend.appendChild(row);
      }
      if (result.unset > 0) {
        legend.appendChild(h("div", { class: "hint-line", text: `${result.unset.toLocaleString()} more not coloured; the palette holds 254 groups.` }));
      }
    };

    const run = (rule: ColorRule): void => {
      this.colorRule = rule;
      this.syncColorButton();
      if (rule.kind === "none") {
        this.colorResult = null;
        status.replaceChildren();
        paint(this.applyMergedColors());
        return;
      }
      if (rule.kind === "material") {
        status.replaceChildren(busyRow("Reading materials"));
        void this.viewer
          .getOrganizeIndex()
          .then((index) => {
            // The popover may have moved on to another rule while this ran.
            if (this.colorRule.kind !== "material") return;
            this.colorResult = computeColorsFromEntries(materialColorEntries(index), (id) => this.viewer.hasGeometry(id));
            status.replaceChildren();
            paint(this.applyMergedColors());
          })
          .catch((err: Error) => {
            status.replaceChildren();
            toast(err.message, "error");
          });
        return;
      }
      if (rule.kind !== "property") {
        this.colorResult = computeColors(this.viewer, rule, []);
        status.replaceChildren();
        paint(this.applyMergedColors());
        return;
      }
      const index = this.indexProvider?.();
      if (!index) return void toast("Properties are not ready yet", "error");
      status.replaceChildren(busyRow("Reading properties"));
      void index
        .build()
        .then((rows) => {
          // The popover may have moved on to another rule while this ran.
          if (this.colorRule.kind !== "property" || this.colorRule.key !== rule.key) return;
          this.colorResult = computeColors(this.viewer, rule, rows);
          status.replaceChildren();
          paint(this.applyMergedColors());
        })
        .catch((err: Error) => {
          status.replaceChildren();
          toast(err.message, "error");
        });
    };

    const modes: Array<[string, ColorRule]> = [
      ["None", { kind: "none" }],
      ["IFC class", { kind: "class" }],
      ["Storey", { kind: "storey" }],
      ["Model", { kind: "model" }],
      ["Random", { kind: "random" }],
      ["Material", { kind: "material" }],
    ];
    const seg = h("div", { class: "seg" });
    for (const [label, rule] of modes) {
      const button = h("button", { type: "button", text: label });
      button.setAttribute("aria-pressed", String(this.colorRule.kind === rule.kind));
      button.addEventListener("click", () => {
        for (const other of seg.children) other.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        keys.value = "";
        run(rule);
      });
      seg.appendChild(button);
    }
    pop.appendChild(seg);

    const index = this.indexProvider?.();
    const options = index ? colorableKeys(index) : [];
    const keys = h("select", { class: "pop-select" }) as HTMLSelectElement;
    keys.appendChild(h("option", { value: "", text: options.length ? "Property..." : "Property (open a model)" }));
    for (const [key, count] of options) {
      keys.appendChild(h("option", { value: key, text: `${key}  (${count})` }));
    }
    if (this.colorRule.kind === "property") keys.value = this.colorRule.key;
    keys.addEventListener("change", () => {
      if (!keys.value) return;
      for (const other of seg.children) other.setAttribute("aria-pressed", "false");
      run({ kind: "property", key: keys.value });
    });

    // Custom colour for the current selection, layered over the active rule.
    const swatch = h("input", { type: "color", value: "#ff8c1a", title: "Custom colour" }) as HTMLInputElement;
    swatch.className = "pop-swatch";
    const applySwatch = h("button", { class: "btn", type: "button", text: "Colour selection" });
    applySwatch.addEventListener("click", () => {
      const ids = this.viewer.getSelectedIds();
      if (ids.length === 0) return void toast("Select elements first", "error");
      const hex = swatch.value;
      this.customColors.set(ids, [
        parseInt(hex.slice(1, 3), 16),
        parseInt(hex.slice(3, 5), 16),
        parseInt(hex.slice(5, 7), 16),
      ]);
      paint(this.applyMergedColors());
    });
    const clearSwatch = h("button", { class: "btn", type: "button", text: "Clear custom" });
    clearSwatch.addEventListener("click", () => {
      this.customColors.clear();
      paint(this.applyMergedColors());
    });
    const customRow = h("div", { class: "pop-row" }, [swatch, applySwatch, clearSwatch]);

    pop.append(keys, customRow, status, legend);
    paint();
  }

  /**
   * Classify every visible element against the active planes in the geometry
   * worker. One conjunctive query: an element survives only when some part of
   * it lies inside every kept half-space, matching how the clip planes render.
   */
  private async classifyAgainstCut(hideClipped: boolean): Promise<void> {
    const sections = this.viewer.getSections();
    if (sections.length === 0) return void toast("No section planes active", "info");
    try {
      const planes = sections.map((section) => {
        const n = isAxisSection(section)
          ? ([section.axis === "x" ? 1 : 0, section.axis === "y" ? 1 : 0, section.axis === "z" ? 1 : 0] as [number, number, number])
          : section.normal;
        // three convention: kept side is n . p + constant > 0.
        const normal: [number, number, number] = section.flip ? [n[0], n[1], n[2]] : [-n[0], -n[1], -n[2]];
        const constant = section.flip ? -section.offset : section.offset;
        return { normal, constant };
      });
      const result = await classifyByPlanes(this.viewer, planes, {});
      if (hideClipped) {
        if (result.dropped.length === 0) return void toast("Nothing is fully clipped", "info");
        this.viewer.setHidden(result.dropped, true);
        toast(`${result.dropped.length} clipped element(s) hidden`, "success");
        return;
      }
      const visible = [...result.kept, ...result.cut];
      if (visible.length === 0) return void toast("Nothing is visible after the cut", "info");
      this.viewer.selectMany(visible);
      toast(`${visible.length} element(s) selected`, "success");
    } catch (error) {
      toast(error instanceof Error ? error.message : "Classification failed", "error");
    }
  }

  /** Storey slide, explode and per-selection offsets: BIMVision's VIEW group. */
  private buildArrange(pop: HTMLElement): void {
    pop.append(h("div", { class: "pop-title", text: "Storey slide" }));
    const slide = h("input", {
      type: "range", min: "0", max: "30", step: "0.5", value: String(this.slideSpacing),
      "aria-label": "Storey slide spacing",
    }) as HTMLInputElement;
    const axisSeg = h("div", { class: "seg" });
    for (const axis of AXES) {
      const button = h("button", { type: "button", text: axis.toUpperCase() });
      button.setAttribute("aria-pressed", String(axis === this.slideAxis));
      button.addEventListener("click", () => {
        this.slideAxis = axis;
        for (const other of axisSeg.children) other.setAttribute("aria-pressed", "false");
        button.setAttribute("aria-pressed", "true");
        this.viewer.setStoreySlide(this.slideAxis, this.slideSpacing);
        this.syncArrange();
      });
      axisSeg.appendChild(button);
    }
    slide.addEventListener("input", () => {
      this.slideSpacing = Number(slide.value);
      this.viewer.setStoreySlide(this.slideAxis, this.slideSpacing);
      this.syncArrange();
    });
    pop.append(axisSeg, h("div", { class: "pop-row" }, [slide]));

    pop.append(h("div", { class: "pop-title", text: "Explode" }));
    const explode = h("input", {
      type: "range", min: "0", max: "1.5", step: "0.03", value: String(this.explodeFactor),
      "aria-label": "Explode factor",
    }) as HTMLInputElement;
    explode.addEventListener("input", () => {
      this.explodeFactor = Number(explode.value);
      this.viewer.setExplode(this.explodeFactor);
      this.syncArrange();
    });
    pop.append(h("div", { class: "pop-row" }, [explode]));

    pop.append(h("div", { class: "pop-title", text: "Move selection" }));
    const step = h("select", { class: "pop-select", "aria-label": "Offset step" }) as HTMLSelectElement;
    for (const value of [0.1, 0.5, 1, 5]) {
      step.appendChild(h("option", { value: String(value), text: `${value} m` }));
    }
    step.value = "0.5";
    pop.append(h("div", { class: "pop-row" }, [step]));
    for (const axis of AXES) {
      const dim = axis === "x" ? 0 : axis === "y" ? 1 : 2;
      const nudge = (sign: number): void => {
        const ids = this.viewer.getSelectedIds();
        if (ids.length === 0) return void toast("Select elements first", "error");
        const delta: [number, number, number] = [0, 0, 0];
        delta[dim] = sign * Number(step.value);
        this.viewer.offsetElements(ids, delta);
        this.syncArrange();
      };
      const minus = h("button", { class: "btn axis", type: "button", text: "-" });
      minus.addEventListener("click", () => nudge(-1));
      const plus = h("button", { class: "btn axis", type: "button", text: "+" });
      plus.addEventListener("click", () => nudge(1));
      pop.append(h("div", { class: "pop-row" }, [
        h("span", { class: "axis-tag", text: axis.toUpperCase() }),
        minus,
        plus,
      ]));
    }

    const clearSelected = h("button", { class: "btn grow", type: "button", text: "Clear selected" });
    clearSelected.addEventListener("click", () => {
      const ids = this.viewer.getSelectedIds();
      if (ids.length === 0) return void toast("Select elements first", "error");
      this.viewer.clearElementOffsets(ids);
      this.syncArrange();
    });
    const clearAll = h("button", { class: "btn grow", type: "button", text: "Clear all" });
    clearAll.addEventListener("click", () => {
      this.slideSpacing = 0;
      this.explodeFactor = 0;
      slide.value = "0";
      explode.value = "0";
      this.viewer.clearElementOffsets();
      this.syncArrange();
    });
    pop.append(h("div", { class: "pop-row" }, [clearSelected, clearAll]));
    pop.append(h("div", {
      class: "hint-line",
      text: "Offsets are display only: measurements and analyses keep resting positions.",
    }));
    this.syncArrange();
  }

  private syncArrange(): void {
    this.arrangeBtn.setAttribute("aria-pressed", String(this.viewer.hasElementOffsets()));
  }

  private buildSelectionSets(pop: HTMLElement): void {
    const key = selectionSetKey(this.viewer);
    pop.append(h("div", { class: "pop-title", text: "Selection sets" }));
    if (!key) {
      pop.appendChild(h("div", { class: "empty", text: "Load a model first." }));
      return;
    }

    const list = h("div", { class: "pop-list" });
    const name = h("input", { type: "text", placeholder: "Name this selection" }) as HTMLInputElement;
    const save = h("button", { class: "btn accent", type: "button", text: "Save" });

    const render = (): void => {
      const sets = readSelectionSets(key);
      list.replaceChildren();
      if (sets.length === 0) {
        list.appendChild(h("div", { class: "empty", text: "Select elements, then save them here." }));
        return;
      }
      sets.forEach((set, index) => {
        const apply = h("button", { class: "btn grow", type: "button", title: `Select ${set.ids.length} element(s)` }, [
          h("span", { class: "grow", text: set.name }),
          h("span", { class: "legend-count", text: String(set.ids.length) }),
        ]);
        apply.style.justifyContent = "space-between";
        apply.addEventListener("click", () => {
          // A set can outlive the elements it named, so select what still exists.
          const alive = set.ids.filter((id) => this.viewer.hasGeometry(id));
          if (alive.length === 0) return void toast("None of those elements are in this model", "error");
          this.viewer.selectMany(alive);
          if (alive.length < set.ids.length) {
            toast(`${alive.length} of ${set.ids.length} still in the model`, "info");
          }
        });
        const only = iconButton("focus", "Isolate this set", () => {
          const alive = set.ids.filter((id) => this.viewer.hasGeometry(id));
          if (alive.length === 0) return void toast("None of those elements are in this model", "error");
          this.viewer.isolate(alive, set.name);
        }, "icon-btn sm");
        const remove = iconButton("x", "Delete", () => {
          const next = readSelectionSets(key);
          next.splice(index, 1);
          writeSelectionSets(key, next);
          render();
        }, "icon-btn sm");
        list.appendChild(h("div", { class: "pop-row" }, [apply, only, remove]));
      });
    };

    const commit = (): void => {
      const ids = this.viewer.getSelectedIds();
      if (ids.length === 0) return void toast("Select something first", "error");
      if (ids.length > SET_LIMIT) return void toast(`Too many to store (${ids.length.toLocaleString()})`, "error");
      const sets = readSelectionSets(key);
      const label = name.value.trim() || `Set ${sets.length + 1}`;
      const at = sets.findIndex((set) => set.name === label);
      const entry = { name: label, ids };
      if (at >= 0) sets[at] = entry;
      else sets.push(entry);
      if (!writeSelectionSets(key, sets)) return void toast("This browser refused to store the set", "error");
      name.value = "";
      toast(`Saved ${label} (${ids.length})`, "success");
      render();
    };

    save.addEventListener("click", commit);
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") commit();
    });
    pop.append(h("div", { class: "pop-row" }, [name, save]), list);
    render();
  }

  private buildViewpoints(pop: HTMLElement): void {
    const key = viewpointKey(this.viewer);
    pop.append(h("div", { class: "pop-title", text: "Viewpoints" }));
    if (!key) {
      pop.appendChild(h("div", { class: "empty", text: "Load a model first." }));
      return;
    }

    const name = h("input", { type: "text", placeholder: "Name" });
    const save = h("button", { class: "btn accent", type: "button", text: "Save" });
    const list = h("div", { class: "pop-list" });

    const render = (): void => {
      const views = readViewpoints(key);
      list.replaceChildren();
      if (views.length === 0) {
        list.appendChild(h("div", { class: "empty", text: "No saved views." }));
        return;
      }
      views.forEach((view, index) => {
        const apply = h("button", { class: "btn grow", type: "button", text: view.name, title: view.name });
        apply.addEventListener("click", () => {
          this.viewer.setCamera(view.pose);
          const planes = view.sections ?? (view.section ? [view.section] : []);
          // The box wins: the viewer keeps the two exclusive, so restoring
          // planes after a box would silently drop the box.
          if (view.box) this.viewer.setSectionBox(view.box);
          else if (planes.length) this.viewer.setSections(planes);
          else this.viewer.clearSection();
          if (view.measurements) this.viewer.setMeasurementStates(view.measurements);
          if (view.annotations) this.viewer.setAnnotationStates(view.annotations);
          // Older viewpoints have no offsets field; treat that as none.
          this.viewer.clearElementOffsets();
          if (view.offsets?.length) this.viewer.setElementOffsetEntries(view.offsets);
          this.sync();
        });
        const remove = iconButton("x", "Delete", () => {
          const next = readViewpoints(key);
          next.splice(index, 1);
          localStorage.setItem(key, JSON.stringify(next));
          render();
        }, "icon-btn sm");
        list.appendChild(h("div", { class: "pop-row" }, [apply, remove]));
      });
    };

    save.addEventListener("click", () => {
      saveViewpoint(this.viewer, name.value);
      name.value = "";
      render();
    });
    name.addEventListener("keydown", (e) => {
      if (e.key === "Enter") save.click();
    });

    pop.append(h("div", { class: "pop-row" }, [name, save]), list);
    render();
  }
}
