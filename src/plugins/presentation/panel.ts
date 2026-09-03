// Presentation: the saved views, in order, with the camera flying between them.
//
// This replaces the screen recording somebody makes by hand at the end of
// every design review. It owns no model state of its own: a slide is a saved
// view plus two numbers, so editing the view edits the slide.
import {
  bar,
  button,
  emptyState,
  h,
  header,
  hint,
  icon,
  note,
  number as numberField,
  page,
  toast,
  ViewStore,
  type CameraPose,
  type ExtensionContext,
  type ExtensionInstance,
  type ViewDefinition,
} from "@ifcviewx/sdk";

interface Slide {
  viewId: string;
  /** Seconds the camera takes to arrive from the previous slide. */
  travel: number;
  /** Seconds the slide is held once it arrives. */
  dwell: number;
  note: string;
}

export interface Deck {
  name: string;
  slides: Slide[];
}

const DEFAULT_TRAVEL = 2.5;
const DEFAULT_DWELL = 3;
export const MAX_DECK_SLIDES = 512;
export const MAX_SLIDE_SECONDS = 3600;
const MAX_DECK_NAME_LENGTH = 200;
const MAX_SLIDE_NOTE_LENGTH = 2000;
const MAX_VIEW_ID_LENGTH = 500;

export const normalizeSlideSeconds = (value: unknown, fallback: number): number | null => {
  const candidate = value === undefined ? fallback : value;
  return typeof candidate === "number" && Number.isFinite(candidate)
    ? Math.min(MAX_SLIDE_SECONDS, Math.max(0, candidate))
    : null;
};

