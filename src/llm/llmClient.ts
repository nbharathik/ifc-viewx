// Assistant providers. Everything here works in the browser alone: pick a
// provider, paste your own key, run. No key ever ships with the static site;
// keys live in this browser's local storage only. Local Studio is optional and
// only changes who holds the key, never whether the assistant works.
//
// Each provider pre-declares its endpoint, wire format and auth header, so the
// only thing left to choose is the model. Known models are listed up front and
// the real list can be pulled from the endpoint itself, which never goes stale.

export type ProviderId = "anthropic" | "openai" | "openrouter" | "local" | "custom";

export interface Provider {
  id: ProviderId;
  label: string;
  /** Anthropic Messages or OpenAI chat-completions wire format. */
  wire: "anthropic" | "openai";
  baseUrl: string;
  /** Hosted providers own their URL; local and custom endpoints do not. */
  fixedUrl: boolean;
  keyPlaceholder: string;
  /** Whether a key is required to reach it at all. */
  needsKey: boolean;
  note: string;
  /** Known models, best first. Refresh replaces this with the endpoint's own list. */
  models: string[];
}

export const PROVIDERS: Provider[] = [
  {
    id: "anthropic",
    label: "Claude (Anthropic)",
    wire: "anthropic",
    baseUrl: "https://api.anthropic.com",
    fixedUrl: true,
    keyPlaceholder: "sk-ant-...",
    needsKey: true,
    note: "Called straight from this tab with the direct-browser-access header. The key stays in this browser.",
    models: ["claude-opus-5", "claude-sonnet-5", "claude-haiku-4-5"],
  },
  {
    id: "openai",
    label: "OpenAI",
    wire: "openai",
    baseUrl: "https://api.openai.com/v1",
    fixedUrl: true,
    keyPlaceholder: "sk-...",
    needsKey: true,
    note: "Any OpenAI chat model. Refresh the list to read the models your key can actually use.",
    models: [],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    wire: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    fixedUrl: true,
    keyPlaceholder: "sk-or-...",
    needsKey: true,
    note: "One key, many vendors. Refresh the list to see everything your account can route to.",
    models: [],
  },
  {
    id: "local",
    label: "Local model (Ollama, LM Studio)",
    wire: "openai",
    baseUrl: "http://localhost:11434/v1",
    fixedUrl: false,
    keyPlaceholder: "usually blank",
    needsKey: false,
    note: "Fully offline. Start the server with CORS enabled, then refresh the list to see what is installed.",
    models: [],
  },
  {
    id: "custom",
    label: "Custom OpenAI-compatible",
    wire: "openai",
    baseUrl: "",
    fixedUrl: false,
    keyPlaceholder: "if your gateway needs one",
    needsKey: false,
    note: "Any endpoint that speaks /chat/completions: vLLM, an org gateway, a proxy.",
    models: [],
  },
];

export const findProvider = (id: string): Provider =>
  PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];

/** What the assistant may do: read the model, or also stage property edits. */
export type AssistantMode = "query" | "edit";

