import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "spaces",
  name: "Room Book",
  tagline: "Every space with its area, volume and occupancy",
  about:
    "Lists every IfcSpace with the areas and volumes the file authored, rolled up by storey. Where a space carries no quantities the footprint of its bounding box fills the gap, and each row says which it is, so a schedule is never quoted from an estimate by accident. Spaces are excluded from the default geometry stream, so the panel loads them on demand when you ask to see one.",
  icon: "layers",
  category: "Data",
  keywords: "space room area gross net occupancy schedule room book gfa nfa boma",
  tier: "web",
  does: [
    "Net and gross floor area, volume, height and perimeter per space",
    "Rolled up by storey, with the storey totals a schedule needs",
    "Occupancy and category read from Pset_SpaceCommon where present",
    "Click a room to isolate it; CSV export of the whole book",
  ],
});