/** Extension storage is user-editable input, not a trusted Deck instance. */
export function normalizeDeck(value: unknown): Deck {
  const fallback: Deck = { name: "Design review", slides: [] };
  if (typeof value !== "object" || value === null || Array.isArray(value)) return fallback;
  const raw = value as Record<string, unknown>;
  if (typeof raw.name !== "string" || !raw.name.trim()) return fallback;
  const name = raw.name.slice(0, MAX_DECK_NAME_LENGTH);
  if (!Array.isArray(raw.slides)) return { name, slides: [] };
  const slides: Slide[] = [];
  for (const entry of raw.slides.slice(0, MAX_DECK_SLIDES)) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const slide = entry as Record<string, unknown>;
    if (typeof slide.viewId !== "string" || !slide.viewId.trim() || slide.viewId.length > MAX_VIEW_ID_LENGTH) continue;
    if (slide.note !== undefined && typeof slide.note !== "string") continue;
    const travel = normalizeSlideSeconds(slide.travel, DEFAULT_TRAVEL);
    const dwell = normalizeSlideSeconds(slide.dwell, DEFAULT_DWELL);
    if (travel === null || dwell === null) continue;
    slides.push({
      viewId: slide.viewId,
      travel,
      dwell,
      note: typeof slide.note === "string" ? slide.note.slice(0, MAX_SLIDE_NOTE_LENGTH) : "",
    });
  }
  return { name, slides };
}

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  const views = new ViewStore();
  let deck = normalizeDeck(ctx.storage.read<unknown>("deck", { name: "Design review", slides: [] }));
  let playing = false;
  let recording = false;
  let disposed = false;
  let at = -1;
  let playbackController: AbortController | null = null;
  let showController: AbortController | null = null;
  let recordingSession: { stop: Promise<Blob | null> | null } | null = null;

  const list = h("div", { class: "slide-list" });
  const library = h("div", { class: "slide-library" });
  const state = h("div", { class: "status-line" });

  const store = (): void => ctx.storage.write("deck", deck);
  const viewOf = (slide: Slide): ViewDefinition | undefined => views.get(slide.viewId);

  const paint = (): void => {
    const saved = views.list();
    library.replaceChildren(
      h("div", { class: "group-title", text: "Saved views" }),
      ...(saved.length === 0
        ? [note("No saved views yet. Set the model up the way you want it, then save it from the Views pane.")]
        : saved.map((view) => {
            const add = h("button", { class: "filter-row pick grow", type: "button", title: `Add ${view.name}` }, [
              icon("bookmark", 12),
              h("span", { class: "grow", text: view.name }),
              h("span", { class: "n", text: view.folder || "" }),
              icon("plus", 12),
            ]);
            add.addEventListener("click", () => {
              stopPlayback();
              if (deck.slides.length >= MAX_DECK_SLIDES) {
                toast(`A presentation may contain at most ${MAX_DECK_SLIDES} slides`, "error");
                return;
              }
              deck.slides.push({ viewId: view.id, travel: DEFAULT_TRAVEL, dwell: DEFAULT_DWELL, note: "" });
              store();
              paint();
            });
            return add;
          })),
    );

    if (deck.slides.length === 0) {
      list.replaceChildren(emptyState("walk", "No slides yet", "Add saved views from the list below, in the order you want to walk them."));
      return;
    }
    list.replaceChildren(
      ...deck.slides.map((slide, index) => {
        const view = viewOf(slide);
        const title = view?.name ?? "(the view this slide used has been deleted)";
        const up = h("button", { class: "icon-btn sm", type: "button", title: "Move earlier", "aria-label": "Move earlier", text: "↑" });
        up.addEventListener("click", () => {
          if (index === 0) return;
          stopPlayback();
          [deck.slides[index - 1], deck.slides[index]] = [deck.slides[index], deck.slides[index - 1]];
          store();
          paint();
        });
        const down = h("button", { class: "icon-btn sm", type: "button", title: "Move later", "aria-label": "Move later", text: "↓" });
        down.addEventListener("click", () => {
          if (index >= deck.slides.length - 1) return;
          stopPlayback();
          [deck.slides[index + 1], deck.slides[index]] = [deck.slides[index], deck.slides[index + 1]];
          store();
          paint();
        });
        const remove = h("button", { class: "icon-btn sm", type: "button", title: "Remove slide", "aria-label": "Remove slide", text: "×" });
        remove.addEventListener("click", () => {
          stopPlayback();
          deck.slides.splice(index, 1);
          store();
          paint();
        });
        const go = h("button", { class: "slide-go grow", type: "button", title: "Go to this slide" }, [
          view?.thumbnail
            ? h("img", { class: "slide-thumb", src: view.thumbnail, alt: "" })
            : h("span", { class: "slide-thumb blank" }, [icon("bookmark", 14)]),
          h("span", { class: "grow" }, [
            h("b", { text: `${index + 1}. ${title}` }),
            h("small", { text: slide.note || view?.description || "" }),
          ]),
        ]);
        go.addEventListener("click", () => void navigate(index));
        return h("div", { class: `slide-row${index === at ? " active" : ""}${view ? "" : " missing"}` }, [
          go,
          h("label", { class: "plug-field", title: "Seconds to fly here" }, [
            h("span", { text: "fly" }),
            numberField(slide.travel, (value) => {
              const next = normalizeSlideSeconds(value, slide.travel);
              if (next === null) return;
              slide.travel = next;
              store();
            }, 0.5, 0),
          ]),
          h("label", { class: "plug-field", title: "Seconds to hold" }, [
            h("span", { text: "hold" }),
            numberField(slide.dwell, (value) => {
              const next = normalizeSlideSeconds(value, slide.dwell);
              if (next === null) return;
              slide.dwell = next;
              store();
            }, 0.5, 0),
          ]),
          up,
          down,
          remove,
        ]);
      }),
    );
  };

  const cancelShow = (): void => {
    showController?.abort();
    showController = null;
  };

  /** Apply the complete saved view, then fly rather than jump to its camera. */
  const show = async (index: number, fly = true, parentSignal?: AbortSignal): Promise<boolean> => {
    const slide = deck.slides[index];
    if (!slide) return false;
    const view = viewOf(slide);
    if (!view) {
      toast("That slide's view has been deleted", "error");
      return false;
    }

    cancelShow();
    const controller = new AbortController();
    showController = controller;
    const cancelFromParent = (): void => controller.abort(parentSignal?.reason);
    parentSignal?.addEventListener("abort", cancelFromParent, { once: true });
    if (parentSignal?.aborted) cancelFromParent();

    try {
      const from = ctx.view.camera();
      // Everything except the camera lands as one saved-view operation. The
      // camera remains separate because it is the only state worth tweening.
      const report = await ctx.view.applySavedView(view, { camera: false, signal: controller.signal });
      if (controller.signal.aborted || disposed) return false;
      at = index;
      if (report.empty.length) {
        ctx.feedback.log(
          `Slide "${view.name}" applied; ${report.empty.length} filter(s) matched nothing: ${report.empty.join(", ")}`,
          "info",
        );
      }
      const arrived = view.camera && fly && slide.travel > 0
        ? await flyTo(from, view.camera, slide.travel, controller.signal)
        : true;
      if (view.camera && arrived && (!fly || slide.travel <= 0)) ctx.view.setCamera(view.camera);
      if (!controller.signal.aborted && !disposed) paint();
      return arrived && !controller.signal.aborted;
    } catch (error) {
      if (controller.signal.aborted || isAbortError(error)) return false;
      const message = error instanceof Error ? error.message : String(error);
      ctx.feedback.log(`Could not apply slide "${view.name}": ${message}`, "error");
      toast(`Could not apply "${view.name}"`, "error");
      return false;
    } finally {
      parentSignal?.removeEventListener("abort", cancelFromParent);
      if (showController === controller) showController = null;
    }
  };

  /** Ease in and out, so a flight starts and ends without a jolt. */
  const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  const flyTo = (from: CameraPose, to: CameraPose, seconds: number, signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      const start = performance.now();
      let frame: number | null = null;
      let settled = false;
      const finish = (arrived: boolean): void => {
        if (settled) return;
        settled = true;
        if (frame !== null) cancelAnimationFrame(frame);
        signal.removeEventListener("abort", cancel);
        resolve(arrived);
      };
      const cancel = (): void => finish(false);
      const step = (): void => {
        frame = null;
        if (signal.aborted || disposed) return finish(false);
        const t = Math.min(1, (performance.now() - start) / (seconds * 1000));
        const k = ease(t);
        ctx.view.setCamera({
          position: [
            from.position[0] + (to.position[0] - from.position[0]) * k,
            from.position[1] + (to.position[1] - from.position[1]) * k,
            from.position[2] + (to.position[2] - from.position[2]) * k,
          ],
          target: [
            from.target[0] + (to.target[0] - from.target[0]) * k,
            from.target[1] + (to.target[1] - from.target[1]) * k,
            from.target[2] + (to.target[2] - from.target[2]) * k,
          ],
        });
        if (t < 1) frame = requestAnimationFrame(step);
        else finish(true);
      };
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
      else frame = requestAnimationFrame(step);
    });

  const wait = (seconds: number, signal: AbortSignal): Promise<boolean> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (completed: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", cancel);
        resolve(completed);
      };
      const cancel = (): void => finish(false);
      const timer = setTimeout(() => finish(true), Math.max(0, seconds) * 1000);
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    });

  const stopRecording = (session = recordingSession): Promise<Blob | null> => {
    if (!session) return Promise.resolve(null);
    if (!session.stop) {
      try {
        session.stop = ctx.view.recordStop();
      } catch (error) {
        session.stop = Promise.reject(error);
      }
      session.stop = session.stop.finally(() => {
        if (recordingSession !== session) return;
        recordingSession = null;
        recording = false;
        if (!disposed) recordButton.textContent = "Record";
      });
    }
    return session.stop;
  };

  const stopPlayback = (): void => {
    playbackController?.abort();
    cancelShow();
    if (recordingSession) {
      void stopRecording(recordingSession).catch((error: unknown) => {
        if (!disposed) ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      });
    }
  };

  const play = async (): Promise<boolean> => {
    if (playing) {
      stopPlayback();
      return false;
    }
    if (deck.slides.length === 0) {
      toast("Add a slide first", "info");
      return false;
    }
    const controller = new AbortController();
    playbackController = controller;
    playing = true;
    playButton.textContent = "Stop";
    let completed = true;
    try {
      for (let index = 0; index < deck.slides.length; index++) {
        if (controller.signal.aborted || disposed) {
          completed = false;
          break;
        }
        state.textContent = `Slide ${index + 1} of ${deck.slides.length}`;
        if (!(await show(index, index > 0, controller.signal))) {
          completed = false;
          break;
        }
        const slide = deck.slides[index];
        if (!slide || !(await wait(slide.dwell, controller.signal))) {
          completed = false;
          break;
        }
      }
    } finally {
      if (playbackController === controller) playbackController = null;
      playing = false;
      if (!disposed) {
        playButton.textContent = "Play";
        state.textContent = "";
      }
    }
    return completed;
  };

  const record = async (): Promise<void> => {
    if (recording) return void stopPlayback();
    if (playing) return void toast("Stop playback before recording", "info");
    if (deck.slides.length === 0) return void toast("Add a slide first", "info");
    let started = false;
    try {
      started = ctx.view.recordStart(30);
    } catch (error) {
      ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
    }
    if (!started) {
      toast("This browser cannot record the viewport", "error");
      return;
    }
    const session = { stop: null as Promise<Blob | null> | null };
    recordingSession = session;
    recording = true;
    recordButton.textContent = "Recording";
    let blob: Blob | null = null;
    try {
      await play();
    } finally {
      try {
        blob = await stopRecording(session);
      } catch (error) {
        if (!disposed) ctx.feedback.log(error instanceof Error ? error.message : String(error), "error");
      }
    }
    if (disposed) return;
    if (!blob || blob.size === 0) return void toast("Nothing was recorded", "error");
    const url = URL.createObjectURL(blob);
    const link = h("a", { href: url, download: `${safeName(deck.name)}.webm` });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    ctx.feedback.log(`Recorded ${(blob.size / 1e6).toFixed(1)} MB walkthrough`, "success");
  };

  const playButton = button("Play", () => void play(), "accent");
  const recordButton = button("Record", () => recording ? stopPlayback() : void record());

  const navigate = (index: number): void => {
    stopPlayback();
    void show(index);
  };

  const step = (delta: number): void => {
    const next = Math.min(deck.slides.length - 1, Math.max(0, at + delta));
    navigate(next);
  };

  const keys = (event: KeyboardEvent): void => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
    if (event.key === "ArrowRight" || event.key === "PageDown") step(1);
    else if (event.key === "ArrowLeft" || event.key === "PageUp") step(-1);
    else return;
    event.preventDefault();
  };

  const root = page(
    header("Presentation", "Saved views in order, with the camera flying between them."),
    bar(
      playButton,
      recordButton,
      button("Previous", () => step(-1)),
      button("Next", () => step(1)),
      button("Export deck", () =>
        ctx.files.export("presentation.deck", `${safeName(deck.name)}.deck.json`, JSON.stringify(deck, null, 2), "application/json")),
      button("Clear", () => {
        stopPlayback();
        deck = { name: deck.name, slides: [] };
        store();
        paint();
      }),
    ),
    hint("walk", "Arrow keys step through the deck. Recording captures the viewport itself, so whatever plays is what is saved."),
    state,
    list,
    library,
  );

  host.appendChild(root);
  root.addEventListener("keydown", keys);
  paint();
  const offViews = views.onChange(() => {
    if (!disposed) paint();
  });

  const off = ctx.events.on("model", () => {
    stopPlayback();
    at = -1;
    paint();
  });

  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      stopPlayback();
      void stopRecording().catch(() => undefined);
      off();
      offViews();
      root.removeEventListener("keydown", keys);
    },
  };
}

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

const safeName = (name: string): string => name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