export interface LlmSettings {
  provider: ProviderId;
  baseUrl: string;
  apiKey: string;
  model: string;
  mode: AssistantMode;
  /** The model id last proved to answer on this endpoint, or "". */
  verified: string;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

const SETTINGS_KEY = "ifc-studio.llm-settings";

/**
 * Generous, because a reasoning model spends this budget thinking before it
 * writes anything: at 4096 a local Qwen burned the whole cap and returned an
 * empty message. It is a ceiling, not a target; ordinary turns use a few
 * hundred tokens.
 */
const MAX_TOKENS = 16384;

/** Enough for a model to say anything at all, cheap enough to spend on a check. */
const VERIFY_TOKENS = 16;

const DEFAULT_SETTINGS: LlmSettings = {
  provider: "anthropic",
  baseUrl: "",
  apiKey: "",
  model: "",
  mode: "query",
  verified: "",
};

export function loadSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const saved = JSON.parse(raw) as Partial<Omit<LlmSettings, "provider">> & { provider?: string };
    // Settings written before the providers were split named one lumped
    // "openai-compatible" entry; a localhost URL means it was a local model.
    const provider = (
      saved.provider === "openai-compatible"
        ? /localhost|127\.0\.0\.1/.test(saved.baseUrl ?? "")
          ? "local"
          : "custom"
        : saved.provider
    ) as ProviderId | undefined;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      provider: provider && PROVIDERS.some((p) => p.id === provider) ? provider : "anthropic",
      mode: saved.mode === "edit" ? "edit" : "query",
      verified: typeof saved.verified === "string" ? saved.verified : "",
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(settings: LlmSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

/** The endpoint in use: the provider's own, unless it allows an override. */
export function endpointOf(settings: LlmSettings): string {
  const provider = findProvider(settings.provider);
  const base = provider.fixedUrl ? provider.baseUrl : settings.baseUrl.trim() || provider.baseUrl;
  return base.replace(/\/+$/, "");
}

export const isConfigured = (settings: LlmSettings): boolean =>
  Boolean(settings.model) && Boolean(settings.apiKey || !findProvider(settings.provider).needsKey);

/** This exact model id was proved to answer, and nothing has changed since. */
export const isVerified = (settings: LlmSettings): boolean =>
  Boolean(settings.model) && settings.verified === settings.model;

/** Auth the way this provider's wire expects it. */
function authHeaders(provider: Provider, settings: LlmSettings): Record<string, string> {
  if (provider.wire === "anthropic") {
    return {
      "x-api-key": settings.apiKey,
      "anthropic-version": "2023-06-01",
      // Opt-in for direct browser calls; the key is the user's own.
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }
  return settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {};
}

/** Ask the endpoint which models it has, so the list is never out of date. */
export async function listModels(settings: LlmSettings): Promise<string[]> {
  const provider = findProvider(settings.provider);
  const base = endpointOf(settings);
  if (!base) throw new Error("Set the base URL first.");
  const path = provider.wire === "anthropic" ? "/v1/models" : "/models";
  const res = await reach(`${base}${path}`, { headers: authHeaders(provider, settings) }, base);
  if (!res.ok) throw new Error(`Could not list models (HTTP ${res.status}): ${await errorDetail(res)}`);
  const data = (await res.json()) as { data?: { id?: string }[] };
  const ids = (data.data ?? []).map((m) => m.id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) throw new Error("The endpoint returned no models.");
  return ids.sort();
}

export interface VerifyResult {
  model: string;
  ms: number;
}

/**
 * Prove the model id is real by using it. A model list only says the server
 * knows a name; one tiny turn says this id is loaded and answering, which is
 * the only claim worth showing the user. Failures carry the server's own
 * words, because they name a wrong id better than we can.
 */
export async function verifyModel(settings: LlmSettings): Promise<VerifyResult> {
  const model = settings.model.trim();
  if (!model) throw new Error("Enter a model id first.");
  const provider = findProvider(settings.provider);
  if (provider.needsKey && !settings.apiKey) throw new Error(`${provider.label} needs an API key.`);
  const base = endpointOf(settings);
  if (!base) throw new Error("Set the endpoint first.");

  const anthropic = provider.wire === "anthropic";
  const started = performance.now();
  const res = await reach(
    `${base}${anthropic ? "/v1/messages" : "/chat/completions"}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders(provider, settings) },
      body: JSON.stringify({
        model,
        max_tokens: VERIFY_TOKENS,
        messages: [{ role: "user", content: "Reply with the single word: ready" }],
      }),
    },
    base,
  );
  if (!res.ok) throw new Error(await errorDetail(res));

  // A 200 is not proof on its own: a wrong base URL can serve a web page, and
  // a gateway can answer without ever reaching a model. Only the shape of a
  // real completion says this id is loaded.
  let data: { choices?: unknown[]; content?: unknown[] };
  try {
    data = (await res.json()) as typeof data;
  } catch {
    throw new Error(`${base} answered, but not with JSON. Check the URL points at the API root.`);
  }
  if (!Array.isArray(anthropic ? data.content : data.choices)) {
    throw new Error(`${base} answered, but not with a chat completion. Check the URL points at the API root.`);
  }
  return { model, ms: Math.round(performance.now() - started) };
}

/** A fetch that cannot connect throws a bare TypeError; say what to check. */
async function reach(url: string, init: RequestInit, base: string): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch {
    throw new Error(`Could not reach ${base}. Check the server is running and allows requests from this page.`);
  }
}

/** One turn. A proxy (Local Studio) wins: then no key lives in this browser. */
export async function chat(
  settings: LlmSettings,
  messages: ChatMessage[],
  proxy?: (messages: ChatMessage[]) => Promise<string>,
): Promise<string> {
  if (proxy) return proxy(messages);
  if (!settings.model) throw new Error("Choose an assistant provider and model in Settings first.");
  const provider = findProvider(settings.provider);
  if (provider.needsKey && !settings.apiKey) {
    throw new Error(`${provider.label} needs an API key. Paste one in Settings.`);
  }
  return provider.wire === "anthropic"
    ? chatAnthropic(settings, messages)
    : chatOpenAi(settings, messages);
}

async function chatOpenAi(settings: LlmSettings, messages: ChatMessage[]): Promise<string> {
  const response = await fetch(`${endpointOf(settings)}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(findProvider(settings.provider), settings),
    },
    // Without a cap a self-hosted server allows the whole context window, and
    // a reasoning model will spend it: one tool choice ran past 15k tokens.
    body: JSON.stringify({ model: settings.model, messages, max_tokens: MAX_TOKENS }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed (HTTP ${response.status}): ${await errorDetail(response)}`);
  }
  const data = (await response.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = data.choices?.[0];
  const content = choice?.message?.content;
  if (!content) {
    // A reasoning model can spend the whole budget thinking and return
    // nothing, which is worth saying plainly rather than "empty response".
    throw new Error(
      choice?.finish_reason === "length"
        ? `The model used all ${MAX_TOKENS} tokens without answering. Reasoning models can do this on long prompts; try a shorter question or turn thinking off on the server.`
        : "LLM returned an empty response",
    );
  }
  return content;
}

async function chatAnthropic(settings: LlmSettings, messages: ChatMessage[]): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const response = await fetch(`${endpointOf(settings)}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...authHeaders(findProvider(settings.provider), settings),
    },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_TOKENS,
      ...(system ? { system } : {}),
      messages: turns,
    }),
  });
  if (!response.ok) {
    throw new Error(`LLM request failed (HTTP ${response.status}): ${await errorDetail(response)}`);
  }
  const data = (await response.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  if (!text) throw new Error("LLM returned an empty response");
  return text;
}

/** The message the server wrote, not the JSON envelope it came wrapped in. */
async function errorDetail(response: Response): Promise<string> {
  const body = await safeText(response);
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string } | string; message?: string };
    const detail = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
    if (detail) return detail;
  } catch {
    // Not JSON: the raw body is the best we have.
  }
  return body || `HTTP ${response.status}`;
}

async function safeText(response: Response): Promise<string> {
  try {
    return (await response.text()).slice(0, 400);
  } catch {
    return "";
  }
}
