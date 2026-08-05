// IDS: load a buildingSMART Information Delivery Specification and check the
// model against it in this tab. Entity, attribute and property facets are
// evaluated. Classification, material and partOf need data the viewer does not
// carry, so they are listed as unchecked rather than silently passed.
import { h, icon, spinner } from "./kit.js";
import { emptyState } from "./shell.js";
import { scanElements } from "./filters.js";
import type { ItemProperties, Viewer } from "../viewer-core/viewer.js";

type Matcher = (value: string) => boolean;

interface Facet {
  kind: string;
  supported: boolean;
  label: string;
  /** Prefilter on the IFC class, so a spec only reads what it is about. */
  typeTest?: (type: string) => boolean;
  test(props: ItemProperties): boolean;
}

interface Spec {
  name: string;
  description: string;
  applicability: Facet[];
  requirements: Facet[];
}

interface SpecResult {
  spec: Spec;
  applicable: number;
  passed: number;
  failures: Array<{ id: number; reason: string }>;
  truncated: boolean;
  /** Elements the viewer could not read at all (geometry-only .ifcx). */
  unreadable: number;
}

interface IdsDocument {
  title: string;
  fileName: string;
  specs: Spec[];
}

/**
 * The IDS the user last opened. Module state rather than panel state, so the
 * assistant can validate against it without the panel being on screen, and so
 * there is only ever one loaded document to disagree about.
 */
let loaded: IdsDocument | null = null;

const loadedIds = (): IdsDocument | null => loaded;

/** Parse and install, which is the only way a document becomes the loaded one. */
function loadIds(text: string, fileName: string): IdsDocument {
  const parsed = parseIds(text);
  loaded = { title: parsed.title, fileName, specs: parsed.specs };
  return loaded;
}

const child = (node: Element, name: string): Element | null =>
  [...node.children].find((item) => item.localName === name) ?? null;
const children = (node: Element, name: string): Element[] =>
  [...node.children].filter((item) => item.localName === name);
const attribute = (node: Element, name: string): string => node.getAttribute(name) ?? "";

/** Never-matching pattern for regexes IDS allows but JavaScript rejects. */
function regex(source: string): RegExp {
  try {
    return new RegExp(`^(?:${source})$`, "i");
  } catch {
    return /$^/;
  }
}

/** IDS value holders are either a simpleValue or an XSD restriction. */
function matcher(node: Element | null): Matcher | null {
  if (!node) return null;
  const simple = child(node, "simpleValue");
  if (simple) {
    const wanted = (simple.textContent ?? "").trim().toLowerCase();
    return (value) => value.trim().toLowerCase() === wanted;
  }
  const restriction = child(node, "restriction");
  if (!restriction) return null;
  const patterns = children(restriction, "pattern").map((item) => regex(attribute(item, "value")));
  const options = children(restriction, "enumeration").map((item) => attribute(item, "value").toLowerCase());
  const bound = (name: string): number | null => {
    const found = child(restriction, name);
    const value = found ? Number(attribute(found, "value")) : NaN;
    return Number.isFinite(value) ? value : null;
  };
  const min = bound("minInclusive");
  const max = bound("maxInclusive");
  const above = bound("minExclusive");
  const below = bound("maxExclusive");
  return (value) => {
    const text = value.trim();
    if (patterns.length && !patterns.some((pattern) => pattern.test(text))) return false;
    if (options.length && !options.includes(text.toLowerCase())) return false;
    const number = Number(text);
    if (Number.isFinite(number)) {
      if (min !== null && number < min) return false;
      if (max !== null && number > max) return false;
      if (above !== null && number <= above) return false;
      if (below !== null && number >= below) return false;
    }
    return true;
  };
}

function describe(node: Element | null): string {
  if (!node) return "any";
  const simple = child(node, "simpleValue");
  if (simple) return (simple.textContent ?? "").trim();
  const restriction = child(node, "restriction");
  if (!restriction) return "any";
  const parts = [...restriction.children].map((item) => attribute(item, "value")).filter(Boolean);
  return parts.join(" or ") || "restricted";
}

const attributeValues = (props: ItemProperties, match: Matcher | null): string[] =>
  props.attributes
    .filter((item) => item.value !== null && (!match || match(item.name)))
    .map((item) => String(item.value));

