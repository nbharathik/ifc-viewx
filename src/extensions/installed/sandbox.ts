import type { ExtensionContext, ExtensionInstance, ExtensionModule } from "../../sdk/types.js";
import type { ExtensionManifest } from "../../sdk/contributions.js";
import type { SectionState } from "../../viewer-core/viewer.js";
import type { ExtensionAuditLog } from "./audit.js";

export const SANDBOX_PROTOCOL = 1;
export const SANDBOX_MESSAGE_BYTES = 256 * 1024;
export const SANDBOX_CONCURRENCY = 4;

interface SandboxHooks {
  audit: ExtensionAuditLog;
  onCrash(id: string, reason: string): void;
}

const CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "connect-src 'none'",
  "media-src data: blob:",
  "worker-src 'none'",
  "manifest-src 'none'",
  "child-src 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "navigate-to 'none'",
  "sandbox allow-scripts",
].join("; ");

const BOOTSTRAP = `(() => {
  "use strict";
  const protocol = 1;
  const pending = new Map();
  const listeners = new Map();
  let port = null;
  let sequence = 0;
  let connect;
  const connected = new Promise((resolve) => { connect = resolve; });
  const emit = (name, payload) => {
    for (const listener of listeners.get(name) || []) {
      try { listener(payload); } catch (error) { console.error(error); }
    }
  };
  const call = (method, params = {}) => connected.then(() => new Promise((resolve, reject) => {
    const id = "call_" + (++sequence);
    pending.set(id, { resolve, reject });
    port.postMessage({ protocol, type: "request", id, method, params });
  }));
  const on = (name, listener) => {
    const group = listeners.get(name) || new Set();
    group.add(listener);
    listeners.set(name, group);
    return () => group.delete(listener);
  };
  const api = {
    call,
    on,
    session: { model: () => call("session.model") },
    model: {
      elements: (options) => call("model.elements", options),
      classes: () => call("model.classes"),
      properties: (id) => call("model.properties", { id }),
      bounds: (id) => call("model.bounds", { id })
    },
    geometry: {
      distance: (a, b, options) => call("geometry.distance", { a, b, ...(options || {}) }),
      clash: (a, b, options) => call("geometry.clash", { a, b, ...(options || {}) }),
      laser: (origin, options) => call("geometry.laser", { origin, ...(options || {}) }),
      sectionContours: (axis, offset, options) => call("geometry.sectionContours", { axis, offset, ...(options || {}) }),
      signatures: (ids, options) => call("geometry.signatures", { ids, ...(options || {}) })
    },
    view: {
      selection: () => call("view.selection"),
      lastPick: () => call("view.lastPick"),
      measuring: () => call("view.measuring"),
      pickGuide: (on) => call("view.pickGuide", { on }),
      isVisible: (id) => call("view.isVisible", { id }),
      categoryVisible: (category) => call("view.categoryVisible", { category }),
      setCategoryVisible: (category, visible) => call("view.setCategoryVisible", { category, visible }),
      select: (ids) => call("view.select", { ids }),
      isolate: (ids, label) => call("view.isolate", { ids, label }),
      hide: (ids) => call("view.hide", { ids }),
      showAll: () => call("view.showAll"),
      frame: (id) => call("view.frame", { id }),
      frameAt: (point, radius) => call("view.frameAt", { point, radius }),
      camera: () => call("view.camera"),
      setCamera: (pose) => call("view.setCamera", { pose }),
      sections: () => call("view.sections"),
      setSections: (sections) => call("view.setSections", { sections }),
      measurements: () => call("view.measurements"),
      addMeasurement: (a, b) => call("view.addMeasurement", { a, b }),
      removeMeasurement: (id) => call("view.removeMeasurement", { id })
    },
    storage: {
      read: (key, fallback) => call("storage.read", { key, fallback }),
      write: (key, value) => call("storage.write", { key, value })
    },
    feedback: {
      log: (text, kind) => call("feedback.log", { text, kind }),
      toast: (text, kind) => call("feedback.toast", { text, kind })
    },
    commands: { run: (id) => call("commands.run", { id }) },
    overlays: {
      line: (overlay, a, b) => call("overlays.line", { overlay, a, b }),
      remove: (id) => call("overlays.remove", { id }),
      clear: () => call("overlays.clear")
    },
    results: {
      create: (resultView, items, options) => call("results.create", { resultView, items, options }),
      get: (id) => call("results.get", { id }),
      page: (id, offset, limit) => call("results.page", { id, offset, limit }),
      dispose: (id) => call("results.dispose", { id })
    },
    local: {
      status: () => call("local.status"),
      capabilities: () => call("local.capabilities"),
      invoke: (capability, input) => call("local.invoke", { capability, input: input || {} })
    },
    issues: { create: (input) => call("issues.create", { input }) },
    files: {
      open: (importer) => call("files.open", { importer }),
      export: (exporter, name, data, mimeType) => call("files.export", { exporter, name, data, mimeType })
    }
  };
  window.IFCViewX = { ready: () => connected.then(() => api), call, on, ui: {
    element: (tag, attributes = {}, children = []) => {
      const node = document.createElement(tag);
      for (const [key, value] of Object.entries(attributes)) {
        if (key === "text") node.textContent = String(value);
        else if (key === "class") node.className = String(value);
        else node.setAttribute(key, String(value));
      }
      for (const child of [].concat(children)) node.append(child);
      return node;
    }
  }};
  window.addEventListener("message", (event) => {
    if (event.source !== window.parent || event.data?.type !== "ifcviewx:connect" || event.data?.nonce !== __IFCVIEWX_NONCE__) return;
    const candidate = event.ports && event.ports[0];
    if (!candidate || port) return;
    port = candidate;
    port.onmessage = ({ data }) => {
      if (!data || data.protocol !== protocol) return;
      if (data.type === "event") return emit(data.name, data.payload);
      const request = pending.get(data.id);
      if (!request) return;
      if (data.type === "progress") return emit("progress:" + data.id, data);
      pending.delete(data.id);
      if (data.type === "result") request.resolve(data.value);
      else request.reject(Object.assign(new Error(data.message || "Extension call failed"), { code: data.code }));
    };
    port.start();
    connect(api);
  });
  window.parent.postMessage({ type: "ifcviewx:ready", protocol, nonce: __IFCVIEWX_NONCE__ }, "*");
})();`;

