// Assistant providers. Everything here works in the browser alone: pick a
// provider, paste your own key, run. No key ever ships with the static site;
// keys live in this browser's local storage only. Local Studio is optional and
// only changes who holds the key, never whether the assistant works.
//
// Each provider pre-declares its endpoint, wire format and auth header, so the
// only thing left to choose is the model. Known models are listed up front and
// the real list can be pulled from the endpoint itself, which never goes stale.

import type { NativeTool } from "./tools.js";

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

/** One tool the model asked for, as both wires report it. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** Tools this assistant turn called. Absent on a plain reply. */
  calls?: ToolCall[];
  /** On a `tool` message: which call it answers. */
  callId?: string;
  /** On a `tool` message: the tool that produced it. */
  name?: string;
}

/** What one turn produced: prose, tool calls, or both. */
export interface TurnResult {
  text: string;
  calls: ToolCall[];
  /** False when the provider refused tools, so the caller drops to fenced blocks. */
  toolsUsed: boolean;
}

/** Tokens the provider reported for one turn. Absent when it reported none. */
export interface ChatUsage {
  input: number;
  output: number;
}

export interface ChatOptions {
  /** Called with each chunk as it arrives. Its presence turns streaming on. */
  onDelta?: (text: string) => void;
  onUsage?: (usage: ChatUsage) => void;
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
  const url = `${base}${anthropic ? "/v1/messages" : "/chat/completions"}`;
  const headers = { "Content-Type": "application/json", ...authHeaders(provider, settings) };
  const body = {
    model,
    max_tokens: VERIFY_TOKENS,
    messages: [{ role: "user", content: "Reply with the single word: ready" }],
  };
  let res: Response;
  try {
    res = anthropic
      ? await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
      : await postOpenAi(url, headers, body);
  } catch {
    throw new Error(`Could not reach ${base}. Check the server is running and allows requests from this page.`);
  }
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
  signal?: AbortSignal,
  options: ChatOptions = {},
): Promise<string> {
  // The proxy holds the key on the service side and answers in one piece, so
  // there is nothing to stream through it.
  if (proxy) return proxy(messages);
  if (!settings.model) throw new Error("Choose an assistant provider and model in Settings first.");
  const provider = findProvider(settings.provider);
  if (provider.needsKey && !settings.apiKey) {
    throw new Error(`${provider.label} needs an API key. Paste one in Settings.`);
  }
  return provider.wire === "anthropic"
    ? chatAnthropic(settings, messages, signal, options)
    : chatOpenAi(settings, messages, signal, options);
}

/**
 * One turn with tools offered natively. Falls back by returning
 * `toolsUsed: false`, which tells the caller to re-ask on the fenced protocol:
 * local servers vary wildly in tool support and an answer must never be lost to
 * a provider that simply does not implement it.
 *
 * Streaming and tools are deliberately not combined. Streamed tool arguments
 * arrive as JSON fragments that cannot be shown to anyone mid-flight, so a turn
 * that may call a tool is a single request, and the streaming path stays for
 * the prose turns where it is worth something.
 */
export async function converse(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: NativeTool[],
  signal?: AbortSignal,
  options: ChatOptions = {},
): Promise<TurnResult> {
  if (!settings.model) throw new Error("Choose an assistant provider and model in Settings first.");
  const provider = findProvider(settings.provider);
  if (provider.needsKey && !settings.apiKey) {
    throw new Error(`${provider.label} needs an API key. Paste one in Settings.`);
  }
  return provider.wire === "anthropic"
    ? converseAnthropic(settings, messages, tools, signal, options)
    : converseOpenAi(settings, messages, tools, signal, options);
}

/** Anthropic content blocks for one stored message. */
function anthropicContent(message: ChatMessage): unknown {
  if (message.role === "tool") {
    return [{ type: "tool_result", tool_use_id: message.callId, content: message.content }];
  }
  if (message.calls?.length) {
    const blocks: unknown[] = [];
    if (message.content) blocks.push({ type: "text", text: message.content });
    for (const call of message.calls) {
      blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.input });
    }
    return blocks;
  }
  return message.content;
}

