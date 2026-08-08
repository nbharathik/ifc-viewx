import type { ResultHandle } from "../capabilities/results.js";
import type { ChatMessage, ChatUsage, ToolCall } from "../llm/llmClient.js";

export interface ViewImageAttachment {
  mimeType: "image/jpeg" | "image/png";
  dataUrl: string;
  width: number;
  height: number;
  explicit: true;
}

export interface ViewerContextSnapshot {
  version: 1;
  revision: string;
  capturedAt: number;
  models: Array<{
    index: number;
    name: string;
    visible: boolean;
    elements: number;
    triangles: number;
    transform: [number, number, number];
  }>;
  summary: {
    fileName: string;
    schema: string | null;
    entities: number;
    triangles: number;
    placedElements: number;
    topTypes: Array<{ type: string; count: number }>;
  } | null;
  selection: Array<{ id: number; type: string; name: string; storey: string }>;
  view: {
    camera: { position: number[]; target: number[] };
    sections: Array<{ axis: "x" | "y" | "z"; offset: number; flip: boolean }>;
    sectionBox: { min: number[]; max: number[] } | null;
    plan: boolean;
    visibility: { total: number; hidden: number; manualHidden: number; rules: Array<{ label: string; mode: string; count: number }> };
    modelsHidden: number[];
    recentPick?: { expressId: number; point: number[] };
  };
  workspace: {
    panel: string;
    activeExtension?: string;
    activeResult?: string;
    focusedRow?: number;
  };
  imageAttached: boolean;
}

export type EvidenceKind = "element" | "property" | "result" | "clash" | "check" | "measurement" | "issue";

export interface EvidenceReference {
  id: string;
  kind: EvidenceKind;
  label: string;
  capabilityId: string;
  resultId?: string;
  row?: number;
  elementIds?: number[];
  path?: string;
  value?: unknown;
  point?: [number, number, number];
}

export interface AssistantToolExecution {
  capabilityId: string;
  title: string;
  effect: "read" | "view" | "propose" | "write" | "external";
  report: string;
  value: unknown;
  result?: ResultHandle;
  evidence: EvidenceReference[];
}

export interface AssistantTurnResult {
  text: string;
  calls: ToolCall[];
  toolsUsed: boolean;
}

export interface AssistantTransportRequest {
  messages: ChatMessage[];
  tools: import("../llm/tools.js").NativeTool[];
  signal: AbortSignal;
  onDelta?(text: string): void;
  onUsage?(usage: ChatUsage): void;
}

export interface AssistantTransport {
  readonly id: string;
  readonly multimodal: boolean;
  converse(request: AssistantTransportRequest): Promise<AssistantTurnResult>;
  complete(request: Omit<AssistantTransportRequest, "tools">): Promise<string>;
}

export type AssistantTraceEvent =
  | { type: "context"; revision: string; imageAttached: boolean }
  | { type: "tool_call"; capabilityId: string }
  | { type: "tool_result"; capabilityId: string; resultId?: string; evidence: string[] }
  | { type: "tool_error"; capabilityId: string; code: "refused" | "stale" | "failed" }
  | { type: "cancel"; targets: Array<"provider" | "geometry" | "local"> };
