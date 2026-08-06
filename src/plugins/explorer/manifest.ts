import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "explorer",
  name: "Element Explorer",
  tagline: "A spreadsheet over every element and property in the model",
  about:
    "Indexes every placed element with its class, name, storey and GlobalId, then lets you add any property set value as a column. Search across the whole table, sort on any column, and push what is left of the filter straight into the viewport.",
  icon: "table",
  category: "Data",
  keywords: "schedule table spreadsheet grid properties pset query filter export",
  tier: "web",
  does: [
    "Add any Pset property as a column, ranked by how common it is",
    "Search and per-class filtering across the whole model",
    "Isolate or hide everything the filter matched",
    "CSV export of the filtered rows, not just the visible page",
  ],
});
