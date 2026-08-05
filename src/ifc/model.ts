// A small IFC object model over web-ifc: the pieces of ifcopenshell.util we
// actually use, written for the browser. web-ifc gives us lines and types;
// everything relational (containment, aggregation, type objects, property
// sets) is an inverse lookup it does not index, so we build those once, on
// demand, and keep them until the model changes.
import type { IfcAPI } from "web-ifc";

export interface PropertyValue {
  [name: string]: string | number | boolean | null;
}
export interface PropertySets {
  [setName: string]: PropertyValue;
}

/** web-ifc wraps every attribute as {value, type}; refs carry an expressID. */
export const val = (v: unknown): string | number | boolean | null => {
  if (v === null || v === undefined) return null;
  if (typeof v === "object" && "value" in (v as Record<string, unknown>)) {
    const inner = (v as { value: unknown }).value;
    return inner === null || inner === undefined ? null : (inner as string | number | boolean);
  }
  return v as string | number | boolean;
};

export const ref = (v: unknown): number | null => {
  if (!v || typeof v !== "object") return null;
  const id = (v as { value?: unknown }).value;
  return typeof id === "number" ? id : null;
};

const refs = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(ref).filter((id): id is number => id !== null) : [];

export class IfcModel {
  private readonly types = new Map<string, number>();
  private containers: Map<number, number> | null = null;
  private aggregates: Map<number, number> | null = null;
  private typeObjects: Map<number, number> | null = null;
  private psetIndex: Map<number, number[]> | null = null;
  private guids: Map<string, number> | null = null;

  constructor(
    readonly api: IfcAPI,
    readonly id: number,
  ) {}

  get schema(): string {
    return this.api.GetModelSchema(this.id);
  }

  /** Cached because GetTypeCodeFromName is a string lookup into the schema. */
  typeCode(name: string): number {
    const key = name.toUpperCase();
    let code = this.types.get(key);
    if (code === undefined) {
      code = this.api.GetTypeCodeFromName(key);
      this.types.set(key, code);
    }
    return code;
  }

  /** web-ifc answers in PascalCase ("IfcWall"), so never compare it raw. */
  typeName(expressID: number): string {
    return this.api.GetNameFromTypeCode(this.api.GetLineType(this.id, expressID));
  }

  isType(expressID: number, name: string): boolean {
    return this.typeName(expressID).toUpperCase() === name.toUpperCase();
  }

  /** Every instance of a class. Abstract supertypes need the inherited walk. */
  byType(name: string, inherited = true): number[] {
    const code = this.typeCode(name);
    if (!code) return [];
    const vector = this.api.GetLineIDsWithType(this.id, code, inherited);
    const out = new Array<number>(vector.size());
    for (let i = 0; i < out.length; i++) out[i] = vector.get(i);
    return out;
  }