async function converseAnthropic(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: NativeTool[],
  signal: AbortSignal | undefined,
  options: ChatOptions,
): Promise<TurnResult> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "tool" ? "user" : m.role, content: anthropicContent(m) }));
  const response = await fetch(`${endpointOf(settings)}/v1/messages`, {
    method: "POST",
    signal,
    headers: { "Content-Type": "application/json", ...authHeaders(findProvider(settings.provider), settings) },
    body: JSON.stringify({
      model: settings.model,
      max_tokens: MAX_TOKENS,
      // The system prompt and the tool table are identical every turn, so
      // marking the tail of the system block cacheable is the whole win.
      ...(system ? { system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }] } : {}),
      tools: tools.map((tool) => ({ name: tool.name, description: tool.description, input_schema: tool.schema })),
      messages: turns,
    }),
  });
  if (!response.ok) {
    const detail = await errorDetail(response);
    if (/tool/i.test(detail) && response.status === 400) return { text: "", calls: [], toolsUsed: false };
    throw new Error(`LLM request failed (HTTP ${response.status}): ${detail}`);
  }
  const data = (await response.json()) as {
    content?: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }>;
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  if (data.usage) {
    options.onUsage?.({ input: asNumber(data.usage.input_tokens), output: asNumber(data.usage.output_tokens) });
  }
  const text = (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
  const calls = (data.content ?? [])
    .filter((b) => b.type === "tool_use" && b.name)
    .map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: b.input ?? {} }));
  return { text, calls, toolsUsed: true };
}

/** OpenAI message objects for one stored message. */
function openAiMessage(message: ChatMessage): Record<string, unknown> {
  if (message.role === "tool") {
    return { role: "tool", tool_call_id: message.callId, content: message.content };
  }
  if (message.calls?.length) {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.calls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.input) },
      })),
    };
  }
  return { role: message.role, content: message.content };
}

async function converseOpenAi(
  settings: LlmSettings,
  messages: ChatMessage[],
  tools: NativeTool[],
  signal: AbortSignal | undefined,
  options: ChatOptions,
): Promise<TurnResult> {
  const response = await postOpenAi(
    `${endpointOf(settings)}/chat/completions`,
    { "Content-Type": "application/json", ...authHeaders(findProvider(settings.provider), settings) },
    {
      model: settings.model,
      messages: messages.map(openAiMessage),
      max_tokens: MAX_TOKENS,
      tools: tools.map((tool) => ({
        type: "function",
        function: { name: tool.name, description: tool.description, parameters: tool.schema },
      })),
    },
    signal,
  );
  if (!response.ok) {
    const detail = await errorDetail(response);
    // A server without tool support says so at 400 or 404; that is a fallback,
    // not a failure, and the difference matters to whether the user sees an error.
    if ((response.status === 400 || response.status === 404) && /tool|function/i.test(detail)) {
      return { text: "", calls: [], toolsUsed: false };
    }
    throw new Error(`LLM request failed (HTTP ${response.status}): ${detail}`);
  }
  const data = (await response.json()) as {
    choices?: Array<{
      message?: {
        content?: string | null;
        tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>;
      };
      finish_reason?: string;
    }>;
    usage?: { prompt_tokens?: number; completion_tokens?: number };
  };
  if (data.usage) {
    options.onUsage?.({ input: asNumber(data.usage.prompt_tokens), output: asNumber(data.usage.completion_tokens) });
  }
  const message = data.choices?.[0]?.message;
  const calls: ToolCall[] = [];
  for (const call of message?.tool_calls ?? []) {
    if (!call.function?.name) continue;
    let input: Record<string, unknown> = {};
    try {
      input = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
    } catch {
      // Malformed arguments are the model's mistake to correct, and it can only
      // do that if the call still arrives with the name attached.
      input = {};
    }
    calls.push({ id: call.id ?? "", name: call.function.name, input });
  }
  return { text: message?.content ?? "", calls, toolsUsed: true };
}

/**
 * SSE `data:` payloads in order. Servers split events across chunks and some
 * send comment lines as keep-alives, so the buffer is drained by blank line
 * rather than by chunk.
 */
async function* sseData(response: Response): AsyncGenerator<string> {
  const body = response.body;
  if (!body) throw new Error("The server sent no response body to stream.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let split = buffer.indexOf("\n\n");
      while (split !== -1) {
        const event = buffer.slice(0, split);
        buffer = buffer.slice(split + 2);
        for (const line of event.split("\n")) {
          if (line.startsWith("data:")) yield line.slice(5).trim();
        }
        split = buffer.indexOf("\n\n");
      }
    }
  } finally {
    reader.releaseLock();
  }
}

const asNumber = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/**
 * Post an OpenAI-wire body, renaming the token cap once if the server asks.
 * Reasoning models (o-series, gpt-5) reject `max_tokens` outright and want
 * `max_completion_tokens`, so sending only one of them locks those out.
 */
async function postOpenAi(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<Response> {
  const response = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify(body) });
  if (response.status !== 400) return response;
  const detail = await errorDetail(response.clone());
  if (!/max_completion_tokens/i.test(detail)) return response;
  const { max_tokens: cap, ...rest } = body;
  return fetch(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify({ ...rest, max_completion_tokens: cap }),
  });
}

