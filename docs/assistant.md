# Assistant

The assistant answers questions about the model that is open in IFCViewX. It
can also select, isolate, frame, measure, and prepare edits for your approval.

## Set it up

1. Open **Assistant**.
2. Open **Assistant settings**.
3. Choose a provider and model, add your API key, and verify the connection.

In the browser version, the key stays in that browser. With
[Local Studio](local-studio.md), the local service can hold the key instead.

## Ask clear questions

Tell the assistant what you want to find or change. For example:

- "Find external walls on level 2."
- "Isolate doors with a fire rating."
- "Group these clashes by storey."
- "Create a section through the selected elements."

The assistant starts each turn with a small summary of the current viewer state,
including the selection, camera, sections, visibility, and active result.

When a question depends on an exact point, the assistant can use your latest
surface pick. If you attach a viewport image, it can also map a point in that
image back to a local viewer pick. The geometry lookup still happens in your
browser.

## What leaves your computer

A remote AI provider receives:

- your question and the assistant instructions;
- a compact viewer summary;
- small tool reports needed to answer the question;
- the current viewport image only when you attach it for that turn.

The IFC file, renderer buffers, raw contour points, and complete result tables
are not sent. An attached image is removed from saved chat data after the turn.

!!! tip
    Remove the selection chip if you do not want the current selection included
    in a turn. Leave the camera attachment off when an image is not needed.

## Query and Edit modes

| Action | Query mode | Edit mode |
| --- | --- | --- |
| Read model data | Allowed | Allowed |
| Change the view | Allowed and reversible | Allowed and reversible |
| Prepare an edit | Not allowed | Staged for your approval |
| Apply an edit or run code | Never | Never |

The assistant cannot apply model edits or run generated Python. Proposed edits
appear in the normal pending-edit bar. Python appears in the console for you to
review and run.

If a reply changes the view, select **Restore previous view** to restore the
camera, selection, visibility, sections, colors, and added measurements.

## Evidence and result sets

Evidence links such as `[E3]` point to local viewer results. Select a link to
open, select, or frame the related elements. These are local pointers, not web
citations.

Large searches, schedules, clashes, and checks stay in a local result set. The
assistant can page, group, select, or isolate those rows without running the
analysis again. A result expires when the model changes.

The same result store is used by bundled and installed extensions. For example,
the assistant can group or isolate rows created by Model Compare without
scanning the baseline again. Only a small page of rows enters the conversation;
the complete working set stays in the viewer.

??? info "Geometry tools and local evidence"
    The `laser` tool uses the latest surface pick and looks for visible geometry
    on both sides of X, Y, and Z. Its measurement lines are reversible.

    The `sectionContours` tool reuses the active X, Y, or Z cut, or creates one
    at the model midpoint. It returns one summary row per intersected element.
    Raw contour coordinates remain in Section Workspace.

    Result tools can page, group, open, select, or isolate existing rows. In
    Edit mode, `issue.stage` can prepare a BCF issue for review. None of these
    actions applies a model edit.

## Extension tools

Extensions can add assistant tools with the `assistant.contribute` permission.
Each tool starts disabled. Enable it under **Assistant settings > Extension
tools**. Enabling a tool does not give it permission to write, call external
services, or bypass Query mode.

## Stop a request

Select **Stop** to cancel the provider request and any linked browser or Local
Studio work. A cancelled turn cannot update a later model session.

Responses from OpenAI-compatible and Anthropic providers stream as they arrive.
Tool arguments are used only after a complete valid JSON value has arrived.

## Browser and Local Studio responsibilities

The browser owns the conversation, viewer context, permissions, evidence,
results, and reversible view changes. Local Studio can hold the provider key
and run trusted native capabilities that need exact geometry or large batch
work. Both paths use the same permission and cancellation rules.
