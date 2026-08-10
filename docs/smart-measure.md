# Smart Measure

Smart Measure is the first Phase 7 geometry workflow. Open it from the plugin
browser after loading a model. It combines object clearance checks and a
three-axis surface laser in one panel.

## Shortest object distance

1. Select two elements in the viewer.
2. Press **Use 2 selected**, or assign A and B separately.
3. Enter the required clearance in millimetres.
4. Press **Measure gap**.

The browser measures the shortest distance between the retained triangle
surfaces in the geometry worker. The witness segment becomes an ordinary
viewer measurement. A zero result means the meshes intersect. Missing retained
geometry and results beyond the requested range are reported instead of being
treated as zero.

When Local Studio holds the original IFC source, **Local precise** routes the
numeric distance through the built-in IfcOpenShell provider with a tighter
native tessellation. The browser mesh query still supplies the responsive
witness line and viewer context. Local mode currently supports elements from
the primary IFC source.

## Three-axis laser

Press **Pick surface**, then click the model where the laser should sit. The
geometry worker casts along positive and negative X, Y, and Z to the next
visible mesh. The source element is excluded from the six hits so its opposite
face does not hide the surrounding space.

Each axis row shows:

- the distance in the negative direction;
- the picked origin;
- the distance in the positive direction;
- the complete span when both surfaces were found.

The range control bounds the search. Hidden elements are excluded. Press
**Face surface** to align the camera perpendicular to the picked face. Press
**Keep axes** to turn the live axes into persistent measurement annotations.

## Persistence and privacy

Kept object witnesses and laser axes are normal browser measurement objects.
Saved viewpoints store their endpoints and restore them with the camera and
cuts. Live laser overlays are removed when the panel closes.

Browser mode sends no geometry anywhere. Local precise mode sends only typed
element IDs to the authenticated Local Studio job API. The service resolves
the stored IFC source by its existing content hash; the extension receives no
file path, session token, or native provider object.

## Fidelity

| Mode | Runs in | Geometry | Best for |
| --- | --- | --- | --- |
| Browser mesh | Geometry worker | Display tessellation | Interactive coordination and laser work |
| Local precise | Local Studio | Tightly tessellated IFC product shapes | Higher-precision clearance review |

Both routes return explicit fidelity and engine metadata. The assistant,
browser MCP bridge, SDK extensions, and the panel use the same typed
`distance` and `laser` capabilities.

The built-in local route reports `native-mesh`, not `exact`. A provider backed
by a true BRep distance kernel can be added later through the same Local Studio
capability boundary without changing the browser workflow.
