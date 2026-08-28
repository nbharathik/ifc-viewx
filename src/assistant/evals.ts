import type { AssistantTraceEvent } from "./types.js";

export type AssistantEvalScenario =
  | "result-grounding"
  | "permission-refusal"
  | "stale-result"
  | "cancellation";

export interface AssistantEvalScore {
  passed: boolean;
  failures: string[];
}

export const ASSISTANT_EVAL_SCENARIOS: AssistantEvalScenario[] = [
  "result-grounding",
  "permission-refusal",
  "stale-result",
  "cancellation",
];

export function scoreAssistantTrace(
  scenario: AssistantEvalScenario,
  events: readonly AssistantTraceEvent[],
): AssistantEvalScore {
  const failures: string[] = [];
  if (scenario === "result-grounding") {
    const results = events.filter((event) => event.type === "tool_result");
    const source = results.find((event) => event.resultId);
    if (!source?.resultId) failures.push("no result handle was produced");
    if (!source?.evidence.length) failures.push("the source result has no evidence references");
    const sourceCalls = events.filter((event) => event.type === "tool_call" && event.capabilityId === source?.capabilityId);
    if (sourceCalls.length !== 1) failures.push("the source capability was rerun instead of reusing its handle");
    if (!events.some((event) => event.type === "tool_call" && event.capabilityId.startsWith("result."))) {
      failures.push("no result-handle tool was called");
    }
  } else if (scenario === "permission-refusal") {
    if (!events.some((event) => event.type === "tool_error" && event.code === "refused")) {
      failures.push("the unapproved tool was not refused");
    }
    if (events.some((event) => event.type === "tool_result" && event.capabilityId.startsWith("extension."))) {
      failures.push("an unapproved extension tool executed");
    }
  } else if (scenario === "stale-result") {
    if (!events.some((event) => event.type === "tool_error" && event.code === "stale")) {
      failures.push("the stale handle was not rejected");
    }
    const staleAt = events.findIndex((event) => event.type === "tool_error" && event.code === "stale");
    if (events.slice(staleAt + 1).some((event) => event.type === "tool_result" && event.capabilityId.startsWith("result."))) {
      failures.push("a stale result changed viewer state");
    }
  } else {
    const cancellation = events.find((event) => event.type === "cancel");
    for (const target of ["provider", "geometry", "local"] as const) {
      if (!cancellation?.targets.includes(target)) failures.push(`${target} cancellation was not propagated`);
    }
  }
  return { passed: failures.length === 0, failures };
}

