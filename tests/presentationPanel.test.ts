import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_DECK_SLIDES,
  MAX_SLIDE_SECONDS,
  mount,
  normalizeDeck,
  normalizeSlideSeconds,
} from "../src/plugins/presentation/panel.js";
import { ViewStore, type ViewDefinition } from "../src/views/definition.js";
import type { ExtensionContext, ExtensionInstance } from "../src/sdk/types.js";

const savedView = (id: string, name: string): ViewDefinition => ({
  id,
  name,
  folder: "",
  description: "",
  filters: [],
  color: null,
  camera: { position: [10, 5, 3], target: [0, 0, 0] },
  projection: "perspective",
  sections: [],
  box: null,
  xray: null,
  hidden: null,
  offsets: [],
  annotations: [],
  measurements: [],
  categories: { spaces: false, openings: false },
  ghostHidden: false,
  thumbnail: "",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

interface Harness {
  ctx: ExtensionContext;
  applySavedView: ReturnType<typeof vi.fn>;
  recordStop: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
}

function harness(views: ViewDefinition[], dwell = 60): Harness {
  const store = new ViewStore();
  store.clear();
  for (const view of views) expect(store.save(view)).toBe(true);
  const deck = {
    name: "Review",
    slides: views.map((view) => ({ viewId: view.id, travel: 5, dwell, note: "" })),
  };
  const applySavedView = vi.fn(async () => ({ empty: [], matched: 0 }));
  const recordStop = vi.fn(async () => new Blob());
  const off = vi.fn();
  const ctx = {
    storage: {
      read: vi.fn((_key: string, fallback: unknown) => deck ?? fallback),
      write: vi.fn(),
    },
    view: {
      camera: () => ({ position: [0, 0, 10], target: [0, 0, 0] }),
      setCamera: vi.fn(),
      applySavedView,
      recordStart: vi.fn(() => true),
      recordStop,
    },
    events: { on: vi.fn(() => off) },
    feedback: { log: vi.fn() },
    files: { export: vi.fn() },
  } as unknown as ExtensionContext;
  return { ctx, applySavedView, recordStop, off };
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

const namedButton = (host: HTMLElement, text: string): HTMLButtonElement => {
  const found = [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === text);
  if (!found) throw new Error(`Missing button ${text}`);
  return found;
};

describe("Presentation storage boundary", () => {
  it("normalizes persisted decks before they are rendered or played", () => {
    const note = "n".repeat(2_100);
    const deck = normalizeDeck({
      name: "D".repeat(250),
      slides: [
        { viewId: "kept", travel: -5, dwell: MAX_SLIDE_SECONDS + 10, note },
        { viewId: "defaults", note: "" },
        { viewId: "infinite", travel: 1, dwell: Number.POSITIVE_INFINITY, note: "" },
        { viewId: "x".repeat(501), travel: 1, dwell: 1, note: "" },
        { viewId: "bad-note", travel: 1, dwell: 1, note: 42 },
      ],
    });

    expect(deck.name).toHaveLength(200);
    expect(deck.slides).toEqual([
      { viewId: "kept", travel: 0, dwell: MAX_SLIDE_SECONDS, note: "n".repeat(2_000) },
      { viewId: "defaults", travel: 2.5, dwell: 3, note: "" },
    ]);
    expect(normalizeDeck(null)).toEqual({ name: "Design review", slides: [] });
    expect(normalizeDeck({ name: "", slides: [] })).toEqual({ name: "Design review", slides: [] });
  });

  it("caps slide count and rejects non-finite number-field values", () => {
    const deck = normalizeDeck({
      name: "Large",
      slides: Array.from({ length: MAX_DECK_SLIDES + 20 }, (_, index) => ({
        viewId: `view-${index}`,
        travel: 1,
        dwell: 1,
        note: "",
      })),
    });

    expect(deck.slides).toHaveLength(MAX_DECK_SLIDES);
    expect(normalizeSlideSeconds(Number.NaN, 3)).toBeNull();
    expect(normalizeSlideSeconds(Number.NEGATIVE_INFINITY, 3)).toBeNull();
  });
});

describe("Presentation lifecycle", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    localStorage.clear();
    new ViewStore().clear();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("uses the complete host apply path and cancels a superseded camera frame", async () => {
    const frames = new Map<number, FrameRequestCallback>();
    let sequence = 0;
    const request = vi.fn((callback: FrameRequestCallback) => {
      const id = ++sequence;
      frames.set(id, callback);
      return id;
    });
    const cancel = vi.fn((id: number) => void frames.delete(id));
    vi.stubGlobal("requestAnimationFrame", request);
    vi.stubGlobal("cancelAnimationFrame", cancel);

    const first = savedView("first", "First");
    const second = savedView("second", "Second");
    const test = harness([first, second]);
    const host = document.createElement("div");
    const instance = mount(host, test.ctx);
    const slides = host.querySelectorAll<HTMLButtonElement>(".slide-go");

    slides[0].click();
    await flush();
    expect(test.applySavedView).toHaveBeenCalledWith(first, expect.objectContaining({ camera: false }));
    expect(request).toHaveBeenCalledOnce();
    const firstSignal = test.applySavedView.mock.calls[0][1].signal as AbortSignal;

    slides[1].click();
    await flush();
    expect(firstSignal.aborted).toBe(true);
    expect(cancel).toHaveBeenCalledWith(1);
    expect(test.applySavedView).toHaveBeenLastCalledWith(second, expect.objectContaining({ camera: false }));
    instance.dispose?.();
  });

  it("Stop cancels the dwell immediately and terminates active recording once", async () => {
    vi.useFakeTimers();
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const test = harness([savedView("one", "One")]);
    const host = document.createElement("div");
    const instance = mount(host, test.ctx);

    namedButton(host, "Record").click();
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    namedButton(host, "Stop").click();
    await flush();

    expect(clearTimer).toHaveBeenCalled();
    expect(test.recordStop).toHaveBeenCalledOnce();
    expect(namedButton(host, "Play")).toBeTruthy();
    expect(namedButton(host, "Record")).toBeTruthy();
    instance.dispose?.();
  });

  it("disposal cancels playback, clears its dwell, and stops the recorder", async () => {
    vi.useFakeTimers();
    const clearTimer = vi.spyOn(globalThis, "clearTimeout");
    const test = harness([savedView("one", "One")]);
    const host = document.createElement("div");
    const instance = mount(host, test.ctx) as ExtensionInstance;

    namedButton(host, "Record").click();
    await flush();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    instance.dispose?.();
    await flush();

    expect(clearTimer).toHaveBeenCalled();
    expect(test.recordStop).toHaveBeenCalledOnce();
    expect(test.off).toHaveBeenCalledOnce();
  });
});
