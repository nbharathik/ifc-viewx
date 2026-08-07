import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "clash",
  name: "Clash Detection",
  tagline: "Find elements that fight for the same space",
  about:
    "Sweeps two sets of IFC classes against each other and reports every pair whose meshes actually intersect. Boxes and BVH nodes only narrow the search; the answer comes from triangle-level intersection of the geometry the viewer already loaded, so a hit is a real collision rather than two boxes overlapping. Set a clearance and it also reports pairs that pass closer than they should. The work runs in a worker, so the viewport keeps drawing while a full discipline is swept, and no geometry leaves the tab.",
  icon: "alert",
  category: "Coordination",
  keywords: "collision interference coordination mep structure hit ducts pipes clearance bvh",
  tier: "web",
  does: [
    "Any class against any class, with structure and MEP presets",
    "Triangle-level mesh intersection, with penetration depth per hit",
    "Clearance checking against the true minimum distance between surfaces",
    "Click a hit to isolate the pair and zoom to the collision itself",
    "Full report as CSV, with GlobalId and the clash position",
  ],
});
