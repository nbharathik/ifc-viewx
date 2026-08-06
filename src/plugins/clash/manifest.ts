import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "clash",
  name: "Clash Detection",
  tagline: "Find elements that fight for the same space",
  about:
    "Sweeps two sets of IFC classes against each other and reports every pair whose volumes overlap by more than the tolerance. It works off the bounding boxes the viewer already holds, so a full sweep of a large model takes about a second and no geometry leaves the tab.",
  icon: "alert",
  category: "Coordination",
  keywords: "collision interference coordination mep structure hit ducts pipes",
  tier: "web",
  does: [
    "Any class against any class, with structure and MEP presets",
    "Uniform grid broad phase; overlap volume and depth per hit",
    "Click a hit to isolate the pair and frame it",
    "Full report as CSV",
  ],
});
