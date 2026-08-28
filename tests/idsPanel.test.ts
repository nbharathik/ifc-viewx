import { beforeEach, describe, expect, it, vi } from "vitest";

import { IdsPanel } from "../src/ui/ids.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

const IDS = `<?xml version="1.0" encoding="UTF-8"?>
<ids xmlns="http://standards.buildingsmart.org/IDS">
  <info><title>Sample requirements</title></info>
  <specifications>
    <specification name="Walls carry a fire rating" ifcVersion="IFC4" minOccurs="0" maxOccurs="unbounded">
      <applicability minOccurs="0" maxOccurs="unbounded">
        <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
      </applicability>
      <requirements>
        <property dataType="IFCLABEL" cardinality="required">
          <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
          <baseName><simpleValue>FireRating</simpleValue></baseName>
        </property>
      </requirements>
    </specification>
  </specifications>
</ids>`;

function mount(openStudio?: () => void): { host: HTMLElement; log: ReturnType<typeof vi.fn> } {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const log = vi.fn();
  new IdsPanel(host, {
    viewer: { getSpatialTree: () => null, getStats: () => null } as unknown as Viewer,
    isolate: vi.fn(),
    report: vi.fn(),
    log,
    ...(openStudio ? { openStudio } : {}),
  });
  return { host, log };
}

const buttons = (host: HTMLElement): string[] =>
  [...host.querySelectorAll("button")].map((b) => b.textContent?.trim() ?? "");

describe("IDS panel", () => {
  beforeEach(() => document.body.replaceChildren());

  it("offers only the two steps a check needs, and starts unable to validate", () => {
    const { host } = mount();
    expect(buttons(host)).toEqual(["Open IDS", "Validate"]);
    expect(host.querySelector<HTMLButtonElement>("button.accent")!.disabled).toBe(true);
    expect(host.textContent).toContain("No IDS loaded");
  });

  it("adds an authoring link only when the host can open the studio", () => {
    const openStudio = vi.fn();
    const { host } = mount(openStudio);
    expect(buttons(host)).toContain("Author requirements");
    host.querySelector<HTMLButtonElement>(".link-btn")!.click();
    expect(openStudio).toHaveBeenCalledOnce();
  });

  it("names the loaded document and enables validation", async () => {
    const { host, log } = mount();
    const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
    const file = new File([IDS], "sample.ids", { type: "application/xml" });
    Object.defineProperty(input, "files", { value: [file], configurable: true });
    input.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => {
      expect(host.textContent).toContain("Sample requirements");
    });
    expect(host.textContent).toContain("1 specification");
    expect(host.querySelector<HTMLButtonElement>("button.accent")!.disabled).toBe(false);
    expect(log).toHaveBeenCalledWith("Loaded IDS sample.ids", "success");
  });
});
