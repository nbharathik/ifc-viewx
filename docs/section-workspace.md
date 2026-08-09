# Section Workspace

Section Workspace turns the active 3D cut into a synchronized 2D drawing. Open
it from the plugin browser after loading a model.

## Build a plan or elevation

1. Choose **Plan / Y**, **Section / X**, or **Section / Z**.
2. Enter an exact model-space cut height, or choose a storey for a plan.
3. Move the normal section plane in the main viewer when you need a visual
   adjustment. The drawing rebuilds after the movement settles.
4. Use **Keep positive / Keep negative** to flip the visible half and
   **Align 3D** to look square at the cut.

The 2D sheet and the 3D view share the same plane. Clicking a contour selects
its IFC element in 3D. Double clicking frames it. Selecting in 3D highlights
the corresponding contour in the sheet.

## Read the drawing

The grid uses model metres in the projected plane. The orange crosshair marks
the projected model datum. Solid paths are closed loops. Dashed paths are open
chains, which can come from an open product mesh, a missing retained geometry
chunk, or a cut that reaches a mesh boundary.

Scroll over the sheet to zoom. Drag empty sheet space to pan; Shift-drag or
middle-drag also works when the pointer is over dense linework. The on-sheet
buttons zoom, fit the complete drawing, or fit only selected contours. The
scale rail and coordinate labels keep a stable screen size as the view moves.

With keyboard focus on the sheet, use `+` and `-` to zoom, arrow keys to pan,
`0` to fit everything, and `F` to fit selected contours.

The compact status strip reports intersected elements, paths, open chains, and
worker time. Open-path guidance is expandable instead of permanently taking
space from the drawing. If the segment budget is reached, the drawing is
labeled partial. Raise **Drawing detail** only when the visible scope needs it;
isolating or hiding unrelated geometry is usually faster.

The previous drawing remains interactive while a new cut is calculated. Plane
controls are persistent, so rebuilding does not take keyboard focus from the
cut-height field.

## Export and fidelity

**Export SVG** writes the current element-owned contours as a standalone
vector drawing. Its metadata identifies the axis, offset, and mesh origin.

The browser intersects the same tessellated geometry used for display. This is
fast, private, and appropriate for coordination, but it is not an exact BRep
drawing. Exact curves, hidden-line removal, DXF, PDF, and oversized batch work
belong to a future optional Local Studio provider with a separate fidelity
label.

The browser sends no geometry to a server. Section plane state already belongs
to saved viewpoints, so saving a view restores the cut with the camera and
other view state.

## Assistant use

The assistant and browser MCP bridge expose `sectionContours`. Ask for a plan
or section analysis to synchronize the 3D plane and receive bounded rows for
each intersected element, including open and closed path counts and total cut
length. The assistant receives summaries, not raw contour coordinates. Result
rows and evidence links remain local and can select or isolate the related
elements.
