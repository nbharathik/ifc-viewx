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
  pythonTimeoutS: number;
  readonly: boolean;
  pythonEnabled: boolean;
  app?: boolean;
  /** Present only when the request carried a valid token. */
  store?: StoreStats;
  llm?: { configured: boolean; provider: string; model: string };
  browserConnected?: boolean;
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

/** web: this tab alone. local: this page came from the service. */
export type ServiceMode = "web" | "local";

const injected = (window as { __IFC_SERVICE__?: { token?: string; served?: boolean } })
  .__IFC_SERVICE__;

export class ServiceClient {
  /** Local Studio serves this page, so the service is always same-origin. */
  readonly served = Boolean(injected?.served && injected.token);
  readonly origin = this.served ? location.origin : "";
  private readonly token = this.served ? (injected?.token ?? "") : "";
  private health: ServiceHealth | null = null;
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
    } catch {
      this.health = null;
    }
    return this.health;
  }

  private headers(json = false): HeadersInit {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.token ? { "X-IFC-Token": this.token } : {}),
    };
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${this.origin}${path}`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify(body),
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
    const started = await this.post<{ jobId?: string; status: string; url?: string }>("/convert", {
      sha: this.sha,
    });
    let url = started.url;
    if (started.jobId) {
      // One dropped poll during a multi-minute conversion is not a failure;
      // the job keeps running, so the client keeps asking for a while.
      let misses = 0;
      for (;;) {
        await new Promise((r) => setTimeout(r, 700));
        let res: Response;
        try {
          res = await fetch(`${this.origin}/jobs/${started.jobId}`, { headers: this.headers() });
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
    const res = await fetch(`${this.origin}${url}`);
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

  async fetchEditResult(resultUrl: string): Promise<Uint8Array> {
    const res = await fetch(`${this.origin}${resultUrl}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`Could not download the edited model (HTTP ${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
}
