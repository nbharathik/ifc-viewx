import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "compare",
  name: "Model Compare",
  tagline: "Diff the open model against an earlier IFC",
  about:
    "Parses a second IFC in a background worker without drawing it, then matches both models by GlobalId to report what was added, removed and changed. Changed elements list the exact attributes and property values that moved, and anything present in the open model can be isolated in place.",
  icon: "compare",
  category: "Quality",
  keywords: "diff revision version change baseline history delta review",
  tier: "web",
  does: [
    "Added, removed, changed and unchanged, matched on GlobalId",
    "Per element list of the attributes and properties that changed",
    "Isolate added or changed elements in the viewport",
    "CSV export of the change report",
  ],
});
