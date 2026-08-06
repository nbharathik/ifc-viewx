// What a running plugin is handed.
//
// The helpers are the whole point: a panel that only calls these keeps working
// when core moves, and the subscriptions it makes are released for it when it
// closes, so a plugin cannot leak a listener into the viewer.
import { toast } from "../../ui/kit.js";
import { classCounts, type PropertyIndex } from "../../sdk/data.js";
import { modelElements } from "../../llm/actions.js";
import type {
  PluginContext,
  PluginEvent,
  PluginManifest,
  PluginPython,
} from "../../sdk/types.js";
import type { Viewer } from "../../viewer-core/viewer.js";
import type { ServiceClient } from "../../bridge/serviceClient.js";

export interface ContextDeps {
  viewer: Viewer;
  service: ServiceClient;
  python: PluginPython;
  index(): PropertyIndex;
  modelKey(): string;
  modelName(): string;
  log(text: string, kind?: "info" | "success" | "error"): void;
  runCommand(id: string): void;
  close(id: string): void;
  /** Model and service changes reach the host first; the viewer owns the rest. */
  hostEvent(event: "model" | "service", handler: () => void): () => void;
}

export interface ScopedContext {
  ctx: PluginContext;
  /** Drops every subscription the plugin made through `on`. */
  release(): void;
}

export function createContext(manifest: PluginManifest, deps: ContextDeps): ScopedContext {
  const bag: Array<() => void> = [];
  const scope = (key: string): string => `ifcviewx.plug.${manifest.id}.${key}`;
  const { viewer } = deps;

  const subscribe = (event: PluginEvent, handler: () => void): (() => void) => {
    switch (event) {
      case "selection":
        return viewer.onSelectionChange(() => handler());
      case "visibility":
        return viewer.onVisibilityChange(handler);
      case "section":
        return viewer.onSectionChange(handler);
      case "measure":
        return viewer.onMeasureChange(handler);
      default:
        return deps.hostEvent(event, handler);
    }
  };

  const ctx: PluginContext = {
    viewer,
    service: deps.service,
    python: deps.python,

    model: () => ({ key: deps.modelKey(), name: deps.modelName(), loaded: deps.modelKey() !== "" }),

    elements: () => modelElements(viewer),
    classes: () => classCounts(modelElements(viewer)),
    index: () => deps.index(),
    properties: (expressID) => viewer.getProperties(expressID),
    tree: () => viewer.getSpatialTree(),
    subtree: (expressID) => viewer.getSubtreeElementIds(expressID),
    bounds: (expressID) => viewer.getElementBounds(expressID),

    select: (ids) => {
      if (ids === null) viewer.clearSelection();
      else if (typeof ids === "number") viewer.select(ids);
      else viewer.selectMany(ids);
    },
    selection: () => viewer.getSelectedIds(),
    isolate: (ids, label) => viewer.isolate(ids, label),
    hide: (ids) => viewer.setHidden(ids, true),
    showAll: () => viewer.showAll(),
    frame: (expressID) => {
      if (expressID === undefined) viewer.fitToModel();
      else viewer.fitToElement(expressID);
    },
    viewFrom: (view) => viewer.viewFrom(view),
    sections: () => viewer.getSections(),
    setSections: (states) => viewer.setSections(states),

    on: (event, handler) => void bag.push(subscribe(event, handler)),
    log: (text, kind) => deps.log(text, kind),
    toast: (text, kind) => toast(text, kind),
    run: (commandId) => deps.runCommand(commandId),

    read: <T,>(key: string, fallback: T): T => {
      try {
        const raw = localStorage.getItem(scope(key));
        return raw === null ? fallback : (JSON.parse(raw) as T);
      } catch {
        return fallback;
      }
    },
    write: (key, value) => {
      try {
        localStorage.setItem(scope(key), JSON.stringify(value));
      } catch {
        deps.log(`${manifest.name} could not save its state (storage is full)`, "error");
      }
    },
    close: () => deps.close(manifest.id),
  };

  return {
    ctx,
    release: () => {
      for (const off of bag.splice(0)) {
        try {
          off();
        } catch {
          // an unsubscribe that throws must not keep the rest subscribed
        }
      }
    },
  };
}
