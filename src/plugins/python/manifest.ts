import { definePlugin } from "@ifcviewx/sdk";

export default definePlugin({
  id: "python",
  name: "Python Console",
  tagline: "Write IfcOpenShell against the open model",
  about:
    "A console for real IfcOpenShell code: queries return a value, edits run on a disposable copy and come back staged for approval. This is the only place Python runs, and only when you press Run. The assistant can write code for you and hand it here, but it can never execute it, on any tier. First Run in this tab downloads the runtime once (~30 MB); in Local Studio the same console runs natively instead, and says which before you press Run.",
  icon: "terminal",
  category: "Automation",
  keywords: "python ifcopenshell script console pyodide query edit snippet code",
  tier: "web",
  does: [
    "Queries assign to `result`; edits define `def edit(model)`",
    "Every edit runs on a copy and is staged, never applied silently",
    "Runs natively in Local Studio, in this tab otherwise",
    "Yours alone: the assistant writes Python, only you run it",
  ],
});