function readFacet(node: Element): Facet {
  const kind = node.localName;
  if (kind === "entity") {
    const name = matcher(child(node, "name"));
    const predefined = matcher(child(node, "predefinedType"));
    return {
      kind,
      supported: true,
      label: `class ${describe(child(node, "name"))}`,
      typeTest: name ? (type) => name(type) : undefined,
      test: (props) => {
        if (name && !name(props.type)) return false;
        if (!predefined) return true;
        return props.attributes
          .filter((item) => item.name === "PredefinedType" || item.name === "ObjectType")
          .some((item) => item.value !== null && predefined(String(item.value)));
      },
    };
  }
  if (kind === "attribute") {
    const name = matcher(child(node, "name"));
    const value = matcher(child(node, "value"));
    return {
      kind,
      supported: true,
      label: `attribute ${describe(child(node, "name"))}${value ? ` is ${describe(child(node, "value"))}` : ""}`,
      test: (props) => {
        const values = attributeValues(props, name).filter((item) => item !== "");
        return value ? values.some(value) : values.length > 0;
      },
    };
  }
  if (kind === "property") {
    const set = matcher(child(node, "propertySet"));
    const base = matcher(child(node, "baseName"));
    const value = matcher(child(node, "value"));
    const cardinality = attribute(node, "cardinality") || (attribute(node, "minOccurs") === "0" ? "optional" : "required");
    const setLabel = describe(child(node, "propertySet"));
    return {
      kind,
      supported: true,
      label: `${setLabel}.${describe(child(node, "baseName"))}${value ? ` is ${describe(child(node, "value"))}` : ""}${
        cardinality === "prohibited" ? " (prohibited)" : ""
      }`,
      test: (props) => {
        if (cardinality === "optional") return true;
        const values: string[] = [];
        for (const pset of props.psets) {
          if (set && !set(pset.name)) continue;
          for (const property of pset.properties) {
            if (base && !base(property.name)) continue;
            if (property.value !== null && String(property.value) !== "") values.push(String(property.value));
          }
        }
        const present = value ? values.some(value) : values.length > 0;
        return cardinality === "prohibited" ? !present : present;
      },
    };
  }
  return { kind, supported: false, label: kind, test: () => true };
}

const readFacets = (node: Element | null): Facet[] =>
  node ? [...node.children].map(readFacet) : [];

function parseIds(text: string): { title: string; specs: Spec[] } {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file is not valid XML.");
  const root = doc.documentElement;
  if (root.localName !== "ids") throw new Error("That file is not an IDS document.");
  const info = child(root, "info");
  const specs = [...root.getElementsByTagName("*")]
    .filter((node) => node.localName === "specification")
    .map((node) => ({
      name: attribute(node, "name") || "Specification",
      description: attribute(node, "description") || (child(node, "description")?.textContent ?? ""),
      applicability: readFacets(child(node, "applicability")),
      requirements: readFacets(child(node, "requirements")),
    }));
  if (specs.length === 0) throw new Error("The IDS holds no specifications.");
  return { title: (info && child(info, "title")?.textContent) || "IDS", specs };
}

async function runSpec(
  viewer: Viewer,
  spec: Spec,
  onProgress: (done: number, total: number) => void,
): Promise<SpecResult> {
  const types = viewer.getElementTypes();
  const prefilters = spec.applicability.map((facet) => facet.typeTest).filter(Boolean) as Array<(type: string) => boolean>;
  const candidates = [...types].filter(([, type]) => prefilters.every((test) => test(type))).map(([id]) => id);

  const reasons = new Map<number, string>();
  let applicable = 0;
  let passed = 0;
  const found = await scanElements(
    viewer,
    candidates,
    (props) => {
      if (!spec.applicability.every((facet) => facet.test(props))) return false;
      applicable++;
      const failed = spec.requirements.find((facet) => facet.supported && !facet.test(props));
      if (!failed) {
        passed++;
        return false;
      }
      reasons.set(props.expressID, failed.label);
      return true;
    },
    onProgress,
  );
  return {
    spec,
    applicable,
    passed,
    failures: found.ids.map((id) => ({ id, reason: reasons.get(id) ?? "requirement not met" })),
    truncated: found.truncated,
    unreadable: found.missing,
  };
}

/**
 * Run every specification in the loaded document. The panel passes callbacks
 * to paint as it goes; the assistant takes the array and summarises it. One
 * runner, so the two can never report different results for the same file.
 */
