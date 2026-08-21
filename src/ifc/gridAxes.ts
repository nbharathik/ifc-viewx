import type { GridAxisLine, IfcGridInfo } from "../viewer-core/engine/types.js";

type Line = Record<string, unknown> & { expressID?: number };
type Point = [number, number, number];

export interface PlacementSource {
  line(expressID: number): Line | null;
  typeName(expressID: number): string;
}

export interface GridAxesSource extends PlacementSource {
  grids: Line[];
  /** Multiplier turning file plane-angle values into radians. */
  angleFactor: number;
  /** Optional 4x4 column-major matrix applied after the placement chain. */
  coordinationMatrix?: number[];
}

const REF_TYPE = 5;
const TWO_PI = Math.PI * 2;

function scalar(value: unknown): unknown {
  if (value && typeof value === "object" && !Array.isArray(value) && "value" in value) {
    return scalar((value as { value: unknown }).value);
  }
  return value;
}

function text(value: unknown): string {
  const raw = scalar(value);
  if (raw === null || raw === undefined) return "";
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "boolean") return String(raw);
  return "";
}

function nullableText(value: unknown): string | null {
  const found = text(value).trim();
  return found || null;
}

function numberValue(value: unknown): number | null {
  const raw = scalar(value);
  const numeric = typeof raw === "number" ? raw : Number(raw);
  return Number.isFinite(numeric) ? numeric : null;
}

function boolValue(value: unknown, fallback: boolean): boolean {
  const raw = scalar(value);
  if (typeof raw === "boolean") return raw;
  if (typeof raw === "string") {
    const t = raw.toUpperCase();
    if (t === "T" || t === ".T." || t === "TRUE") return true;
    if (t === "F" || t === ".F." || t === "FALSE") return false;
  }
  return fallback;
}

function ref(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("value" in value)) return null;
  const id = (value as { value: unknown }).value;
  return typeof id === "number" ? id : null;
}

function refs(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  return value.map(ref).filter((id): id is number => id !== null);
}

function tripleOf(coords: unknown): Point | null {
  if (!Array.isArray(coords) || coords.length === 0) return null;
  const nums = coords.map(numberValue);
  if (nums.some((n) => n === null)) return null;
  return [nums[0] ?? 0, nums[1] ?? 0, nums[2] ?? 0];
}

function pointOf(id: number | null, source: PlacementSource): Point | null {
  const line = id === null ? null : source.line(id);
  return line ? tripleOf(line.Coordinates) : null;
}

function directionOf(id: number | null, source: PlacementSource): Point | null {
  const line = id === null ? null : source.line(id);
  return line ? tripleOf(line.DirectionRatios) : null;
}

function dot(a: Point, b: Point): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: Point, b: Point): Point {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Point): Point {
  const len = Math.hypot(v[0], v[1], v[2]);
  return len > 0 ? [v[0] / len, v[1] / len, v[2] / len] : v;
}

function identity(): number[] {
  return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
}

/** Column-major 4x4 product a * b. */
export function multiply(a: number[], b: number[]): number[] {
  const out = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      out[c * 4 + r] =
        a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

export function transformPoint(m: number[], p: Point): Point {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

/** IfcAxis2Placement3D or 2D to a column-major matrix; 2D fields default into 3D. */
function axis2Matrix(place: Line, source: PlacementSource): number[] {
  const location = pointOf(ref(place.Location), source) ?? [0, 0, 0];
  const axis = directionOf(ref(place.Axis), source) ?? [0, 0, 1];
  const refDir = directionOf(ref(place.RefDirection), source) ?? [1, 0, 0];
  const z = normalize(axis);
  const along = dot(refDir, z);
  const x = normalize([refDir[0] - along * z[0], refDir[1] - along * z[1], refDir[2] - along * z[2]]);
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, location[0], location[1], location[2], 1];
}

interface PlacementResolution {
  matrix: number[];
  complete: boolean;
}

/** Composed IfcLocalPlacement chain, retaining whether every link was usable. */
function resolvePlacement(product: Line, source: PlacementSource): PlacementResolution {
  let matrix = identity();
  let placementId = ref(product.ObjectPlacement);
  const seen = new Set<number>();
  let complete = true;
  while (placementId !== null) {
    if (seen.has(placementId)) {
      complete = false;
      break;
    }
    seen.add(placementId);
    if (source.typeName(placementId) !== "IfcLocalPlacement") {
      complete = false;
      break;
    }
    const placement = source.line(placementId);
    if (!placement) {
      complete = false;
      break;
    }
    const relId = ref(placement.RelativePlacement);
    const relative = relId === null ? null : source.line(relId);
    if (relative) {
      const type = source.typeName(relId!);
      if (type !== "IfcAxis2Placement2D" && type !== "IfcAxis2Placement3D") complete = false;
      if (ref(relative.Location) === null || pointOf(ref(relative.Location), source) === null) complete = false;
      const axisId = ref(relative.Axis);
      const refDirectionId = ref(relative.RefDirection);
      if (axisId !== null && directionOf(axisId, source) === null) complete = false;
      if (refDirectionId !== null && directionOf(refDirectionId, source) === null) complete = false;
      matrix = multiply(axis2Matrix(relative, source), matrix);
    } else {
      complete = false;
    }
    placementId = ref(placement.PlacementRelTo);
  }
  return { matrix, complete };
}

/** Composed placement for permissive callers such as grid display. */
function placementMatrix(product: Line, source: PlacementSource): number[] {
  return resolvePlacement(product, source).matrix;
}

/** A complete local-placement chain, or null when evaluating it would guess. */
export function completeLocalPlacementMatrix(product: Line, source: PlacementSource): number[] | null {
  const resolved = resolvePlacement(product, source);
  return resolved.complete ? resolved.matrix : null;
}

interface TrimSelect {
  point: number | null;
  parameter: number | null;
}

function trimOf(entries: unknown): TrimSelect {
  const list = Array.isArray(entries) ? entries : entries ? [entries] : [];
  const trim: TrimSelect = { point: null, parameter: null };
  for (const entry of list) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as { type?: number };
    if (value.type === REF_TYPE && !("name" in value)) {
      const id = ref(entry);
      if (id !== null) trim.point = id;
    } else {
      const parameter = numberValue(entry);
      if (parameter !== null) trim.parameter = parameter;
    }
  }
  return trim;
}

