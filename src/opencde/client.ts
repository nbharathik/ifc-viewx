export type OpenCdeAuth =
  | { kind: "none" }
  | { kind: "bearer"; token: string }
  | { kind: "basic"; username: string; password: string };

export interface OpenCdeVersion {
  api_id: string;
  version_id: string;
  detailed_version?: string;
  api_base_url?: string;
}

export interface OpenCdeAuthInfo {
  oauth2_auth_url?: string;
  oauth2_token_url?: string;
  oauth2_dynamic_client_reg_url?: string;
  http_basic_supported?: boolean;
  supported_oauth2_flows: string[];
}

export interface OpenCdeUser {
  id: string;
  name?: string;
}

export interface BcfAuthorization {
  project_actions?: string[];
  topic_actions?: string[];
  comment_actions?: string[];
}

export interface BcfProject {
  project_id: string;
  name: string;
  authorization?: BcfAuthorization;
}

export interface BcfProjectExtensions extends BcfAuthorization {
  topic_type?: string[];
  topic_status?: string[];
  topic_label?: string[];
  priority?: string[];
  user_id_type?: string[];
  /** Accepted for servers that expose the older vendor-specific name. */
  users?: string[];
  stage?: string[];
}

export interface BcfTopic {
  guid: string;
  server_assigned_id?: string;
  creation_author?: string;
  creation_date?: string;
  modified_author?: string;
  modified_date?: string;
  topic_type?: string;
  topic_status?: string;
  reference_links?: string[];
  title: string;
  priority?: string;
  labels?: string[];
  assigned_to?: string;
  stage?: string;
  description?: string;
  due_date?: string;
  authorization?: BcfAuthorization;
}

export interface BcfComment {
  guid: string;
  date?: string;
  author?: string;
  modified_date?: string;
  modified_author?: string;
  comment?: string;
  viewpoint_guid?: string;
  topic_guid?: string;
  authorization?: BcfAuthorization;
}

export interface BcfPoint {
  x: number;
  y: number;
  z: number;
}

export interface BcfComponent {
  ifc_guid?: string;
  originating_system?: string;
  authoring_tool_id?: string;
}

export interface BcfViewpoint {
  guid: string;
  index?: number;
  perspective_camera?: {
    camera_view_point: BcfPoint;
    camera_direction: BcfPoint;
    camera_up_vector: BcfPoint;
    field_of_view: number;
    aspect_ratio?: number;
  };
  orthogonal_camera?: {
    camera_view_point: BcfPoint;
    camera_direction: BcfPoint;
    camera_up_vector: BcfPoint;
    view_to_world_scale: number;
    aspect_ratio?: number;
  };
  clipping_planes?: Array<{ location: BcfPoint; direction: BcfPoint }>;
  snapshot?: { snapshot_type: "png" | "jpg"; snapshot_data?: string };
  components?: {
    selection?: BcfComponent[];
    visibility?: { default_visibility?: boolean; exceptions?: BcfComponent[] };
  };
}

export interface BcfTopicWrite {
  guid?: string;
  topic_type?: string;
  topic_status?: string;
  reference_links?: string[];
  title: string;
  priority?: string;
  labels?: string[];
  assigned_to?: string;
  stage?: string;
  description?: string;
  due_date?: string;
}

export interface OpenCdeSession {
  serverUrl: string;
  foundationBaseUrl: string;
  bcfBaseUrl: string;
  documentsBaseUrl?: string;
  versions: OpenCdeVersion[];
}

export type OpenCdeFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export class OpenCdeError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "opencde_error",
  ) {
    super(message);
    this.name = "OpenCdeError";
  }
}

export class OpenCdeEndpointTrustError extends OpenCdeError {
  constructor(readonly advertisedOrigins: string[]) {
    super(
      `This server delegates its OpenCDE API to ${advertisedOrigins.join(", ")}. Confirm that endpoint before sending credentials.`,
      0,
      "endpoint_confirmation_required",
    );
    this.name = "OpenCdeEndpointTrustError";
  }
}

const localHost = (hostname: string): boolean =>
  hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname === "::1";

function serverUrl(input: string): URL {
  let value = input.trim();
  if (!/^[a-z][a-z\d+.-]*:/i.test(value)) value = `https://${value}`;
  const url = new URL(value);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname))) {
    throw new OpenCdeError("Use HTTPS for a remote OpenCDE server. HTTP is accepted only on localhost.", 0, "insecure_server");
  }
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname
    .replace(/\/foundation\/versions\/?$/i, "")
    .replace(/\/$/, "");
  return url;
}

function endpoint(value: string | undefined, fallback: string, root: URL): URL {
  const url = new URL(value || fallback, `${root.origin}/`);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname))) {
    throw new OpenCdeError("The server advertised an insecure OpenCDE endpoint.", 0, "insecure_endpoint");
  }
  url.pathname = url.pathname.replace(/\/$/, "");
  return url;
}

