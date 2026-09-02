import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dock } from "../src/ui/dock.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

/** A viewer stub with just enough surface for the rail to build and sync. */
function railViewer(measuring: boolean): Viewer {
  return {
    isMeasuring: () => measuring,
    getSection: () => null,
    getSections: () => [],
    getMeasurementFormat: () => ({
      unit: "auto",
      precision: { mode: "decimals", value: 2 },
      zeroSuppression: 0,
    }),
    getSnapMode: () => "auto",
    getMeasureMode: () => "distance",
    getMeasureConstraint: () => "free",
    getPendingPoints: () => [],
    getMeasurementRevision: () => 0,
    getMeasurementObjects: () => [],
    getMeasurement: () => null,
    setMeasuring: vi.fn(),
    onSectionChange: () => () => undefined,
    onMeasureChange: () => () => undefined,
    onModelLoaded: () => () => undefined,
    onAnnotationChange: () => () => undefined,
    getAnnotationRevision: () => 0,
    getAnnotationStates: () => [],
    hasElementOffsets: () => false,
    getSceneInfo: () => ({ meshCount: 0, triangleCount: 0, visibleTriangleCount: 0, bounds: { min: [0, 0, 0], max: [10, 10, 10] } }),
    getSectionBox: () => null,
    getModelBox: () => ({ min: [0, 0, 0], max: [10, 10, 10] }),
    isPlanView: () => false,
  } as unknown as Viewer;
}

function mount(measuring: boolean, hostWidth: number): { host: HTMLElement; card: HTMLElement; dock: HTMLElement } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  Object.defineProperty(host, "clientWidth", { value: hostWidth, configurable: true });
  new Dock(host, railViewer(measuring));
  const card = host.querySelector<HTMLElement>("#measure-card")!;
  // jsdom has no layout, so the card reports the width the CSS would give it.
  Object.defineProperty(card, "offsetWidth", { value: 286, configurable: true });
  return { host, card, dock: host.querySelector<HTMLElement>("#dock")! };
}

const openSection = (dock: HTMLElement): void => {
  dock.querySelector<HTMLButtonElement>('button[title*="Section planes"]')!.click();
};

describe("rail panel placement", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("puts a panel beside the measure card when the viewport has room", () => {
    const { dock, card } = mount(true, 1200);
    openSection(dock);
    expect(card.classList.contains("yield")).toBe(false);
    expect(dock.classList.contains("card-open")).toBe(true);
    // The offset the panel is pushed by has to be the card's real width.
    expect(dock.style.getPropertyValue("--mc-w")).toBe("286px");
  });

  // 42 px of rail gutter plus a 286 px card plus the 262 px section panel
  // needs about 600 px of viewer; 520 is comfortably under it.
  it("steps the card aside when the two would not both fit", () => {
    const { dock, card } = mount(true, 520);
    openSection(dock);
    expect(card.classList.contains("yield")).toBe(true);
    // Side by side is off, so the panel keeps its normal anchored position.
    expect(dock.classList.contains("card-open")).toBe(false);
  });

  it("brings the card back when the panel closes", () => {
    const { dock, card } = mount(true, 520);
    openSection(dock);
    expect(card.classList.contains("yield")).toBe(true);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(card.classList.contains("yield")).toBe(false);
  });

  it("leaves the offset alone when nothing is being measured", () => {
    const { dock, card } = mount(false, 1200);
    openSection(dock);
    expect(card.classList.contains("yield")).toBe(false);
    expect(dock.classList.contains("card-open")).toBe(false);
  });

  it("keeps a rail panel open when the model is clicked", () => {
    const { host, dock } = mount(true, 1200);
    openSection(dock);
    expect(dock.querySelector(".pop")).not.toBeNull();
    // A pointerdown in the viewport is what closes an ordinary popover.
    host.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true }));
    expect(dock.querySelector(".pop")).not.toBeNull();
  });

  it("shows one rail panel at a time", () => {
    const { dock } = mount(true, 1200);
    openSection(dock);
    dock.querySelector<HTMLButtonElement>('button[title*="Colour by"]')!.click();
    expect(dock.querySelectorAll(".pop")).toHaveLength(1);
    expect(dock.querySelectorAll('button[aria-expanded="true"]')).toHaveLength(1);
  });

  it("lays colour grouping out as a labelled, scrollable result panel", () => {
    const { dock } = mount(false, 1200);
    dock.querySelector<HTMLButtonElement>('button[title*="Colour by"]')!.click();
    const pop = dock.querySelector<HTMLElement>(".color-pop")!;
    expect(pop).not.toBeNull();
    expect(pop.querySelector(".color-modes")?.getAttribute("role")).toBe("group");
    expect(pop.querySelectorAll(".color-modes button")).toHaveLength(6);
    expect(pop.querySelector(".legend")?.getAttribute("aria-label")).toBe("Colour groups");
    expect(pop.querySelector(".pop-select")?.getAttribute("aria-label")).toBe("Colour by property");
  });
});
