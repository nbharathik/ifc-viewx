// Score the assistant's tool choice on golden questions, against a real model.
//
// The deterministic loop tests in tests/toolCalling.test.ts prove the wiring.
// This proves the prompt: given a question, does the model reach for the right
// tool first? That is the thing that regresses silently when the prompt is
// edited, and the only way to see it is to ask a real model.
//
// Usage:
//   ANTHROPIC_API_KEY=sk-... node scripts/eval-assistant.mjs
//   OPENAI_API_KEY=sk-... EVAL_MODEL=gpt-4o node scripts/eval-assistant.mjs
// With no key it prints what it would have run and exits 0, so CI stays green
// until someone deliberately wires a key in.

const anthropicKey = process.env.ANTHROPIC_API_KEY;
const openaiKey = process.env.OPENAI_API_KEY;

/** One golden case: the question, and the tool a competent answer starts with. */
export const CASES = [
  { ask: "How many walls are in this model?", expect: ["counts", "find"] },
  { ask: "What storeys does this building have?", expect: ["storeys"] },
  { ask: "Show me only the doors", expect: ["find", "search"] },
  { ask: "Tell me everything about element 1234", expect: ["properties"] },
  { ask: "Are there any quality problems with this file?", expect: ["check"] },
  { ask: "Do the services clash with the structure?", expect: ["clash"] },
  { ask: "Build me a table of doors with their fire ratings", expect: ["schedule"] },
  { ask: "Hide everything except the second floor", expect: ["find", "storeys", "search"] },
  { ask: "Put everything back on screen", expect: ["show"] },
  { ask: "Does this model pass the IDS I loaded?", expect: ["ids"] },
  // The tools added alongside the section box and the ranked index. Each one
  // has a question a competent answer cannot start any other way.
  { ask: "Find the fire rated doors on level 2", expect: ["search", "find"] },
  { ask: "What have I got selected?", expect: ["selection"] },
  { ask: "Why is half the model missing?", expect: ["visibility"] },
  { ask: "Cut the building in half horizontally", expect: ["section"] },
  { ask: "Clip the view to a box around the columns", expect: ["sectionBox", "find", "search"] },
  { ask: "Look at the building from directly above", expect: ["camera"] },
  { ask: "Colour the walls red and the slabs blue", expect: ["color", "find", "search"] },
  { ask: "What is the floor area of each room?", expect: ["categories", "schedule", "find"] },
  { ask: "Bring back the walls I hid earlier, but leave the rest hidden", expect: ["unhide", "visibility"] },
  { ask: "Turn off the services model so I can see the structure", expect: ["models"] },
  { ask: "A prior search returned result_7. Group those rows by storey without searching again.", expect: ["result__group"] },
  { ask: "Open row 12 from the prior result_7 in the viewer.", expect: ["result__open"] },
  { ask: "Isolate rows 2, 4 and 8 from result_7.", expect: ["result__isolate"] },
  { ask: "Group the prior clash result_9 by class pair so I can triage the biggest coordination groups.", expect: ["result__group"] },
  { ask: "From the point I just clicked, measure to the next surfaces on all three axes.", expect: ["laser"] },
  { ask: "Turn the current horizontal cut into a section drawing and tell me which elements have open contours.", expect: ["sectionContours"] },
];

/**
 * Mirrors nativeTools() for the viewer tier, without importing TypeScript.
 * tests/evalHarness.test.ts asserts this matches the real TOOLS registry, so a
 * tool added there and forgotten here fails the suite rather than silently
 * going unscored.
 */
