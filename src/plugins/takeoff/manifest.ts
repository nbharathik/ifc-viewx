import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "takeoff",
  name: "Quantity Takeoff",
  tagline: "Volumes, areas and counts rolled up by class and storey",
  about:
    "Reads the base quantities authored in the file (Qto_*, plus quantity-shaped properties) for every placed element and aggregates them. Where an element carries no quantities the bounding box fills the gap, and each row says how much of the total is authored rather than estimated.",
  icon: "calculator",
  category: "Data",
  keywords: "qto quantities volume area boq bill of quantities cost estimate",
  tier: "web",
  does: [
    "Group by class, by storey, or by both",
    "Net and gross volume, area, length and count",
    "Coverage column: how much of the group carries real quantities",
    "Click a row to isolate the group; export the table as CSV",
  ],
});