  line(expressID: number): Record<string, unknown> | null {
    try {
      return this.api.GetLine(this.id, expressID) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  write(line: Record<string, unknown>): void {
    this.api.WriteLine(this.id, line as never);
  }

  /**
   * Change one attribute without re-serialising the rest of the entity.
   *
   * WriteLine rebuilds every argument from the typed object it is handed,
   * which is a lossy round trip: on IFC4 doors the browser build throws
   * inside that path on attributes we never touched. The raw tape carries the
   * arguments already encoded, so replacing one and writing it back leaves
   * everything else byte-identical. Attribute order in a parsed line matches
   * the raw argument order, which is what makes the index safe to derive.
   */
  writeAttribute(expressID: number, attribute: string, value: string | number | boolean | null): boolean {
    const line = this.line(expressID);
    if (!line) return false;
    const names = Object.keys(line).filter((key) => key !== "expressID" && key !== "type");
    const index = names.indexOf(attribute);
    if (index < 0) return false;
    const raw = this.api.GetRawLineData(this.id, expressID);
    if (!raw || raw.arguments.length !== names.length) return false;
    const previous = raw.arguments[index] as { type?: number } | null;
    raw.arguments[index] = { type: previous?.type ?? 1, value } as never;
    this.api.WriteRawLineData(this.id, raw);
    return true;
  }

  save(): Uint8Array {
    return this.api.SaveModel(this.id);
  }

  /** Invalidate every derived index; call after any structural write. */
  reindex(): void {
    this.containers = null;
    this.aggregates = null;
    this.typeObjects = null;
    this.psetIndex = null;
    this.guids = null;
  }

  // -- inverse indexes -------------------------------------------------------
  /** One pass over the relationship instances, not a lookup per element. */
  private relate(relType: string, from: string, to: string): Map<number, number> {
    const map = new Map<number, number>();
    for (const rid of this.byType(relType, false)) {
      const rel = this.line(rid);
      if (!rel) continue;
      const owner = ref(rel[from]);
      if (owner === null) continue;
      for (const child of refs(rel[to])) map.set(child, owner);
    }
    return map;
  }

  containerOf(expressID: number): number | null {
    this.containers ??= this.relate(
      "IfcRelContainedInSpatialStructure",
      "RelatingStructure",
      "RelatedElements",
    );
    return this.containers.get(expressID) ?? null;
  }

  aggregateOf(expressID: number): number | null {
    this.aggregates ??= this.relate("IfcRelAggregates", "RelatingObject", "RelatedObjects");
    return this.aggregates.get(expressID) ?? null;
  }

  typeObjectOf(expressID: number): number | null {
    this.typeObjects ??= this.relate("IfcRelDefinesByType", "RelatingType", "RelatedObjects");
    return this.typeObjects.get(expressID) ?? null;
  }

  /** The storey an element sits in, walking up through aggregation. */
  storeyOf(expressID: number): number | null {
    let node: number | null = this.containerOf(expressID) ?? this.aggregateOf(expressID);
    for (let hops = 0; node !== null && hops < 12; hops++) {
      if (this.isType(node, "IfcBuildingStorey")) return node;
      node = this.containerOf(node) ?? this.aggregateOf(node);
    }
    return null;
  }

  guidOf(expressID: number): string | null {
    const line = this.line(expressID);
    const guid = line ? val(line.GlobalId) : null;
    return typeof guid === "string" ? guid : null;
  }

  /** GlobalId to expressID, for diffing and for stable references. */
  guidIndex(): Map<string, number> {
    if (this.guids) return this.guids;
    const map = new Map<string, number>();
    for (const id of this.byType("IfcRoot")) {
      const guid = this.guidOf(id);
      if (guid !== null) map.set(guid, id);
    }
    this.guids = map;
    return map;
  }

  // -- property sets ---------------------------------------------------------
  private propertyIndex(): Map<number, number[]> {
    if (this.psetIndex) return this.psetIndex;
    const map = new Map<number, number[]>();
    for (const rid of this.byType("IfcRelDefinesByProperties", false)) {
      const rel = this.line(rid);
      if (!rel) continue;
      const definition = ref(rel.RelatingPropertyDefinition);
      if (definition === null) continue;
      for (const owner of refs(rel.RelatedObjects)) {
        const list = map.get(owner);
        if (list) list.push(definition);
        else map.set(owner, [definition]);
      }
    }
    this.psetIndex = map;
    return map;
  }

  /** One property set or quantity set, flattened to name/value pairs. */
  private readSet(setID: number): [string, PropertyValue] | null {
    const set = this.line(setID);
    if (!set) return null;
    const name = String(val(set.Name) ?? "(unnamed)");
    const out: PropertyValue = {};
    for (const pid of refs(set.HasProperties)) {
      const property = this.line(pid);
      if (!property) continue;
      const key = String(val(property.Name) ?? "");
      if (key) out[key] = val(property.NominalValue);
    }
    // Qto_* sets carry quantities instead, each with its own value attribute.
    for (const qid of refs(set.Quantities)) {
      const quantity = this.line(qid);
      if (!quantity) continue;
      const key = String(val(quantity.Name) ?? "");
      if (!key) continue;
      out[key] =
        val(quantity.LengthValue) ??
        val(quantity.AreaValue) ??
        val(quantity.VolumeValue) ??
        val(quantity.CountValue) ??
        val(quantity.WeightValue) ??
        val(quantity.TimeValue);
    }
    return [name, out];
  }

  /**
   * Property sets for one element. With `inherited`, the element type's sets
   * are merged underneath, which is what a scheduling tool reports and what a
   * plain instance-only read gets wrong.
   */
  psetsOf(expressID: number, inherited = true): PropertySets {
    const index = this.propertyIndex();
    const out: PropertySets = {};
    if (inherited) {
      const typeObject = this.typeObjectOf(expressID);
      if (typeObject !== null) {
        for (const setID of index.get(typeObject) ?? []) {
          const entry = this.readSet(setID);
          if (entry) out[entry[0]] = entry[1];
        }
        // IfcTypeObject.HasPropertySets is the direct link, not a relationship.
        const type = this.line(typeObject);
        for (const setID of refs(type?.HasPropertySets)) {
          const entry = this.readSet(setID);
          if (entry) out[entry[0]] = { ...out[entry[0]], ...entry[1] };
        }
      }
    }
    for (const setID of index.get(expressID) ?? []) {
      const entry = this.readSet(setID);
      if (entry) out[entry[0]] = { ...out[entry[0]], ...entry[1] };
    }
    return out;
  }

  /** Flat "Set.Property" to value map, for column lookups. */
  flatProperties(expressID: number, inherited = true): Map<string, string | number | boolean | null> {
    const flat = new Map<string, string | number | boolean | null>();
    for (const [setName, values] of Object.entries(this.psetsOf(expressID, inherited))) {
      for (const [key, value] of Object.entries(values)) {
        flat.set(`${setName}.${key}`, value);
        if (!flat.has(key)) flat.set(key, value);
      }
    }
    return flat;
  }
}