export const TOOLS = [
  ["find", "substring filters; lists elements (id, type, name, storey)", { type: { type: "string" }, name: { type: "string" }, storey: { type: "string" } }, []],
  ["counts", "element counts per IFC class", {}, []],
  ["storeys", "storeys with element summaries", {}, []],
  ["properties", "attributes, psets, quantities of one element", { id: { type: "integer" } }, ["id"]],
  ["select", "highlight and frame elements in 3D; one id or a set", { id: { type: "integer" }, ids: { type: "array", items: { type: "integer" } } }, []],
  ["fit", "frame an element; omit id for the whole model", { id: { type: "integer" } }, []],
  ["isolate", "show only these elements", { ids: { type: "array", items: { type: "integer" } } }, ["ids"]],
  ["hide", "hide these elements", { ids: { type: "array", items: { type: "integer" } } }, ["ids"]],
  ["show", "make everything visible again", {}, []],
  ["check", "structural QA: identity, containment, placement, units, naming", {}, []],
  ["schedule", "table of a class; omit properties to list what is available", { type: { type: "string" }, properties: { type: "array", items: { type: "string" } } }, ["type"]],
  ["ids", "validate against the IDS the user loaded; pass/fail per specification", {}, []],
  ["clash", "triangle-level clash sweep with rows ready to group by severity, classPair, level, primary or kind", { a: { type: "array", items: { type: "string" } }, b: { type: "array", items: { type: "string" } }, tolerance: { type: "number" }, clearance: { type: "number" } }, []],
  ["distance", "exact shortest mesh distance between two elements, with witness points in the viewer", { a: { type: "integer" }, b: { type: "integer" }, maxDistance: { type: "number" } }, ["a", "b"]],
  ["laser", "cast a three-axis laser from a surface point to the next visible meshes", { origin: { type: "array", items: { type: "number" }, minItems: 3, maxItems: 3 }, source: { type: "integer" }, maxDistance: { type: "number" }, includeHidden: { type: "boolean" } }, []],
  ["search", "ranked full-text search over names, classes, storeys and property values; use this before find when the wording is loose", { query: { type: "string" }, limit: { type: "integer" } }, ["query"]],
  ["selection", "what the user has selected right now, with class and name", {}, []],
  ["visibility", "what is hidden and why: counts, named rules, section state, lazy categories", {}, []],
  ["unhide", "make these elements visible again without showing everything", { ids: { type: "array", items: { type: "integer" } } }, ["ids"]],
  ["categories", "spaces and openings are off by default and carry no geometry until switched on", { IfcSpace: { type: "boolean" }, IfcOpeningElement: { type: "boolean" } }, []],
  ["color", "paint groups of elements; omit groups to take the colouring off", { groups: { type: "array", items: { type: "object" } } }, []],
  ["section", "an axis cut, an arbitrary plane via normal, or a cut on the picked face; pass clear to remove", { axis: { type: "string" }, offset: { type: "number" }, normal: { type: "array", items: { type: "number" } }, fromPick: { type: "boolean" }, flip: { type: "boolean" }, clear: { type: "boolean" } }, []],
  ["sectionContours", "build element-owned 2D contour summaries at a cut and synchronize the 3D plane", { axis: { type: "string" }, offset: { type: "number" }, flip: { type: "boolean" }, includeHidden: { type: "boolean" }, maxSegments: { type: "integer" } }, []],
  ["sectionBox", "clip to a box around these elements; pass clear to remove it", { ids: { type: "array", items: { type: "integer" } }, clear: { type: "boolean" } }, []],
  ["camera", "move to a preset viewpoint, or read where the camera is", { view: { type: "string" } }, []],
  ["models", "the federated models with their element counts; pass show/hide to switch a discipline on or off", { show: { type: "array", items: { type: "integer" } }, hide: { type: "array", items: { type: "integer" } } }, []],
  ["result__page", "read a bounded page from a prior result without rerunning its analysis", { handle: { type: "string" }, offset: { type: "integer" }, limit: { type: "integer" } }, ["handle"]],
  ["result__group", "group prior result rows by a field without rerunning the source capability", { handle: { type: "string" }, field: { type: "string" } }, ["handle", "field"]],
  ["result__open", "make a prior result active and return its first page", { handle: { type: "string" }, row: { type: "integer" } }, ["handle"]],
  ["result__select", "select elements referenced by prior result rows", { handle: { type: "string" }, rows: { type: "array", items: { type: "integer" } } }, ["handle"]],
  ["result__isolate", "isolate elements referenced by prior result rows", { handle: { type: "string" }, rows: { type: "array", items: { type: "integer" } } }, ["handle"]],
];

const SYSTEM = `You are the assistant inside IFCViewX, a fast IFC viewer. The IFC file and geometry stay on this device. Compact viewer context and tool reports go to the configured provider.
A model is loaded: 217 entities, classes IfcWall (8), IfcColumn (4), IfcSlab (2), IfcDoor (2), IfcWindow (2), on two storeys.
An IDS document is loaded.
MODE: QUERY (read-only). You may inspect anything and change what is shown in 3D, but you may not change the model.
TOOLS: call them directly through the tool interface. Prefer them to guessing. Reuse result handles through result tools instead of rerunning the source analysis.
Ground every numeric claim in a tool report.`;

async function askAnthropic(ask) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: process.env.EVAL_MODEL || "claude-opus-5",
      max_tokens: 1024,
      system: SYSTEM,
      tools: TOOLS.map(([name, description, properties, required]) => ({
        name,
        description,
        input_schema: { type: "object", properties, required, additionalProperties: false },
      })),
      messages: [{ role: "user", content: ask }],
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === "tool_use").map((b) => b.name);
}

async function askOpenAi(ask) {
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${openaiKey}` },
    body: JSON.stringify({
      model: process.env.EVAL_MODEL || "gpt-4o",
      max_tokens: 1024,
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: ask },
      ],
      tools: TOOLS.map(([name, description, properties, required]) => ({
        type: "function",
        function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } },
      })),
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.tool_calls || []).map((c) => c.function?.name);
}

async function main() {
  const ask = anthropicKey ? askAnthropic : openaiKey ? askOpenAi : null;
  if (!ask) {
    console.log(`No ANTHROPIC_API_KEY or OPENAI_API_KEY set, so nothing was called.`);
    console.log(`${CASES.length} golden cases are ready:`);
    for (const c of CASES) console.log(`  ${c.expect.join(" or ").padEnd(18)} <- ${c.ask}`);
    console.log(`\nSet a key and run again to score them.`);
    return;
  }

  let hits = 0;
  const misses = [];
  for (const testCase of CASES) {
    let called = [];
    try {
      called = await ask(testCase.ask);
    } catch (err) {
      console.error(`  error on "${testCase.ask}": ${err.message}`);
      misses.push({ ...testCase, called: ["<error>"] });
      continue;
    }
    const first = called[0];
    const ok = first !== undefined && testCase.expect.includes(first);
    if (ok) hits += 1;
    else misses.push({ ...testCase, called });
    console.log(`${ok ? "PASS" : "FAIL"}  ${String(first ?? "no tool").padEnd(12)} ${testCase.ask}`);
  }

  const score = ((hits / CASES.length) * 100).toFixed(0);
  console.log(`\nTool choice: ${hits}/${CASES.length} (${score}%)`);
  if (misses.length) {
    console.log(`\nMissed:`);
    for (const m of misses) {
      console.log(`  "${m.ask}"\n    wanted ${m.expect.join(" or ")}, got ${m.called.join(", ") || "nothing"}`);
    }
  }
  // A prompt change that drops below this has regressed, not merely varied.
  if (hits / CASES.length < 0.8) process.exitCode = 1;
}

// Importing this file for its CASES and TOOLS must not fire a hundred API
// calls, so the run only happens when it is the process entry point.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, "/").split("/").pop())) {
  await main();
}