function pick<T>(
  trim: TrimSelect,
  preferCartesian: boolean,
  byPoint: (id: number) => T | null,
  byParameter: (u: number) => T | null,
): T | null {
  if (preferCartesian && trim.point !== null) return byPoint(trim.point);
  if (trim.parameter !== null) return byParameter(trim.parameter);
  if (trim.point !== null) return byPoint(trim.point);
  return null;
}

function trimmedPoints(curve: Line, source: GridAxesSource): Point[] | null {
  const basisId = ref(curve.BasisCurve);
  const basis = basisId === null ? null : source.line(basisId);
  if (basisId === null || !basis) return null;
  const basisType = source.typeName(basisId);
  const trim1 = trimOf(curve.Trim1);
  const trim2 = trimOf(curve.Trim2);
  const preferCartesian = text(curve.MasterRepresentation).toUpperCase() !== "PARAMETER";
  const sense = boolValue(curve.SenseAgreement, true);

  if (basisType === "IfcLine") {
    const origin = pointOf(ref(basis.Pnt), source);
    const dirId = ref(basis.Dir);
    const vector = dirId === null ? null : source.line(dirId);
    const orientation = vector ? directionOf(ref(vector.Orientation), source) : null;
    if (!origin || !vector || !orientation) return null;
    const magnitude = numberValue(vector.Magnitude) ?? 1;
    const unit = normalize(orientation);
    const at = (u: number): Point => [
      origin[0] + u * magnitude * unit[0],
      origin[1] + u * magnitude * unit[1],
      origin[2] + u * magnitude * unit[2],
    ];
    const start = pick(trim1, preferCartesian, (id) => pointOf(id, source), at);
    const end = pick(trim2, preferCartesian, (id) => pointOf(id, source), at);
    return start && end ? [start, end] : null;
  }

  if (basisType === "IfcCircle") {
    const positionId = ref(basis.Position);
    const position = positionId === null ? null : source.line(positionId);
    const radius = numberValue(basis.Radius);
    if (!position || radius === null) return null;
    const frame = axis2Matrix(position, source);
    const center: Point = [frame[12], frame[13], frame[14]];
    const xAxis: Point = [frame[0], frame[1], frame[2]];
    const yAxis: Point = [frame[4], frame[5], frame[6]];
    const angleOf = (trim: TrimSelect): number | null =>
      pick(
        trim,
        preferCartesian,
        (id) => {
          const point = pointOf(id, source);
          if (!point) return null;
          const d: Point = [point[0] - center[0], point[1] - center[1], point[2] - center[2]];
          return Math.atan2(dot(d, yAxis), dot(d, xAxis));
        },
        (u) => u * source.angleFactor,
      );
    const t1 = angleOf(trim1);
    const t2 = angleOf(trim2);
    if (t1 === null || t2 === null) return null;
    let sweep = (sense ? t2 - t1 : t1 - t2) % TWO_PI;
    if (sweep <= 0) sweep += TWO_PI;
    const segments = Math.max(8, Math.ceil(sweep / (TWO_PI / 64)));
    const points: Point[] = [];
    for (let i = 0; i <= segments; i++) {
      const angle = sense ? t1 + (sweep * i) / segments : t1 - (sweep * i) / segments;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);
      points.push([
        center[0] + radius * (cos * xAxis[0] + sin * yAxis[0]),
        center[1] + radius * (cos * xAxis[1] + sin * yAxis[1]),
        center[2] + radius * (cos * xAxis[2] + sin * yAxis[2]),
      ]);
    }
    return points;
  }

  return null;
}

