import * as THREE from "three";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ViewerControls } from "../src/viewer-core/scene/controls.js";
import type { SceneController } from "../src/viewer-core/scene/scene.js";

describe("Viewer keyboard shortcut ownership", () => {
  beforeEach(() => {
    document.body.replaceChildren();
  });

  it("does not run viewport shortcuts from controls or while a modal is open", () => {
    const host = document.createElement("div");
    const canvas = document.createElement("canvas");
    host.appendChild(canvas);
    document.body.appendChild(host);
    const scene = {
      renderer: { domElement: canvas },
      camera: new THREE.PerspectiveCamera(50, 1, 0.1, 100),
      getResolutionScale: () => 1,
      setResolutionScale: vi.fn(),
      getRenderTiming: () => ({ lastMs: 0 }),
      resize: vi.fn(),
    } as unknown as SceneController;
    const onHide = vi.fn();
    const controls = new ViewerControls(scene, host, vi.fn(), { onHide });

    const select = document.createElement("select");
    document.body.appendChild(select);
    select.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(onHide).not.toHaveBeenCalled();

    const customControl = document.createElement("div");
    customControl.tabIndex = 0;
    document.body.appendChild(customControl);
    customControl.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(onHide).not.toHaveBeenCalled();

    const dialog = document.createElement("dialog");
    dialog.setAttribute("open", "");
    document.body.appendChild(dialog);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(onHide).not.toHaveBeenCalled();

    dialog.remove();
    const hiddenPluginModal = document.createElement("div");
    hiddenPluginModal.className = "hidden";
    hiddenPluginModal.setAttribute("aria-modal", "true");
    document.body.appendChild(hiddenPluginModal);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(onHide).toHaveBeenCalledTimes(1);

    hiddenPluginModal.classList.remove("hidden");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "h", bubbles: true }));
    expect(onHide).toHaveBeenCalledTimes(1);
    controls.dispose();
  });
});
