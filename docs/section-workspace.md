# Section Workspace

Section Workspace turns a 3D cut into a linked 2D plan or elevation. Load a
model, then open **Section Workspace** from **Plugins**.

## Create a drawing

1. Choose **Plan / Y**, **Section / X**, or **Section / Z**.
2. Enter a cut position. For a plan, you can choose a storey instead.
3. Use **Keep positive** or **Keep negative** to choose the visible side.
4. Select **Align 3D** to face the cut directly.

Moving the matching section plane in 3D also updates the drawing.

## Work with the 2D view

- Select a contour to select its element in 3D.
- Double-click a contour to frame the element.
- Scroll to zoom and drag empty space to pan.
- Use `+` and `-` to zoom, arrow keys to pan, `0` to fit all, and `F` to fit
  the selection.

Solid lines are closed contours. Dashed lines are open contours. Open lines can
come from an open mesh, missing geometry, or a cut at a mesh boundary.

The grid uses model metres in the projected plane. The orange crosshair marks
the projected model datum. The scale rail and coordinate labels stay the same
size on screen while you zoom.

If the status says the drawing is partial, first hide or isolate unrelated
geometry. Increase **Drawing detail** only if you still need more contours.

The status also shows intersected elements, path count, open paths, and worker
time. The old drawing remains interactive while a new cut is being calculated,
so the panel does not lock during an update.

## Export

Select **Export SVG** to save the current drawing as a vector file. The export
stores the cut axis, position, and mesh origin in its metadata.

!!! note
    The drawing uses the model's display mesh. It is suitable for coordination,
    but it is not an exact BRep drawing and does not perform hidden-line removal.

The work stays in your browser. Saved viewpoints keep the section plane, camera,
and other view settings.

The browser applies model placements, origin shifts, and federation offsets
before making contours. Exact curves, DXF, PDF, hidden-line drawings, and large
batch exports need a native provider with a separate fidelity label.

## Use it with the assistant

The assistant can run `sectionContours` to summarize the active cut. It receives
element counts and path summaries, not the raw 2D coordinates. Evidence links
can select or isolate the matching elements in your viewer.
