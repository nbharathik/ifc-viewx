// Client for the local service (the ifcviewx package).
//
// Two studios, and they are separate apps. Web Studio is this tab alone. Local
// Studio is the ifcviewx package: it serves its own copy of this viewer from
// 127.0.0.1 and adds conversion, native IfcOpenShell and the MCP bridge.
//
// The client only ever talks to the service that served this page. A hosted
// page never reaches your machine: it does not probe loopback, it holds no
// token, and there is nothing to paste. Not served by the service means Web
// Studio, and every call below is inert.

import type { ChatMessage, ChatOptions, TurnResult } from "../llm/llmClient.js";
import type { NativeTool } from "../llm/tools.js";
import { compareNumericVersion, compatibleUpperBound, parseNumericVersion } from "../sdk/semver.js";

export interface StoreStats {
  dir: string;
  files: number;
  bytes: number;
  quotaBytes: number;
  freeBytes: number;
  pendingResults: number;
}

export interface ServiceHealth {
  version: string;
  capabilities: string[];
  providerApi?: { min: number; max: number };
  pythonTimeoutS: number;
  readonly: boolean;
  pythonEnabled: boolean;
  app?: boolean;
  /** Present only when the request carried a valid token. */
  store?: StoreStats;
  llm?: { configured: boolean; provider: string; model: string; multimodal?: boolean };
  browserConnected?: boolean;
  /** Where the service keeps things, so the viewer can name it exactly. */
  paths?: { store: string; state: string; audit: string; keySource: string };
}

export interface PythonOutcome {
  error?: string;
  message?: string;
  violations?: string[];
  stdout?: string;
  resultJson?: string;
  summary?: string;
  affectedGuids?: string[];
  entityCountBefore?: number;
  entityCountAfter?: number;
  resultUrl?: string;
  diff?: EditDiff;
}

export interface EditDiff {
  added: number;
  removed: number;
  modified: number;
  addedSample?: Array<{ globalId: string; type?: string; name?: string }>;
  modifiedSample?: Array<{ globalId: string; type?: string; name?: string }>;
}

export interface LocalProviderCapability {
  id: string;
  title: string;
  description: string;
  effect: "read" | "compute" | "staged-write";
  modelRequirement: "none" | "ifc-source";
  available: boolean;
  unavailableReason?: string;
  inputSchema: Record<string, unknown>;
  resultSchema: Record<string, unknown>;
  timeoutSeconds?: number;
}

export interface LocalProvider {
  schemaVersion: 1;
  id: string;
  version: string;
  name: string;
  description: string;
  source: string;
  trust: "trusted-native";
  limits: {
    maxConcurrency: number;
    timeoutSeconds: number;
    memoryBytes: number;
    resultTtlSeconds: number;
  };
  capabilities: LocalProviderCapability[];
}

export interface LocalJobProgress {
  phase: string;
  done: number;
  total: number;
  message: string;
  partialResultHandle?: string;
}

export interface LocalJob {
  schemaVersion: 1;
  id: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  providerId: string;
  providerVersion: string;
  capabilityId: string;
  modelSha?: string | null;
  progress: LocalJobProgress;
  resultAvailable: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
}

export type LocalCompanionMatch =
  | { status: "available"; provider: LocalProvider }
  | { status: "offline" | "missing" | "incompatible"; provider?: LocalProvider };

export function satisfiesVersionRange(version: string, range: string): boolean | null {
  const current = parseNumericVersion(version.split(/[+-]/, 1)[0]);
  if (!current || !range.trim() || range.includes("||")) return null;
  for (const token of range.replaceAll(",", " ").trim().split(/\s+/)) {
    if (token === "*" || token.toLowerCase() === "x") continue;
    const wildcard = /^(\d+)\.(?:x|\*)$/i.exec(token);
    if (wildcard) {
      if (current[0] !== Number(wildcard[1])) return false;
      continue;
    }
    const ranged = /^(\^|~)(\d+(?:\.\d+){0,2})$/.exec(token);
    if (ranged) {
      const base = parseNumericVersion(ranged[2]);
      if (!base) return null;
      const upper = compatibleUpperBound(ranged[1] as "^" | "~", ranged[2], base);
      if (compareNumericVersion(current, base) < 0 || compareNumericVersion(current, upper) >= 0) return false;
      continue;
    }
    const compared = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/.exec(token);
    if (!compared) return null;
    const target = parseNumericVersion(compared[2]);
    if (!target) return null;
    const relation = compareNumericVersion(current, target);
    const operator = compared[1];
    const matches = !operator && compared[2].split(".").length === 1
      ? current[0] === target[0]
      : !operator || operator === "="
        ? relation === 0
        : operator === ">="
          ? relation >= 0
          : operator === "<="
            ? relation <= 0
            : operator === ">"
              ? relation > 0
              : relation < 0;
    if (!matches) return false;
  }
  return true;
}

