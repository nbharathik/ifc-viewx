// The viewport rail: every camera, tool and visibility control as one column
// of icons floating in the top-left corner, clear of the structure panel and
// of the viewport floor. Each icon opens its options sideways, next to itself.
// It reads and writes the viewer directly, so no tool state is mirrored
// anywhere else.
import { attachPopover, busyRow, h, icon, iconButton, toast } from "./kit.js";
import { applyColors, colorableKeys, computeColors, cssColor, type ColorResult, type ColorRule } from "./colorBy.js";
import { formatAngle, formatArea, formatLength } from "../viewer-core/viewer.js";
import type { PropertyIndex } from "../sdk/data.js";
import type { CameraPose, LazyCategory, MeasureMode, SectionBox, SectionState, SnapMode, Viewer, ViewPreset } from "../viewer-core/viewer.js";

interface Viewpoint {
  name: string;
  pose: CameraPose;
  /** Kept for viewpoints saved before sections could combine. */
  section: SectionState | null;
  sections?: SectionState[];
  /** Absent on viewpoints saved before the box existed, which is not a box. */
  box?: SectionBox | null;
}

const AXES: Array<SectionState["axis"]> = ["x", "y", "z"];
const VIEWS: Array<[string, ViewPreset]> = [
  ["Front", "front"],
  ["Right", "right"],
  ["Top", "top"],
  ["Iso", "iso"],
];
const CATEGORIES: Array<[LazyCategory, string]> = [
  ["IfcSpace", "Spaces"],
  ["IfcOpeningElement", "Openings"],
];
/** Three is the whole choice: smart, corners only, or nothing. */
const SNAPS: Array<[SnapMode, string, string]> = [
  ["auto", "Auto", "Corners, midpoints and edges"],
  ["vertex", "Vertex", "Corners only"],
  ["off", "Off", "Any point on the surface"],
];
const MODES: Array<[MeasureMode, string, string]> = [
  ["distance", "Length", "Two points"],
  ["angle", "Angle", "Three points: arm, corner, arm"],
  ["area", "Area", "Click a ring of points, then close it"],
];
/** What each end of the span caught, for the line under the number. */
const ENDS: Record<string, string> = {
  vertex: "corner",
  midpoint: "midpoint",
  edge: "edge",
  surface: "surface",
};

