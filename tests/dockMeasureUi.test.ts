import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Dock } from "../src/ui/dock.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

function measureViewer(): Viewer {
  return {
    isMeasuring: () => true,
    getStats: () => ({ totalEntities: 20, triangleCount: 50 }),
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
    getMeasurementStates: () => [],
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

  afterEach(() => {
    vi.restoreAllMocks();
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

  it("opens the verified Smart Measure plugin from the compact instrument header", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const viewer = measureViewer();
    const dock = new Dock(host, viewer);
    const open = vi.fn();
    dock.onOpenSmartMeasure = open;

    const smart = host.querySelector<HTMLButtonElement>(".mc-smart");
    expect(smart).not.toBeNull();
    smart?.click();

    expect(viewer.setMeasuring).toHaveBeenCalledWith(false);
    expect(open).toHaveBeenCalledOnce();
  });

  it("mounts when browser storage is unavailable", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    const host = document.createElement("div");
    document.body.appendChild(host);

    expect(() => new Dock(host, measureViewer())).not.toThrow();
    expect(host.querySelector("#measure-card")).not.toBeNull();
  });

  it("retries durable measurement and annotation writes after storage recovers", () => {
    let measureChanged = (): void => undefined;
    let annotationChanged = (): void => undefined;
    const viewer = measureViewer();
    Object.assign(viewer, {
      getMeasurementRevision: () => 1,
      getAnnotationRevision: () => 1,
      onMeasureChange: (listener: () => void) => {
        measureChanged = listener;
        return () => undefined;
      },
      onAnnotationChange: (listener: () => void) => {
        annotationChanged = listener;
        return () => undefined;
      },
    });
    const attempts = new Map<string, number>();
    const originalSetItem = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
      const count = (attempts.get(key) ?? 0) + 1;
      attempts.set(key, count);
      if (count === 1) throw new DOMException("full", "QuotaExceededError");
      originalSetItem.call(this, key, value);
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    new Dock(host, viewer);

    measureChanged();
    measureChanged();
    annotationChanged();
    annotationChanged();

    const measurementKey = "ifcviewx.measure.20-50";
    const annotationKey = "ifcviewx.notes.20-50";
    expect(attempts.get(measurementKey)).toBe(2);
    expect(attempts.get(annotationKey)).toBe(2);
    expect(localStorage.getItem(measurementKey)).toBe("[]");
    expect(localStorage.getItem(annotationKey)).toBe("[]");
  });

  it("keeps a viewpoint visible when deleting it cannot be persisted", () => {
    const key = "ifcviewx.vp.20-50";
    localStorage.setItem(key, JSON.stringify([{
      name: "Keep me",
      pose: { position: [8, 8, 8], target: [1, 2, 3] },
      section: null,
    }]));
    const host = document.createElement("div");
    document.body.appendChild(host);
    new Dock(host, measureViewer());
    host.querySelector<HTMLButtonElement>('button[aria-label="Saved viewpoints"]')?.click();

    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("full", "QuotaExceededError");
    });
    host.querySelector<HTMLButtonElement>('button[aria-label="Delete"]')?.click();

    expect(localStorage.getItem(key)).toContain("Keep me");
    expect(host.querySelector(".pop-list")?.textContent).toContain("Keep me");
    expect(document.querySelector("#toasts")?.textContent).toContain("could not delete this viewpoint");
  });
});
