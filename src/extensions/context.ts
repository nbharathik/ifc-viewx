import type {
  ExtensionCapabilities,
  ExtensionContext,
  ExtensionIssueInput,
  ExtensionIssueResult,
} from "../sdk/types.js";
import type {
  CommandContribution,
  ContributionFor,
  ContributionKind,
  ExtensionManifest,
  ExtensionPermission,
} from "../sdk/contributions.js";
import type { HostContext } from "../plugins/runtime/context.js";
import type { ExtensionScope } from "./contributions.js";
import type { ExtensionResultStore } from "./results.js";
import type { ResultHandle } from "../capabilities/results.js";
import { normalizeView, viewNeedsIndex } from "../views/definition.js";

const EXTENSION_STORAGE_VALUE_BYTES = 64 * 1024;
const EXTENSION_STORAGE_TOTAL_BYTES = 256 * 1024;
const EXTENSION_STORAGE_KEYS = 64;

export interface ExtensionRuntimeBindings {
  registerCommand?(contribution: CommandContribution, handler: () => void): () => void;
  results?: ExtensionResultStore;
  onResult?(handle: ResultHandle): void;
  addOverlayLine?(a: [number, number, number], b: [number, number, number]): number;
  removeOverlayLine?(id: number): void;
  openFile?(accepts: readonly string[]): Promise<{ name: string; mimeType: string; text: string }>;
  exportFile?(name: string, data: string, mimeType: string): void;
  createIssue?(input: ExtensionIssueInput): Promise<ExtensionIssueResult>;
}

const capabilityPermissions: Readonly<Record<string, readonly ExtensionPermission[]>> = {
  find: ["model.structure.read"],
  counts: ["model.structure.read"],
  storeys: ["model.structure.read"],
  properties: ["model.properties.read"],
  check: ["model.structure.read", "model.properties.read"],
  schedule: ["model.structure.read", "model.properties.read"],
  ids: ["model.structure.read", "model.properties.read"],
  clash: ["geometry.query"],
  distance: ["geometry.query", "view.control"],
  laser: ["geometry.query", "view.control"],
  sectionContours: ["geometry.query", "view.control"],
  volumes: ["geometry.mesh.read"],
  sun: ["geometry.mesh.read"],
  deviation: ["geometry.mesh.read"],
  setPointCloud: ["view.overlay"],
  modelBox: ["geometry.query"],
  georeferencedToScene: ["view.read"],
  setSun: ["view.control"],
  capture: ["viewport.capture"],
  recordStart: ["viewport.capture"],
  recordStop: ["viewport.capture"],
  search: ["model.structure.read", "model.properties.read"],
  selection: ["view.read"],
  visibility: ["view.read"],
  select: ["view.control"],
  fit: ["view.control"],
  isolate: ["view.control"],
  hide: ["view.control"],
  unhide: ["view.control"],
  show: ["view.control"],
  categories: ["view.control"],
  color: ["view.control"],
  section: ["view.control"],
  sectionBox: ["geometry.query", "view.control"],
  models: ["view.control"],
  camera: ["view.control"],
};

const contributionPermission: Partial<Record<ContributionKind, ExtensionPermission>> = {
  assistantTools: "assistant.contribute",
  overlays: "view.overlay",
  importers: "file.open",
  exporters: "file.export",
  settings: "storage.extension",
};

function linkedSignal(primary: AbortSignal, secondary?: AbortSignal): {
  signal: AbortSignal;
  dispose(): void;
} {
  if (!secondary) return { signal: primary, dispose: () => undefined };
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  primary.addEventListener("abort", abort, { once: true });
  secondary.addEventListener("abort", abort, { once: true });
  if (primary.aborted || secondary.aborted) controller.abort();
  return {
    signal: controller.signal,
    dispose: () => {
      primary.removeEventListener("abort", abort);
      secondary.removeEventListener("abort", abort);
    },
  };
}

