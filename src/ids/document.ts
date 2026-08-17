export type IdsFacetKind = "entity" | "attribute" | "property" | "partOf" | "classification" | "material";
export type IdsCardinality = "required" | "optional" | "prohibited";

export interface IdsValueRule {
  simple?: string;
  base?: string;
  enumeration?: string[];
  pattern?: string[];
  minInclusive?: number;
  maxInclusive?: number;
  minExclusive?: number;
  maxExclusive?: number;
}

export interface IdsFacetDraft {
  id: string;
  kind: IdsFacetKind;
  cardinality: IdsCardinality;
  instructions: string;
  uri: string;
  name?: IdsValueRule;
  predefinedType?: IdsValueRule;
  value?: IdsValueRule;
  propertySet?: IdsValueRule;
  baseName?: IdsValueRule;
  system?: IdsValueRule;
  entityName?: IdsValueRule;
  relation?: string;
  dataType?: string;
}

export interface IdsSpecificationDraft {
  id: string;
  name: string;
  identifier: string;
  description: string;
  instructions: string;
  ifcVersion: string;
  minOccurs: number;
  maxOccurs: number | "unbounded";
  applicability: IdsFacetDraft[];
  requirements: IdsFacetDraft[];
}

export interface IdsDraft {
  title: string;
  fileName: string;
  version: string;
  description: string;
  author: string;
  date: string;
  purpose: string;
  milestone: string;
  specifications: IdsSpecificationDraft[];
}

export interface IdsRequirementTemplate {
  id: string;
  name: string;
  description: string;
  requirements: IdsFacetDraft[];
}

