import { afterEach, describe, expect, it, vi } from "vitest";

import { XrController } from "../src/viewer-core/scene/xr.js";

class FakeSession extends EventTarget {
  readonly end = vi.fn(async () => {
    this.dispatchEvent(new Event("end"));
  });
}

const originalXr = Object.getOwnPropertyDescriptor(navigator, "xr");

afterEach(() => {
  if (originalXr) Object.defineProperty(navigator, "xr", originalXr);
  else delete (navigator as Navigator & { xr?: unknown }).xr;
  vi.restoreAllMocks();
});

function harness(setSession = vi.fn(async () => undefined)) {
  const session = new FakeSession();
  const requestSession = vi.fn(async () => session as unknown as XRSession);
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: { isSessionSupported: vi.fn(async () => true), requestSession } as unknown as XRSystem,
  });
  const xr = {
    enabled: false,
    setReferenceSpaceType: vi.fn(),
    setSession,
    getReferenceSpace: vi.fn(() => null),
    setReferenceSpace: vi.fn(),
  };
  const setAnimationLoop = vi.fn();
  const setPresenting = vi.fn();
  const draw = vi.fn();
  const controller = new XrController({
    renderer: { xr, setAnimationLoop } as never,
    draw,
    standAt: () => [0, 0, 0],
    setPresenting,
  });
  return { controller, draw, requestSession, session, setAnimationLoop, setPresenting, setSession, xr };
}

describe("XR session lifecycle", () => {
  it("ends and fully rolls back a session when the renderer rejects it", async () => {
    const failure = new Error("XR-compatible context failed");
    const state = harness(vi.fn(async () => Promise.reject(failure)));
    const changes = vi.fn();
    state.controller.onChange(changes);

    await expect(state.controller.start("immersive-vr")).rejects.toBe(failure);

    expect(state.session.end).toHaveBeenCalledTimes(1);
    expect(state.controller.current()).toBeNull();
    expect(state.controller.isPresenting()).toBe(false);
    expect(state.xr.enabled).toBe(false);
    expect(state.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(state.setPresenting).toHaveBeenLastCalledWith(false);
    expect(changes).not.toHaveBeenCalled();
  });

  it("emits one state change per transition when end and cleanup overlap", async () => {
    const state = harness();
    const changes: Array<string | null> = [];
    state.controller.onChange((mode) => changes.push(mode));

    await state.controller.start("immersive-ar");
    await state.controller.end();
    await state.controller.end();
    state.session.dispatchEvent(new Event("end"));

    expect(changes).toEqual(["immersive-ar", null]);
    expect(state.session.end).toHaveBeenCalledTimes(1);
    expect(state.setPresenting.mock.calls).toEqual([[true], [false]]);
    expect(state.setAnimationLoop).toHaveBeenLastCalledWith(null);
  });

  it("disposal synchronously stops presentation and closes the session once", async () => {
    const state = harness();
    const changes: Array<string | null> = [];
    state.controller.onChange((mode) => changes.push(mode));
    await state.controller.start("immersive-vr");

    state.controller.dispose();
    state.controller.dispose();
    await Promise.resolve();

    expect(state.controller.current()).toBeNull();
    expect(state.setAnimationLoop).toHaveBeenLastCalledWith(null);
    expect(state.xr.enabled).toBe(false);
    expect(state.session.end).toHaveBeenCalledTimes(1);
    expect(changes).toEqual(["immersive-vr", null]);
    await expect(state.controller.start("immersive-vr")).rejects.toThrow(/disposed/i);
  });
});