async function runIds(
  viewer: Viewer,
  onSpec?: (result: SpecResult, index: number, total: number) => void,
  onProgress?: (spec: Spec, index: number, total: number, done: number, of: number) => void,
): Promise<SpecResult[]> {
  const document_ = loaded;
  if (!document_) throw new Error("No IDS is loaded. Open an .ids file in the IDS panel first.");
  if (viewer.getElementTypes().size === 0) throw new Error("Open a model first.");
  const total = document_.specs.length;
  const results: SpecResult[] = [];
  for (const [index, spec] of document_.specs.entries()) {
    const result = await runSpec(viewer, spec, (done, of) => onProgress?.(spec, index, total, done, of));
    results.push(result);
    onSpec?.(result, index, total);
  }
  return results;
}

/** The same run, flattened to what an LLM can read in one report. */
export async function idsReport(viewer: Viewer): Promise<Record<string, unknown>> {
  const results = await runIds(viewer);
  const applicable = results.reduce((sum, result) => sum + result.applicable, 0);
  const unreadable = results.reduce((sum, result) => sum + result.unreadable, 0);
  return {
    ids: loaded?.title ?? "IDS",
    file: loaded?.fileName ?? "",
    specifications: results.map((result) => ({
      name: result.spec.name,
      applicable: result.applicable,
      passed: result.passed,
      failed: result.failures.length,
      truncated: result.truncated,
      notChecked: [...new Set([...result.spec.applicability, ...result.spec.requirements]
        .filter((facet) => !facet.supported).map((facet) => facet.kind))],
      requirements: result.spec.requirements.map((facet) => facet.label),
      failures: result.failures.slice(0, 20),
    })),
    failedSpecifications: results.filter((result) => result.failures.length > 0).length,
    // A geometry-only .ifcx reads as a clean pass, which would be a lie.
    readable: !(applicable === 0 && unreadable > 0),
  };
}

export interface IdsActions {
  viewer: Viewer;
  isolate(label: string, ids: number[]): void;
  report(title: string, ids: number[]): void;
  log(message: string, kind?: "info" | "success" | "error"): void;
  /** A document was loaded or replaced; the assistant can now check it. */
  changed?(): void;
}

export class IdsPanel {
  private readonly input = h("input", { type: "file", accept: ".ids,.xml", hidden: true });
  private readonly open = h("button", { class: "btn", type: "button" }, [icon("folder", 14), h("span", { text: "Open IDS" })]);
  private readonly run = h("button", { class: "btn accent", type: "button", text: "Validate" });
  private readonly title = h("div", { class: "status-line" });
  private readonly status = h("div", { class: "status-line" });
  private readonly results = h("div", { class: "scroll" });
  private readonly empty = emptyState("clipboard", "No IDS loaded", "Open an .ids file to check the model against its specifications.");

  constructor(host: HTMLElement, private readonly actions: IdsActions) {
    this.run.disabled = true;
    this.open.addEventListener("click", () => this.input.click());
    this.input.addEventListener("change", () => {
      const file = this.input.files?.[0];
      if (file) void this.load(file).catch((err: Error) => this.fail(err));
      this.input.value = "";
    });
    this.run.addEventListener("click", () => void this.validate().catch((err: Error) => this.fail(err)));

    host.appendChild(
      h("div", { class: "page" }, [
        h("div", { class: "row" }, [this.open, this.run, this.input]),
        this.title,
        this.status,
        this.empty,
        this.results,
      ]),
    );
  }

  /** The status line, with a ring while the pass it describes is still going. */
  private say(text: string, busy = false): void {
    this.status.replaceChildren(...(busy ? [spinner(12)] : []), h("span", { text }));
  }

  private fail(err: Error): void {
    this.say(err.message);
    this.status.classList.add("error");
    this.run.disabled = loadedIds() === null;
    this.run.classList.remove("busy");
  }

  private async load(file: File): Promise<void> {
    const parsed = loadIds(await file.text(), file.name);
    this.title.textContent = `${parsed.title} · ${parsed.specs.length} specification${parsed.specs.length === 1 ? "" : "s"} · ${file.name}`;
    this.say("");
    this.status.classList.remove("error");
    this.run.disabled = false;
    this.empty.classList.add("hidden");
    this.results.replaceChildren();
    this.actions.log(`Loaded IDS ${file.name}`, "success");
    this.actions.changed?.();
  }

