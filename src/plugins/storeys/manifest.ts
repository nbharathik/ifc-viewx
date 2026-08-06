import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "storeys",
  name: "Storey Navigator",
  tagline: "Walk the building one level at a time",
  about:
    "Lists every storey with its elevation and how much sits on it, and isolates one with a click. The camera stays put as you step up and down, which is what makes comparing levels readable, and the ceiling cut drops a section under the level above so you look into the storey instead of at its slab.",
  icon: "layers",
  category: "Navigation",
  keywords: "level floor storey plan section isolate walk elevation",
  tier: "web",
  does: [
    "Every storey with elevation and element count",
    "Isolate a level without moving the camera",
    "Ceiling cut for a plan style look into the level",
    "Step up and down through the building",
  ],
});