let sequence = 0;
const uid = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${(++sequence).toString(36)}`;
const localChildren = (node: Element, name: string): Element[] => [...node.children].filter((item) => item.localName === name);
const localChild = (node: Element, name: string): Element | null => localChildren(node, name)[0] ?? null;
const textOf = (node: Element | null): string => (node?.textContent ?? "").trim();

function valueRule(node: Element | null): IdsValueRule | undefined {
  if (!node) return undefined;
  const simple = localChild(node, "simpleValue");
  if (simple) return { simple: textOf(simple) };
  const restriction = localChild(node, "restriction");
  if (!restriction) return undefined;
  const numbers = (name: string): number | undefined => {
    const raw = localChild(restriction, name)?.getAttribute("value") ?? "";
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };
  return {
    base: restriction.getAttribute("base") || undefined,
    enumeration: localChildren(restriction, "enumeration").map((item) => item.getAttribute("value") ?? ""),
    pattern: localChildren(restriction, "pattern").map((item) => item.getAttribute("value") ?? ""),
    minInclusive: numbers("minInclusive"),
    maxInclusive: numbers("maxInclusive"),
    minExclusive: numbers("minExclusive"),
    maxExclusive: numbers("maxExclusive"),
  };
}

function facetFrom(node: Element): IdsFacetDraft {
  const kind = node.localName as IdsFacetKind;
  const entity = kind === "partOf" ? localChild(node, "entity") : null;
  const cardinality = node.getAttribute("cardinality");
  return {
    id: uid("facet"),
    kind,
    cardinality: cardinality === "optional" || cardinality === "prohibited" ? cardinality : "required",
    instructions: node.getAttribute("instructions") ?? "",
    uri: node.getAttribute("uri") ?? "",
    name: valueRule(localChild(node, "name")),
    predefinedType: valueRule(localChild(node, "predefinedType")),
    value: valueRule(localChild(node, "value")),
    propertySet: valueRule(localChild(node, "propertySet")),
    baseName: valueRule(localChild(node, "baseName")),
    system: valueRule(localChild(node, "system")),
    entityName: entity ? valueRule(localChild(entity, "name")) : undefined,
    relation: node.getAttribute("relation") ?? "",
    dataType: node.getAttribute("dataType") ?? "",
  };
}

export function parseIdsDocument(text: string, fileName = "requirements.ids"): IdsDraft {
  const document_ = new DOMParser().parseFromString(text, "application/xml");
  if (document_.querySelector("parsererror")) throw new Error("That file is not valid XML.");
  const root = document_.documentElement;
  if (root.localName !== "ids") throw new Error("That file is not an IDS document.");
  const info = localChild(root, "info");
  const specifications = [...root.getElementsByTagName("*")]
    .filter((node) => node.localName === "specification")
    .map((node): IdsSpecificationDraft => ({
      id: uid("spec"),
      name: node.getAttribute("name") || "Specification",
      identifier: node.getAttribute("identifier") ?? "",
      description: node.getAttribute("description") ?? "",
      instructions: node.getAttribute("instructions") ?? "",
      ifcVersion: node.getAttribute("ifcVersion") || "IFC4",
      minOccurs: Number(localChild(node, "applicability")?.getAttribute("minOccurs") ?? "1"),
      maxOccurs: localChild(node, "applicability")?.getAttribute("maxOccurs") === "unbounded"
        ? "unbounded"
        : Number(localChild(node, "applicability")?.getAttribute("maxOccurs") ?? "1"),
      applicability: [...(localChild(node, "applicability")?.children ?? [])].map(facetFrom),
      requirements: [...(localChild(node, "requirements")?.children ?? [])].map(facetFrom),
    }));
  if (specifications.length === 0) throw new Error("The IDS holds no specifications.");
  return {
    title: textOf(info ? localChild(info, "title") : null) || "IDS requirements",
    fileName,
    version: textOf(info ? localChild(info, "version") : null),
    description: textOf(info ? localChild(info, "description") : null),
    author: textOf(info ? localChild(info, "author") : null),
    date: textOf(info ? localChild(info, "date") : null),
    purpose: textOf(info ? localChild(info, "purpose") : null),
    milestone: textOf(info ? localChild(info, "milestone") : null),
    specifications,
  };
}

const esc = (value: string): string => value
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;")
  .replace(/'/g, "&apos;");

function valueXml(name: string, rule: IdsValueRule | undefined): string {
  if (!rule) return "";
  if (rule.simple !== undefined) return `<ids:${name}><ids:simpleValue>${esc(rule.simple)}</ids:simpleValue></ids:${name}>`;
  const entries: string[] = [];
  for (const value of rule.enumeration ?? []) entries.push(`<xs:enumeration value="${esc(value)}"/>`);
  for (const value of rule.pattern ?? []) entries.push(`<xs:pattern value="${esc(value)}"/>`);
  for (const key of ["minInclusive", "maxInclusive", "minExclusive", "maxExclusive"] as const) {
    if (rule[key] !== undefined) entries.push(`<xs:${key} value="${rule[key]}"/>`);
  }
  if (entries.length === 0) return "";
  const numeric = [rule.minInclusive, rule.maxInclusive, rule.minExclusive, rule.maxExclusive]
    .some((value) => value !== undefined);
  const base = rule.base || (numeric ? "xs:decimal" : "xs:string");
  return `<ids:${name}><xs:restriction base="${esc(base)}">${entries.join("")}</xs:restriction></ids:${name}>`;
}

function facetXml(facet: IdsFacetDraft, requirements: boolean): string {
  const attributes: string[] = [];
  if (requirements && facet.kind !== "entity") attributes.push(`cardinality="${facet.cardinality}"`);
  if (requirements && facet.instructions) attributes.push(`instructions="${esc(facet.instructions)}"`);
  if (requirements && facet.uri && ["classification", "property", "material"].includes(facet.kind)) {
    attributes.push(`uri="${esc(facet.uri)}"`);
  }
  if (facet.kind === "property" && facet.dataType) attributes.push(`dataType="${esc(facet.dataType.toUpperCase())}"`);
  if (facet.kind === "partOf" && facet.relation) attributes.push(`relation="${esc(facet.relation)}"`);
  const attr = attributes.length ? ` ${attributes.join(" ")}` : "";
  let body = "";
  if (facet.kind === "entity") body = valueXml("name", facet.name) + valueXml("predefinedType", facet.predefinedType);
  if (facet.kind === "attribute") body = valueXml("name", facet.name) + valueXml("value", facet.value);
  if (facet.kind === "property") body = valueXml("propertySet", facet.propertySet) + valueXml("baseName", facet.baseName) + valueXml("value", facet.value);
  if (facet.kind === "classification") body = valueXml("value", facet.value) + valueXml("system", facet.system);
  if (facet.kind === "material") body = valueXml("value", facet.value);
  if (facet.kind === "partOf") body = `<ids:entity>${valueXml("name", facet.entityName)}</ids:entity>`;
  return `<ids:${facet.kind}${attr}>${body}</ids:${facet.kind}>`;
}

function infoXml(document_: IdsDraft): string {
  const fields: Array<[string, string]> = [
    ["title", document_.title || "IDS requirements"], ["version", document_.version],
    ["description", document_.description], ["author", document_.author], ["date", document_.date],
    ["purpose", document_.purpose], ["milestone", document_.milestone],
  ];
  return fields.filter(([, value]) => value).map(([name, value]) => `<ids:${name}>${esc(value)}</ids:${name}>`).join("");
}

function hasRule(rule: IdsValueRule | undefined): boolean {
  return Boolean(rule && (
    rule.simple !== undefined
    || rule.enumeration?.length
    || rule.pattern?.length
    || rule.minInclusive !== undefined
    || rule.maxInclusive !== undefined
    || rule.minExclusive !== undefined
    || rule.maxExclusive !== undefined
  ));
}

function assertFacet(facet: IdsFacetDraft, spec: string): void {
  const missing = (label: string): never => { throw new Error(`${spec}: ${facet.kind} facet needs ${label}.`); };
  if ((facet.kind === "entity" || facet.kind === "attribute") && !hasRule(facet.name)) missing("a name");
  if (facet.kind === "property" && !hasRule(facet.propertySet)) missing("a property set");
  if (facet.kind === "property" && !hasRule(facet.baseName)) missing("a property name");
  if (facet.kind === "partOf" && !hasRule(facet.entityName)) missing("a parent entity");
  if (facet.kind === "classification" && !hasRule(facet.system)) missing("a classification system");
  if (facet.kind === "partOf" && facet.cardinality === "optional") {
    throw new Error(`${spec}: partOf requirements can only be required or prohibited in IDS 1.0.`);
  }
  if (facet.uri && /\/latest(?:\/|$)/i.test(facet.uri)) {
    throw new Error(`${spec}: replace the bSDD latest URI with a versioned stable URI.`);
  }
}

export function serializeIdsDocument(document_: IdsDraft): string {
  if (document_.specifications.length === 0) throw new Error("Add at least one specification before exporting.");
  if (document_.author && !/^[^@]+@[^.]+\..+$/.test(document_.author)) throw new Error("The IDS author must be an email address.");
  for (const spec of document_.specifications) {
    if (spec.applicability.length === 0) throw new Error(`${spec.name || "Specification"}: add at least one applicability facet.`);
    for (const facet of [...spec.applicability, ...spec.requirements]) assertFacet(facet, spec.name || "Specification");
    if (!Number.isInteger(spec.minOccurs) || spec.minOccurs < 0) throw new Error(`${spec.name}: minimum applicability must be zero or greater.`);
    if (spec.maxOccurs !== "unbounded" && (!Number.isInteger(spec.maxOccurs) || spec.maxOccurs < spec.minOccurs)) {
      throw new Error(`${spec.name}: maximum applicability must be at least the minimum.`);
    }
  }
  const order: IdsFacetKind[] = ["entity", "partOf", "classification", "attribute", "property", "material"];
  const specs = document_.specifications.map((spec) => {
    const attrs = [
      `name="${esc(spec.name || "Specification")}"`,
      `ifcVersion="${esc(spec.ifcVersion || "IFC4")}"`,
      ...(spec.identifier ? [`identifier="${esc(spec.identifier)}"`] : []),
      ...(spec.description ? [`description="${esc(spec.description)}"`] : []),
      ...(spec.instructions ? [`instructions="${esc(spec.instructions)}"`] : []),
    ];
    const sorted = [...spec.applicability].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
    const applicability = sorted.map((facet) => facetXml(facet, false)).join("");
    const requirements = spec.requirements.map((facet) => facetXml(facet, true)).join("");
    return `<ids:specification ${attrs.join(" ")}><ids:applicability minOccurs="${spec.minOccurs}" maxOccurs="${spec.maxOccurs}">${applicability}</ids:applicability>${
      requirements ? `<ids:requirements>${requirements}</ids:requirements>` : ""
    }</ids:specification>`;
  }).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<ids:ids xmlns:ids="http://standards.buildingsmart.org/IDS" xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:schemaLocation="http://standards.buildingsmart.org/IDS https://standards.buildingsmart.org/IDS/1.0/ids.xsd">${
    `<ids:info>${infoXml(document_)}</ids:info><ids:specifications>${specs}</ids:specifications>`
  }</ids:ids>\n`;
}

