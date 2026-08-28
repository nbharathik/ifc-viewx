import { describe, expect, it, vi } from "vitest";
import { mount } from "../src/plugins/point-cloud/panel.js";
import type { ExtensionContext } from "../src/sdk/index.js";

function context(): ExtensionContext {
  const store = new Map<string, unknown>();
  return {
    signal: new AbortController().signal,
    session: { model: () => ({ key: "model", name: "Architecture.ifc", loaded: true }) },
    geometry: {
      deviation: vi.fn(async (points: Float64Array) => ({
        distances: Float32Array.from({ length: points.length / 3 }, (_, index) => index * 0.01),
        measured: points.length / 3,
        points: points.length / 3,
      })),
    },
    view: {
      modelBox: () => ({ min: [0, 0, 0], max: [10, 3, 10] }),
      models: () => [],
      georeferencedToScene: () => null,
      setPointCloud: vi.fn(),
      setPointCloudSize: vi.fn(),
      setPointCloudVisible: vi.fn(),
    },
    storage: {
      read: <T,>(key: string, fallback: T): T => store.has(key) ? store.get(key) as T : fallback,
      write: (key: string, value: unknown) => void store.set(key, value),
    },
    feedback: { log: vi.fn(), toast: vi.fn() },
    events: { on: () => () => undefined },
  } as unknown as ExtensionContext;
}

function scanFile(name: string, text: string): File {
  const bytes = new TextEncoder().encode(text);
  return {
    name,
    size: bytes.byteLength,
    arrayBuffer: async () => bytes.buffer,
  } as File;
}

async function choose(host: HTMLElement, file: File): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  Object.defineProperty(input, "files", { configurable: true, value: [file] });
  input.dispatchEvent(new Event("change"));
  await Promise.resolve();
}

const byText = (host: HTMLElement, text: string): HTMLButtonElement =>
  [...host.querySelectorAll<HTMLButtonElement>("button")].find((node) => node.textContent === text)!;

describe("Point Cloud panel", () => {
  it("opens a supported scan, draws it, and completes a deviation comparison", async () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);

    expect(host.querySelector<HTMLInputElement>('input[type="file"]')?.accept).not.toContain(".laz");
    await choose(host, scanFile("survey.xyz", "0 0 0\n1 2 3\n"));
    await vi.waitFor(() => expect(host.textContent).toContain("survey.xyz"));

    expect(ctx.view.setPointCloud).toHaveBeenCalled();
    expect(host.querySelectorAll(".cloud-stage.done")).toHaveLength(2);

    byText(host, "Compare with model").click();
    await vi.waitFor(() => expect(host.textContent).toContain("Surface deviation"));

    expect(ctx.geometry.deviation).toHaveBeenCalledOnce();
    expect(host.querySelectorAll(".cloud-stage.done")).toHaveLength(3);
    instance?.dispose?.();
  });

  it("invalidates a measured result when alignment changes", async () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);
    await choose(host, scanFile("survey.xyz", "0 0 0\n1 2 3\n"));
    await vi.waitFor(() => expect(host.textContent).toContain("survey.xyz"));
    byText(host, "Compare with model").click();
    await vi.waitFor(() => expect(host.textContent).toContain("Surface deviation"));

    const east = [...host.querySelectorAll<HTMLLabelElement>(".cloud-field")]
      .find((label) => label.textContent?.includes("East offset"))!
      .querySelector<HTMLInputElement>("input")!;
    east.value = String(Number(east.value) + 1);
    east.dispatchEvent(new Event("change"));

    expect(host.textContent).not.toContain("Surface deviation");
    expect(byText(host, "Compare with model")).toBeTruthy();
    instance?.dispose?.();
  });

  it("shows import failures inside the panel", async () => {
    const host = document.createElement("div");
    const ctx = context();
    const instance = mount(host, ctx);

    await choose(host, scanFile("broken.xyz", "not a point cloud\n"));
    await vi.waitFor(() => expect(host.querySelector(".cloud-error")?.textContent).toContain("No X Y Z rows"));
    expect(ctx.feedback.toast).toHaveBeenCalledWith(expect.stringContaining("No X Y Z rows"), "error");
    instance?.dispose?.();
  });
});
