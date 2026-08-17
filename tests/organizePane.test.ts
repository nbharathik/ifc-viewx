import { beforeEach, describe, expect, it, vi } from "vitest";

import { OrganizePane } from "../src/ui/organizePane.js";
import type { OrganizeIndex, Viewer } from "../src/viewer-core/viewer.js";

const INDEX: OrganizeIndex = {
  groups: [
    { expressID: 50, name: "HVAC supply", ifcType: "IfcSystem", ids: [1, 2, 3] },
    { expressID: 51, name: null, ifcType: "IfcZone", ids: [4] },
  ],
  layers: [{ name: "A-WALL", ids: [1, 2] }],
  classifications: [{ system: "Uniclass", code: "EF_25_10", ids: [2, 3] }],
  materials: [{ name: "Concrete", ids: [1, 4] }],
};

const EMPTY: OrganizeIndex = { groups: [], layers: [], classifications: [], materials: [] };

function fakeViewer(index: OrganizeIndex = INDEX): Viewer {
  return {
    getStats: () => ({ totalEntities: 5 }),
    getOrganizeIndex: vi.fn(() => Promise.resolve(index)),
    onModelLoaded: () => () => undefined,
    selectMany: vi.fn(),
    isolate: vi.fn(),
    setHidden: vi.fn(),
  } as unknown as Viewer;
}

async function mount(viewer: Viewer): Promise<{ host: HTMLElement; pane: OrganizePane }> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const pane = new OrganizePane(host, viewer);
  pane.render();
  await pane.ready();
  return { host, pane };
}

const rows = (host: HTMLElement): HTMLElement[] => [...host.querySelectorAll<HTMLElement>(".org-row")];
const modeButton = (host: HTMLElement, label: string): HTMLButtonElement => {
  const button = [...host.querySelectorAll<HTMLButtonElement>(".org-switch button")]
    .find((b) => b.textContent === label);
  if (!button) throw new Error(`no mode button ${label}`);
  return button;
};

describe("Organize pane", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("shows the no-model empty state before anything is loaded", () => {
    const viewer = { ...fakeViewer(), getStats: () => null } as unknown as Viewer;
    const host = document.createElement("div");
    document.body.appendChild(host);
    new OrganizePane(host, viewer).render();
    expect(host.querySelector(".empty")?.textContent).toContain("No model loaded");
  });

  it("fetches the index once and renders group rows with name, tag and count", async () => {
    const viewer = fakeViewer();
    const { host, pane } = await mount(viewer);
    pane.render();
    await pane.ready();
    expect(viewer.getOrganizeIndex).toHaveBeenCalledTimes(1);
    const list = rows(host);
    expect(list).toHaveLength(2);
    expect(list[0].querySelector(".name")?.textContent).toBe("HVAC supply");
    expect(list[0].querySelector(".tag")?.textContent).toBe("IfcSystem");
    expect(list[0].querySelector(".n")?.textContent).toBe("3");
    expect(list[1].querySelector(".name")?.textContent).toBe("Group #51");
  });

  it("shows a busy row while the index loads", async () => {
    let release: (index: OrganizeIndex) => void = () => undefined;
    const viewer = fakeViewer();
    (viewer.getOrganizeIndex as ReturnType<typeof vi.fn>).mockReturnValue(
      new Promise<OrganizeIndex>((resolve) => (release = resolve)),
    );
    const host = document.createElement("div");
    document.body.appendChild(host);
    const pane = new OrganizePane(host, viewer);
    pane.render();
    expect(host.querySelector(".busy-row")).not.toBeNull();
    release(INDEX);
    await pane.ready();
    expect(host.querySelector(".busy-row")).toBeNull();
    expect(rows(host)).toHaveLength(2);
  });

  it("switches modes and renders each list with its counts", async () => {
    const { host } = await mount(fakeViewer());

    modeButton(host, "Layers").click();
    expect(rows(host)).toHaveLength(1);
    expect(rows(host)[0].querySelector(".name")?.textContent).toBe("A-WALL");
    expect(rows(host)[0].querySelector(".n")?.textContent).toBe("2");

    modeButton(host, "Classes").click();
    expect(rows(host)[0].querySelector(".name")?.textContent).toBe("EF_25_10");
    expect(rows(host)[0].querySelector(".tag")?.textContent).toBe("Uniclass");

    modeButton(host, "Materials").click();
    expect(rows(host)[0].querySelector(".name")?.textContent).toBe("Concrete");
    expect(modeButton(host, "Materials").getAttribute("aria-pressed")).toBe("true");
    expect(modeButton(host, "Groups").getAttribute("aria-pressed")).toBe("false");
  });

  it("selects the ids when a row is clicked", async () => {
    const viewer = fakeViewer();
    const { host } = await mount(viewer);
    rows(host)[0].querySelector<HTMLButtonElement>(".main")?.click();
    expect(viewer.selectMany).toHaveBeenCalledWith([1, 2, 3]);
  });

  it("isolates and hides through the row action buttons", async () => {
    const viewer = fakeViewer();
    const { host } = await mount(viewer);
    const buttons = rows(host)[0].querySelectorAll<HTMLButtonElement>(".icon-btn");
    buttons[0].click();
    expect(viewer.isolate).toHaveBeenCalledWith([1, 2, 3], "HVAC supply");
    buttons[1].click();
    expect(viewer.setHidden).toHaveBeenCalledWith([1, 2, 3], true);
  });

  it("shows a per-mode empty state when the model has none", async () => {
    const { host } = await mount(fakeViewer(EMPTY));
    expect(host.querySelector(".empty")?.textContent).toContain("No groups");
    modeButton(host, "Materials").click();
    expect(host.querySelector(".empty")?.textContent).toContain("No materials");
  });

  it("caps the list at 500 rows and counts the rest", async () => {
    const layers = Array.from({ length: 512 }, (_, i) => ({ name: `L${i}`, ids: [i] }));
    const { host } = await mount(fakeViewer({ ...EMPTY, layers }));
    modeButton(host, "Layers").click();
    expect(rows(host)).toHaveLength(500);
    expect(host.querySelector(".hint-line")?.textContent).toContain("12 more");
  });
});