async function chatOpenAi(
  settings: LlmSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: ChatOptions = {},
): Promise<string> {
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(findProvider(settings.provider), settings),
  };
  const url = `${endpointOf(settings)}/chat/completions`;
  // Without a cap a self-hosted server allows the whole context window, and
  // a reasoning model will spend it: one tool choice ran past 15k tokens.
  const body = { model: settings.model, messages, max_tokens: MAX_TOKENS };
  if (options.onDelta) {
    const streamed = await streamOpenAi(url, headers, body, signal, options);
    if (streamed !== null) return streamed;
  }
  const response = await postOpenAi(url, headers, body, signal);
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

/**
 * Streams an OpenAI-wire reply, or returns null so the caller falls back to the
 * one-shot request. Servers that do not support SSE are common on the local
 * tier, and a failed stream must never lose the answer.
 */
async function streamOpenAi(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: ChatOptions,
): Promise<string | null> {
  let response: Response;
  try {
    response = await postOpenAi(url, headers, { ...body, stream: true }, signal);
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  if (!response.ok) {
    // A real error still has to surface; only a refusal to stream falls back.
    if (response.status === 400 || response.status === 404) return null;
    throw new Error(`LLM request failed (HTTP ${response.status}): ${await errorDetail(response)}`);
  }
  if (!/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) return null;

  let text = "";
  let usage: ChatUsage | null = null;
  let finish = "";
  for await (const payload of sseData(response)) {
    if (payload === "[DONE]") break;
    let event: {
      choices?: Array<{ delta?: { content?: string }; finish_reason?: string }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    const chunk = event.choices?.[0]?.delta?.content;
    if (chunk) {
      text += chunk;
      options.onDelta?.(chunk);
    }
    if (event.choices?.[0]?.finish_reason) finish = event.choices[0].finish_reason as string;
    if (event.usage) {
      usage = { input: asNumber(event.usage.prompt_tokens), output: asNumber(event.usage.completion_tokens) };
    }
  }
  if (usage) options.onUsage?.(usage);
  if (text) return text;
  if (finish === "length") {
    throw new Error(
      `The model used all ${MAX_TOKENS} tokens without answering. Reasoning models can do this on long prompts; try a shorter question or turn thinking off on the server.`,
    );
  }
  // An empty stream is more likely a server that ignored `stream` than a model
  // with nothing to say, so let the one-shot path decide.
  return null;
}

async function streamAnthropic(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
  signal: AbortSignal | undefined,
  options: ChatOptions,
): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(url, { method: "POST", signal, headers, body: JSON.stringify({ ...body, stream: true }) });
  } catch (err) {
    if (signal?.aborted) throw err;
    return null;
  }
  if (!response.ok) {
    if (response.status === 400 || response.status === 404) return null;
    throw new Error(`LLM request failed (HTTP ${response.status}): ${await errorDetail(response)}`);
  }
  if (!/text\/event-stream/i.test(response.headers.get("content-type") ?? "")) return null;

  let text = "";
  let input = 0;
  let output = 0;
  for await (const payload of sseData(response)) {
    let event: {
      type?: string;
      delta?: { type?: string; text?: string };
      message?: { usage?: { input_tokens?: number; output_tokens?: number } };
      usage?: { input_tokens?: number; output_tokens?: number };
      error?: { message?: string };
    };
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "error") throw new Error(event.error?.message ?? "The assistant stream failed");
    if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
      text += event.delta.text;
      options.onDelta?.(event.delta.text);
    }
    if (event.type === "message_start") input = asNumber(event.message?.usage?.input_tokens);
    if (event.usage?.output_tokens) output = asNumber(event.usage.output_tokens);
  }
  if (input || output) options.onUsage?.({ input, output });
  return text || null;
}

async function chatAnthropic(
  settings: LlmSettings,
  messages: ChatMessage[],
  signal?: AbortSignal,
  options: ChatOptions = {},
): Promise<string> {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));
  const url = `${endpointOf(settings)}/v1/messages`;
  const headers = {
    "Content-Type": "application/json",
    ...authHeaders(findProvider(settings.provider), settings),
  };
  const body = {
    model: settings.model,
    max_tokens: MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: turns,
  };
  if (options.onDelta) {
    const streamed = await streamAnthropic(url, headers, body, signal, options);
    if (streamed !== null) return streamed;
  }
  const response = await fetch(url, {
    method: "POST",
    signal,
    headers,
    body: JSON.stringify(body),
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
