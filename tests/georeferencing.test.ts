import { describe, expect, it } from 'vitest';
import type { IfcAPI } from 'web-ifc';
import {
  applyModelTransform,
  canTransform,
  compatibleCrs,
  localToProjected,
  projectedToLocal,
  relativeModelTransform,
} from '../src/geo/coordinates.js';
import { readIfcGeoReference } from '../src/ifc/georeferencing.js';
import type { IfcGeoReference, MapConversionInfo, ProjectedCrsInfo } from '../src/viewer-core/engine/types.js';

const crs = (name = 'EPSG:25833'): ProjectedCrsInfo => ({
  expressID: 10,
  name,
  description: null,
  geodeticDatum: 'ETRS89',
  verticalDatum: 'DHHN2016',
  mapProjection: 'UTM',
  mapZone: '33N',
  mapUnit: 'METRE',
});

function reference(operation: MapConversionInfo, name = 'EPSG:25833'): IfcGeoReference {
  return { schema: 'IFC4X3_ADD2', projectedCrs: crs(name), operation, trueNorth: null, warnings: [] };
}

function conversion(overrides: Partial<MapConversionInfo> = {}): MapConversionInfo {
  return {
    kind: 'map-conversion',
    expressID: 20,
    sourceCrsID: 30,
    targetCrsID: 10,
    eastings: 500_000,
    northings: 5_800_000,
    orthogonalHeight: 100,
    xAxisAbscissa: 1,
    xAxisOrdinate: 0,
    rotation: 0,
    scale: 1,
    ...overrides,
  };
}

describe('IFC projected coordinate transforms', () => {
  it('round trips local coordinates through rotation, scale and map translation', () => {
    const geo = reference(conversion({ rotation: Math.PI / 2, scale: 2, eastings: 500, northings: 1_000, orthogonalHeight: 30 }));
    const projected = localToProjected([10, -5, 2], geo);
    expect(projected).toEqual([510, 1_020, 34]);
    const local = projectedToLocal(projected!, geo)!;
    expect(local[0]).toBeCloseTo(10);
    expect(local[1]).toBeCloseTo(-5);
    expect(local[2]).toBeCloseTo(2);
  });

  it('places a compatible model in the anchor engineering frame', () => {
    const anchor = reference(conversion({ rotation: Math.PI / 6 }));
    const model = reference(conversion({
      eastings: 500_100,
      northings: 5_800_200,
      orthogonalHeight: 104,
      rotation: Math.PI * 5 / 12,
      scale: 0.9996,
    }));
    const transform = relativeModelTransform(anchor, model);
    expect(transform).not.toBeNull();
    expect(transform?.rotationZ).toBeCloseTo(Math.PI / 4);
    expect(transform?.scale).toBeCloseTo(0.9996);
    const point = [12, -4, 3] as [number, number, number];
    const throughAnchor = localToProjected(applyModelTransform(point, transform!), anchor);
    const throughModel = localToProjected(point, model);
    expect(throughAnchor?.[0]).toBeCloseTo(throughModel![0], 8);
    expect(throughAnchor?.[1]).toBeCloseTo(throughModel![1], 8);
    expect(throughAnchor?.[2]).toBeCloseTo(throughModel![2], 8);
  });

  it('refuses automatic placement when projected CRS declarations conflict', () => {
    const anchor = reference(conversion(), 'EPSG:25833');
    const model = reference(conversion({ eastings: 400_000 }), 'EPSG:32633');
    expect(compatibleCrs(anchor.projectedCrs, model.projectedCrs)).toBe(false);
    expect(relativeModelTransform(anchor, model)).toBeNull();
  });
});

