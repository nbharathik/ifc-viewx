// The sample model is generated, so nothing catches a malformed entity except
// a parse. This loads it through the same web-ifc build the viewer ships.
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { IfcAPI } from "web-ifc";

import { readIfcGeoReference } from "../src/ifc/georeferencing.js";
import { sampleModel, SAMPLE_NAME } from "../src/ui/sample.js";

let api: IfcAPI;
let modelID: number;

beforeAll(async () => {
  api = new IfcAPI();
  api.SetWasmPath("node_modules/web-ifc/", true);
  await api.Init();
  modelID = api.OpenModel(sampleModel());
});

afterAll(() => {
  if (api && modelID !== undefined) api.CloseModel(modelID);
});

describe("sample model", () => {
  it("has the header a viewer looks for", () => {
    const text = new TextDecoder().decode(sampleModel());
    expect(text.startsWith("ISO-10303-21;")).toBe(true);
    expect(text).toContain("FILE_SCHEMA(('IFC4'))");
    expect(text).toContain(SAMPLE_NAME);
    expect(text.trimEnd().endsWith("END-ISO-10303-21;")).toBe(true);
  });

  it("opens in web-ifc without an error", () => {
    expect(modelID).toBeGreaterThanOrEqual(0);
    expect(api.IsModelOpen(modelID)).toBe(true);
  });

  it("provides a projected CRS and map conversion for Geo Context", () => {
    const geo = readIfcGeoReference(api, modelID);
    expect(geo.projectedCrs).toMatchObject({ name: "EPSG:25833", geodeticDatum: "ETRS89", verticalDatum: "DHHN2016" });
    expect(geo.operation).toMatchObject({ kind: "map-conversion", eastings: 451_000, northings: 5_990_000, orthogonalHeight: 12.5 });
    expect(geo.trueNorth?.direction).toEqual([0, 1]);
    expect(geo.warnings).toEqual([]);
  });

  it("produces the classes the sample promises", () => {
    const found = new Map<string, number>();
    const lines = api.GetAllLines(modelID);
    for (let i = 0; i < lines.size(); i++) {
      const id = lines.get(i);
      const type = api.GetNameFromTypeCode(api.GetLineType(modelID, id));
      found.set(type, (found.get(type) ?? 0) + 1);
    }
    // Two storeys of: slab, four walls, two columns, a door and a window.
    expect(found.get("IfcWall")).toBe(8);
    expect(found.get("IfcSlab")).toBe(2);
    expect(found.get("IfcColumn")).toBe(4);
    expect(found.get("IfcDoor")).toBe(2);
    expect(found.get("IfcWindow")).toBe(2);
    expect(found.get("IfcBuildingStorey")).toBe(2);
    // Two rooms per storey, each with a quantity set and a property set.
    expect(found.get("IfcSpace")).toBe(4);
    expect(found.get("IfcElementQuantity")).toBe(4);
    expect(found.get("IfcPropertySet")).toBe(12);
  });

  it("gives every space the quantities a room book reads", () => {
    const spaces = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCSPACE"));
    expect(spaces.size()).toBe(4);
    const first = api.GetLine(modelID, spaces.get(0)) as {
      Name?: { value?: string };
      LongName?: { value?: string };
    };
    expect(first.Name?.value).toBe("101");
    expect(first.LongName?.value).toBe("Office");

    const quantities = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCQUANTITYAREA"));
    // Net and gross floor area on each of the four rooms.
    expect(quantities.size()).toBe(8);
    const area = api.GetLine(modelID, quantities.get(0)) as {
      Name?: { value?: string };
      AreaValue?: { value?: number };
    };
    expect(area.Name?.value).toBe("NetFloorArea");
    // Half of a 9.4 by 7.4 metre inner footprint.
    expect(area.AreaValue?.value).toBeCloseTo(34.78, 1);
  });

  it("tessellates into real geometry", () => {
    let meshes = 0;
    let triangles = 0;
    api.StreamAllMeshes(modelID, (mesh) => {
      meshes += 1;
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const placed = mesh.geometries.get(i);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        triangles += geometry.GetIndexDataSize() / 3;
      }
    });
    // Eighteen boxes, twelve triangles each, before any welding.
    expect(meshes).toBe(18);
    expect(triangles).toBeGreaterThanOrEqual(18 * 12);
  });

  it("reads back the property set the walls carry", () => {
    // Eight walls plus the four rooms' Pset_SpaceCommon.
    const sets = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCPROPERTYSET"));
    expect(sets.size()).toBe(12);
    const first = api.GetLine(modelID, sets.get(0)) as { Name?: { value?: string } };
    expect(first.Name?.value).toBe("Pset_WallCommon");
  });
});
