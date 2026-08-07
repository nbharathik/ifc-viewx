import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "finder",
  name: "Model Finder",
  tagline: "Search the whole model in plain words, then act on what comes back",
  about:
    "Ranked search over every element's class, name and storey, and over its property values once the property index has been built. Words may come in any order, so \"external fire door level 2\" finds what a substring filter cannot. The results are a working set: select them, isolate them, colour them, or clip a section box around them. It runs the same BM25 index the assistant searches with, so the panel and the assistant always agree about what is in the model.",
  icon: "search",
  category: "Data",
  keywords: "search find bm25 rank query text lookup filter locate element name property",
  tier: "web",
  does: [
    "Ranked full-text search over class, name, storey and property values",
    "Words in any order, and camel-case class names split so Wall finds IfcWallStandardCase",
    "Select, isolate, colour or box the results in one click",
    "Property values are included once the index has been built, on request",
  ],
});
