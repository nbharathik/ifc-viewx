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

/**
 * One document version on a CDE. The Documents API describes a document as a
 * reference the client resolves for metadata and then downloads; different
 * servers spell the download link differently, so the reader accepts all
 * three shapes rather than only the one the first server used.
 */
export interface OpenCdeDocument {
  guid: string;
  name: string;
  version?: string;
  size?: number;
  created_at?: string;
  content_type?: string;
  /** Where the bytes are, once resolved. */
  downloadUrl?: string;
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

const JSON_LIMIT = 8 * 1024 * 1024;
const SNAPSHOT_LIMIT = 32 * 1024 * 1024;
const DOCUMENT_LIMIT = 768 * 1024 * 1024;

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
  if (url.username || url.password) throw new OpenCdeError("Enter CDE credentials in the authentication fields, not in the server URL.", 0, "url_credentials");
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
  if (url.username || url.password) throw new OpenCdeError("The server advertised an endpoint containing credentials.", 0, "endpoint_credentials");
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

function copyAuth(auth: OpenCdeAuth): OpenCdeAuth {
  if (auth.kind === "none") return { kind: "none" };
  if (auth.kind === "bearer" && typeof auth.token === "string") return { kind: "bearer", token: auth.token };
  if (auth.kind === "basic" && typeof auth.username === "string" && typeof auth.password === "string") {
    return { kind: "basic", username: auth.username, password: auth.password };
  }
  throw new OpenCdeError("Choose a valid OpenCDE authentication method.", 0, "invalid_auth");
}

function copySession(session: OpenCdeSession): OpenCdeSession {
  return {
    ...session,
    versions: session.versions.map((version) => ({ ...version })),
  };
}

function sameStrings(one: readonly string[], two: readonly string[]): boolean {
  return one.length === two.length && one.every((value, index) => value === two[index]);
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
  private connectionGeneration = 0;
  private pendingEndpointTrust: { server: string; origins: string[] } | null = null;

  constructor(private readonly fetcher: OpenCdeFetch = globalThis.fetch.bind(globalThis)) {}

  getSession(): OpenCdeSession | null {
    return this.session ? copySession(this.session) : null;
  }

  disconnect(): void {
    this.connectionGeneration += 1;
    this.session = null;
    this.auth = { kind: "none" };
    this.pendingEndpointTrust = null;
  }

  async connect(
    input: string,
    auth: OpenCdeAuth,
    options: { trustAdvertisedOrigins?: boolean; signal?: AbortSignal } = {},
  ): Promise<OpenCdeSession> {
    const generation = ++this.connectionGeneration;
    const nextAuth = copyAuth(auth);
    const root = serverUrl(input);
    // URL.pathname is always at least "/". Normalize it before joining so a
    // bare host cannot turn "//foundation/versions" into a new hostname.
    const rootPath = root.pathname.replace(/\/+$/, "");
    const server = `${root.origin}${rootPath}`;
    const versionsUrl = new URL(`${rootPath}/foundation/versions`, `${root.origin}/`);
    const raw = await this.json(versionsUrl, { signal: options.signal }, { kind: "none" });
    this.assertCurrentConnection(generation);
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
    const bcfUrl = endpoint(bcf.api_base_url, `${root.origin}${rootPath}/bcf/3.0`, root);
    const foundationUrl = endpoint(
      foundation.api_base_url,
      `${root.origin}${rootPath}/foundation/${foundation.version_id}`,
      root,
    );
    const documentsUrl = documents
      ? endpoint(documents.api_base_url, `${root.origin}${rootPath}/documents/1.0`, root)
      : null;
    const advertisedOrigins = [...new Set([bcfUrl, foundationUrl, documentsUrl]
      .filter((url): url is URL => Boolean(url))
      .map((url) => url.origin)
      .filter((origin) => origin !== root.origin))];
    if (advertisedOrigins.length) {
      const pending = this.pendingEndpointTrust;
      const matchesPending = pending?.server === server && sameStrings(pending.origins, advertisedOrigins);
      if (!options.trustAdvertisedOrigins || (pending !== null && !matchesPending)) {
        this.pendingEndpointTrust = { server, origins: [...advertisedOrigins] };
        throw new OpenCdeEndpointTrustError(advertisedOrigins);
      }
    }
    this.assertCurrentConnection(generation);
    this.auth = nextAuth;
    this.session = {
      serverUrl: server,
      foundationBaseUrl: foundationUrl.href,
      bcfBaseUrl: bcfUrl.href,
      ...(documentsUrl ? { documentsBaseUrl: documentsUrl.href } : {}),
      versions,
    };
    this.pendingEndpointTrust = null;
    return copySession(this.session);
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
    return this.withResponse(`${session.bcfBaseUrl}/${path}`, { signal, headers: { Accept: "image/*" } }, async (response) => {
      if (response.status === 404) return null;
      if (!response.ok) throw await this.httpError(response);
      const bytes = await responseBytes(response, SNAPSHOT_LIMIT, "viewpoint snapshot");
      return new Blob([bytes as BlobPart], { type: response.headers.get("content-type") ?? "application/octet-stream" });
    });
  }

  // -- documents -------------------------------------------------------------

  /** True when the server advertised the Documents API at all. */
  hasDocuments(): boolean {
    return Boolean(this.session?.documentsBaseUrl);
  }

  /**
   * Documents the server is willing to list. The Documents API's own flow is
   * an interactive picker the server renders; a plain listing is an optional
   * convenience, so a server without one answers 404 and this returns nothing
   * rather than failing the panel.
   */
  async documents(signal?: AbortSignal): Promise<OpenCdeDocument[]> {
    const base = this.requireDocuments();
    const url = `${base}/documents`;
    try {
      const raw = await this.json(url, { signal });
      return list<Record<string, unknown>>(raw, "documents").map((entry) => readDocument(entry, url));
    } catch (error) {
      if (error instanceof OpenCdeError && (error.status === 404 || error.status === 501)) return [];
      throw error;
    }
  }

  /** Every version of one document, newest first where the server orders. */
  async documentVersions(documentGuid: string, signal?: AbortSignal): Promise<OpenCdeDocument[]> {
    const base = this.requireDocuments();
    const url = `${base}/documents/${encodeURIComponent(documentGuid)}/versions`;
    const raw = await this.json(url, { signal });
    return list<Record<string, unknown>>(raw, "versions").map((entry) => readDocument(entry, url));
  }

  /**
   * Resolve a document reference URL. This is what a BCF topic carries and
   * what the server's picker hands back: a URL that answers with metadata,
   * including where the bytes are.
   */
  async documentReference(url: string, signal?: AbortSignal): Promise<OpenCdeDocument> {
    const referenceUrl = documentUrl(url, this.requireDocuments());
    const raw = await this.json(referenceUrl, { signal });
    const document_ = readDocument((raw ?? {}) as Record<string, unknown>, referenceUrl.href);
    if (!document_.downloadUrl) {
      // Some servers answer metadata at the reference and serve the bytes at
      // the same URL with a different Accept; that is the documented fallback.
      document_.downloadUrl = referenceUrl.href;
    }
    return document_;
  }

  /** The bytes. Nothing here caches: the caller decides what to keep. */
  async documentContent(
    document_: OpenCdeDocument,
    signal?: AbortSignal,
  ): Promise<{ name: string; bytes: Uint8Array }> {
    const url = document_.downloadUrl;
    if (!url) throw new OpenCdeError("That document does not say where its content is.", 0, "no_download_url");
    const contentUrl = documentUrl(url, this.requireDocuments());
    return this.withResponse(contentUrl, { signal, headers: { Accept: "application/octet-stream" } }, async (response) => {
      if (!response.ok) throw await this.httpError(response);
      const disposition = response.headers.get("content-disposition") ?? "";
      const named = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition)?.[1];
      return {
        name: safeDocumentName(decodeName(named) || document_.name || "document"),
        bytes: await responseBytes(response, DOCUMENT_LIMIT, "document"),
      };
    }, this.auth, 5 * 60_000);
  }

