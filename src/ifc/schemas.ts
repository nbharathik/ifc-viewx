// What this build actually reads, per schema.
//
// "Supports IFC4.3" is a claim every viewer makes and almost none qualifies.
// This is the qualification: one row per schema, saying what the parser does
// with it and what is missing, so a road or rail team can tell before they
// open the file rather than after.
export type SchemaSupport = "full" | "partial" | "geometry" | "none";

export interface SchemaRow {
  schema: string;
  label: string;
  geometry: SchemaSupport;
  properties: SchemaSupport;
  spatial: SchemaSupport;
  /** Infrastructure entities: alignments, linear placement, referents. */
  linear: SchemaSupport;
  note: string;
}

export const SCHEMA_MATRIX: SchemaRow[] = [
  {
    schema: "IFC2X3",
    label: "IFC2x3 TC1",
    geometry: "full",
    properties: "full",
    spatial: "full",
    linear: "none",
    note: "The long-lived export target. No alignment entities exist in this schema.",
  },
  {
    schema: "IFC4",
    label: "IFC4 ADD2 TC1",
    geometry: "full",
    properties: "full",
    spatial: "full",
    linear: "none",
    note: "The current building schema. Everything in the viewer is written against it.",
  },
  {
    schema: "IFC4X1",
    label: "IFC4x1",
    geometry: "geometry",
    properties: "full",
    spatial: "full",
    linear: "partial",
    note: "The first alignment draft. Horizontal and vertical alignments are read; cant is not.",
  },
  {
    schema: "IFC4X2",
    label: "IFC4x2",
    geometry: "geometry",
    properties: "full",
    spatial: "full",
    linear: "partial",
    note: "Bridge extension. Alignments read as in 4x1.",
  },
  {
    schema: "IFC4X3",
    label: "IFC4.3 ADD2",
    geometry: "geometry",
    properties: "full",
    spatial: "full",
    linear: "partial",
    note:
      "Alignments are read from IfcAlignmentHorizontal and IfcAlignmentVertical: lines, circular arcs and clothoids " +
      "are solved, other transition curves are integrated as clothoids between their two curvatures. Cant, linear " +
      "placement along an alignment and referents are not yet read.",
  },
];

export const SUPPORT_LABEL: Record<SchemaSupport, string> = {
  full: "Full",
  partial: "Partial",
  geometry: "Geometry only",
  none: "Not in this schema",
};

/**
 * Exact declarations implemented by this build after punctuation is removed.
 * Dotted spellings are aliases, but unknown editions must not fall back to a
 * shorter family (for example IFC4X9 is not IFC4).
 */
const DECLARATION_FAMILY: Readonly<Record<string, string>> = {
  IFC2X3: "IFC2X3",
  IFC2X3TC1: "IFC2X3",
  IFC23: "IFC2X3",
  IFC23TC1: "IFC2X3",
  IFC4: "IFC4",
  IFC4ADD1: "IFC4",
  IFC4ADD2: "IFC4",
  IFC4ADD2TC1: "IFC4",
  IFC4X1: "IFC4X1",
  IFC41: "IFC4X1",
  IFC4X2: "IFC4X2",
  IFC42: "IFC4X2",
  IFC4X3: "IFC4X3",
  IFC43: "IFC4X3",
  IFC4X3ADD1: "IFC4X3",
  IFC43ADD1: "IFC4X3",
  IFC4X3ADD2: "IFC4X3",
  IFC43ADD2: "IFC4X3",
  IFC4X3TC1: "IFC4X3",
  IFC43TC1: "IFC4X3",
  IFC4X3RC1: "IFC4X3",
  IFC43RC1: "IFC4X3",
  IFC4X3RC2: "IFC4X3",
  IFC43RC2: "IFC4X3",
  IFC4X3RC3: "IFC4X3",
  IFC43RC3: "IFC4X3",
  IFC4X3RC4: "IFC4X3",
  IFC43RC4: "IFC4X3",
};

/** The row for a declared schema string, however the file spells it. */
export function schemaRow(declared: string): SchemaRow | null {
  const normalized = declared.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const family = DECLARATION_FAMILY[normalized];
  return family ? SCHEMA_MATRIX.find((row) => row.schema === family) ?? null : null;
}
