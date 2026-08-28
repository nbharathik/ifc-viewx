// Scaffolds a plugin folder.
//
//   npm run new-plugin -- room-check "Room Check"
//
// The template is written out here rather than kept as files on disk, so there
// is no second copy of the plugin shape to drift out of step with the SDK.
import { mkdir, writeFile, access } from "node:fs/promises";
import { join } from "node:path";

const [id, ...rest] = process.argv.slice(2);
const name = rest.join(" ").trim();

if (!id || !/^[a-z][a-z0-9-]*$/.test(id)) {
  console.error("Usage: npm run new-plugin -- <id> [Display Name]");
  console.error("The id is the folder name: lowercase letters, digits and dashes.");
  process.exit(1);
}

const title = name || id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const dir = join("src", "plugins", id);

if (await access(dir).then(() => true, () => false)) {
  console.error(`src/plugins/${id} already exists.`);
  process.exit(1);
}

const manifest = `${JSON.stringify({
  manifestVersion: 2,
  id,
  name: title,
  version: "0.1.0",
  sdk: ">=2.0.0 <3",
  description: "A short description of what this extension does.",
  runtime: { kind: "bundled", entry: "panel.ts" },
  activationEvents: [`onPanel:${id}`],
  permissions: ["model.structure.read"],
  contributes: {
    panels: [{ id, title, icon: "blocks" }],
  },
  catalog: {
    tagline: "One line on what it does",
    about: "A paragraph for the catalog. Say what it reads, what it changes, and anything a user would be surprised by.",
    icon: "blocks",
    category: "Data",
    keywords: "search terms people would type",
    does: ["The first thing it does", "The second thing it does"],
  },
}, null, 2)}\n`;

const panel = `import { bar, button, note, page, stats, type ExtensionContext, type ExtensionInstance } from "@ifcviewx/sdk";

export function mount(host: HTMLElement, ctx: ExtensionContext): ExtensionInstance {
  const body = document.createElement("div");
  const root = page(bar(button("Count elements", () => run())), body);

  const run = (): void => {
    const elements = ctx.model.elements();
    body.replaceChildren(
      stats([
        ["Elements", elements.length.toLocaleString()],
        ["Classes", String(ctx.model.classes().length)],
      ]),
      note("Click an element in the viewport and this panel can react to it."),
    );
  };

  ctx.events.on("model", () => run());
  host.appendChild(root);
  run();

  return {};
}
`;

await mkdir(dir, { recursive: true });
await writeFile(join(dir, "extension.json"), manifest);
await writeFile(join(dir, "panel.ts"), panel);

console.log(`Created src/plugins/${id}/`);
console.log("  extension.json   permissions, activation, and catalog metadata");
console.log("  panel.ts      what runs when someone opens it");
console.log("");
console.log("Run `npm run dev` and open the Plugins button. Nothing else to register.");