  private requireDocuments(): string {
    const session = this.requireSession();
    if (!session.documentsBaseUrl) {
      throw new OpenCdeError("This server does not advertise the OpenCDE Documents API.", 0, "documents_unavailable");
    }
    return session.documentsBaseUrl;
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

  private assertCurrentConnection(generation: number): void {
    if (generation !== this.connectionGeneration) {
      throw new OpenCdeError("A newer OpenCDE connection replaced this request.", 0, "connection_superseded");
    }
  }

  private async bcf(path: string, init: RequestInit = {}): Promise<unknown> {
    const session = this.requireSession();
    return this.json(`${session.bcfBaseUrl}/${path}`, init);
  }

  private async json(input: RequestInfo | URL, init: RequestInit = {}, auth = this.auth): Promise<unknown> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json");
    if (init.body) headers.set("Content-Type", "application/json");
    return this.withResponse(input, { ...init, headers }, async (response) => {
      if (!response.ok) throw await this.httpError(response);
      if (response.status === 204) return null;
      try {
        return JSON.parse(new TextDecoder().decode(await responseBytes(response, JSON_LIMIT, "JSON response"))) as unknown;
      } catch (error) {
        if (error instanceof OpenCdeError) throw error;
        throw new OpenCdeError("The OpenCDE server returned invalid JSON.", response.status, "invalid_json");
      }
    }, auth);
  }