function escapedScript(source: string): string {
  return source.replace(/<\/script/gi, "<\\/script");
}

function designTokens(): string {
  const styles = getComputedStyle(document.documentElement);
  const names = [
    "--bg", "--surface", "--surface-hi", "--fg", "--fg-2", "--fg-3", "--fg-4",
    "--line", "--line-hi", "--hover", "--accent", "--accent-hi", "--accent-soft",
    "--ok", "--warn", "--err", "--mono", "--sans", "--r1", "--r2", "--r3",
  ];
  return names.map((name) => `${name}:${styles.getPropertyValue(name).trim() || "initial"}`).join(";");
}

export function sandboxDocument(html: string, nonce: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("meta[http-equiv='Content-Security-Policy' i]").forEach((node) => node.remove());
  const csp = parsed.createElement("meta");
  csp.httpEquiv = "Content-Security-Policy";
  csp.content = CSP;
  const style = parsed.createElement("style");
  style.textContent = `:root{${designTokens()};color-scheme:light dark}*{box-sizing:border-box}html,body{width:100%;height:100%;margin:0;background:var(--surface);color:var(--fg);font:12px/1.5 var(--sans),system-ui,sans-serif}body{padding:10px}button,input,select{font:inherit;color:inherit}button{min-height:26px;padding:0 9px;border:1px solid var(--line-hi);border-radius:var(--r2);background:var(--surface-hi);cursor:pointer}button:hover{background:var(--hover)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:2px}.ifcx-page{display:flex;flex-direction:column;gap:8px}.ifcx-row{display:flex;align-items:center;gap:6px;flex-wrap:wrap}.ifcx-note{padding:8px;border-left:2px solid var(--accent);background:var(--accent-soft);color:var(--fg-2)}.ifcx-data{font-family:var(--mono),monospace;font-variant-numeric:tabular-nums}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;transition:none!important}}`;
  const bridge = parsed.createElement("script");
  bridge.textContent = escapedScript(BOOTSTRAP.replaceAll("__IFCVIEWX_NONCE__", JSON.stringify(nonce)));
  parsed.head.prepend(bridge);
  parsed.head.prepend(style);
  parsed.head.prepend(csp);
  return `<!doctype html>\n${parsed.documentElement.outerHTML}`;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("params must be an object");
  return value as Record<string, unknown>;
}

