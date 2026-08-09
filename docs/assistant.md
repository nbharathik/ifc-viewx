# Assistant and viewer integration

The assistant works on the model that is already open. It does not receive the
IFC file or renderer buffers. Instead, each turn begins with a compact snapshot
of the current viewer state and can call the same typed capabilities used by
extensions and the browser MCP bridge.

## What a provider receives

A configured remote provider receives:

- the system instructions and the question;
- a compact `VIEWER_CONTEXT_V1` snapshot with the model summary, current
  selection, camera, sections, visibility state, active panel, and active
  result handle;
- the most recent real viewport pick, including its precise face, edge or vertex kind when one exists;
- tool schemas and the bounded reports returned by tools;
- a viewport image only when you press the camera button for that turn.

The IFC file, mesh buffers, provider key, and complete result arrays are not
sent. The image attachment is removed from saved chat data after the turn. A
normal turn does not capture an image at all.

Local Studio can hold the provider key and proxy turns through the same tool
protocol. Set `IFCVIEWX_LLM_MULTIMODAL=1` only when that configured provider
accepts images. Local Studio records that an image was attached, but does not
write its contents to the audit log.

## Viewer context and grounding

The structured context tells the assistant what is selected, hidden, clipped,
or currently active. Selection can be removed from a turn with its attachment
chip. The optional image adds visual context and enables `view.pickAt`, which
maps normalized image coordinates back to the viewer's local picking result.

Tool reports include local evidence references such as `[E3]`. References are
shown below the answer. Selecting one opens the related elements or result row
in the viewer, selects its geometry, and frames it where possible.

Evidence is not a web citation. It is a local pointer into the exact tool result
used during the turn.

The `laser` capability can reuse the most recent surface pick or a point
returned by `view.pickAt`. It casts to visible geometry on both sides of X, Y,
and Z, creates reversible measurement spans, and returns one evidence row per
axis hit.

The `sectionContours` capability reuses the active X, Y, or Z cut, or creates
one at the model midpoint. It synchronizes that plane with the 3D view and
returns one compact row per intersected element with open and closed path
counts. Raw 2D points stay in the browser drawing. Rows receive result handles
and local evidence links, so a follow-up can group, select, or isolate them
without rerunning the cut.

## Result handles

Search, schedule, clash, check, and other row-oriented capabilities can return
a result handle. The assistant can then use:

- `result.page` to read a bounded page;
- `result.group` to group existing rows by storey, type, kind, or another field;
- `result.open` to make a result or row active;
- `result.select` and `result.isolate` to act on referenced elements;
- `issue.stage` in Edit mode to prepare a BCF issue payload for review.

Bundled and installed SDK v2 extensions use the same bounded result store.
When an extension such as Model Compare creates a result, that handle becomes
the active viewer result and the same page, group, open and selection follow-ups
work without rescanning the model.

Clash rows include `severity`, `classPair`, `level`, `primary`, and `kind`, so
the assistant can turn a large sweep into coordination groups before it opens,
isolates, or stages selected rows as an issue. The full clash row set enters
the bounded result store, while the initial answer still shows only the worst
bounded page.

The source analysis is not rerun for these steps. Reports keep at most 40 rows
in conversation history, while the bounded local result store retains the full
working set. Handles are rejected after the model revision changes.

## Effects and approval

Capabilities declare an effect:

| Effect | Assistant behavior |
| --- | --- |
| Read | Allowed in Query and Edit modes |
| View | Allowed and captured in one reversible view transaction |
| Propose | Allowed only in Edit mode and staged for user approval |
| Write or external | Never exposed to the assistant |

If an answer isolates elements, changes a section, moves the camera, or adds a
measurement, a single **Restore previous view** action returns the camera,
selection, visibility, sections, model visibility, categories, and added
measurements to their prior state.

Model edits still use the existing pending-edit bar. The assistant cannot apply
them. Generated Python is displayed for review and is never executed by the
assistant.

## Extension tools

An extension with `assistant.contribute` can declare an `assistantTools`
contribution that references a registered capability. Each contribution is
disabled by default. It appears under **Assistant settings > Extension tools**,
where it can be enabled or disabled independently.

Approval does not bypass the capability policy. Write and external effects
remain unavailable, Query mode still refuses proposals, and a capability owned
by another extension cannot be enabled through a mismatched declaration.

## Cancellation and streaming

OpenAI-compatible and Anthropic transports stream prose while buffering tool
argument fragments until complete JSON is available. Local Studio normalizes
both provider formats into the same event stream.

Pressing Stop aborts the provider request and passes the same signal to browser
geometry and Local Studio work. No result from the cancelled turn is allowed to
change a later model session.

## Browser and Local Studio split

Assistant orchestration, viewer context, result handles, evidence, permissions,
and view transactions run in the browser. This keeps interaction immediate and
ensures that all view effects use the open model.

Local Studio is used for provider-key custody and for native capabilities that
need exact geometry, large batch processing, or a trusted local package. Those
jobs still enter through the same capability policy and cancellation path.