function authorization(auth: OpenCdeAuth): string | null {
  if (auth.kind === "bearer") return auth.token.trim() ? `Bearer ${auth.token.trim()}` : null;
  if (auth.kind !== "basic") return null;
  const bytes = new TextEncoder().encode(`${auth.username}:${auth.password}`);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function list<T>(value: unknown, key?: string): T[] {
  const source = key && object(value) ? value[key] : value;
  if (!Array.isArray(source)) throw new OpenCdeError("The OpenCDE server returned an unexpected response.", 0, "invalid_response");
  return source as T[];
}

function errorMessage(value: unknown, fallback: string): string {
  if (!object(value)) return fallback;
  for (const key of ["message", "error_description", "error", "detail"]) {
    if (typeof value[key] === "string" && value[key]) return value[key] as string;
  }
  return fallback;
}

export class OpenCdeClient {
  private session: OpenCdeSession | null = null;
  private auth: OpenCdeAuth = { kind: "none" };

  constructor(private readonly fetcher: OpenCdeFetch = globalThis.fetch.bind(globalThis)) {}

  getSession(): OpenCdeSession | null {
    return this.session;
  }

  disconnect(): void {
    this.session = null;
    this.auth = { kind: "none" };
  }

  async connect(
    input: string,
    auth: OpenCdeAuth,
    options: { trustAdvertisedOrigins?: boolean; signal?: AbortSignal } = {},
  ): Promise<OpenCdeSession> {
    const root = serverUrl(input);
    const versionsUrl = new URL(`${root.pathname}/foundation/versions`, `${root.origin}/`);
    const raw = await this.json(versionsUrl, { signal: options.signal }, { kind: "none" });
    const versions = list<OpenCdeVersion>(raw, "versions").filter((item) => (
      item && typeof item.api_id === "string" && typeof item.version_id === "string"
    ));
    const bcf = versions.find((item) => item.api_id.toLowerCase() === "bcf" && item.version_id === "3.0");
    if (!bcf) throw new OpenCdeError("This server does not advertise BCF API 3.0.", 0, "bcf_3_unavailable");
    const foundations = versions
      .filter((item) => item.api_id.toLowerCase() === "foundation")
      .sort((a, b) => b.version_id.localeCompare(a.version_id, undefined, { numeric: true }));
    const foundation = foundations[0];
    if (!foundation) throw new OpenCdeError("This server does not advertise the OpenCDE Foundation API.", 0, "foundation_unavailable");
    const documents = versions.find((item) => item.api_id.toLowerCase() === "documents" && item.version_id === "1.0");
    const bcfUrl = endpoint(bcf.api_base_url, `${root.origin}${root.pathname}/bcf/3.0`, root);
    const foundationUrl = endpoint(
      foundation.api_base_url,
      `${root.origin}${root.pathname}/foundation/${foundation.version_id}`,
      root,
    );
    const documentsUrl = documents
      ? endpoint(documents.api_base_url, `${root.origin}${root.pathname}/documents/1.0`, root)
      : null;
    const advertisedOrigins = [...new Set([bcfUrl, foundationUrl, documentsUrl]
      .filter((url): url is URL => Boolean(url))
      .map((url) => url.origin)
      .filter((origin) => origin !== root.origin))];
    if (advertisedOrigins.length && !options.trustAdvertisedOrigins) {
      throw new OpenCdeEndpointTrustError(advertisedOrigins);
    }
    this.auth = auth;
    this.session = {
      serverUrl: `${root.origin}${root.pathname}`,
      foundationBaseUrl: foundationUrl.href,
      bcfBaseUrl: bcfUrl.href,
      ...(documentsUrl ? { documentsBaseUrl: documentsUrl.href } : {}),
      versions,
    };
    return this.session;
  }

  async authenticationInfo(signal?: AbortSignal): Promise<OpenCdeAuthInfo> {
    const session = this.requireSession();
    return this.json(`${session.foundationBaseUrl}/auth`, { signal }, { kind: "none" }) as Promise<OpenCdeAuthInfo>;
  }

  async currentUser(signal?: AbortSignal): Promise<OpenCdeUser | null> {
    const session = this.requireSession();
    try {
      return await this.json(`${session.foundationBaseUrl}/current-user`, { signal }) as OpenCdeUser;
    } catch (error) {
      if (error instanceof OpenCdeError && error.status === 404) return null;
      throw error;
    }
  }

  async projects(signal?: AbortSignal): Promise<BcfProject[]> {
    return list<BcfProject>(await this.bcf("projects?includeAuthorization=true", { signal }));
  }

  async projectExtensions(projectId: string, signal?: AbortSignal): Promise<BcfProjectExtensions> {
    return this.bcf(`projects/${encodeURIComponent(projectId)}/extensions`, { signal }) as Promise<BcfProjectExtensions>;
  }

  async topics(projectId: string, signal?: AbortSignal): Promise<BcfTopic[]> {
    return list<BcfTopic>(await this.bcf(
      `projects/${encodeURIComponent(projectId)}/topics?includeAuthorization=true&$top=500`,
      { signal },
    ));
  }

  async comments(projectId: string, topicGuid: string, signal?: AbortSignal): Promise<BcfComment[]> {
    return list<BcfComment>(await this.bcf(
      `projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/comments?includeAuthorization=true`,
      { signal },
    ));
  }

  async viewpoints(projectId: string, topicGuid: string, signal?: AbortSignal): Promise<BcfViewpoint[]> {
    return list<BcfViewpoint>(await this.bcf(
      `projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/viewpoints`,
      { signal },
    ));
  }

  async viewpointSnapshot(
    projectId: string,
    topicGuid: string,
    viewpointGuid: string,
    signal?: AbortSignal,
  ): Promise<Blob | null> {
    const session = this.requireSession();
    const path = `projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}` +
      `/viewpoints/${encodeURIComponent(viewpointGuid)}/snapshot`;
    const response = await this.request(`${session.bcfBaseUrl}/${path}`, { signal, headers: { Accept: "image/*" } });
    if (response.status === 404) return null;
    if (!response.ok) throw await this.httpError(response);
    return response.blob();
  }

  async createTopic(projectId: string, topic: BcfTopicWrite, signal?: AbortSignal): Promise<BcfTopic> {
    return this.bcf(`projects/${encodeURIComponent(projectId)}/topics`, {
      method: "POST",
      signal,
      body: JSON.stringify(topic),
    }) as Promise<BcfTopic>;
  }

  async updateTopic(projectId: string, guid: string, topic: BcfTopicWrite, signal?: AbortSignal): Promise<BcfTopic> {
    return this.bcf(`projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(guid)}`, {
      method: "PUT",
      signal,
      body: JSON.stringify(topic),
    }) as Promise<BcfTopic>;
  }

  async createComment(
    projectId: string,
    topicGuid: string,
    comment: { guid?: string; comment: string; viewpoint_guid?: string },
    signal?: AbortSignal,
  ): Promise<BcfComment> {
    return this.bcf(
      `projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/comments`,
      { method: "POST", signal, body: JSON.stringify(comment) },
    ) as Promise<BcfComment>;
  }

  async createViewpoint(
    projectId: string,
    topicGuid: string,
    viewpoint: BcfViewpoint,
    signal?: AbortSignal,
  ): Promise<BcfViewpoint> {
    return this.bcf(
      `projects/${encodeURIComponent(projectId)}/topics/${encodeURIComponent(topicGuid)}/viewpoints`,
      { method: "POST", signal, body: JSON.stringify(viewpoint) },
    ) as Promise<BcfViewpoint>;
  }

  private requireSession(): OpenCdeSession {
    if (!this.session) throw new OpenCdeError("Connect to an OpenCDE server first.", 0, "not_connected");
    return this.session;
  }

  private async bcf(path: string, init: RequestInit = {}): Promise<unknown> {
    const session = this.requireSession();
    return this.json(`${session.bcfBaseUrl}/${path}`, init);
  }

  private async json(input: RequestInfo | URL, init: RequestInit = {}, auth = this.auth): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await this.request(input, { ...init, headers }, auth);
    if (!response.ok) throw await this.httpError(response);
    if (response.status === 204) return null;
    try {
      return await response.json();
    } catch {
      throw new OpenCdeError("The OpenCDE server returned invalid JSON.", response.status, "invalid_json");
    }
  }

  private async request(input: RequestInfo | URL, init: RequestInit, auth = this.auth): Promise<Response> {
    const headers = new Headers(init.headers);
    const value = authorization(auth);
    if (value) headers.set("Authorization", value);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenCDE request timed out")), 20_000);
    const abort = (): void => controller.abort(init.signal?.reason);
    init.signal?.addEventListener("abort", abort, { once: true });
    try {
      return await this.fetcher(input, { ...init, headers, signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) {
        const message = init.signal?.aborted ? "OpenCDE request cancelled." : "The OpenCDE server did not respond in time.";
        throw new OpenCdeError(message, 0, init.signal?.aborted ? "cancelled" : "timeout");
      }
      throw new OpenCdeError(
        error instanceof Error ? `Could not reach the OpenCDE server: ${error.message}` : "Could not reach the OpenCDE server.",
        0,
        "network_error",
      );
    } finally {
      clearTimeout(timeout);
      init.signal?.removeEventListener("abort", abort);
    }
  }

  private async httpError(response: Response): Promise<OpenCdeError> {
    const fallback = response.status === 401
      ? "The server rejected these credentials."
      : response.status === 403
        ? "This account is not allowed to perform that OpenCDE action."
        : `OpenCDE request failed with HTTP ${response.status}.`;
    let detail: unknown = null;
    try {
      detail = await response.clone().json();
    } catch {
      detail = null;
    }
    return new OpenCdeError(errorMessage(detail, fallback), response.status, `http_${response.status}`);
  }
}
