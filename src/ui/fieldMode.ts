// Field mode: the app installed, touch-sized and working with the radio off.
//
// Nothing here changes what the viewer does. It registers the worker that
// makes the shell available offline, keeps the install affordance where the
// user can find it, and reports honestly whether this session is actually
// ready for a basement.
import { h, icon, safeStorageGet, safeStorageSet, toast } from "./kit.js";

export interface InstallPrompt extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

const TOUCH_KEY = "ifcviewx.touch";

export interface FieldState {
  /** The service worker is registered and controlling this page. */
  offlineReady: boolean;
  /** The browser has offered an install prompt we can raise. */
  installable: boolean;
  /** Already running from the home screen or the app list. */
  installed: boolean;
  online: boolean;
}

export class FieldMode {
  private prompt: InstallPrompt | null = null;
  private registration: ServiceWorkerRegistration | null = null;
  private readonly listeners = new Set<(state: FieldState) => void>();

  constructor(private readonly log: (message: string, kind?: "info" | "success" | "error") => void) {
    window.addEventListener("beforeinstallprompt", (event) => {
      event.preventDefault();
      this.prompt = event as InstallPrompt;
      this.emit();
    });
    window.addEventListener("appinstalled", () => {
      this.prompt = null;
      this.log(
        this.state().offlineReady
          ? "IFCViewX installed. Its application shell is ready offline."
          : "IFCViewX installed. Keep it open once while offline setup finishes.",
        "success",
      );
      this.emit();
    });
    window.addEventListener("online", () => this.emit());
    window.addEventListener("offline", () => {
      this.emit();
      toast(
        this.state().offlineReady
          ? "Offline. The application shell is available on this device."
          : "Offline. This tab can continue, but offline reopening is not ready.",
        "info",
      );
    });
    navigator.serviceWorker?.addEventListener("controllerchange", () => this.emit());
    if (safeStorageGet(TOUCH_KEY) === "1") this.setTouch(true);
  }

  /**
   * Register the worker. Deliberately not on a dev server: a cached shell
   * during development hides the change you just made, and the offline story
   * is about a deployed build.
   */
  register(base: string, enabled: boolean): void {
    if (!enabled || !("serviceWorker" in navigator)) return;
    // A page opened from a file:// URL has no origin a worker may claim.
    if (location.protocol !== "http:" && location.protocol !== "https:") return;
    void navigator.serviceWorker
      .register(`${base}sw.js`, { scope: base })
      .then((registration) => {
        this.registration = registration;
        this.emit();
        const announceUpdate = (worker: ServiceWorker | null): void => {
          if (worker?.state === "installed" && navigator.serviceWorker.controller) {
            this.log("A new version of IFCViewX is ready. Close and reopen the app to use it.", "info");
          }
        };
        announceUpdate(registration.waiting);
        registration.addEventListener("updatefound", () => {
          const worker = registration.installing;
          worker?.addEventListener("statechange", () => {
            announceUpdate(worker);
          });
        });
      })
      .catch(() => {
        // An unregisterable worker is not an error worth a toast: everything
        // except the offline story still works.
        this.log("Offline mode is unavailable in this browser", "info");
      });
  }

  state(): FieldState {
    const controller = navigator.serviceWorker?.controller;
    const active = this.registration?.active;
    const navigator_ = navigator as Navigator & { standalone?: boolean };
    return {
      offlineReady: Boolean(active && controller && active.scriptURL === controller.scriptURL),
      installable: this.prompt !== null,
      installed: window.matchMedia?.("(display-mode: standalone)").matches === true || navigator_.standalone === true,
      online: navigator.onLine,
    };
  }

  async install(): Promise<void> {
    if (!this.prompt) {
      toast(
        this.state().installed
          ? "Already installed"
          : "This browser installs from its own menu: look for Install or Add to Home Screen.",
        "info",
      );
      return;
    }
    await this.prompt.prompt();
    const choice = await this.prompt.userChoice;
    if (choice.outcome === "accepted") this.log("Installing IFCViewX", "success");
    this.prompt = null;
    this.emit();
  }

  /** Larger hit targets, so every primary control is reachable with a glove. */
  setTouch(on: boolean): void {
    document.documentElement.classList.toggle("touch-mode", on);
    safeStorageSet(TOUCH_KEY, on ? "1" : "0");
    this.emit();
  }

  isTouch(): boolean {
    return document.documentElement.classList.contains("touch-mode");
  }

  onChange(listener: (state: FieldState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const state = this.state();
    for (const listener of this.listeners) listener(state);
  }

  /** The status-bar chip: what field mode can promise right now. */
  chip(): HTMLElement {
    const label = h("b", { text: "" });
    const button = h("button", { class: "sb-btn", type: "button" }, [icon("walk", 12), label]);
    button.addEventListener("click", () => void this.install());
    const wrap = h("span", { class: "sb-item hidden" }, [button, h("span", { class: "sb-sep" })]);
    const paint = (state: FieldState): void => {
      const text = !state.online
        ? "Offline"
        : state.installed
          ? "Installed"
          : state.installable
            ? "Install"
            : state.offlineReady
              ? "Offline ready"
              : "";
      label.textContent = text;
      button.title = !state.online
        ? state.offlineReady
          ? "No connection. The application shell is available on this device."
          : "No connection. This tab can continue, but offline reopening is not ready."
        : state.installed
          ? "Running as an installed app"
          : state.installable
            ? "Install IFCViewX so it opens from the home screen and works with no connection"
            : "The app shell is cached: this tab opens with no connection";
      wrap.classList.toggle("hidden", text === "");
    };
    this.onChange(paint);
    paint(this.state());
    return wrap;
  }
}