/** Viewpoints are keyed by model shape so they follow the model, not the tab. */
export function viewpointKey(viewer: Viewer): string | null {
  const stats = viewer.getStats();
  return stats ? `ifcviewx.vp.${stats.totalEntities}-${stats.triangleCount}` : null;
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
  private readonly measureList = h("div", { class: "mc-list hidden" });
  private readonly measureHint = h("div", { class: "mc-hint" });
  /** What the list currently shows; rows rebuild only when this changes. */
  private measureSig = "";
  private readonly closeRing = h("button", { class: "btn sm grow hidden", type: "button", text: "Close ring" });
  private readonly colorBtn: HTMLButtonElement;
  private colorRule: ColorRule = { kind: "none" };
  private colorResult: ColorResult | null = null;
  /** Set once the plugin host exists; property rules read its shared index. */
  private indexProvider: (() => PropertyIndex) | null = null;

  /** Set by the app: opening a file picker is its business, not the dock's. */
  onAddModel: (() => void) | null = null;

  constructor(host: HTMLElement, private readonly viewer: Viewer) {
    this.root = h("div", { id: "dock", role: "toolbar", "aria-label": "Viewport tools" });

    this.tool("frame", "Frame model  F", () => viewer.fitToModel());
    this.popTool("cube", "Camera views", (pop, close) => this.buildViews(pop, close));

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

    this.sep();
    this.popTool("layers", "Models", (pop, close) => this.buildModels(pop, close));
    this.popTool("focus", "Selection sets", (pop) => this.buildSelectionSets(pop));
    this.popTool("bookmark", "Saved viewpoints", (pop) => this.buildViewpoints(pop));
    this.tool("camera", "Screenshot  S", () => viewer.screenshot());

    this.measureCard = this.buildMeasureCard();
    host.append(this.root, this.measureCard);
    // Dragging a handle in the viewport moves the same value the popover
    // shows, so keep any open slider honest.
    viewer.onSectionChange(() => this.syncSectionInputs());
    viewer.onMeasureChange(() => this.syncMeasure());
    this.sync();
  }

  private syncSectionInputs(): void {
    const open = this.root.querySelector(".pop");
    if (!open) return;
    for (const section of this.viewer.getSections()) {
      const slider = open.querySelector<HTMLInputElement>(`input[data-axis="${section.axis}"]`);
      if (slider) slider.value = String(section.offset);
    }
    // The plan follows the section, so an axis toggle can flip it from afar.
    open
      .querySelector('button[data-plan]')
      ?.setAttribute("aria-pressed", String(this.viewer.isPlanView()));
  }

  /** Reflect tool state that other entry points (keys, palette) can change. */
  sync(): void {
    this.measureBtn.setAttribute("aria-pressed", String(this.viewer.isMeasuring()));
    this.sectionBtn.setAttribute("aria-pressed", String(this.viewer.getSection() !== null));
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
    attachPopover(button, build, "right");
    return button;
  }

  // -- measure ---------------------------------------------------------------
  /**
   * The measure card is not a popover: a popover would close on the first
   * click into the viewport, which is exactly when the tool starts being used.
   * It only exists while measuring, so nothing sits over the model otherwise.
   */
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

    const reset = h("button", { class: "btn sm grow", type: "button", text: "Clear all" });
    reset.addEventListener("click", () => this.viewer.resetMeasure());
    this.closeRing.addEventListener("click", () => {
      if (!this.viewer.closeArea()) toast("Place at least three points first", "info");
    });
    const done = iconButton("x", "Close measure  Esc", () => {
      this.viewer.setMeasuring(false);
      this.sync();
    }, "icon-btn sm");

    return h("div", { id: "measure-card", class: "hidden" }, [
      h("div", { class: "mc-head" }, [
        icon("ruler", 12),
        h("span", { class: "grow", text: "Measure" }),
        done,
      ]),
      h("div", { class: "mc-row" }, [h("span", { class: "mc-key", text: "Mode" }), modes]),
      this.measureValue,
      this.measureSplit,
      this.measureList,
      h("div", { class: "mc-row" }, [h("span", { class: "mc-key", text: "Snap" }), snaps]),
      h("div", { class: "mc-row" }, [this.closeRing, reset]),
      this.measureHint,
    ]);
  }

  private syncMeasure(): void {
    const on = this.viewer.isMeasuring();
    this.measureCard.classList.toggle("hidden", !on);
    if (!on) return;
    const snap = this.viewer.getSnapMode();
    const buttons = this.measureCard.querySelectorAll<HTMLButtonElement>(".mc-snap button");
    SNAPS.forEach(([value], index) =>
      buttons[index]?.setAttribute("aria-pressed", String(value === snap)),
    );
    const shape = this.viewer.getMeasureMode();
    const modeButtons = this.measureCard.querySelectorAll<HTMLButtonElement>(".mc-mode button");
    MODES.forEach(([value], index) =>
      modeButtons[index]?.setAttribute("aria-pressed", String(value === shape)),
    );
    this.closeRing.classList.toggle("hidden", shape !== "area");

    if (shape === "distance") return this.syncDistance();
    this.syncShape(shape);
  }

  private syncDistance(): void {
    const found = this.viewer.getMeasurement();
    this.measureValue.textContent = found && found.distance > 0 ? formatLength(found.distance) : "-";
    this.measureValue.classList.toggle("live", !found?.complete);
    this.measureSplit.textContent =
      found && found.distance > 0
        ? `${formatLength(found.horizontal)} across · ${formatLength(found.vertical)} up`
        : "";

    const spans = this.viewer.getMeasurements();
    this.syncMeasureList(spans);
    const pending = found !== null && !found.complete;
    this.measureHint.textContent = pending
      ? "Release or click on the second point"
      : spans.length
        ? `${ENDS[found!.ends[0]]} to ${ENDS[found!.ends[1] ?? "surface"]} · click starts the next one`
        : "Click or drag from the first point · right-drag orbits";
  }

  /** Angle and area read the finished shapes, and say what the ring still needs. */
  private syncShape(mode: "angle" | "area"): void {
    const shapes = this.viewer.getShapeMeasures().filter((entry) => entry.kind === mode);
    const pending = this.viewer.getPendingPoints();
    const last = shapes[shapes.length - 1];

    if (last && pending.length === 0) {
      this.measureValue.textContent =
        last.kind === "angle" ? formatAngle(last.angle ?? 0) : formatArea(last.area ?? 0);
      this.measureValue.classList.remove("live");
      this.measureSplit.textContent = `perimeter ${formatLength(last.perimeter)}`;
    } else {
      this.measureValue.textContent = pending.length ? `${pending.length} point(s)` : "-";
      this.measureValue.classList.toggle("live", pending.length > 0);
      this.measureSplit.textContent = "";
    }

    this.syncShapeList(shapes);
    if (mode === "angle") {
      this.measureHint.textContent =
        pending.length === 0
          ? "Click the first arm, then the corner, then the second arm"
          : pending.length === 1
            ? "Click the corner the angle is measured at"
            : "Click the far end of the second arm";
      return;
    }
    this.measureHint.textContent =
      pending.length === 0
        ? "Click around the outline, then close it"
        : pending.length < 3
          ? `${3 - pending.length} more point(s) before it can close`
          : "Click the first point again, or Close ring";
  }

  private syncShapeList(shapes: ReturnType<Viewer["getShapeMeasures"]>): void {
    const sig = shapes.map((shape) => `${shape.id}:${(shape.area ?? shape.angle ?? 0).toFixed(4)}`).join("|");
    if (sig === this.measureSig) return;
    this.measureSig = sig;
    this.measureList.classList.toggle("hidden", shapes.length === 0);
    this.measureList.replaceChildren(
      ...shapes.map((shape, index) =>
        h("div", { class: "mc-mrow" }, [
          h("span", { class: "idx", text: String(index + 1) }),
          h("span", {
            class: "d",
            text: shape.kind === "angle" ? formatAngle(shape.angle ?? 0) : formatArea(shape.area ?? 0),
          }),
          h("span", { class: "grow ends", text: `${shape.points.length} points` }),
          iconButton("x", "Remove this measurement", () => this.viewer.removeShapeMeasure(shape.id), "icon-btn sm"),
        ]),
      ),
    );
  }

  /** One row per placed span; rebuilt only when the spans actually change. */
  private syncMeasureList(spans: ReturnType<Viewer["getMeasurements"]>): void {
    const sig = spans.map((span) => `${span.id}:${span.distance.toFixed(4)}`).join("|");
    if (sig === this.measureSig) return;
    this.measureSig = sig;
    this.measureList.classList.toggle("hidden", spans.length === 0);
    this.measureList.replaceChildren(
      ...spans.map((span, index) =>
        h("div", { class: "mc-mrow" }, [
          h("span", { class: "idx", text: String(index + 1) }),
          h("span", { class: "d", text: formatLength(span.distance) }),
          h("span", {
            class: "grow ends",
            text: `${ENDS[span.ends[0]]} to ${ENDS[span.ends[1] ?? "surface"]}`,
          }),
          iconButton("x", "Remove this measurement", () => this.viewer.removeMeasurement(span.id), "icon-btn sm"),
        ]),
      ),
    );
    if (spans.length > 1) {
      const total = spans.reduce((sum, span) => sum + span.distance, 0);
      this.measureList.appendChild(
        h("div", { class: "mc-mrow total" }, [
          h("span", { class: "idx" }),
          h("span", { class: "d", text: formatLength(total) }),
          h("span", { class: "grow ends", text: "total" }),
        ]),
      );
    }
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
    const state = new Map<SectionState["axis"], SectionState>(
      this.viewer.getSections().map((section) => [section.axis, section]),
    );

    const apply = (): void => {
      this.viewer.setSections([...state.values()]);
      this.sync();
    };

    pop.append(h("div", { class: "pop-title", text: "Section planes" }));
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

      const read = (): SectionState => ({
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
      pop.appendChild(h("div", { class: "pop-row" }, [toggle, slider, flip]));
    }

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
        this.viewer.setSections([...state.values()]);
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
      this.sync();
    });
    pop.appendChild(h("div", { class: "pop-row" }, [plan, off]));
    this.buildSectionBox(pop, bounds);
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

    const apply = (): void => {
      this.viewer.setSectionBox(box);
      this.sync();
    };
    const paint = (): void => {
      rows.forEach((slider, i) => {
        slider.value = String(i % 2 === 0 ? box.min[i >> 1] : box.max[i >> 1]);
      });
    };

    pop.append(h("div", { class: "pop-title", text: "Section box" }));
    for (const axis of AXES) {
      const index = AXES.indexOf(axis);
      const [low, high] = [bounds.min[index], bounds.max[index]];
      const pair: HTMLInputElement[] = [];
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
          apply();
        });
        pair.push(slider);
        rows.push(slider);
      }
      pop.appendChild(
        h("div", { class: "pop-row" }, [h("span", { class: "axis-tag", text: axis.toUpperCase() }), ...pair]),
      );
    }

    const around = h("button", { class: "btn grow", type: "button", text: "Box selection" });
    around.addEventListener("click", () => {
      const fitted = this.viewer.boxAround(this.viewer.getSelectedIds());
      if (!fitted) return toast("Select something first", "info");
      box = fitted;
      paint();
      apply();
    });
    const clear = h("button", { class: "btn", type: "button", text: "No box" });
    clear.addEventListener("click", () => {
      box = this.viewer.getModelBox();
      paint();
      this.viewer.setSectionBox(null);
      this.sync();
    });
    pop.appendChild(h("div", { class: "pop-row" }, [around, clear]));
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
    this.syncColorButton();
  }

  private syncColorButton(): void {
    this.colorBtn.setAttribute("aria-pressed", String(this.colorRule.kind !== "none"));
  }

  private buildColors(pop: HTMLElement): void {
    pop.append(h("div", { class: "pop-title", text: "Colour by" }));
    const legend = h("div", { class: "pop-list legend" });
    const status = h("div", {});

    const paint = (): void => {
      legend.replaceChildren();
      const result = this.colorResult;
      if (!result || result.groups.length === 0) {
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
        this.viewer.clearColorOverride();
        status.replaceChildren();
        paint();
        return;
      }
      if (rule.kind !== "property") {
        this.colorResult = computeColors(this.viewer, rule, []);
        applyColors(this.viewer, this.colorResult);
        status.replaceChildren();
        paint();
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
          applyColors(this.viewer, this.colorResult);
          status.replaceChildren();
          paint();
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
    pop.append(keys, status, legend);
    paint();
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
