import { BridgeClient } from "../bridge/bridgeClient.js";
import type { ServiceClient } from "../bridge/serviceClient.js";
import { VIEWER_POLICY } from "../capabilities/policy.js";
import type { CapabilityRegistry } from "../capabilities/registry.js";
import type { ViewerCapabilityContext } from "../capabilities/types.js";
import { readViewpoints, saveViewpoint, viewpointKey } from "../ui/dock.js";
import type { Viewer } from "../viewer-core/viewer.js";

export interface BrowserBridgeState {
  loaded: boolean;
  fileName: string;
  schema: string | null;
  pendingEdit: string | null;
}

export interface BrowserBridgeOptions {
  viewer: Viewer;
  service: ServiceClient;
  capabilities: CapabilityRegistry<ViewerCapabilityContext>;
  capabilityContext: ViewerCapabilityContext;
  state(): BrowserBridgeState;
  onStatus(status: "disconnected" | "connecting" | "connected", detail?: string): void;
}

export function createBrowserBridge(options: BrowserBridgeOptions): BridgeClient {
  const { viewer, service, capabilities, capabilityContext } = options;
  const bridge = new BridgeClient({ onStatus: options.onStatus });

  bridge.register("get_status", () => ({
    ...options.state(),
    sha: service.getSha(),
    mode: service.mode(),
  }));
  bridge.register("get_model_info", async () => ({
    fileName: options.state().fileName,
    schema: options.state().schema,
    stats: viewer.getStats(),
    countsByType: await viewer.getCountsByType(),
  }));
  bridge.register("get_spatial_tree", () => {
    const tree = viewer.getSpatialTree();
    if (!tree) throw new Error("no model loaded");
    return tree;
  });
  bridge.register("get_selection", () => ({ expressId: viewer.getSelection() }));
  bridge.register("select_element", (params) => {
    const id = Number(params.express_id);
    if (!Number.isFinite(id)) throw new Error("express_id required");
    viewer.select(id);
    viewer.fitToElement(id);
    return { selected: id };
  });
  bridge.register("get_properties", async (params) => {
    const id = Number(params.express_id);
    const props = await viewer.getProperties(id);
    if (!props) throw new Error(`no properties for express_id ${id}`);
    return props;
  });
  bridge.register("set_visibility", (params) => {
    const id = Number(params.express_id);
    if (!Number.isFinite(id) || id <= 0) throw new Error("express_id required");
    viewer.setSubtreeVisible(id, Boolean(params.visible));
    return { expressId: id, visible: Boolean(params.visible) };
  });
  bridge.register("show_all", () => {
    viewer.showAll();
    return { ok: true };
  });
  bridge.register("fit_view", (params) => {
    const id = Number(params.express_id);
    if (Number.isFinite(id) && id > 0) viewer.fitToElement(id);
    else viewer.fitToModel();
    return { ok: true };
  });

  for (const capability of capabilities.list((entry) => entry.exposure.mcp === true)) {
    bridge.register(capability.id, async (params) => {
      const value = await capabilities.executeValue(capability.id, params, capabilityContext, {
        policy: VIEWER_POLICY,
      });
      return typeof value === "string" ? { report: value } : value;
    });
  }

  bridge.register("capture_view", async (params) => {
    const width = Number(params.max_width);
    const blob = await viewer.captureImage(
      Number.isFinite(width) && width > 0 ? Math.min(width, 2048) : 1024,
      "image/png",
    );
    if (!blob) throw new Error("nothing to capture");
    const buffer = new Uint8Array(await blob.arrayBuffer());
    let binary = "";
    for (const byte of buffer) binary += String.fromCharCode(byte);
    const viewport = viewer.getViewport();
    return {
      mimeType: "image/png",
      base64: btoa(binary),
      width: viewport.width,
      height: viewport.height,
    };
  });
  bridge.register("list_viewpoints", () => {
    const key = viewpointKey(viewer);
    return { viewpoints: key ? readViewpoints(key).map((view) => view.name) : [] };
  });
  bridge.register("save_viewpoint", (params) => {
    const name = saveViewpoint(viewer, typeof params.name === "string" ? params.name : undefined);
    if (!name) throw new Error(viewpointKey(viewer) ? "browser could not persist viewpoint" : "no model loaded");
    return { saved: name };
  });

  return bridge;
}