  private async validate(): Promise<void> {
    const document_ = loadedIds();
    if (!document_) return;
    this.run.disabled = true;
    this.run.classList.add("busy");
    this.status.classList.remove("error");
    this.results.replaceChildren();
    this.say("Reading the model", true);
    let failedSpecs = 0;
    let applicable = 0;
    let unreadable = 0;
    try {
      await runIds(
        this.actions.viewer,
        (result) => {
          if (result.failures.length) failedSpecs++;
          applicable += result.applicable;
          unreadable += result.unreadable;
          this.results.appendChild(this.renderResult(result));
        },
        (spec, index, total, done, of) => {
          this.say(`Checking ${index + 1}/${total}: ${spec.name} (${done}/${of})`, true);
        },
      );
    } finally {
      this.run.disabled = false;
      this.run.classList.remove("busy");
    }
    // A geometry-only file would otherwise pass everything for the wrong reason.
    const blind = applicable === 0 && unreadable > 0;
    const total = document_.specs.length;
    const outcome = blind
      ? "Nothing could be read from this file. Open the .ifc rather than the converted .ifcx."
      : failedSpecs
        ? `${failedSpecs} of ${total} specifications have failures`
        : `All ${total} specifications pass`;
    this.say(outcome);
    this.status.classList.toggle("error", blind);
    this.actions.log(outcome, failedSpecs || blind ? "error" : "success");
  }

  private renderResult(result: SpecResult): HTMLElement {
    const { spec } = result;
    const failed = result.failures.length;
    const severity = failed ? "err" : result.applicable === 0 ? "muted" : "ok";
    const head = h("button", { class: "spec-head", type: "button", "aria-expanded": "false" }, [
      h("span", { class: `dot ${severity}` }),
      h("span", { class: "grow", text: spec.name, title: spec.description || spec.name }),
      h("span", { class: "n", text: `${result.passed}/${result.applicable}` }),
      icon("chevron", 12),
    ]);
    const body = h("div", { class: "spec-body hidden" });
    head.addEventListener("click", () => {
      const open = head.getAttribute("aria-expanded") !== "true";
      head.setAttribute("aria-expanded", String(open));
      body.classList.toggle("hidden", !open);
    });

    const unchecked = [...spec.applicability, ...spec.requirements].filter((facet) => !facet.supported);
    if (unchecked.length) {
      body.appendChild(
        h("div", { class: "note", text: `Not checked here: ${[...new Set(unchecked.map((facet) => facet.kind))].join(", ")}` }),
      );
    }
    if (result.truncated) {
      body.appendChild(h("div", { class: "note", text: "Scan capped; run again after narrowing with filters." }));
    }
    if (spec.requirements.length) {
      body.appendChild(
        h("div", { class: "note", text: `Requires: ${spec.requirements.map((facet) => facet.label).join("; ")}` }),
      );
    }

    if (failed) {
      const isolate = h("button", { class: "btn sm", type: "button", text: "Isolate failures" });
      isolate.addEventListener("click", () =>
        this.actions.isolate(`IDS fail: ${spec.name}`, result.failures.map((item) => item.id)),
      );
      const report = h("button", { class: "btn sm", type: "button", text: "Raise issue" });
      report.addEventListener("click", () =>
        this.actions.report(`IDS: ${spec.name}`, result.failures.map((item) => item.id)),
      );
      body.appendChild(h("div", { class: "row" }, [isolate, report]));
      for (const failure of result.failures.slice(0, 200)) {
        const row = h("button", { class: "filter-row pick", type: "button", title: failure.reason }, [
          h("span", { class: "mono", text: `#${failure.id}` }),
          h("span", { class: "grow", text: failure.reason }),
        ]);
        row.addEventListener("click", () => {
          this.actions.viewer.select(failure.id);
          this.actions.viewer.fitToElement(failure.id);
        });
        body.appendChild(row);
      }
      if (failed > 200) body.appendChild(h("div", { class: "note", text: `${failed - 200} more not listed` }));
    } else if (result.applicable === 0) {
      body.appendChild(
        h("div", {
          class: "note",
          text: result.unreadable
            ? `${result.unreadable.toLocaleString()} candidates carried no readable data.`
            : "No element in the model matched the applicability.",
        }),
      );
    }

    return h("div", { class: "spec" }, [head, body]);
  }
}
