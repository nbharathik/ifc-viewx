import { beforeEach, describe, expect, it, vi } from "vitest";

import type { SpatialNode } from "../src/viewer-core/engine/types.js";
import { TreePanel, type TreeSource } from "../src/viewer-core/panels/tree.js";

const TREE: SpatialNode = {
  expressID: 1,
  type: "IfcProject",
  name: "Project",
  children: [{
    expressID: 2,
    type: "IfcSite",
    name: "Site",
    children: [{
      expressID: 3,
      type: "IfcBuilding",
      name: "Building",
      children: [{
        expressID: 4,
        type: "IfcBuildingStorey",
        name: "Ground floor",
        children: [
          { expressID: 5, type: "IfcWall", name: "Wall", children: [] },
          { expressID: 6, type: "IfcDoor", name: "Door", children: [] },
        ],
      }],
    }],
  }],
};

function source(tree: SpatialNode = TREE): TreeSource & { select: ReturnType<typeof vi.fn>; toggleSubtreeVisible: ReturnType<typeof vi.fn> } {
  let selectionListener: ((id: number | null) => void) | null = null;
  let visibilityListener: (() => void) | null = null;
  let selected: number | null = null;
  const hidden = new Set<number>();
  const result = {
    getSpatialTree: () => tree,
    select: vi.fn((id: number | null) => {
      selected = id;
      selectionListener?.(id);
    }),
    getSelection: () => selected,
    onSelectionChange: (listener: (id: number | null) => void) => {
      selectionListener = listener;
      return () => {
        selectionListener = null;
      };
    },
    onModelLoaded: () => () => undefined,
    isSubtreeVisible: (id: number) => !hidden.has(id),
    toggleSubtreeVisible: vi.fn((id: number) => {
      if (hidden.has(id)) hidden.delete(id);
      else hidden.add(id);
      visibilityListener?.();
    }),
    onVisibilityChange: (listener: () => void) => {
      visibilityListener = listener;
      return () => {
        visibilityListener = null;
      };
    },
  };
  return result;
}

const press = (target: HTMLElement, key: string): void => {
  target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
};

describe("Spatial tree keyboard navigation", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("keeps one treeitem tabbable and supports navigation, expansion, selection and visibility", () => {
    const host = document.createElement("div");
    document.body.appendChild(host);
    const treeSource = source();
    const panel = new TreePanel(host, treeSource);
    const items = (): HTMLElement[] => [...host.querySelectorAll<HTMLElement>("[role=treeitem]")];

    expect(items()).toHaveLength(4);
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    expect(items()[0].dataset.id).toBe("1");

    items()[0].focus();
    press(items()[0], "End");
    expect((document.activeElement as HTMLElement).dataset.id).toBe("4");

    press(document.activeElement as HTMLElement, "ArrowRight");
    expect(items()).toHaveLength(6);
    expect((document.activeElement as HTMLElement).dataset.id).toBe("4");
    press(document.activeElement as HTMLElement, "ArrowDown");
    expect((document.activeElement as HTMLElement).dataset.id).toBe("5");
    expect((document.activeElement as HTMLElement).getAttribute("aria-posinset")).toBe("1");
    expect((document.activeElement as HTMLElement).getAttribute("aria-setsize")).toBe("2");

    press(document.activeElement as HTMLElement, "Enter");
    expect(treeSource.select).toHaveBeenLastCalledWith(5);
    press(document.activeElement as HTMLElement, "v");
    expect(treeSource.toggleSubtreeVisible).toHaveBeenLastCalledWith(5);
    expect((document.activeElement as HTMLElement).getAttribute("aria-label")).toContain("hidden");

    press(document.activeElement as HTMLElement, "ArrowLeft");
    expect((document.activeElement as HTMLElement).dataset.id).toBe("4");
    expect(items().filter((item) => item.tabIndex === 0)).toHaveLength(1);
    panel.dispose();
  });

  it("keeps a visible tab stop when virtualization scrolls the focused row away", () => {
    const largeTree: SpatialNode = {
      expressID: 1000,
      type: "IfcProject",
      name: "Large project",
      children: Array.from({ length: 120 }, (_, index) => ({
        expressID: 2000 + index,
        type: "IfcBuildingStorey",
        name: `Storey ${index + 1}`,
        children: [],
      })),
    };
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new TreePanel(host, source(largeTree));
    const body = host.querySelector<HTMLElement>(".ifc-tree-scroll")!;
    Object.defineProperty(body, "clientHeight", { configurable: true, value: 88 });

    const original = host.querySelector<HTMLElement>("[role=treeitem]")!;
    original.focus();
    body.scrollTop = 22 * 80;
    (panel as unknown as { paint(): void }).paint();

    const painted = [...host.querySelectorAll<HTMLElement>("[role=treeitem]")];
    const tabStops = painted.filter((item) => item.tabIndex === 0);
    expect(tabStops).toHaveLength(1);
    expect(Number(tabStops[0].dataset.row)).toBeGreaterThan(60);
    tabStops[0].focus();
    expect(document.activeElement).toBe(tabStops[0]);
    panel.dispose();
  });
});
