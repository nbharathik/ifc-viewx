import { beforeEach, describe, expect, it, vi } from "vitest";
import { GeoContextPanel } from "../src/ui/geo.js";
import type { FederatedModel, Viewer } from "../src/viewer-core/viewer.js";

function model(overrides: Partial<FederatedModel> = {}): FederatedModel {
  return {
    index: 0,
    name: "Architecture.ifc",
    visible: true,
    elements: 2,
    triangles: 24,
    offset: [0, 0, 0],
    transform: { translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none" },
    geoStatus: "ready",
    diagnostics: [],
    geo: {
      schema: "IFC4X3_ADD2",
      projectedCrs: { name: "EPSG:25832", geodeticDatum: "ETRS89", verticalDatum: null, mapProjection: "UTM", mapZone: "32N", mapUnit: "METRE" },
      trueNorth: { degreesFromGridNorth: 1.25 },
      operation: {
        kind: "map-conversion",
        eastings: 100,
        northings: 200,
        orthogonalHeight: 5,
        rotation: 0,
        scale: 1,
      },
    },
    ...overrides,
  } as unknown as FederatedModel;
}

function viewer(selectionHandlers: Array<() => void>, modelHandlers: Array<() => void>): Viewer {
  return {
    onModelLoaded: (handler: () => void) => {
      modelHandlers.push(handler);
      return () => undefined;
    },
    onSelectionChange: (handler: () => void) => {
      selectionHandlers.push(handler);
      return () => undefined;
    },
    getModels: () => [model()],
    getGeoAnchor: () => 0,
    getLastPick: () => null,
    getCamera: () => ({ position: [0, 0, 0], target: [1, 2, 3] }),
    getModelOrigin: () => [0, 0, 0],
    sceneToGeoreferenced: (point: [number, number, number]) => ({
      crs: "EPSG:25832",
      coordinates: [point[0] + 100, point[1] + 200, point[2]] as [number, number, number],
    }),
    georeferencedToScene: () => null,
    setModelPlacement: vi.fn(),
    alignGeospatialModels: vi.fn(() => 0),
    addMeasurement: vi.fn(),
    updateMeasurement: vi.fn(),
    removeMeasurement: vi.fn(),
    getSelectedIds: () => [],
    getElementBounds: () => null,
    getSpatialTree: () => null,
    getModelBox: () => ({ min: [0, 0, 0], max: [1, 1, 1] }),
    getProperties: vi.fn(async () => null),
  } as unknown as Viewer;
}

describe("Geo Context panel", () => {
  beforeEach(() => localStorage.clear());

  it("shows the projected datum and the model coordinate ledger", () => {
    const host = document.createElement("div");
    const panel = new GeoContextPanel(host, { viewer: viewer([], []), log: vi.fn(), createIssue: vi.fn() });

    expect(host.querySelector(".geo-plate-copy strong")?.textContent).toBe("EPSG:25832");
    // Plain decimals whatever the reader's locale, so a copied coordinate
    // still parses in GIS and survey tools.
    expect(host.querySelector(".geo-plate-value code")?.textContent).toBe("101.000 / 202.000 / 3.000");
    expect(host.textContent).toContain("Anchor ready");
    // Four placement lines up front; the long list and hand placement fold away.
    expect(host.querySelectorAll(".geo-model-body > .geo-ledger dt")).toHaveLength(4);
    const folds = [...host.querySelectorAll<HTMLDetailsElement>(".geo-fold")];
    expect(folds).toHaveLength(2);
    expect(folds.every((fold) => !fold.open)).toBe(true);
    // An empty grid is decoration, so no layer means no preview.
    expect(host.querySelector(".geo-map")).toBeNull();

    panel.dispose();
  });

  it("a viewport selection moves the readout without rebuilding the alignment fields", () => {
    const host = document.createElement("div");
    const selection: Array<() => void> = [];
    const panel = new GeoContextPanel(host, { viewer: viewer(selection, []), log: vi.fn(), createIssue: vi.fn() });

    const east = host.querySelector<HTMLInputElement>('input[aria-label="East / X"]')!;
    east.value = "12.5";
    const readout = host.querySelector(".geo-plate-value code");

    for (const handler of selection) handler();

    // Repainting on every click used to throw away a half-typed alignment.
    expect(host.querySelector<HTMLInputElement>('input[aria-label="East / X"]')?.value).toBe("12.5");
    expect(host.querySelector(".geo-plate-value code")).toBe(readout);

    panel.dispose();
  });
});
