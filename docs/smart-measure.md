# Smart Measure

Use Smart Measure to check the gap between two elements or measure along the
X, Y, and Z axes. Load a model, then open **Smart Measure** from **Plugins**.

## Measure a gap

1. Select two elements.
2. Select **Use 2 selected**. You can also set A and B separately.
3. Enter the required clearance in millimetres.
4. Select **Measure gap**.

The result appears as a measurement in the viewer. A value of zero means the
two meshes intersect. If geometry is missing or outside the search range, the
tool reports that instead of showing zero.

### Browser or Local precise

| Mode | Use it for | Geometry |
| --- | --- | --- |
| Browser mesh | Fast coordination checks | The model's display mesh |
| Local precise | A higher-precision review | A tighter IfcOpenShell mesh in Local Studio |

**Local precise** works only when Local Studio has the original IFC file. It
currently supports elements from the primary model. The result is more precise,
but it is still mesh based and is not an exact BRep distance.

The browser query also creates the responsive witness line and viewer context.
Local Studio returns the numeric distance from its tighter tessellation. Both
results include their geometry engine and fidelity so reports do not mix the
two modes silently.

## Use the three-axis laser

1. Select **Pick surface**.
2. Select a point on the model.
3. Adjust the range if needed.

The tool looks in both directions along X, Y, and Z. Each row shows the negative
distance, the picked point, the positive distance, and the full span when both
ends are found.

- **Face surface** turns the camera towards the picked face.
- **Keep axes** saves the live axes as viewer measurements.
- Hidden elements are ignored.

## Saved views and privacy

Saved viewpoints include measurements created by this tool. Live laser lines
disappear when the panel closes.

Browser mode sends no geometry to a server. Local precise mode sends element
IDs to your authenticated Local Studio service, which finds the stored IFC file
from its content hash.

The assistant, browser MCP bridge, extensions, and Smart Measure panel all use
the same typed `distance` and `laser` capabilities. A future provider can add a
true BRep distance kernel through the same Local Studio boundary without
changing the panel workflow.
