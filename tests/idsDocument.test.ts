import { describe, expect, it } from "vitest";
import {
  newFacet, newIdsDocument, parseIdsDocument, serializeIdsDocument,
} from "../src/ids/document.js";

describe("IDS 1.0 authoring document", () => {
  it("round-trips all facet kinds and stable bSDD URIs", () => {
    const draft = newIdsDocument();
    const spec = draft.specifications[0];
    const classification = newFacet("classification");
    classification.system = { simple: "Uniclass" };
    classification.value = { simple: "EF_25" };
    classification.uri = "https://identifier.buildingsmart.org/uri/test/uniclass/1.0/class/EF_25";
    const material = newFacet("material");
    material.value = { simple: "Concrete" };
    material.uri = "https://identifier.buildingsmart.org/uri/test/materials/1.0/class/concrete";
    const attribute = newFacet("attribute");
    const partOf = newFacet("partOf");
    spec.requirements.push(classification, material, attribute, partOf);

    const xml = serializeIdsDocument(draft);
    const parsed = parseIdsDocument(xml, "roundtrip.ids");
    expect(parsed.specifications[0].requirements.map((facet) => facet.kind)).toEqual([
      "property", "classification", "material", "attribute", "partOf",
    ]);
    expect(parsed.specifications[0].requirements[1].uri).toBe(classification.uri);
    expect(parsed.specifications[0].requirements[2].uri).toBe(material.uri);
    expect(parsed.specifications[0]).toMatchObject({ minOccurs: 1, maxOccurs: "unbounded" });
  });

  it("writes applicability facets in IDS schema order", () => {
    const draft = newIdsDocument();
    draft.specifications[0].applicability = [newFacet("material"), newFacet("entity"), newFacet("attribute")];
    const xml = serializeIdsDocument(draft);
    expect(xml.indexOf("<ids:entity")).toBeLessThan(xml.indexOf("<ids:attribute"));
    expect(xml.indexOf("<ids:attribute")).toBeLessThan(xml.indexOf("<ids:material"));
  });

  it("rejects mutable latest bSDD references", () => {
    const draft = newIdsDocument();
    draft.specifications[0].requirements[0].uri = "https://identifier.buildingsmart.org/uri/test/example/latest/prop/fire";
    expect(() => serializeIdsDocument(draft)).toThrow(/versioned stable URI/);
  });

  it("writes numeric restrictions with a numeric XSD base", () => {
    const draft = newIdsDocument();
    draft.specifications[0].requirements[0].value = { minInclusive: 30, maxInclusive: 120 };
    const xml = serializeIdsDocument(draft);
    expect(xml).toContain('<xs:restriction base="xs:decimal">');
  });

  it("rejects optional partOf requirements because IDS 1.0 does not allow them", () => {
    const draft = newIdsDocument();
    const partOf = newFacet("partOf");
    partOf.cardinality = "optional";
    draft.specifications[0].requirements.push(partOf);
    expect(() => serializeIdsDocument(draft)).toThrow(/required or prohibited/);
  });
});