export function newFacet(kind: IdsFacetKind): IdsFacetDraft {
  const facet: IdsFacetDraft = { id: uid("facet"), kind, cardinality: "required", instructions: "", uri: "" };
  if (kind === "entity" || kind === "attribute") facet.name = { simple: kind === "entity" ? "IfcWall" : "Name" };
  if (kind === "property") {
    facet.propertySet = { simple: "Pset_WallCommon" };
    facet.baseName = { simple: "FireRating" };
  }
  if (kind === "partOf") facet.entityName = { simple: "IfcBuildingStorey" };
  if (kind === "classification") facet.system = { simple: "Classification system" };
  if (kind === "material") facet.value = { simple: "Material name" };
  return facet;
}

export function newIdsDocument(): IdsDraft {
  return {
    title: "Information requirements",
    fileName: "requirements.ids",
    version: "1.0",
    description: "",
    author: "",
    date: new Date().toISOString().slice(0, 10),
    purpose: "",
    milestone: "",
    specifications: [{
      id: uid("spec"),
      name: "Wall information",
      identifier: "REQ-WALL-001",
      description: "",
      instructions: "",
      ifcVersion: "IFC4",
      minOccurs: 1,
      maxOccurs: "unbounded",
      applicability: [newFacet("entity")],
      requirements: [newFacet("property")],
    }],
  };
}