function curvePoints(curveId: number, source: GridAxesSource): Point[] | null {
  const curve = source.line(curveId);
  if (!curve) return null;
  const type = source.typeName(curveId);
  if (type === "IfcPolyline") {
    const points = refs(curve.Points)
      .map((id) => pointOf(id, source))
      .filter((p): p is Point => p !== null);
    return points.length >= 2 ? points : null;
  }
  if (type === "IfcIndexedPolyCurve") {
    // Segments arcs are ignored; grid axes are straight point runs in practice.
    const listId = ref(curve.Points);
    const list = listId === null ? null : source.line(listId);
    if (!list || !Array.isArray(list.CoordList)) return null;
    const points = list.CoordList.map(tripleOf).filter((p): p is Point => p !== null);
    return points.length >= 2 ? points : null;
  }
  if (type === "IfcTrimmedCurve") return trimmedPoints(curve, source);
  return null;
}

/** Plane-angle unit factor from the model's IfcUnitAssignment; defaults to radians. */
export function planeAngleFactor(
  assignment: Line | null,
  line: (expressID: number) => Line | null,
  typeName: (expressID: number) => string,
): number {
  for (const unitId of refs(assignment?.Units)) {
    const unit = line(unitId);
    if (!unit || !text(unit.UnitType).toUpperCase().includes("PLANEANGLEUNIT")) continue;
    const kind = typeName(unitId);
    if (kind === "IfcSIUnit") return 1;
    if (kind === "IfcConversionBasedUnit") {
      const measureId = ref(unit.ConversionFactor);
      const measure = measureId === null ? null : line(measureId);
      const factor = measure ? numberValue(measure.ValueComponent) : null;
      if (factor !== null) return factor;
    }
  }
  return 1;
}

const SI_PREFIX: Record<string, number> = {
  KILO: 1e3,
  HECTO: 1e2,
  DECA: 10,
  DECI: 0.1,
  CENTI: 0.01,
  MILLI: 1e-3,
  MICRO: 1e-6,
};

function siPrefixFactor(value: unknown): number {
  return SI_PREFIX[text(value).toUpperCase().replace(/\./g, "")] ?? 1;
}

/** Length unit factor to metres from the model's IfcUnitAssignment; defaults to 1. */
export function lengthUnitFactor(
  assignment: Line | null,
  line: (expressID: number) => Line | null,
  typeName: (expressID: number) => string,
): number {
  for (const unitId of refs(assignment?.Units)) {
    const unit = line(unitId);
    if (!unit || !text(unit.UnitType).toUpperCase().includes("LENGTHUNIT")) continue;
    const kind = typeName(unitId);
    if (kind === "IfcSIUnit") return siPrefixFactor(unit.Prefix);
    if (kind === "IfcConversionBasedUnit") {
      const measureId = ref(unit.ConversionFactor);
      const measure = measureId === null ? null : line(measureId);
      const factor = measure ? numberValue(measure.ValueComponent) : null;
      if (factor === null) continue;
      const componentId = measure ? ref(measure.UnitComponent) : null;
      const component = componentId === null ? null : line(componentId);
      return factor * (component ? siPrefixFactor(component.Prefix) : 1);
    }
  }
  return 1;
}

export function extractGridAxes(source: GridAxesSource): IfcGridInfo[] {
  const coordination =
    source.coordinationMatrix && source.coordinationMatrix.length === 16 ? source.coordinationMatrix : null;
  const grids: IfcGridInfo[] = [];
  for (const grid of source.grids) {
    const expressID = typeof grid.expressID === "number" ? grid.expressID : null;
    if (expressID === null) continue;
    let matrix = placementMatrix(grid, source);
    if (coordination) matrix = multiply(coordination, matrix);
    const axes: GridAxisLine[] = [];
    const collect = (key: "UAxes" | "VAxes" | "WAxes", axisGroup: "U" | "V" | "W"): void => {
      for (const axisId of refs(grid[key])) {
        const axis = source.line(axisId);
        if (!axis) continue;
        const curveId = ref(axis.AxisCurve);
        const local = curveId === null ? null : curvePoints(curveId, source);
        if (!local || local.length < 2) continue;
        if (!boolValue(axis.SameSense, true)) local.reverse();
        const points: number[] = [];
        for (const point of local) {
          const placed = transformPoint(matrix, point);
          points.push(placed[0], placed[1], placed[2]);
        }
        axes.push({ label: nullableText(axis.AxisTag), axisGroup, points });
      }
    };
    collect("UAxes", "U");
    collect("VAxes", "V");
    collect("WAxes", "W");
    grids.push({ expressID, name: nullableText(grid.Name), axes });
  }
  return grids;
}
