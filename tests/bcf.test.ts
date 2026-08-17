import { beforeEach, describe, expect, it, vi } from "vitest";
import { BcfPanel } from "../src/ui/bcf.js";
import type { OpenCdeFetch } from "../src/opencde/client.js";
import type { Viewer } from "../src/viewer-core/viewer.js";

beforeEach(() => {
  localStorage.clear();
  document.body.replaceChildren();
  HTMLDialogElement.prototype.showModal ??= function showModal(): void {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function close(): void {
    this.removeAttribute("open");
    this.dispatchEvent(new Event("close"));
  };
});

describe("BCF capture", () => {
  it("keeps multiple selected components, their GlobalIds and a section box", async () => {
    const viewer = {
      onModelLoaded: vi.fn(),
      getStats: () => ({ totalEntities: 20, triangleCount: 40 }),
      getVisibilityCounts: () => ({ hidden: 0 }),
      getElementTypes: () => new Map([[11, "IfcWall"], [22, "IfcPipeSegment"]]),
      isElementVisible: () => true,
      getCamera: () => ({ position: [4, 5, 6], target: [1, 2, 3] }),
      getSections: () => [],
      getSectionBox: () => ({ min: [0, 1, 2], max: [3, 4, 5] }),
      getSelectedIds: () => [11, 22],
      getAnnotationStates: () => [],
      getProperties: async (id: number) => ({
        expressID: id,
        type: id === 11 ? "IfcWall" : "IfcPipeSegment",
        attributes: [{ name: "GlobalId", value: id === 11 ? "wall-guid" : "pipe-guid" }],
        propertySets: [],
      }),
      captureImage: async () => null,
    } as unknown as Viewer;
    const panel = new BcfPanel(document.createElement("div"), {
      viewer,
      modelName: () => "coordination.ifc",
      log: vi.fn(),
    });

    const id = panel.capture("Wall and pipe", "64 mm penetration", {
      elementIds: [11, 22],
      priority: "Critical",
    });
    await vi.waitFor(() => {
      const saved = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]") as Array<{
        viewpoint?: { selections?: Array<{ guid: string | null }> };
      }>;
      expect(saved[0]?.viewpoint?.selections?.[1]?.guid).toBe("pipe-guid");
    });
    const topics = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]") as Array<Record<string, unknown>>;
    expect(id).toBeTruthy();
    expect(topics[0]).toMatchObject({ title: "Wall and pipe", priority: "Critical" });
    expect(topics[0].viewpoint).toMatchObject({
      sectionBox: { min: [0, 1, 2], max: [3, 4, 5] },
      selections: [{ id: 11, guid: "wall-guid" }, { id: 22, guid: "pipe-guid" }],
    });
  });

  it("connects a BCF project and explicitly syncs a newly captured issue", async () => {
    const remoteTopics: Array<Record<string, unknown>> = [];
    const fetcher: OpenCdeFetch = vi.fn(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
      if (url.endsWith("/foundation/versions")) return json({ versions: [
        { api_id: "foundation", version_id: "1.0", api_base_url: "https://cde.test/foundation/1.0" },
        { api_id: "bcf", version_id: "3.0", api_base_url: "https://cde.test/bcf/3.0" },
      ] });
      if (url.includes("/projects?")) return json([{ project_id: "p1", name: "Campus coordination" }]);
      if (url.endsWith("/projects/p1/extensions")) return json({
        topic_type: ["Issue"],
        topic_status: ["Open", "Resolved"],
        priority: ["Normal", "Critical"],
        user_id_type: ["architect@example.com"],
      });
      if (url.endsWith("/foundation/1.0/current-user")) return json({ id: "coordinator@example.com" });
      if (url.includes("/projects/p1/topics?") && method === "GET") return json(remoteTopics);
      if (url.endsWith("/projects/p1/topics") && method === "POST") {
        const created = { ...JSON.parse(String(init?.body)), server_assigned_id: "BCF-17" };
        remoteTopics.push(created);
        return json(created, 201);
      }
      if (url.endsWith("/viewpoints") && method === "POST") return json(JSON.parse(String(init?.body)), 201);
      throw new Error(`Unexpected request: ${method} ${url}`);
    });
    const viewer = {
      onModelLoaded: vi.fn(),
      getStats: () => ({ totalEntities: 20, triangleCount: 40 }),
      getVisibilityCounts: () => ({ hidden: 0 }),
      getElementTypes: () => new Map([[11, "IfcWall"]]),
      isElementVisible: () => true,
      getCamera: () => ({ position: [4, 5, 6], target: [1, 2, 3] }),
      getSections: () => [],
      getSectionBox: () => null,
      getSelectedIds: () => [11],
      getAnnotationStates: () => [],
      getProperties: async () => ({ expressID: 11, type: "IfcWall", attributes: [], propertySets: [] }),
      captureImage: async () => null,
    } as unknown as Viewer;
    const host = document.createElement("div");
    document.body.appendChild(host);
    const panel = new BcfPanel(host, {
      viewer,
      modelName: () => "campus.ifc",
      log: vi.fn(),
      openCdeFetch: fetcher,
    });

    host.querySelector<HTMLButtonElement>('[data-action="open-cde-connect"]')?.click();
    const dialog = document.querySelector<HTMLDialogElement>(".cde-dialog")!;
    const server = dialog.querySelector<HTMLInputElement>('input[aria-label="OpenCDE server URL"]')!;
    server.value = "https://cde.test";
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Find projects")?.click();
    await vi.waitFor(() => expect(dialog.querySelector<HTMLSelectElement>('select[aria-label="OpenCDE project"]')).toBeTruthy());
    [...dialog.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Open project")?.click();
    await vi.waitFor(() => expect(dialog.isConnected).toBe(false));

    const guid = panel.capture("Wall opening", "Coordinate the structural opening", { priority: "Critical" });
    expect(guid).toBeTruthy();
    let stored = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]") as Array<{
      remote?: { state?: string };
    }>;
    expect(stored[0]?.remote?.state).toBe("pending-create");
    host.querySelector<HTMLButtonElement>('[data-action="open-cde-sync"]')?.click();
    await vi.waitFor(() => {
      stored = JSON.parse(localStorage.getItem("ifcviewx.bcf.20-40") ?? "[]");
      expect(stored[0]?.remote?.state).toBe("synced");
    });
    expect(remoteTopics[0]).toMatchObject({ title: "Wall opening", priority: "Critical" });
    expect(fetcher).toHaveBeenCalledWith(
      expect.stringContaining("/viewpoints"),
      expect.objectContaining({ method: "POST" }),
    );
  });
});