describe('IFC georeferencing extraction', () => {
  it('reads map conversion, projected CRS, datum, unit and true north', () => {
    const typeCodes = new Map([
      ['IFCPROJECTEDCRS', 1],
      ['IFCMAPCONVERSION', 2],
      ['IFCRIGIDOPERATION', 3],
      ['IFCGEOMETRICREPRESENTATIONCONTEXT', 4],
    ]);
    const ids = new Map<number, number[]>([[1, [10]], [2, [20]], [3, []], [4, [40]]]);
    const lines = new Map<number, Record<string, unknown>>([
      [10, {
        Name: { value: 'EPSG:25833' },
        GeodeticDatum: { value: 'ETRS89' },
        VerticalDatum: { value: 'DHHN2016' },
        MapProjection: { value: 'UTM' },
        MapZone: { value: '33N' },
        MapUnit: { value: 60 },
      }],
      [20, {
        SourceCRS: { value: 30 },
        TargetCRS: { value: 10 },
        Eastings: { value: 333_000 },
        Northings: { value: 5_999_000 },
        OrthogonalHeight: { value: 42 },
        XAxisAbscissa: { value: Math.cos(Math.PI / 6) },
        XAxisOrdinate: { value: Math.sin(Math.PI / 6) },
        Scale: { value: 0.9996 },
      }],
      [40, { TrueNorth: { value: 50 } }],
      [50, { DirectionRatios: [{ value: 0.1 }, { value: 1 }] }],
      [60, { Name: { value: 'METRE' } }],
    ]);
    const vector = (values: number[]) => ({ size: () => values.length, get: (index: number) => values[index], delete: () => undefined });
    const api = {
      GetTypeCodeFromName: (name: string) => typeCodes.get(name) ?? 0,
      GetLineIDsWithType: (_modelID: number, code: number) => vector(ids.get(code) ?? []),
      GetLine: (_modelID: number, id: number) => lines.get(id),
      GetModelSchema: () => 'IFC4X3_ADD2',
    } as unknown as IfcAPI;

    const geo = readIfcGeoReference(api, 1);
    expect(geo.projectedCrs).toMatchObject({ name: 'EPSG:25833', geodeticDatum: 'ETRS89', verticalDatum: 'DHHN2016', mapUnit: 'METRE' });
    expect(geo.operation).toMatchObject({ kind: 'map-conversion', eastings: 333_000, northings: 5_999_000, scale: 0.9996 });
    expect(geo.operation?.kind === 'map-conversion' ? geo.operation.rotation : 0).toBeCloseTo(Math.PI / 6);
    expect(geo.trueNorth?.degreesFromGridNorth).toBeCloseTo(Math.atan2(0.1, 1) * 180 / Math.PI);
    expect(geo.warnings).toEqual([]);
  });

  it('keeps length-based IfcRigidOperation available for truncated coordinates', () => {
    const codes = new Map([['IFCPROJECTEDCRS', 1], ['IFCMAPCONVERSION', 2], ['IFCRIGIDOPERATION', 3], ['IFCGEOMETRICREPRESENTATIONCONTEXT', 4]]);
    const typeIds = new Map<number, number[]>([[1, [10]], [2, []], [3, [30]], [4, []]]);
    const lines = new Map<number, Record<string, unknown>>([
      [10, { Name: { value: 'EPSG:25833' } }],
      [30, {
        SourceCRS: { value: 20 },
        TargetCRS: { value: 10 },
        FirstCoordinate: { name: 'IFCLENGTHMEASURE', value: 500_000 },
        SecondCoordinate: { name: 'IFCLENGTHMEASURE', value: 5_800_000 },
        Height: { value: 100 },
      }],
    ]);
    const api = {
      GetTypeCodeFromName: (name: string) => codes.get(name) ?? 0,
      GetLineIDsWithType: (_modelID: number, code: number) => ({ size: () => (typeIds.get(code) ?? []).length, get: (index: number) => (typeIds.get(code) ?? [])[index] }),
      GetLine: (_modelID: number, id: number) => lines.get(id),
      GetModelSchema: () => 'IFC4X3_ADD2',
    } as unknown as IfcAPI;

    const geo = readIfcGeoReference(api, 1);
    expect(geo.operation).toMatchObject({ kind: 'rigid-operation', coordinateKind: 'length', firstCoordinate: 500_000 });
    expect(canTransform(geo)).toBe(true);
  });
});
