import { describe, expect, it } from "vitest";
import { ASSISTANT_EVAL_SCENARIOS, scoreAssistantTrace } from "../src/assistant/evals.js";
import type { AssistantTraceEvent } from "../src/assistant/types.js";

describe("deterministic assistant eval traces", () => {
  it("covers grounding, permissions, stale state and cancellation", () => {
    expect(ASSISTANT_EVAL_SCENARIOS).toEqual([
      "result-grounding",
      "permission-refusal",
      "stale-result",
      "cancellation",
    ]);
  });

  it("accepts a grounded result-reuse trace", () => {
    const trace: AssistantTraceEvent[] = [
      { type: "context", revision: "model-a", imageAttached: false },
      { type: "tool_call", capabilityId: "find" },
      { type: "tool_result", capabilityId: "find", resultId: "result_1", evidence: ["E1", "E2"] },
      { type: "tool_call", capabilityId: "result.group" },
      { type: "tool_result", capabilityId: "result.group", evidence: ["E3"] },
    ];
    expect(scoreAssistantTrace("result-grounding", trace)).toEqual({ passed: true, failures: [] });
  });

  it("detects a repeated scan and missing evidence", () => {
    const trace: AssistantTraceEvent[] = [
      { type: "tool_call", capabilityId: "find" },
      { type: "tool_result", capabilityId: "find", resultId: "result_1", evidence: [] },
      { type: "tool_call", capabilityId: "find" },
    ];
    const score = scoreAssistantTrace("result-grounding", trace);
    expect(score.passed).toBe(false);
    expect(score.failures.join(" ")).toMatch(/evidence|rerun|result-handle/);
  });

  it("scores permission refusal, stale handles and full cancellation", () => {
    expect(scoreAssistantTrace("permission-refusal", [
      { type: "tool_error", capabilityId: "extension.audit", code: "refused" },
    ]).passed).toBe(true);
    expect(scoreAssistantTrace("stale-result", [
      { type: "tool_error", capabilityId: "result.page", code: "stale" },
    ]).passed).toBe(true);
    expect(scoreAssistantTrace("cancellation", [
      { type: "cancel", targets: ["provider", "geometry", "local"] },
    ]).passed).toBe(true);
  });
});