  /** Keep cancellation and the timeout alive until the response body is consumed. */
  private async withResponse<T>(
    input: RequestInfo | URL,
    init: RequestInit,
    consume: (response: Response) => Promise<T>,
    auth = this.auth,
    timeoutMs = 20_000,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    // Reference and download URLs are server-controlled and may legitimately
    // point at a public object store. Never forward CDE credentials to such an
    // origin: only the endpoints confirmed while connecting are trusted.
    const target = requestUrl(input, this.session?.serverUrl);
    const trusted = target ? this.trustedOrigins().has(target.origin) : false;
    const value = trusted ? authorization(auth) : null;
    if (value) headers.set("Authorization", value);
    else headers.delete("Authorization");
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error("OpenCDE request timed out")), timeoutMs);
    const abort = (): void => controller.abort(init.signal?.reason);
    if (init.signal?.aborted) abort();
    else init.signal?.addEventListener("abort", abort, { once: true });
    try {
      if (controller.signal.aborted) throw controller.signal.reason;
      const response = await this.fetcher(input, {
        ...init,
        headers,
        signal: controller.signal,
        ...(value ? { redirect: "error" as const } : {}),
      });
      await this.validateResponseTarget(response, target, Boolean(value));
      return await consume(response);
    } catch (error) {
      if (error instanceof OpenCdeError) throw error;
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

  private async validateResponseTarget(response: Response, requested: URL | null, authenticated: boolean): Promise<void> {
    if (!response.url) return;
    const final = requestUrl(response.url);
    if (!final || (final.protocol !== "https:" && !(final.protocol === "http:" && localHost(final.hostname)))) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenCdeError("The OpenCDE request redirected to an insecure URL.", 0, "insecure_redirect");
    }
    if (final.username || final.password) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenCdeError("The OpenCDE request redirected to a URL containing credentials.", 0, "redirect_credentials");
    }
    if (authenticated && requested && final.origin !== requested.origin) {
      await response.body?.cancel().catch(() => undefined);
      throw new OpenCdeError("The authenticated OpenCDE request redirected to an untrusted origin.", 0, "untrusted_redirect");
    }
  }

  private trustedOrigins(): Set<string> {
    if (!this.session) return new Set();
    return new Set([
      this.session.serverUrl,
      this.session.foundationBaseUrl,
      this.session.bcfBaseUrl,
      this.session.documentsBaseUrl,
    ].filter((value): value is string => Boolean(value)).map((value) => new URL(value).origin));
  }

  private async httpError(response: Response): Promise<OpenCdeError> {
    const fallback = response.status === 401
      ? "The server rejected these credentials."
      : response.status === 403
        ? "This account is not allowed to perform that OpenCDE action."
        : `OpenCDE request failed with HTTP ${response.status}.`;
    let detail: unknown = null;
    try {
      const bytes = await responseBytes(response, 64 * 1024, "error response");
      detail = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    } catch {
      detail = null;
    }
    return new OpenCdeError(errorMessage(detail, fallback), response.status, `http_${response.status}`);
  }
}

/** Read whichever spelling of a document the server used. */
function readDocument(entry: Record<string, unknown>, baseUrl?: string): OpenCdeDocument {
  const links = (entry._links ?? {}) as Record<string, { href?: string } | undefined>;
  const download =
    text(entry.download_url) ??
    text(entry.content_url) ??
    links.download?.href ??
    links.content?.href ??
    undefined;
  return {
    guid: text(entry.guid) ?? text(entry.document_guid) ?? text(entry.id) ?? "",
    name: text(entry.file_name) ?? text(entry.name) ?? text(entry.title) ?? "document",
    version: text(entry.version) ?? text(entry.version_id) ?? undefined,
    size: typeof entry.file_size === "number" ? entry.file_size : typeof entry.size === "number" ? entry.size : undefined,
    created_at: text(entry.creation_date) ?? text(entry.created_at) ?? undefined,
    content_type: text(entry.content_type) ?? undefined,
    ...(download ? { downloadUrl: documentUrl(download, baseUrl).href } : {}),
  };
}

function requestUrl(input: RequestInfo | URL, baseUrl?: string): URL | null {
  try {
    const value = input instanceof Request ? input.url : String(input);
    return new URL(value, baseUrl);
  } catch {
    return null;
  }
}

function documentUrl(value: string, baseUrl?: string): URL {
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    throw new OpenCdeError("The CDE supplied an invalid document URL.", 0, "invalid_document_url");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && localHost(url.hostname))) {
    throw new OpenCdeError("The CDE supplied an insecure document URL.", 0, "insecure_document_url");
  }
  if (url.username || url.password) {
    throw new OpenCdeError("The CDE supplied a document URL containing credentials.", 0, "document_url_credentials");
  }
  return url;
}

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value : undefined;

function decodeName(value: string | undefined): string {
  if (!value) return "";
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function safeDocumentName(value: string): string {
  const leaf = value.replace(/\\/g, "/").split("/").pop() ?? "";
  return leaf.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 255) || "document";
}

async function responseBytes(response: Response, limit: number, label: string): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel().catch(() => undefined);
    throw new OpenCdeError(`The OpenCDE ${label} exceeds the ${Math.round(limit / 1024 / 1024)} MB limit.`, 0, "response_too_large");
  }
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.byteLength > limit) {
      throw new OpenCdeError(`The OpenCDE ${label} exceeds its size limit.`, 0, "response_too_large");
    }
    return bytes;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel();
        throw new OpenCdeError(`The OpenCDE ${label} exceeds its size limit.`, 0, "response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}
