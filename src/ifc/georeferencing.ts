import type { IfcAPI } from 'web-ifc';
import type {
  CoordinateOperationInfo,
  IfcGeoReference,
  ProjectedCrsInfo,
  TrueNorthInfo,
} from '../viewer-core/engine/types.js';

type Line = Record<string, unknown>;

function scalar(value: unknown): string | number | boolean | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value !== 'object' || Array.isArray(value)) return null;
  return scalar((value as { value?: unknown }).value);
}

function text(value: unknown): string | null {
  const valueText = scalar(value);
  return typeof valueText === 'string' && valueText.trim() ? valueText.trim() : null;
}

function number(value: unknown, fallback = 0): number {
  const numeric = scalar(value);
  return typeof numeric === 'number' && Number.isFinite(numeric) ? numeric : fallback;
}

function reference(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as { value?: unknown; name?: unknown };
  return typeof record.value === 'number' && !record.name ? record.value : null;
}

function byType(api: IfcAPI, modelID: number, name: string): number[] {
  try {
    const code = api.GetTypeCodeFromName(name.toUpperCase());
    if (!code) return [];
    const vector = api.GetLineIDsWithType(modelID, code, false);
    const ids = Array.from({ length: vector.size() }, (_, index) => vector.get(index));
    (vector as unknown as { delete?: () => void }).delete?.();
    return ids;
  } catch {
    return [];
  }
}

function line(api: IfcAPI, modelID: number, expressID: number | null): Line | null {
  if (expressID === null) return null;
  try {
    return api.GetLine(modelID, expressID) as Line;
  } catch {
    return null;
  }
}

function unitName(api: IfcAPI, modelID: number, value: unknown): string | null {
  const unit = line(api, modelID, reference(value));
  if (!unit) return null;
  const name = text(unit.Name);
  const prefix = text(unit.Prefix);
  if (!name) return null;
  return prefix ? `${prefix}_${name}` : name;
}

function projectedCrs(api: IfcAPI, modelID: number, preferred: number | null): ProjectedCrsInfo | null {
  const ids = byType(api, modelID, 'IfcProjectedCRS');
  const expressID = preferred !== null && ids.includes(preferred) ? preferred : ids[0];
  const crs = line(api, modelID, expressID ?? null);
  if (!crs || expressID === undefined) return null;
  return {
    expressID,
    name: text(crs.Name),
    description: text(crs.Description),
    geodeticDatum: text(crs.GeodeticDatum),
    verticalDatum: text(crs.VerticalDatum),
    mapProjection: text(crs.MapProjection),
    mapZone: text(crs.MapZone),
    mapUnit: unitName(api, modelID, crs.MapUnit),
  };
}

function measureKind(value: unknown): 'length' | 'angle' | 'unknown' {
  if (!value || typeof value !== 'object') return 'unknown';
  const name = String((value as { name?: unknown }).name ?? '').toUpperCase();
  if (name.includes('LENGTH')) return 'length';
  if (name.includes('ANGLE')) return 'angle';
  return 'unknown';
}

function coordinateOperation(
  api: IfcAPI,
  modelID: number,
): { operation: CoordinateOperationInfo | null; count: number } {
  const maps = byType(api, modelID, 'IfcMapConversion');
  if (maps.length) {
    const expressID = maps[0];
    const operation = line(api, modelID, expressID);
    if (!operation) return { operation: null, count: maps.length };
    const xAxisAbscissa = number(operation.XAxisAbscissa, 1);
    const xAxisOrdinate = number(operation.XAxisOrdinate, 0);
    const scale = number(operation.Scale, 1);
    return {
      count: maps.length,
      operation: {
        kind: 'map-conversion',
        expressID,
        sourceCrsID: reference(operation.SourceCRS),
        targetCrsID: reference(operation.TargetCRS),
        eastings: number(operation.Eastings),
        northings: number(operation.Northings),
        orthogonalHeight: number(operation.OrthogonalHeight),
        xAxisAbscissa,
        xAxisOrdinate,
        rotation: Math.atan2(xAxisOrdinate, xAxisAbscissa),
        scale,
      },
    };
  }

  const rigids = byType(api, modelID, 'IfcRigidOperation');
  if (!rigids.length) return { operation: null, count: 0 };
  const expressID = rigids[0];
  const operation = line(api, modelID, expressID);
  if (!operation) return { operation: null, count: rigids.length };
  const firstKind = measureKind(operation.FirstCoordinate);
  const secondKind = measureKind(operation.SecondCoordinate);
  return {
    count: rigids.length,
    operation: {
      kind: 'rigid-operation',
      expressID,
      sourceCrsID: reference(operation.SourceCRS),
      targetCrsID: reference(operation.TargetCRS),
      firstCoordinate: number(operation.FirstCoordinate),
      secondCoordinate: number(operation.SecondCoordinate),
      height: number(operation.Height),
      coordinateKind: firstKind === secondKind ? firstKind : 'unknown',
    },
  };
}

function trueNorth(api: IfcAPI, modelID: number): TrueNorthInfo | null {
  for (const expressID of byType(api, modelID, 'IfcGeometricRepresentationContext')) {
    const context = line(api, modelID, expressID);
    const direction = line(api, modelID, reference(context?.TrueNorth));
    const ratios = direction?.DirectionRatios;
    if (!Array.isArray(ratios) || ratios.length < 2) continue;
    const x = number(ratios[0], NaN);
    const y = number(ratios[1], NaN);
    if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < 1e-12) continue;
    return {
      direction: [x, y],
      degreesFromGridNorth: Math.atan2(x, y) * 180 / Math.PI,
    };
  }
  return null;
}

export function readIfcGeoReference(api: IfcAPI, modelID: number): IfcGeoReference {
  const result = coordinateOperation(api, modelID);
  const crs = projectedCrs(api, modelID, result.operation?.targetCrsID ?? null);
  const north = trueNorth(api, modelID);
  const warnings: string[] = [];
  if (!crs) warnings.push('No IfcProjectedCRS was found.');
  if (!result.operation) warnings.push('No IfcMapConversion or IfcRigidOperation was found.');
  if (result.count > 1) warnings.push('Multiple coordinate operations were found; the first one is active.');
  if (result.operation?.kind === 'map-conversion') {
    if (!Number.isFinite(result.operation.scale) || result.operation.scale <= 0) {
      warnings.push('The map conversion scale is invalid.');
    }
    if (Math.hypot(result.operation.xAxisAbscissa, result.operation.xAxisOrdinate) < 1e-12) {
      warnings.push('The map conversion X-axis direction is invalid.');
    }
  }
  if (result.operation?.kind === 'rigid-operation' && result.operation.coordinateKind !== 'length') {
    warnings.push('The rigid operation uses angular or unknown coordinates and cannot be aligned as a projected model.');
  }
  return {
    schema: api.GetModelSchema(modelID),
    projectedCrs: crs,
    operation: result.operation,
    trueNorth: north,
    warnings,
  };
}
