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
    // Segmented facades and partitions leave visible door and window gaps.
    expect(found.get("IfcWall")).toBe(24);
    expect(found.get("IfcSlab")).toBe(4);
    expect(found.get("IfcColumn")).toBe(8);
    expect(found.get("IfcDoor")).toBe(4);
    expect(found.get("IfcWindow")).toBe(2);
    expect(found.get("IfcBuildingStorey")).toBe(2);
    // Two rooms per storey, each with a quantity set and a property set.
    expect(found.get("IfcSpace")).toBe(4);
    expect(found.get("IfcElementQuantity")).toBe(4);
    expect(found.get("IfcPropertySet")).toBe(28);
  });

  it("gives every space the quantities a room book reads", () => {
    const spaces = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCSPACE"));
    expect(spaces.size()).toBe(4);
    const first = api.GetLine(modelID, spaces.get(0)) as {
      Name?: { value?: string };
      LongName?: { value?: string };
    };
    expect(first.Name?.value).toBe("101");
    expect(first.LongName?.value).toBe("Open office");

    const quantities = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCQUANTITYAREA"));
    // Net and gross floor area on each of the four rooms.
    expect(quantities.size()).toBe(8);
    const area = api.GetLine(modelID, quantities.get(0)) as {
      Name?: { value?: string };
      AreaValue?: { value?: number };
    };
    expect(area.Name?.value).toBe("NetFloorArea");
    // Half of the inner footprint, allowing for the central partition.
    expect(area.AreaValue?.value).toBeCloseTo(47.8125, 3);
  });

  it("carries useful material assignments for organising and colour-by", () => {
    const materials = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCMATERIAL"));
    const names: string[] = [];
    for (let i = 0; i < materials.size(); i++) {
      const line = api.GetLine(modelID, materials.get(i)) as { Name?: { value?: string } };
      if (line.Name?.value) names.push(line.Name.value);
    }
    expect(names.sort()).toEqual([
      "Clear glass", "Concrete", "Oak", "Painted steel", "Warm white masonry",
    ]);
    const relations = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCRELASSOCIATESMATERIAL"));
    expect(relations.size()).toBe(5);
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
    // Forty-two styled products, twelve triangles each before any welding.
    expect(meshes).toBe(42);
    expect(triangles).toBeGreaterThanOrEqual(42 * 12);
  });

  it("joins the floor, walls and roof without a floating level", () => {
    const bounds = new Map<string, { min: number; max: number }>();
    api.StreamAllMeshes(modelID, (mesh) => {
      const product = api.GetLine(modelID, mesh.expressID) as { Name?: { value?: string } };
      const name = product.Name?.value;
      if (!name) return;
      let min = Number.POSITIVE_INFINITY;
      let max = Number.NEGATIVE_INFINITY;
      for (let i = 0; i < mesh.geometries.size(); i++) {
        const placed = mesh.geometries.get(i);
        const matrix = Array.from(placed.flatTransformation as ArrayLike<number>);
        const geometry = api.GetGeometry(modelID, placed.geometryExpressID);
        const vertices = api.GetVertexArray(geometry.GetVertexData(), geometry.GetVertexDataSize());
        for (let vertex = 0; vertex < vertices.length; vertex += 6) {
          const x = vertices[vertex];
          const y = vertices[vertex + 1];
          const z = vertices[vertex + 2];
          // web-ifc emits the viewer's Y-up coordinates.
          const worldY = matrix[1] * x + matrix[5] * y + matrix[9] * z + matrix[13];
          min = Math.min(min, worldY);
          max = Math.max(max, worldY);
        }
      }
      bounds.set(name, { min, max });
    });

    expect(bounds.get("Ground-bearing slab")).toMatchObject({ max: expect.closeTo(0, 5) });
    expect(bounds.get("South wall left 1")).toMatchObject({ min: expect.closeTo(0, 5), max: expect.closeTo(3, 5) });
    expect(bounds.get("First-floor slab")).toMatchObject({ min: expect.closeTo(3, 5), max: expect.closeTo(3.2, 5) });
    expect(bounds.get("South wall left 2")).toMatchObject({ min: expect.closeTo(3.2, 5), max: expect.closeTo(6.2, 5) });
    expect(bounds.get("Warm roof")).toMatchObject({ min: expect.closeTo(6.2, 5) });
  });

  it("reads back the property set the walls carry", () => {
    // Twenty-four wall segments plus the four rooms' Pset_SpaceCommon.
    const sets = api.GetLineIDsWithType(modelID, api.GetTypeCodeFromName("IFCPROPERTYSET"));
    expect(sets.size()).toBe(28);
    const first = api.GetLine(modelID, sets.get(0)) as { Name?: { value?: string } };
    expect(first.Name?.value).toBe("Pset_WallCommon");
  });
});
