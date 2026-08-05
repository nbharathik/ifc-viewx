// Prompt contract for the assistant, gated on the mode the user picked. Query
// mode offers reading and view control only; edit mode adds typed property ops,
// which never touch geometry, so the viewer keeps its meshes.
//
// Generated Python is never executed for the assistant, in any session and on
// any tier. It may write code, and the app shows that code to the user, who
// decides whether to run it in the Python Console. The assistant's own reach
// stops at the typed tools below.
import type { AssistantMode } from "./llmClient.js";
import { toolBlock } from "./tools.js";

const QUERY_RULE = `MODE: QUERY (read-only). You may inspect anything and change what is shown in 3D, but you may not
change the model. Edit ops and \`\`\`python edit\`\`\` are refused before they run, so do not attempt them: if the user
asks for a change, say Edit mode is needed and describe exactly what you would do there.`;

const EDIT_RULE = `MODE: EDIT (properties only). You may read, and you may stage changes to non-geometric data:
names, descriptions, tags, object types and property values. You may NOT create or delete entities, and you may not
touch geometry, placement, quantities or the spatial tree. That restriction is what keeps the 3D view from reloading,
so treat it as absolute rather than a preference. If a request needs geometry, say so and stop.`;

const VIEWER_ACTIONS = `VIEWER ACTIONS: a \`\`\`viewer block with one JSON object. Instant, and always available.
${toolBlock("viewer")}`;

const EDIT_ACTIONS = `EDIT ACTIONS: an \`\`\`edit block with one JSON object. These change the model, so they run on a
disposable copy and the user must click Apply. Never say a change is applied; say it is staged for review.
${toolBlock("edit")}
There is no delete op and no create op in this mode: both change what the viewer has to draw.
Always get ids from a \`\`\`viewer find first. Never guess an id. Report the measured diff you get back.`;

/**
 * Reports are capped so a table cannot swamp the context, which makes the
 * shown count a lie unless the model is told to read the flag instead.
 */
const TRUNCATION_RULE = `TRUNCATED REPORTS: a report carrying "truncated": true is partial. Use its "matches" or "total" for
the real count and never present the listed rows as the whole set; narrow the query if the user needs them all.`;

const PYTHON_RULE = (mode: AssistantMode): string => `PYTHON IS NEVER RUN FOR YOU. Not in this tab, not on any service,
whatever the user has connected. The actions above are your tools, and they cover reading, QA, schedules, IDS and
clash${mode === "edit" ? ", renaming and property edits" : ""}.
Reach for Python only when something genuinely needs it: geometry math, creating new entities, or analysis across
thousands of elements. In that case say in one sentence what it needs and why, then write the IfcOpenShell code in a
\`\`\`python block. It will NOT be executed. The app shows it to the user, who can run it themselves in the Python
Console. Never describe the result of code that has not run, and never say you ran it.`;

export function systemPrompt(brief: string | null, mode: AssistantMode): string {
  return [
    "You are the assistant inside IFCViewX, a fast local IFC viewer. Everything runs on the user's machine; nothing is uploaded.",
    brief ?? "No model is loaded yet.",
    mode === "edit" ? EDIT_RULE : QUERY_RULE,
    "You can call tools by replying with exactly ONE fenced code block; its execution report arrives as the next user message. When you have what you need, reply in plain text. Prefer viewer actions: they are instant.",
    VIEWER_ACTIONS,
    mode === "edit" ? EDIT_ACTIONS : "",
    PYTHON_RULE(mode),
    TRUNCATION_RULE,
    "Ground every numeric claim in a tool report. If the request is ambiguous, ask before acting.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function repairPrompt(error: string): string {
  return `The tool call failed. Fix it and reply with a corrected block of the same kind. Error report:\n\n${error}`;
}

export interface ExtractedCode {
  code: string;
  kind: "query" | "edit" | "viewer" | "modelEdit";
}

/**
 * Which tool a bare JSON payload is. Models label these blocks `json` far more
 * often than they use our fence names, so the payload decides: viewer actions
 * carry `action`, edits carry `op`, and the two never overlap.
 */
function classifyJson(body: string): "viewer" | "modelEdit" | null {
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    if (typeof value.op === "string") return "modelEdit";
    if (typeof value.action === "string") return "viewer";
  } catch {
    return null;
  }
  return null;
}

/** Pull the first tool block out of an LLM reply, whichever kind comes first. */
export function extractCode(reply: string): ExtractedCode | null {
  const found: Array<{ at: number; block: ExtractedCode }> = [];

  const viewer = /```viewer\s*\n([\s\S]*?)```/.exec(reply);
  if (viewer) found.push({ at: viewer.index, block: { code: viewer[1].trim(), kind: "viewer" } });

  const modelEdit = /```edit\s*\n([\s\S]*?)```/.exec(reply);
  if (modelEdit) found.push({ at: modelEdit.index, block: { code: modelEdit[1].trim(), kind: "modelEdit" } });

  const python = /```python[ \t]*(query|edit)?\s*\n([\s\S]*?)```/.exec(reply);
  if (python) {
    const kind = python[1] === "edit" || /def\s+edit\s*\(/.test(python[2]) ? "edit" : "query";
    found.push({ at: python.index, block: { code: python[2].trim(), kind } });
  }

  for (const match of reply.matchAll(/```(?:json)?[ \t]*\n([\s\S]*?)```/g)) {
    const body = match[1].trim();
    const kind = classifyJson(body);
    if (kind) found.push({ at: match.index, block: { code: body, kind } });
  }

  found.sort((a, b) => a.at - b.at);
  return found[0]?.block ?? null;
}

/**
 * The reply without the block that was extracted as a call. The transcript
 * shows that block as a tool card, so leaving the fence in the prose would
 * print the same JSON twice.
 */
export function stripBlock(reply: string, code: string): string {
  return reply
    .replace(/```[\w ]*\n([\s\S]*?)```/g, (whole, body: string) => (body.trim() === code ? "" : whole))
    .trim();
}
