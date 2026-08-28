import type {
  CoordinateOperationInfo,
  IfcGeoReference,
  ModelTransform,
  ProjectedCrsInfo,
} from '../viewer-core/engine/types.js';

export const IDENTITY_MODEL_TRANSFORM: ModelTransform = {
  translation: [0, 0, 0],
  rotationZ: 0,
  scale: 1,
  source: 'none',
};

export function operationTranslation(operation: CoordinateOperationInfo): [number, number, number] {
  return operation.kind === 'map-conversion'
    ? [operation.eastings, operation.northings, operation.orthogonalHeight]
    : [operation.firstCoordinate, operation.secondCoordinate, operation.height];
}

export function operationRotation(operation: CoordinateOperationInfo): number {
  return operation.kind === 'map-conversion' ? operation.rotation : 0;
}

export function operationScale(operation: CoordinateOperationInfo): number {
  return operation.kind === 'map-conversion' ? operation.scale : 1;
}

export function canTransform(reference: IfcGeoReference | null): reference is IfcGeoReference & {
  projectedCrs: ProjectedCrsInfo;
  operation: CoordinateOperationInfo;
} {
  if (!reference?.projectedCrs || !reference.operation) return false;
  if (reference.operation.kind === 'rigid-operation' && reference.operation.coordinateKind !== 'length') return false;
  const scale = operationScale(reference.operation);
  return Number.isFinite(scale) && scale > 0;
}

const clean = (value: string | null): string => (value ?? '').trim().toUpperCase().replace(/\s+/g, ' ');

export function crsKey(crs: ProjectedCrsInfo | null): string {
  if (!crs) return '';
  return [crs.name, crs.geodeticDatum, crs.verticalDatum, crs.mapProjection, crs.mapZone, crs.mapUnit]
    .map(clean)
    .join('|');
}

export function compatibleCrs(a: ProjectedCrsInfo | null, b: ProjectedCrsInfo | null): boolean {
  if (!a || !b) return false;
  const nameA = clean(a.name);
  const nameB = clean(b.name);
  if (nameA && nameB) return nameA === nameB;
  return crsKey(a) === crsKey(b);
}

export function relativeModelTransform(
  anchor: IfcGeoReference,
  model: IfcGeoReference,
): ModelTransform | null {
  if (!canTransform(anchor) || !canTransform(model) || !compatibleCrs(anchor.projectedCrs, model.projectedCrs)) {
    return null;
  }
  const anchorOperation = anchor.operation;
  const modelOperation = model.operation;
  const anchorScale = operationScale(anchorOperation);
  const scale = operationScale(modelOperation) / anchorScale;
  const rotationZ = operationRotation(modelOperation) - operationRotation(anchorOperation);
  const anchorOffset = operationTranslation(anchorOperation);
  const modelOffset = operationTranslation(modelOperation);
  const dx = modelOffset[0] - anchorOffset[0];
  const dy = modelOffset[1] - anchorOffset[1];
  const dz = modelOffset[2] - anchorOffset[2];
  const angle = -operationRotation(anchorOperation);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    translation: [
      (cosine * dx - sine * dy) / anchorScale,
      (sine * dx + cosine * dy) / anchorScale,
      dz / anchorScale,
    ],
    rotationZ,
    scale,
    source: 'automatic',
  };
}

export function localToProjected(
  point: [number, number, number],
  reference: IfcGeoReference,
): [number, number, number] | null {
  if (!canTransform(reference)) return null;
  const operation = reference.operation;
  const translation = operationTranslation(operation);
  const scale = operationScale(operation);
  const angle = operationRotation(operation);
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    translation[0] + scale * (cosine * point[0] - sine * point[1]),
    translation[1] + scale * (sine * point[0] + cosine * point[1]),
    translation[2] + scale * point[2],
  ];
}

export function projectedToLocal(
  point: [number, number, number],
  reference: IfcGeoReference,
): [number, number, number] | null {
  if (!canTransform(reference)) return null;
  const operation = reference.operation;
  const translation = operationTranslation(operation);
  const scale = operationScale(operation);
  const angle = -operationRotation(operation);
  const x = (point[0] - translation[0]) / scale;
  const y = (point[1] - translation[1]) / scale;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return [
    cosine * x - sine * y,
    sine * x + cosine * y,
    (point[2] - translation[2]) / scale,
  ];
}

export function applyModelTransform(
  point: [number, number, number],
  transform: ModelTransform,
): [number, number, number] {
  const cosine = Math.cos(transform.rotationZ) * transform.scale;
  const sine = Math.sin(transform.rotationZ) * transform.scale;
  return [
    cosine * point[0] - sine * point[1] + transform.translation[0],
    sine * point[0] + cosine * point[1] + transform.translation[1],
    transform.scale * point[2] + transform.translation[2],
  ];
}

export function safeModelTransform(transform: Partial<ModelTransform>): ModelTransform {
  const translation = transform.translation ?? [0, 0, 0];
  return {
    translation: translation.map((value) => Number.isFinite(value) ? value : 0) as [number, number, number],
    rotationZ: Number.isFinite(transform.rotationZ) ? transform.rotationZ! : 0,
    scale: Number.isFinite(transform.scale) && transform.scale! > 0 ? transform.scale! : 1,
    source: transform.source ?? 'manual',
    ...(transform.recordedAt ? { recordedAt: transform.recordedAt } : {}),
  };
}