export function cloneFacet(facet: IdsFacetDraft): IdsFacetDraft {
  return { ...structuredClone(facet), id: uid("facet") };
}

export const BUILTIN_IDS_TEMPLATES: IdsRequirementTemplate[] = [
  {
    id: "identity",
    name: "Asset identity",
    description: "Requires a name, tag and stable classification for handed-over assets.",
    requirements: [
      { ...newFacet("attribute"), name: { simple: "Name" } },
      { ...newFacet("attribute"), name: { simple: "Tag" }, cardinality: "optional" },
      { ...newFacet("classification"), system: { simple: "Classification system" } },
    ],
  },
  {
    id: "fire",
    name: "Fire safety",
    description: "Adds the common fire rating and externality requirements.",
    requirements: [
      { ...newFacet("property"), propertySet: { simple: "Pset_WallCommon" }, baseName: { simple: "FireRating" } },
      { ...newFacet("property"), propertySet: { simple: "Pset_WallCommon" }, baseName: { simple: "IsExternal" } },
    ],
  },
  {
    id: "location",
    name: "Spatial assignment",
    description: "Requires every applicable object to be assigned to a building storey.",
    requirements: [{ ...newFacet("partOf"), entityName: { simple: "IfcBuildingStorey" }, relation: "IFCRELCONTAINEDINSPATIALSTRUCTURE" }],
  },
];