function finite(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${name} must be a finite number`);
  return value;
}

function optionalFinite(value: unknown, name: string): number | undefined {
  return value === undefined ? undefined : finite(value, name);
}

function integer(value: unknown, name: string): number {
  const out = finite(value, name);
  if (!Number.isInteger(out)) throw new Error(`${name} must be an integer`);
  return out;
}

function lazyCategory(value: unknown): "IfcSpace" | "IfcOpeningElement" {
  if (value !== "IfcSpace" && value !== "IfcOpeningElement") {
    throw new Error("category must be IfcSpace or IfcOpeningElement");
  }
  return value;
}

function textValue(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || value.length > max) throw new Error(`${name} must be a string under ${max} characters`);
  return value;
}

function ids(value: unknown, name: string, max = 5000): number[] {
  if (!Array.isArray(value) || value.length > max) throw new Error(`${name} must contain at most ${max} ids`);
  return value.map((entry, index) => integer(entry, `${name}[${index}]`));
}

function point(value: unknown, name: string): [number, number, number] {
  if (!Array.isArray(value) || value.length !== 3) throw new Error(`${name} must be a three-number point`);
  return [finite(value[0], `${name}[0]`), finite(value[1], `${name}[1]`), finite(value[2], `${name}[2]`)];
}

function encodedSize(value: unknown): number {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error("message is not JSON serializable");
  return new TextEncoder().encode(json).byteLength;
}

export class SandboxRuntime implements ExtensionInstance {
  private readonly iframe: HTMLIFrameElement;
  private readonly nonce = crypto.randomUUID();
  private readonly controllers = new Map<string, AbortController>();
  private readonly timestamps: number[] = [];
  private readonly seenRequestIds = new Map<string, number>();
  private port: MessagePort | null = null;
  private violations = 0;
  private frameLoads = 0;
  private disposed = false;
  private handshakeTimer = 0;

  constructor(
    host: HTMLElement,
    html: string,
    private readonly manifest: ExtensionManifest,
    private readonly context: ExtensionContext,
    private readonly hooks: SandboxHooks,
    payload?: unknown,
  ) {
    this.iframe = document.createElement("iframe");
    this.iframe.className = "extension-frame";
    this.iframe.title = manifest.name;
    this.iframe.setAttribute("sandbox", "allow-scripts");
    this.iframe.setAttribute("csp", CSP);
    this.iframe.setAttribute("credentialless", "");
    this.iframe.setAttribute(
      "allow",
      "accelerometer 'none'; camera 'none'; clipboard-read 'none'; clipboard-write 'none'; geolocation 'none'; gyroscope 'none'; microphone 'none'; payment 'none'; serial 'none'; usb 'none'",
    );
    this.iframe.setAttribute("referrerpolicy", "no-referrer");
    this.iframe.srcdoc = sandboxDocument(html, this.nonce);
    window.addEventListener("message", this.handshake);
    this.iframe.addEventListener("load", () => {
      this.frameLoads += 1;
      if (this.frameLoads > 1) this.crash("The extension attempted to navigate its sandbox frame");
    });
    this.iframe.addEventListener("error", () => this.crash("The extension frame failed to load"));
    host.appendChild(this.iframe);
    this.handshakeTimer = window.setTimeout(() => this.crash("The extension did not complete its sandbox handshake"), 5000);
    context.signal.addEventListener("abort", () => this.dispose(), { once: true });
    context.events.on("model", () => {
      for (const controller of this.controllers.values()) controller.abort();
      const payload = manifest.permissions.includes("model.summary.read") ? context.session.model() : null;
      this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "model", payload });
    });
    if (manifest.permissions.includes("view.read")) {
      context.events.on("selection", () => this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "selection", payload: context.view.selection() }));
      context.events.on("visibility", () => this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "visibility", payload: null }));
      context.events.on("section", () => this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "section", payload: context.view.sections() }));
      context.events.on("measure", () => this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "measure", payload: context.view.measurements() }));
    }
    if (payload !== undefined) this.activation = payload;
  }

  private activation: unknown;

  receive(payload: unknown): void {
    this.activation = payload;
    this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "activation", payload });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.clearTimeout(this.handshakeTimer);
    window.removeEventListener("message", this.handshake);
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
    this.port?.close();
    this.port = null;
    this.iframe.remove();
  }

  private readonly handshake = (event: MessageEvent): void => {
    if (this.disposed || event.source !== this.iframe.contentWindow) return;
    const data = event.data as { type?: unknown; protocol?: unknown; nonce?: unknown } | null;
    if (!data || data.type !== "ifcviewx:ready" || data.protocol !== SANDBOX_PROTOCOL || data.nonce !== this.nonce) return;
    window.removeEventListener("message", this.handshake);
    window.clearTimeout(this.handshakeTimer);
    const channel = new MessageChannel();
    this.port = channel.port1;
    this.port.onmessage = (message) => void this.receiveMessage(message.data);
    this.port.onmessageerror = () => this.violation("The extension sent an unreadable message");
    this.port.start();
    this.iframe.contentWindow?.postMessage(
      { type: "ifcviewx:connect", protocol: SANDBOX_PROTOCOL, nonce: this.nonce },
      "*",
      [channel.port2],
    );
    this.send({ protocol: SANDBOX_PROTOCOL, type: "event", name: "ready", payload: { extensionId: this.manifest.id } });
    if (this.activation !== undefined) this.receive(this.activation);
  };

  async receiveMessage(value: unknown): Promise<void> {
    if (this.disposed) return;
    let size: number;
    try {
      size = encodedSize(value);
    } catch {
      return this.violation("Messages must be JSON serializable");
    }
    if (size > SANDBOX_MESSAGE_BYTES) return this.violation("The extension sent an oversized message");
    const now = Date.now();
    while (this.timestamps.length && this.timestamps[0] < now - 10_000) this.timestamps.shift();
    for (const [id, seenAt] of this.seenRequestIds) if (seenAt < now - 10_000) this.seenRequestIds.delete(id);
    this.timestamps.push(now);
    if (this.timestamps.length > 120) return this.violation("The extension exceeded its message rate limit");
    if (!value || typeof value !== "object") return this.violation("The extension sent a malformed message");
    const message = value as {
      protocol?: unknown;
      type?: unknown;
      id?: unknown;
      method?: unknown;
      params?: unknown;
    };
    if (message.protocol !== SANDBOX_PROTOCOL || typeof message.id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(message.id)) {
      return this.violation("The extension sent an invalid protocol or request id");
    }
    if (message.type === "cancel") {
      this.controllers.get(message.id)?.abort();
      return;
    }
    if (message.type !== "request" || typeof message.method !== "string" || message.method.length > 80) {
      return this.violation("The extension sent an invalid request");
    }
    if (this.seenRequestIds.has(message.id)) return this.violation("The extension replayed a request id");
    this.seenRequestIds.set(message.id, now);
    if (this.controllers.size >= SANDBOX_CONCURRENCY) {
      return this.error(message.id, "busy", `Only ${SANDBOX_CONCURRENCY} calls may run at once`, true);
    }
    const controller = new AbortController();
    this.controllers.set(message.id, controller);
    try {
      const result = await this.dispatch(message.method, record(message.params ?? {}), controller.signal);
      if (encodedSize(result) > SANDBOX_MESSAGE_BYTES) throw new Error("The result is too large; use paging or a result handle");
      this.send({ protocol: SANDBOX_PROTOCOL, type: "result", id: message.id, value: result ?? null });
      if (this.sensitive(message.method)) {
        this.hooks.audit.record({ extensionId: this.manifest.id, action: message.method, outcome: "allowed" });
      }
    } catch (error) {
      const aborted = error instanceof DOMException && error.name === "AbortError";
      const messageText = error instanceof Error ? error.message : String(error);
      this.error(message.id, aborted ? "aborted" : "denied", messageText, aborted);
      this.hooks.audit.record({ extensionId: this.manifest.id, action: message.method, outcome: aborted ? "failed" : "denied", detail: messageText });
    } finally {
      this.controllers.delete(message.id);
    }
  }

  dispatch(method: string, params: Record<string, unknown>, signal: AbortSignal): unknown | Promise<unknown> {
    switch (method) {
      case "session.model": return this.context.session.model();
      case "model.elements": {
        const offset = Math.max(0, Math.floor(optionalFinite(params.offset, "offset") ?? 0));
        const limit = Math.min(500, Math.max(1, Math.floor(optionalFinite(params.limit, "limit") ?? 100)));
        const elements = this.context.model.elements();
        return { items: elements.slice(offset, offset + limit), total: elements.length, nextOffset: offset + limit < elements.length ? offset + limit : null };
      }
      case "model.classes": return this.context.model.classes();
      case "model.properties": return this.context.model.properties(integer(params.id, "id"));
      case "model.bounds": return this.context.model.bounds(integer(params.id, "id"));
      case "geometry.distance": return this.context.geometry.distance(integer(params.a, "a"), integer(params.b, "b"), {
        maxDistance: optionalFinite(params.maxDistance, "maxDistance"), signal,
      });
      case "geometry.laser": return this.context.geometry.laser(point(params.origin, "origin"), {
        source: params.source === undefined ? undefined : integer(params.source, "source"),
        ids: params.ids === undefined ? undefined : ids(params.ids, "ids"),
        includeHidden: params.includeHidden === true,
        maxDistance: optionalFinite(params.maxDistance, "maxDistance"),
        epsilon: optionalFinite(params.epsilon, "epsilon"),
        signal,
      });
      case "geometry.sectionContours": {
        if (params.axis !== "x" && params.axis !== "y" && params.axis !== "z") {
          throw new Error("axis must be x, y or z");
        }
        return this.context.geometry.sectionContours(params.axis, finite(params.offset, "offset"), {
          ids: params.ids === undefined ? undefined : ids(params.ids, "ids"),
          includeHidden: params.includeHidden === true,
          tolerance: optionalFinite(params.tolerance, "tolerance"),
          maxSegments: Math.min(2500, Math.max(1, Math.floor(optionalFinite(params.maxSegments, "maxSegments") ?? 2500))),
          signal,
        });
      }
      case "geometry.signatures": return this.context.geometry.signatures(ids(params.ids, "ids").slice(0, 500), { signal });
      case "geometry.clash": return this.context.geometry.clash(ids(params.a, "a"), ids(params.b, "b"), {
        toleranceMm: optionalFinite(params.toleranceMm, "toleranceMm"),
        clearanceMm: optionalFinite(params.clearanceMm, "clearanceMm"),
        limit: Math.min(1000, Math.max(1, Math.floor(optionalFinite(params.limit, "limit") ?? 500))),
        signal,
      });
      case "view.selection": return this.context.view.selection();
      case "view.lastPick": return this.context.view.lastPick();
      case "view.measuring": return this.context.view.measuring();
      case "view.pickGuide": this.context.view.pickGuide(params.on === true); return null;
      case "view.isVisible": return this.context.view.isVisible(integer(params.id, "id"));
      case "view.categoryVisible": return this.context.view.categoryVisible(lazyCategory(params.category));
      case "view.setCategoryVisible": {
        if (typeof params.visible !== "boolean") throw new Error("visible must be boolean");
        return this.context.view.setCategoryVisible(lazyCategory(params.category), params.visible).then(() => null);
      }
      case "view.select": this.context.view.select(params.ids === null ? null : ids(params.ids, "ids")); return null;
      case "view.isolate": this.context.view.isolate(ids(params.ids, "ids"), params.label === undefined ? undefined : textValue(params.label, "label", 100)); return null;
      case "view.hide": this.context.view.hide(ids(params.ids, "ids")); return null;
      case "view.showAll": this.context.view.showAll(); return null;
      case "view.frame": this.context.view.frame(params.id === undefined ? undefined : integer(params.id, "id")); return null;
      case "view.frameAt": this.context.view.frameAt(point(params.point, "point"), optionalFinite(params.radius, "radius")); return null;
      case "view.camera": return this.context.view.camera();
      case "view.setCamera": {
        const pose = record(params.pose);
        this.context.view.setCamera({ position: point(pose.position, "pose.position"), target: point(pose.target, "pose.target") });
        return null;
      }
      case "view.sections": return this.context.view.sections();
      case "view.setSections": {
        if (!Array.isArray(params.sections) || params.sections.length > 6) throw new Error("sections must contain at most six planes");
        const sections: SectionState[] = params.sections.map((entry, index) => {
          const value = record(entry);
          if (value.axis !== "x" && value.axis !== "y" && value.axis !== "z") throw new Error(`sections[${index}].axis is invalid`);
          if (typeof value.flip !== "boolean") throw new Error(`sections[${index}].flip must be boolean`);
          const axis = value.axis;
          return { axis, offset: finite(value.offset, `sections[${index}].offset`), flip: value.flip };
        });
        this.context.view.setSections(sections);
        return null;
      }
      case "view.measurements": return this.context.view.measurements();
      case "view.addMeasurement": return this.context.view.addMeasurement(point(params.a, "a"), point(params.b, "b"));
      case "view.removeMeasurement": this.context.view.removeMeasurement(integer(params.id, "id")); return null;
      case "storage.read": return this.context.storage.read(textValue(params.key, "key", 100), params.fallback);
      case "storage.write": {
        const key = textValue(params.key, "key", 100);
        if (encodedSize(params.value) > 64 * 1024) throw new Error("Stored values are limited to 64 KB");
        this.context.storage.write(key, params.value);
        return null;
      }
      case "feedback.log": this.context.feedback.log(textValue(params.text, "text", 1000), this.feedbackKind(params.kind)); return null;
      case "feedback.toast": this.context.feedback.toast(textValue(params.text, "text", 500), this.feedbackKind(params.kind)); return null;
      case "commands.run": this.context.commands.run(textValue(params.id, "id", 100)); return null;
      case "overlays.line": return this.context.overlays.line(textValue(params.overlay, "overlay", 100), point(params.a, "a"), point(params.b, "b"));
      case "overlays.remove": return this.context.overlays.remove(textValue(params.id, "id", 100));
      case "overlays.clear": this.context.overlays.clear(); return null;
      case "results.create": {
        if (!Array.isArray(params.items) || params.items.length > 1000) throw new Error("Result creation is limited to 1,000 rows per call");
        return this.context.results.create(textValue(params.resultView, "resultView", 100), params.items, record(params.options ?? {}));
      }
      case "results.get": return this.context.results.get(textValue(params.id, "id", 100));
      case "results.page": return this.context.results.page(
        textValue(params.id, "id", 100),
        Math.max(0, Math.floor(optionalFinite(params.offset, "offset") ?? 0)),
        Math.min(500, Math.max(1, Math.floor(optionalFinite(params.limit, "limit") ?? 100))),
      );
      case "results.dispose": return this.context.results.dispose(textValue(params.id, "id", 100));
      case "local.status": return this.context.local.status();
      case "local.capabilities": return this.context.local.capabilities();
      case "local.invoke": {
        const input = record(params.input ?? {});
        if (encodedSize(input) > SANDBOX_MESSAGE_BYTES) throw new Error("Local provider input is too large");
        return this.context.local.invoke(
          textValue(params.capability, "capability", 160),
          input,
          signal,
        );
      }
      case "issues.create": {
        const input = record(params.input);
        if (encodedSize(input) > 16 * 1024) throw new Error("Issue input is limited to 16 KB");
        const metadata = input.metadata === undefined ? undefined : record(input.metadata);
        if (metadata && Object.keys(metadata).length > 24) throw new Error("Issue metadata is limited to 24 fields");
        for (const [key, value] of Object.entries(metadata ?? {})) {
          textValue(key, "metadata key", 80);
          if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
            throw new Error(`metadata.${key} must be a string, number, or boolean`);
          }
        }
        const priority = input.priority;
        if (priority !== undefined && !["Low", "Normal", "High", "Critical"].includes(String(priority))) {
          throw new Error("priority must be Low, Normal, High, or Critical");
        }
        return this.context.issues.create({
          title: textValue(input.title, "title", 160),
          description: input.description === undefined ? undefined : textValue(input.description, "description", 4000),
          elementIds: input.elementIds === undefined ? undefined : ids(input.elementIds, "elementIds", 200),
          point: input.point === undefined ? undefined : point(input.point, "point"),
          priority: priority as "Low" | "Normal" | "High" | "Critical" | undefined,
          metadata: metadata as Record<string, string | number | boolean> | undefined,
        });
      }
      case "files.open": return this.context.files.open(textValue(params.importer, "importer", 100));
      case "files.export": {
        const name = textValue(params.name, "name", 160);
        if (/[/\\]/.test(name)) throw new Error("Export names cannot contain a path");
        const data = textValue(params.data, "data", SANDBOX_MESSAGE_BYTES);
        this.context.files.export(
          textValue(params.exporter, "exporter", 100), name, data, textValue(params.mimeType, "mimeType", 100),
        );
        return null;
      }
      default: throw new Error(`Unknown extension method ${method}`);
    }
  }

  private feedbackKind(value: unknown): "info" | "success" | "error" | undefined {
    if (value === undefined) return undefined;
    if (value !== "info" && value !== "success" && value !== "error") throw new Error("kind must be info, success, or error");
    return value;
  }

  private sensitive(method: string): boolean {
    return method.startsWith("view.") || method.startsWith("overlays.") || method.startsWith("local.") || method.startsWith("issues.") || method === "storage.write" || method.startsWith("files.");
  }

  private violation(reason: string): void {
    this.violations += 1;
    this.hooks.audit.record({ extensionId: this.manifest.id, action: "protocol", outcome: "denied", detail: reason });
    if (this.violations >= 3) this.crash(`Disabled after repeated protocol violations: ${reason}`);
  }

  private crash(reason: string): void {
    if (this.disposed) return;
    this.hooks.audit.record({ extensionId: this.manifest.id, action: "runtime", outcome: "failed", detail: reason });
    this.dispose();
    this.hooks.onCrash(this.manifest.id, reason);
  }

  private error(id: string, code: string, message: string, retryable = false): void {
    this.send({ protocol: SANDBOX_PROTOCOL, type: "error", id, code, message, retryable });
  }

  private send(message: Record<string, unknown>): void {
    if (!this.port || this.disposed) return;
    try {
      if (encodedSize(message) <= SANDBOX_MESSAGE_BYTES) this.port.postMessage(message);
    } catch {
      this.violation("The host could not serialize an extension message");
    }
  }
}

export function sandboxExtensionModule(
  html: string,
  manifest: ExtensionManifest,
  hooks: SandboxHooks,
): ExtensionModule {
  return {
    mount: (host, context, payload) => new SandboxRuntime(host, html, manifest, context, hooks, payload),
  };
}
