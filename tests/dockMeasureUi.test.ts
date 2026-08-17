import { beforeEach, describe, expect, it, vi } from "vitest";

import { Dock } from "../src/ui/dock.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

function measureViewer(): Viewer {
  return {
    isMeasuring: () => true,
    getSection: () => null,
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
    getSections: () => [],
  } as unknown as Viewer;
}

describe("Measure card layout", () => {
  beforeEach(() => {
    localStorage.clear();
    document.body.replaceChildren();
  });

  it("keeps advanced settings and the ledger collapsed without hiding ledger content", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    new Dock(host, measureViewer());

    const card = host.querySelector<HTMLElement>("#measure-card");
    const drawers = card?.querySelectorAll<HTMLDetailsElement>(".mc-disclosure");
    expect(card?.classList.contains("hidden")).toBe(false);
    // Accuracy, the ledger and the quantity survey all start collapsed.
    expect([...drawers ?? []].map((drawer) => drawer.open)).toEqual([false, false, false]);
    expect(card?.querySelector(".mc-list")?.classList.contains("hidden")).toBe(false);
    expect(card?.querySelector(".mc-ledger summary")?.textContent).toContain("0 saved");
  });

  it("opens Smart Measure from the compact instrument header", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const viewer = measureViewer();
    const dock = new Dock(host, viewer);
    const open = vi.fn();
    dock.onOpenSmartMeasure = open;

    host.querySelector<HTMLButtonElement>(".mc-smart")?.click();

    expect(viewer.setMeasuring).toHaveBeenCalledWith(false);
    expect(open).toHaveBeenCalledOnce();
  });
});