export function createExtensionContext(
  manifest: ExtensionManifest,
  host: HostContext,
  scope: ExtensionScope,
  bindings: ExtensionRuntimeBindings = {},
): ExtensionContext {
  const permissions = new Set<ExtensionPermission>(manifest.permissions);
  const resultBindings = new Map<string, () => void>();
  const overlayBindings = new Map<string, () => void>();
  let pickGuideCleanupBound = false;
  const storagePrefix = `ifcviewx.plug.${manifest.id}.`;
  let overlaySequence = 0;
  const requirePermission = (permission: ExtensionPermission): void => {
    if (!permissions.has(permission)) {
      throw new Error(`${manifest.name} requires permission ${permission}`);
    }
  };
  const capabilityAllowed = (id: string, effect: string): boolean => {
    if (effect !== "read" && effect !== "view") return false;
    const required = capabilityPermissions[id];
    return required !== undefined && required.every((permission) => permissions.has(permission));
  };
  const capabilities: ExtensionCapabilities = {
    list: () => host.capabilities.list().filter((capability) => capabilityAllowed(capability.id, capability.effect)),
    execute: async <T,>(id: string, input: Record<string, unknown> = {}, signal?: AbortSignal): Promise<T> => {
      const capability = host.capabilities.list().find((entry) => entry.id === id);
      if (!capability || !capabilityAllowed(capability.id, capability.effect)) {
        throw new Error(`${manifest.name} is not allowed to invoke capability ${id}`);
      }
      const linked = linkedSignal(scope.signal, signal);
      try {
        return await host.capabilities.execute<T>(id, input, linked.signal);
      } finally {
        linked.dispose();
      }
    },
  };

  return {
    manifest,
    signal: scope.signal,
    session: {
      model: () => {
        requirePermission("model.summary.read");
        return host.model();
      },
    },
    model: {
      elements: () => {
        requirePermission("model.structure.read");
        return host.elements();
      },
      classes: () => {
        requirePermission("model.structure.read");
        return host.classes();
      },
      properties: (id) => {
        requirePermission("model.properties.read");
        return host.properties(id);
      },
      tree: () => {
        requirePermission("model.structure.read");
        return host.tree();
      },
      subtree: (id) => {
        requirePermission("model.structure.read");
        return host.subtree(id);
      },
      bounds: (id) => {
        requirePermission("geometry.query");
        return host.bounds(id);
      },
      index: () => {
        requirePermission("model.index.build");
        return host.index();
      },
      modelOf: (id) => {
        requirePermission("model.structure.read");
        return host.modelOf(id);
      },
      expressOf: (id) => {
        requirePermission("model.structure.read");
        return host.expressOf(id);
      },
      scheduleGraph: () => {
        requirePermission("model.structure.read");
        return host.taskGraph();
      },
    },
    geometry: {
      clash: async (a, b, options = {}) => {
        requirePermission("geometry.query");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.clash(a, b, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      distance: async (a, b, options = {}) => {
        requirePermission("geometry.query");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.distance(a, b, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      laser: async (origin, options = {}) => {
        requirePermission("geometry.query");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.laser(origin, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      sectionContours: async (axis, offset, options = {}) => {
        requirePermission("geometry.query");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.sectionContours(axis, offset, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      signatures: async (ids, options = {}) => {
        requirePermission("geometry.query");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.geometrySignatures(ids, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      volumes: async (ids, options = {}) => {
        requirePermission("geometry.mesh.read");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.volumes(ids, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      deviation: async (points, options = {}) => {
        requirePermission("geometry.mesh.read");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.deviation(points, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      sun: async (samples, directions, stepMinutes, options = {}) => {
        requirePermission("geometry.mesh.read");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.sun(samples, directions, stepMinutes, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
    },
    view: {
      select: (ids) => {
        requirePermission("view.control");
        host.select(ids);
      },
      selection: () => {
        requirePermission("view.read");
        return host.selection();
      },
      lastPick: () => {
        requirePermission("view.read");
        return host.lastPick();
      },
      measuring: () => {
        requirePermission("view.read");
        return host.viewer.isMeasuring();
      },
      pickGuide: (on) => {
        requirePermission("view.control");
        if (on && !pickGuideCleanupBound) {
          pickGuideCleanupBound = true;
          scope.onDispose(() => host.setPickGuide(false));
        }
        host.setPickGuide(on);
      },
      isVisible: (id) => {
        requirePermission("view.read");
        return host.isVisible(id);
      },
      rules: () => {
        requirePermission("view.read");
        return host.rules();
      },
      models: () => {
        requirePermission("view.read");
        return host.models();
      },
      setModelVisible: (index, visible) => {
        requirePermission("view.control");
        host.setModelVisible(index, visible);
      },
      categoryVisible: (category) => {
        requirePermission("view.read");
        return host.viewer.isCategoryVisible(category);
      },
      setCategoryVisible: async (category, visible) => {
        requirePermission("view.control");
        await host.viewer.setCategoryVisible(category, visible);
      },
      applySavedView: async (view, options = {}) => {
        const normalized = normalizeView(view);
        if (!normalized) throw new TypeError("Invalid saved-view definition");
        requirePermission("view.read");
        requirePermission("view.control");
        requirePermission("model.structure.read");
        if (viewNeedsIndex(normalized)) requirePermission("model.index.build");
        const linked = linkedSignal(scope.signal, options.signal);
        try {
          return await host.applySavedView(normalized, { ...options, signal: linked.signal });
        } finally {
          linked.dispose();
        }
      },
      isolate: (ids, label) => {
        requirePermission("view.control");
        host.isolate(ids, label);
      },
      hide: (ids) => {
        requirePermission("view.control");
        host.hide(ids);
      },
      showAll: () => {
        requirePermission("view.control");
        host.showAll();
      },
      frame: (id) => {
        requirePermission("view.control");
        host.frame(id);
      },
      frameAt: (point, radius) => {
        requirePermission("view.control");
        host.frameAt(point, radius);
      },
      viewFrom: (view) => {
        requirePermission("view.control");
        host.viewFrom(view);
      },
      camera: () => {
        requirePermission("view.read");
        return host.camera();
      },
      setCamera: (pose) => {
        requirePermission("view.control");
        host.setCamera(pose);
      },
      sections: () => {
        requirePermission("view.read");
        return host.sections();
      },
      setSections: (states) => {
        requirePermission("view.control");
        host.setSections(states);
      },
      sectionBox: () => {
        requirePermission("view.read");
        return host.sectionBox();
      },
      setSectionBox: (box) => {
        requirePermission("view.control");
        host.setSectionBox(box);
      },
      boxAround: (ids, pad) => {
        requirePermission("geometry.query");
        return host.boxAround(ids, pad);
      },
      modelBox: () => {
        requirePermission("geometry.query");
        return host.modelBox();
      },
      georeferencedToScene: (point) => {
        requirePermission("view.read");
        return host.georeferencedToScene(point);
      },
      setSun: (direction) => {
        requirePermission("view.control");
        host.setSun(direction);
      },
      setPointCloud: (positions, colors, size) => {
        requirePermission("view.overlay");
        host.setPointCloud(positions, colors, size);
      },
      setPointCloudSize: (size) => {
        requirePermission("view.overlay");
        host.setPointCloudSize(size);
      },
      setPointCloudVisible: (visible) => {
        requirePermission("view.overlay");
        host.setPointCloudVisible(visible);
      },
      capture: (maxWidth, type, quality) => {
        requirePermission("viewport.capture");
        return host.capture(maxWidth, type, quality);
      },
      recordStart: (fps) => {
        requirePermission("viewport.capture");
        return host.recordStart(fps);
      },
      recordStop: () => {
        requirePermission("viewport.capture");
        return host.recordStop();
      },
      colorBy: (assignment, colors) => {
        requirePermission("view.control");
        host.colorBy(assignment, colors);
      },
      measurements: () => {
        requirePermission("view.read");
        return host.measurements();
      },
      addMeasurement: (a, b) => {
        requirePermission("view.control");
        return host.addMeasurement(a, b);
      },
      removeMeasurement: (id) => {
        requirePermission("view.control");
        host.removeMeasurement(id);
      },
    },
    events: {
      on: (event, handler) => {
        const off = host.on(event, handler);
        scope.onDispose(off);
        return off;
      },
    },
    storage: {
      read: <T,>(key: string, fallback: T): T => {
        requirePermission("storage.extension");
        try {
          const raw = localStorage.getItem(`${storagePrefix}${key}`);
          return raw === null ? fallback : JSON.parse(raw) as T;
        } catch {
          return fallback;
        }
      },
      write: (key, value) => {
        requirePermission("storage.extension");
        const raw = JSON.stringify(value);
        if (raw === undefined) throw new Error("Extension storage values must be JSON serializable");
        const bytes = new TextEncoder().encode(raw).byteLength;
        if (bytes > EXTENSION_STORAGE_VALUE_BYTES) throw new Error("Extension storage values are limited to 64 KB");
        const target = `${storagePrefix}${key}`;
        let count = 0;
        let total = bytes;
        for (let index = 0; index < localStorage.length; index++) {
          const storedKey = localStorage.key(index);
          if (!storedKey?.startsWith(storagePrefix)) continue;
          count += 1;
          if (storedKey !== target) total += new TextEncoder().encode(localStorage.getItem(storedKey) ?? "").byteLength;
        }
        if (localStorage.getItem(target) === null && count >= EXTENSION_STORAGE_KEYS) {
          throw new Error(`Extension storage is limited to ${EXTENSION_STORAGE_KEYS} keys`);
        }
        if (total > EXTENSION_STORAGE_TOTAL_BYTES) throw new Error("Extension storage is limited to 256 KB");
        localStorage.setItem(target, raw);
      },
    },
    feedback: {
      publishFindings: (summary, findings) => host.publishFindings(summary, findings),
      publishResults: (set) => host.publishResults(set),
      log: (text, kind) => host.log(text, kind),
      toast: (text, kind) => host.toast(text, kind),
    },
    commands: {
      run: (id) => {
        const declared = manifest.contributes.commands?.some((command) => command.id === id);
        if (!declared) throw new Error(`${manifest.name} did not declare command ${id}`);
        host.run(id);
      },
      register: (id, handler) => {
        const contribution = manifest.contributes.commands?.find((command) => command.id === id);
        if (!contribution) throw new Error(`${manifest.name} did not declare command ${id}`);
        if (!bindings.registerCommand) throw new Error("This host cannot register extension commands");
        const cleanup = bindings.registerCommand(contribution, handler);
        return scope.bind("commands", id, cleanup);
      },
    },
    capabilities,
    contributions: {
      register: <Kind extends ContributionKind>(
        kind: Kind,
        contribution: ContributionFor<Kind>,
        cleanup?: () => void,
      ): (() => void) => {
        const needed = contributionPermission[kind];
        if (needed) requirePermission(needed);
        const declared = manifest.contributes[kind] as Array<{ id: string }> | undefined;
        if (!declared?.some((entry) => entry.id === contribution.id)) {
          throw new Error(`${manifest.name} did not declare ${kind}:${contribution.id}`);
        }
        return scope.bind(kind, contribution.id, cleanup ?? (() => undefined));
      },
    },
    overlays: {
      line: (overlay, a, b) => {
        requirePermission("view.overlay");
        const declared = manifest.contributes.overlays?.find((entry) => entry.id === overlay);
        if (!declared) throw new Error(`${manifest.name} did not declare overlay ${overlay}`);
        const quota = Math.min(500, Math.max(1, declared.quota ?? 200));
        if (overlayBindings.size >= quota) throw new Error(`${manifest.name} reached its ${quota} overlay primitive limit`);
        if (!bindings.addOverlayLine || !bindings.removeOverlayLine) throw new Error("This host cannot draw extension overlays");
        const measurementId = bindings.addOverlayLine(a, b);
        const handle = `overlay_${++overlaySequence}`;
        const remove = scope.bind("overlays", overlay, () => {
          bindings.removeOverlayLine?.(measurementId);
          overlayBindings.delete(handle);
        });
        overlayBindings.set(handle, remove);
        return handle;
      },
      remove: (id) => {
        const remove = overlayBindings.get(id);
        if (!remove) return false;
        remove();
        return true;
      },
      clear: () => {
        for (const remove of [...overlayBindings.values()]) remove();
      },
    },
    files: {
      open: async (importer) => {
        requirePermission("file.open");
        const declared = manifest.contributes.importers?.find((entry) => entry.id === importer);
        if (!declared) throw new Error(`${manifest.name} did not declare importer ${importer}`);
        if (!bindings.openFile) throw new Error("This host cannot open extension files");
        const opened = await bindings.openFile(declared.accepts);
        if (scope.signal.aborted) throw new DOMException("Extension closed", "AbortError");
        return opened;
      },
      export: (exporter, name, data, mimeType) => {
        requirePermission("file.export");
        const declared = manifest.contributes.exporters?.find((entry) => entry.id === exporter);
        if (!declared) throw new Error(`${manifest.name} did not declare exporter ${exporter}`);
        if (!declared.mimeTypes.includes(mimeType)) throw new Error(`${manifest.name} did not declare MIME type ${mimeType}`);
        if (!bindings.exportFile) throw new Error("This host cannot export extension files");
        bindings.exportFile(name, data, mimeType);
      },
    },
    issues: {
      create: async (input) => {
        requirePermission("review.issue.create");
        requirePermission("viewport.capture");
        if (!bindings.createIssue) throw new Error("This host cannot create review issues");
        return bindings.createIssue(input);
      },
    },
    results: {
      create: (resultView, items, options = {}) => {
        const declared = manifest.contributes.resultViews?.some((view) => view.id === resultView);
        if (!declared) throw new Error(`${manifest.name} did not declare result view ${resultView}`);
        if (!bindings.results) throw new Error("This host cannot store extension results");
        const handle = bindings.results.create(manifest.id, resultView, items, {
          ...options,
          revision: options.revision ?? host.model().key,
        });
        bindings.onResult?.(handle);
        const remove = scope.bind("resultViews", resultView, () => {
          bindings.results?.dispose(manifest.id, handle.id);
          resultBindings.delete(handle.id);
        });
        resultBindings.set(handle.id, remove);
        return handle;
      },
      get: (id) => bindings.results?.get(manifest.id, id) ?? null,
      page: <T,>(id: string, offset = 0, limit = 100) => {
        if (!bindings.results) throw new Error("This host cannot read extension results");
        return bindings.results.page<T>(manifest.id, id, offset, limit);
      },
      dispose: (id) => {
        const remove = resultBindings.get(id);
        if (remove) {
          remove();
          return true;
        }
        return bindings.results?.dispose(manifest.id, id) ?? false;
      },
    },
    local: {
      status: () => {
        requirePermission("local.invoke");
        const companion = manifest.localCompanion;
        if (!companion) throw new Error(`${manifest.name} did not declare a Local Studio companion`);
        const match = host.service.matchCompanion(companion.id, companion.version);
        return {
          state: match.status,
          providerId: companion.id,
          expectedVersion: companion.version,
          ...(match.provider ? { installedVersion: match.provider.version } : {}),
          trustedNative: true as const,
        };
      },
      capabilities: () => {
        requirePermission("local.invoke");
        const companion = manifest.localCompanion;
        if (!companion) throw new Error(`${manifest.name} did not declare a Local Studio companion`);
        const match = host.service.matchCompanion(companion.id, companion.version);
        return match.status === "available"
          ? match.provider.capabilities.filter((entry) => entry.available).map((entry) => entry.id)
          : [];
      },
      invoke: async <T,>(capability: string, input: Record<string, unknown> = {}, signal?: AbortSignal) => {
        requirePermission("local.invoke");
        const companion = manifest.localCompanion;
        if (!companion) throw new Error(`${manifest.name} did not declare a Local Studio companion`);
        const linked = linkedSignal(scope.signal, signal);
        try {
          return await host.service.invokeLocal<T>(
            companion.id,
            companion.version,
            capability,
            input,
            linked.signal,
          );
        } finally {
          linked.dispose();
        }
      },
    },
    python: {
      runsNatively: () => {
        requirePermission("automation.python");
        return host.python.runsNatively();
      },
      query: (code, onStatus) => {
        requirePermission("automation.python");
        return host.python.query(code, onStatus);
      },
      propose: (code, onStatus) => {
        requirePermission("automation.python");
        requirePermission("edit.propose");
        return host.python.propose(code, onStatus);
      },
    },
    close: () => host.close(),
  };
}