/** web: this tab alone. local: this page came from the service. */
export type ServiceMode = "web" | "local";

const injected = (window as { __IFC_SERVICE__?: { token?: string; served?: boolean } })
  .__IFC_SERVICE__;

const isEventRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export class ServiceClient {
  /** Local Studio serves this page, so the service is always same-origin. */
  readonly served = Boolean(injected?.served && injected.token);
  readonly origin = this.served ? location.origin : "";
  private readonly token = this.served ? (injected?.token ?? "") : "";
  private health: ServiceHealth | null = null;
  private providers: LocalProvider[] = [];
  /** sha of the model this service holds for the current session. */
  private sha: string | null = null;

  getToken(): string {
    return this.token;
  }

  isAvailable(): boolean {
    return this.health !== null;
  }

  /** The one call the UI needs to decide what to show. */
  mode(): ServiceMode {
    return this.health ? "local" : "web";
  }

  getHealth(): ServiceHealth | null {
    return this.health;
  }

  getProviders(): readonly LocalProvider[] {
    return this.providers;
  }

  matchCompanion(id: string, versionRange: string): LocalCompanionMatch {
    if (this.mode() !== "local") return { status: "offline" };
    const provider = this.providers.find((entry) => entry.id === id);
    if (!provider) return { status: "missing" };
    return satisfiesVersionRange(provider.version, versionRange) === true
      ? { status: "available", provider }
      : { status: "incompatible", provider };
  }

  can(capability: string): boolean {
    return this.health?.capabilities.includes(capability) ?? false;
  }

  /** True once an IFC has been handed to the service this session. */
  hasModel(): boolean {
    return this.sha !== null;
  }

  getSha(): string | null {
    return this.sha;
  }

  forgetModel(): void {
    this.sha = null;
  }

  /**
   * Point the session back at a model the service already holds. Used after
   * conversion: the viewer now shows the .ifcx, but native Python and checks
   * still run against the .ifc source stored under this hash.
   */
  adoptModel(sha: string): void {
    this.sha = sha;
  }

  /** True when Python will run natively rather than in this tab. */
  runsNatively(): boolean {
    return this.mode() === "local" && this.can("python") && this.hasModel();
  }

  /** True when the service holds a provider key, so no key is needed here. */
  proxiesLlm(): boolean {
    return this.mode() === "local" && this.can("llm") && Boolean(this.health?.llm?.configured);
  }

  /**
   * Where Local Studio keeps its files, reported by the service itself rather
   * than guessed from a convention, so the privacy panel can print a path the
   * user can actually paste into a file manager. Null in the browser, which is
   * the honest answer: there is no folder.
   */
  storagePaths(): { store?: string; state?: string; audit?: string; keySource?: string } | null {
    const paths = this.health?.paths;
    return paths ? { ...paths } : null;
  }

  /** Ask the service to show one of its own folders in the file manager. */
  async revealFolder(which: "store" | "state"): Promise<void> {
    await this.post<{ ok: boolean }>("/store/reveal", { which });
  }

  /**
   * Ask the service what it can do. Same-origin only: a hosted page returns
   * "web" here without a single request, which is what keeps the two studios
   * genuinely separate rather than separate-by-default.
   */
  async probe(): Promise<ServiceHealth | null> {
    if (!this.served) return null;
    try {
      const res = await fetch(`${this.origin}/health`, {
        headers: this.headers(),
        signal: AbortSignal.timeout(1500),
      });
      // `store` only comes back when the injected token was accepted.
      const health = res.ok ? ((await res.json()) as ServiceHealth) : null;
      this.health = health?.store ? health : null;
      this.providers = [];
      if (this.health?.providerApi && this.health.providerApi.min <= 1 && this.health.providerApi.max >= 1) {
        try {
          const providers = await fetch(`${this.origin}/api/v1/providers`, {
            headers: this.headers(),
            signal: AbortSignal.timeout(1500),
          });
          if (providers.ok) {
            const listing = await providers.json() as { providers?: LocalProvider[] };
            this.providers = Array.isArray(listing.providers) ? listing.providers : [];
          }
        } catch {
          this.providers = [];
        }
      }
    } catch {
      this.health = null;
      this.providers = [];
    }
    return this.health;
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.token ? { "X-IFC-Token": this.token } : {}),
    };
  }

  private async post<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
      signal,
    });
    if (res.status === 401) throw new Error("This tab's session token is stale; reload the page.");
    if (res.status === 429) throw new Error("Too many failed attempts; wait a moment and retry.");
    // A gateway error page is not JSON, and a 4xx body that happens to parse
    // would otherwise be handed back as if the call had succeeded.
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`${path} answered HTTP ${res.status} with a body that is not JSON.`);
    }
    if (!res.ok) {
      const detail = (data as { message?: string; error?: string } | null)?.message
        ?? (data as { error?: string } | null)?.error;
      throw new Error(detail ?? `${path} failed (HTTP ${res.status}).`);
    }
    return data as T;
  }

  private async get<T>(path: string, signal?: AbortSignal): Promise<T> {
    const res = await fetch(`${this.origin}${path}`, { headers: this.headers(), signal });
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      throw new Error(`${path} answered HTTP ${res.status} with a body that is not JSON.`);
    }
    if (!res.ok) {
      const detail = (data as { message?: string; error?: string } | null)?.message
        ?? (data as { error?: string } | null)?.error;
      throw new Error(detail ?? `${path} failed (HTTP ${res.status}).`);
    }
    return data as T;
  }

  async startLocalJob(
    providerId: string,
    providerVersion: string,
    capabilityId: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
  ): Promise<LocalJob> {
    if (this.mode() !== "local") throw new Error("Local Studio is not available.");
    return this.post<LocalJob>("/api/v1/jobs", {
      providerId,
      providerVersion,
      capabilityId,
      input,
      ...(this.sha ? { modelSha: this.sha } : {}),
    }, signal);
  }

  async getLocalJob(jobId: string, signal?: AbortSignal): Promise<LocalJob> {
    return this.get<LocalJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}`, signal);
  }

  async cancelLocalJob(jobId: string, signal?: AbortSignal): Promise<LocalJob> {
    return this.post<LocalJob>(`/api/v1/jobs/${encodeURIComponent(jobId)}/cancel`, {}, signal);
  }

  async getLocalJobResult<T>(jobId: string, signal?: AbortSignal): Promise<T> {
    const result = await this.get<{ schemaVersion: 1; value: T }>(
      `/api/v1/jobs/${encodeURIComponent(jobId)}/result`,
      signal,
    );
    return result.value;
  }

  async invokeLocal<T>(
    providerId: string,
    providerVersion: string,
    capabilityId: string,
    input: Record<string, unknown> = {},
    signal?: AbortSignal,
    onProgress?: (progress: LocalJobProgress) => void,
  ): Promise<T> {
    const match = this.matchCompanion(providerId, providerVersion);
    if (match.status !== "available") {
      if (match.status === "incompatible") {
        throw new Error(`Installed ${providerId} ${match.provider?.version ?? "unknown"} does not match ${providerVersion}.`);
      }
      throw new Error(match.status === "missing" ? `Local provider ${providerId} is not installed.` : "Local Studio is not available.");
    }
    const capability = match.provider.capabilities.find((item) => item.id === capabilityId);
    const timeoutSeconds = capability?.timeoutSeconds ?? match.provider.limits?.timeoutSeconds ?? 900;
    const deadline = new AbortController();
    const timeout = window.setTimeout(
      () => deadline.abort(new DOMException("Local provider deadline reached", "TimeoutError")),
      (Math.max(1, timeoutSeconds) + 30) * 1000,
    );
    const callerAborted = (): void => deadline.abort(signal?.reason);
    if (signal?.aborted) callerAborted();
    else signal?.addEventListener("abort", callerAborted, { once: true });
    let job: LocalJob | null = null;
    const cancelAndThrow = async (): Promise<never> => {
      if (job) await this.cancelLocalJob(job.id, AbortSignal.timeout(5000)).catch(() => undefined);
      if (signal?.aborted) throw new DOMException("Local provider job cancelled", "AbortError");
      throw new Error(`Local provider job exceeded its ${timeoutSeconds}-second deadline.`);
    };
    try {
      job = await this.startLocalJob(providerId, providerVersion, capabilityId, input, deadline.signal);
      for (;;) {
        if (deadline.signal.aborted) return cancelAndThrow();
        onProgress?.(job.progress);
        if (job.status === "succeeded") return this.getLocalJobResult<T>(job.id, deadline.signal);
        if (job.status === "failed") throw new Error(job.error?.message ?? "Local provider job failed.");
        if (job.status === "cancelled") throw new DOMException("Local provider job cancelled", "AbortError");
        await new Promise<void>((resolve) => {
          const aborted = (): void => {
            window.clearTimeout(wait);
            resolve();
          };
          const wait = window.setTimeout(() => {
            deadline.signal.removeEventListener("abort", aborted);
            resolve();
          }, 350);
          deadline.signal.addEventListener("abort", aborted, { once: true });
        });
        if (deadline.signal.aborted) return cancelAndThrow();
        job = await this.getLocalJob(job.id, deadline.signal);
      }
    } catch (error) {
      if (deadline.signal.aborted) return cancelAndThrow();
      throw error;
    } finally {
      window.clearTimeout(timeout);
      signal?.removeEventListener("abort", callerAborted);
    }
  }

  /** Upload once per model; the service stores it by content hash. */
  async uploadModel(bytes: Uint8Array, name: string): Promise<{ sha: string; converted: boolean }> {
    const form = new FormData();
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>]), name);
    const res = await fetch(`${this.origin}/model`, {
      method: "POST",
      headers: this.headers(),
      body: form,
    });
    if (res.status === 401) throw new Error("This tab's session token is stale; reload the page.");
    const data = (await res.json()) as { sha?: string; converted: boolean; message?: string };
    if (!res.ok || !data.sha) throw new Error(data.message ?? `Upload failed (HTTP ${res.status}).`);
    this.sha = data.sha;
    return { sha: data.sha, converted: data.converted };
  }

  /**
   * Convert with IfcOpenShell and return the .ifcx bytes. Polls the job so the
   * caller can show real progress; conversion of a large model takes minutes.
   */
  async convert(onProgress?: (text: string, percent: number) => void): Promise<Uint8Array> {
    if (!this.sha) throw new Error("Upload a model first.");
    const capability = this.providers
      .find((provider) => provider.id === "org.ifcviewx.core")
      ?.capabilities.find((item) => item.id === "ifc.convert");
    const deadline = Date.now() + ((capability?.timeoutSeconds ?? 900) + 30) * 1000;
    const started = await this.post<{ jobId?: string; status: string; url?: string }>("/convert", {
      sha: this.sha,
    }, AbortSignal.timeout(30_000));
    let url = started.url;
    if (started.jobId) {
      // One dropped poll during a multi-minute conversion is not a failure;
      // the job keeps running, so the client keeps asking for a while.
      let misses = 0;
      for (;;) {
        if (Date.now() >= deadline) {
          await this.post(`/jobs/${started.jobId}/cancel`, {}, AbortSignal.timeout(5000)).catch(() => undefined);
          throw new Error("Conversion exceeded its Local Studio deadline.");
        }
        await new Promise((r) => setTimeout(r, 700));
        let res: Response;
        try {
          res = await fetch(`${this.origin}/jobs/${started.jobId}`, {
            headers: this.headers(),
            signal: AbortSignal.timeout(15_000),
          });
        } catch {
          if (++misses > 8) throw new Error("Lost contact with the local service during conversion.");
          continue;
        }
        if (!res.ok) {
          throw new Error(
            res.status === 404
              ? "The service no longer knows this conversion job (it may have restarted); reopen the model and convert again."
              : `Job status failed (HTTP ${res.status}).`,
          );
        }
        misses = 0;
        const job = (await res.json()) as {
          status: string;
          url?: string;
          error?: string;
          percent?: number;
          meshes?: number;
        };
        if (job.status === "error") throw new Error(job.error ?? "Conversion failed.");
        if (job.status === "cancelled") throw new Error("Conversion cancelled.");
        if (job.status === "done") {
          url = job.url;
          break;
        }
        if (job.status !== "queued" && job.status !== "running") {
          throw new Error(`Unexpected job status: ${job.status}`);
        }
        const percent = job.percent ?? 0;
        onProgress?.(`Converting with IfcOpenShell · ${percent}%`, percent);
      }
    }
    if (!url) throw new Error("Conversion produced no output.");
    const res = await fetch(`${this.origin}${url}`, { signal: AbortSignal.timeout(300_000) });
    if (!res.ok) throw new Error(`Could not download the converted model (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** Run guarded IfcOpenShell code natively. Errors come back in the payload. */
  async runPython(code: string, mode: "query" | "edit"): Promise<PythonOutcome> {
    if (!this.sha) throw new Error("The local service does not have this model yet.");
    return this.post<PythonOutcome>("/python", { sha: this.sha, code, mode });
  }

  /** Assistant turn through the service, so the provider key stays there. */
  async chat(messages: Array<{ role: string; content: string }>, model?: string): Promise<string> {
    const outcome = await this.post<{ content?: string; error?: string; message?: string }>(
      "/llm/chat",
      { messages, model },
    );
    if (outcome.error) throw new Error(outcome.message ?? outcome.error);
    if (!outcome.content) throw new Error("The assistant returned an empty response.");
    return outcome.content;
  }

  /** Native assistant turn through Local Studio, normalized from its SSE stream. */
  async converse(
    messages: ChatMessage[],
    tools: NativeTool[],
    signal?: AbortSignal,
    options: ChatOptions = {},
  ): Promise<TurnResult> {
    const response = await fetch(`${this.origin}/llm/stream`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ messages, tools }),
      signal,
    });
    if (response.status === 401) throw new Error("This tab's session token is stale; reload the page.");
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(detail || `Local assistant failed (HTTP ${response.status})`);
    }
    if (!response.body) throw new Error("Local Studio sent no assistant stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let buffer = "";
    let text = "";
    let calls: TurnResult["calls"] = [];
    let toolsUsed = tools.length === 0;
    let completed = false;
    const consume = (payload: string): void => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload) as unknown;
      } catch {
        throw new Error("Local Studio sent a malformed assistant stream event");
      }
      if (!isEventRecord(parsed) || typeof parsed.type !== "string") {
        throw new Error("Local Studio sent a malformed assistant stream event");
      }
      if (completed) throw new Error("Local Studio sent data after the final assistant event");
      const event = parsed as {
        type?: string;
        delta?: string;
        call?: TurnResult["calls"][number];
        usage?: { input?: number; output?: number };
        text?: string;
        calls?: TurnResult["calls"];
        toolsUsed?: boolean;
        message?: string;
      };
      if (event.type === "text_delta" && event.delta) {
        text += event.delta;
        options.onDelta?.(event.delta);
      } else if (event.type === "tool_call" && event.call) calls.push(event.call);
      else if (event.type === "usage" && event.usage) {
        options.onUsage?.({ input: Number(event.usage.input) || 0, output: Number(event.usage.output) || 0 });
      } else if (event.type === "done") {
        if (!text && event.text) text = event.text;
        if (calls.length === 0 && event.calls) calls = event.calls;
        if (typeof event.toolsUsed === "boolean") toolsUsed = event.toolsUsed;
        completed = true;
      } else if (event.type === "error") throw new Error(event.message ?? "The local assistant stream failed");
    };
    const drain = (): void => {
      let split = /\r?\n\r?\n/.exec(buffer);
      while (split) {
        const raw = buffer.slice(0, split.index);
        buffer = buffer.slice(split.index + split[0].length);
        const data = raw.split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart());
        if (data.length) consume(data.join("\n").trim());
        split = /\r?\n\r?\n/.exec(buffer);
      }
    };
    const decode = (value?: Uint8Array, stream = false): string => {
      try {
        return decoder.decode(value, { stream });
      } catch {
        throw new Error("Local Studio sent invalid UTF-8 in the assistant stream");
      }
    };
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buffer += decode(chunk.value, true);
        drain();
      }
      buffer += decode();
      drain();
      if (buffer.trim()) throw new Error("Local Studio assistant stream ended in a partial event");
      if (!completed) throw new Error("Local Studio assistant stream ended before its final event");
    } finally {
      reader.releaseLock();
    }
    return { text, calls, toolsUsed };
  }

  async fetchEditResult(resultUrl: string): Promise<Uint8Array> {
    const res = await fetch(`${this.origin}${resultUrl}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Could not download the edited model (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
