// The viewport rail: every camera, tool and visibility control as one column
// of icons floating in the top-left corner, clear of the structure panel and
// of the viewport floor. Each icon opens its options sideways, next to itself.
// It reads and writes the viewer directly, so no tool state is mirrored
// anywhere else.
import { attachPopover, h, icon, iconButton, toast } from "./kit.js";
import { formatLength } from "../viewer-core/viewer.js";
import type { CameraPose, LazyCategory, SectionState, SnapMode, Viewer, ViewPreset } from "../viewer-core/viewer.js";

interface Viewpoint {
  name: string;
  pose: CameraPose;
  /** Kept for viewpoints saved before sections could combine. */
  section: SectionState | null;
  sections?: SectionState[];
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

    this.sep();
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
    const reset = h("button", { class: "btn sm grow", type: "button", text: "Clear all" });
    reset.addEventListener("click", () => this.viewer.resetMeasure());
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
      this.measureValue,
      this.measureSplit,
      this.measureList,
      h("div", { class: "mc-row" }, [h("span", { class: "mc-key", text: "Snap" }), snaps]),
      h("div", { class: "mc-row" }, [reset]),
      this.measureHint,
    ]);
  }

  private syncMeasure(): void {
    const on = this.viewer.isMeasuring();
    this.measureCard.classList.toggle("hidden", !on);
    if (!on) return;
    const mode = this.viewer.getSnapMode();
    const buttons = this.measureCard.querySelectorAll<HTMLButtonElement>(".mc-snap button");
    SNAPS.forEach(([value], index) =>
      buttons[index]?.setAttribute("aria-pressed", String(value === mode)),
    );

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
  }

  private buildVisibility(pop: HTMLElement, close: () => void): void {
    const hasSelection = this.viewer.getSelection() !== null;
    pop.append(h("div", { class: "pop-title", text: "Visibility" }));
    const actions: Array<[string, string, () => void, boolean]> = [
      ["Isolate selection", "I", () => this.viewer.isolateSelected(), hasSelection],
      ["Hide selection", "H", () => this.viewer.hideSelected(), hasSelection],
      ["Show all", "A", () => this.viewer.showAll(), true],
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
          if (planes.length) this.viewer.setSections(planes);
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
