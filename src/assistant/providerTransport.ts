import type { ServiceClient } from "../bridge/serviceClient.js";
import {
  chat,
  converse,
  findProvider,
  type LlmSettings,
} from "../llm/llmClient.js";
import type { AssistantTransport, AssistantTransportRequest } from "./types.js";

export class ProviderTransportError extends Error {
  constructor(
    message: string,
    readonly code: "not_configured" | "unsupported" | "provider" | "network" | "cancelled",
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderTransportError";
  }
}

function normalized(error: unknown, signal: AbortSignal): never {
  if (signal.aborted) throw new ProviderTransportError("The assistant turn was cancelled", "cancelled");
  const message = error instanceof Error ? error.message : String(error);
  if (/choose.*provider|api key|not configured/i.test(message)) {
    throw new ProviderTransportError(message, "not_configured");
  }
  if (/reach|network|fetch|unreachable/i.test(message)) {
    throw new ProviderTransportError(message, "network", true);
  }
  throw new ProviderTransportError(message, "provider", /overload|timeout|temporar/i.test(message));
}

export function browserProviderTransport(settings: LlmSettings): AssistantTransport {
  const provider = findProvider(settings.provider);
  return {
    id: `browser:${settings.provider}:${settings.model}`,
    multimodal: provider.multimodal,
    async converse(request: AssistantTransportRequest) {
      try {
        return await converse(settings, request.messages, request.tools, request.signal, {
          onDelta: request.onDelta,
          onUsage: request.onUsage,
        });
      } catch (error) {
        return normalized(error, request.signal);
      }
    },
    async complete(request) {
      try {
        return await chat(settings, request.messages, undefined, request.signal, {
          onDelta: request.onDelta,
          onUsage: request.onUsage,
        });
      } catch (error) {
        return normalized(error, request.signal);
      }
    },
  };
}

export function localProviderTransport(service: ServiceClient): AssistantTransport {
  const llm = service.getHealth()?.llm;
  return {
    id: `local:${llm?.provider ?? "unknown"}:${llm?.model ?? "default"}`,
    multimodal: llm?.multimodal === true,
    async converse(request) {
      try {
        return await service.converse(request.messages, request.tools, request.signal, {
          onDelta: request.onDelta,
          onUsage: request.onUsage,
        });
      } catch (error) {
        return normalized(error, request.signal);
      }
    },
    async complete(request) {
      const result = await this.converse({ ...request, tools: [] });
      if (!result.text) throw new ProviderTransportError("The assistant returned an empty response", "provider");
      return result.text;
    },
  };
}
