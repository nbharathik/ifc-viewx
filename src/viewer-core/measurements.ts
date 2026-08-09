/**
 * Measurement arithmetic stays in metres. This module is the display edge:
 * unit choices and rounding never flow back into geometry calculations.
 */
export type MeasurementUnit =
  | "auto"
  | "millimetres"
  | "centimetres"
  | "metres"
  | "decimal-feet"
  | "decimal-inches"
  | "engineering"
  | "architectural";

export interface MeasurementPrecision {
  mode: "decimals" | "denominator" | "increment";
  value: number;
}

export interface MeasurementFormat {
  unit: MeasurementUnit;
  precision: MeasurementPrecision;
  /** AutoCAD-style component/decimal suppression flags described in the roadmap. */
  zeroSuppression: 0 | 1 | 2 | 3 | 4 | 8 | 12;
}

export const DEFAULT_MEASUREMENT_FORMAT: Readonly<MeasurementFormat> = Object.freeze({
  unit: "auto",
  precision: Object.freeze({ mode: "decimals", value: 2 }),
  zeroSuppression: 0,
});

export type MeasurementSemantic =
  | "point-to-point"
  | "point-to-line"
  | "point-to-face"
  | "line-to-line"
  | "line-to-face"
  | "face-to-face";

export type MeasurementEndKind = "vertex" | "midpoint" | "edge" | "surface";
export type MeasureConstraint = "free" | "x" | "y" | "z" | "perpendicular" | "parallel";
export type Point3 = [number, number, number];

const END_CLASS: Record<MeasurementEndKind, "point" | "line" | "face"> = {
  vertex: "point",
  midpoint: "line",
  edge: "line",
  surface: "face",
};

/** A stable, order-independent name for what the two endpoints landed on. */
export function measurementSemantic(
  ends: [MeasurementEndKind, MeasurementEndKind],
): MeasurementSemantic {
  const rank = { point: 0, line: 1, face: 2 } as const;
  const pair = ends.map((end) => END_CLASS[end]).sort((a, b) => rank[a] - rank[b]);
  return `${pair[0]}-to-${pair[1]}` as MeasurementSemantic;
}

/** Apply an orthographic world-axis lock without mutating either input point. */
export function constrainMeasurementPoint(
  origin: Point3,
  point: Point3,
  lock: MeasureConstraint,
  surfaceNormal?: Point3 | null,
): Point3 {
  if (lock === "x") return [point[0], origin[1], origin[2]];
  if (lock === "y") return [origin[0], point[1], origin[2]];
  if (lock === "z") return [origin[0], origin[1], point[2]];
  if ((lock === "perpendicular" || lock === "parallel") && surfaceNormal) {
    const length = Math.hypot(...surfaceNormal);
    if (length > 1e-12) {
      const normal: Point3 = surfaceNormal.map((value) => value / length) as Point3;
      const delta: Point3 = [point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]];
      const along = delta[0] * normal[0] + delta[1] * normal[1] + delta[2] * normal[2];
      if (lock === "perpendicular") {
        return [origin[0] + normal[0] * along, origin[1] + normal[1] * along, origin[2] + normal[2] * along];
      }
      return [
        point[0] - normal[0] * along,
        point[1] - normal[1] * along,
        point[2] - normal[2] * along,
      ];
    }
  }
  return [...point];
}

function cleanFormat(value: Partial<MeasurementFormat> | undefined): MeasurementFormat {
  const unit = value?.unit ?? DEFAULT_MEASUREMENT_FORMAT.unit;
  const mode = value?.precision?.mode ?? DEFAULT_MEASUREMENT_FORMAT.precision.mode;
  const raw = value?.precision?.value ?? DEFAULT_MEASUREMENT_FORMAT.precision.value;
  const valid = Number.isFinite(raw) && (mode === "decimals" ? raw >= 0 : raw > 0);
  const precision = valid ? raw : DEFAULT_MEASUREMENT_FORMAT.precision.value;
  const zeroSuppression = value?.zeroSuppression ?? DEFAULT_MEASUREMENT_FORMAT.zeroSuppression;
  return { unit, precision: { mode, value: precision }, zeroSuppression };
}

function rounded(value: number, precision: MeasurementPrecision): number {
  if (precision.mode === "increment") return Math.round(value / precision.value) * precision.value;
  if (precision.mode === "denominator") return Math.round(value * precision.value) / precision.value;
  const scale = 10 ** Math.min(8, Math.max(0, Math.round(precision.value)));
  return Math.round(value * scale) / scale;
}

function decimal(value: number, precision: MeasurementPrecision, flags: number): string {
  const places = precision.mode === "decimals" ? Math.min(8, Math.max(0, Math.round(precision.value))) : 6;
  let out = rounded(value, precision).toFixed(places);
  if (flags & 8) out = out.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  if ((flags & 4) && Math.abs(Number(out)) < 1) out = out.replace(/^(-?)0\./, "$1.");
  return out === "-0" ? "0" : out;
}

function fraction(inches: number, denominator: number): { whole: number; numerator: number; denominator: number } {
  const safe = Math.max(1, Math.round(denominator));
  let whole = Math.floor(inches);
  let numerator = Math.round((inches - whole) * safe);
  if (numerator === safe) {
    whole += 1;
    numerator = 0;
  }
  if (numerator === 0) return { whole, numerator, denominator: 1 };
  let a = numerator;
  let b = safe;
  while (b) [a, b] = [b, a % b];
  return { whole, numerator: numerator / a, denominator: safe / a };
}

function feetAndInches(metres: number, format: MeasurementFormat, architectural: boolean): string {
  const negative = metres < 0 ? "-" : "";
  const totalInches = Math.abs(metres) / 0.0254;
  let feet = Math.floor(totalInches / 12);
  let inches = totalInches - feet * 12;
  let inchText: string;
  if (architectural) {
    const denominator = format.precision.mode === "denominator" ? format.precision.value : 16;
    const part = fraction(inches, denominator);
    inches = part.whole;
    if (inches >= 12) {
      feet += 1;
      inches -= 12;
    }
    inchText = part.numerator
      ? `${inches} ${part.numerator}/${part.denominator}`
      : String(inches);
  } else {
    inches = rounded(inches, format.precision);
    if (inches >= 12) {
      feet += 1;
      inches -= 12;
    }
    inchText = decimal(inches, format.precision, format.zeroSuppression);
  }

  // The low two bits select component suppression. 0 is the compact default,
  // 1 includes both, 2 includes zero feet, 3 includes zero inches.
  const componentMode = format.zeroSuppression & 3;
  const showFeet = feet !== 0 || componentMode === 1 || componentMode === 2;
  const showInches = inches !== 0 || componentMode === 1 || componentMode === 3;
  const feetPart = showFeet ? `${feet}'` : "";
  const inchPart = showInches ? `${inchText}\"` : "";
  return `${negative}${feetPart}${showFeet && showInches ? "-" : ""}${inchPart || (!feetPart ? '0"' : "")}`;
}

/** Format metres using the requested display convention. */
export function formatLength(metres: number, value?: Partial<MeasurementFormat>): string {
  if (!Number.isFinite(metres)) return "-";
  const format = cleanFormat(value);
  if (format.unit === "auto") {
    if (Math.abs(metres) >= 1) return `${metres.toFixed(Math.abs(metres) >= 100 ? 1 : 2)} m`;
    return `${Math.round(metres * 1000)} mm`;
  }
  if (format.unit === "engineering") return feetAndInches(metres, format, false);
  if (format.unit === "architectural") return feetAndInches(metres, format, true);
  const scale = {
    millimetres: 1000,
    centimetres: 100,
    metres: 1,
    "decimal-feet": 1 / 0.3048,
    "decimal-inches": 1 / 0.0254,
  }[format.unit];
  const suffix = {
    millimetres: "mm",
    centimetres: "cm",
    metres: "m",
    "decimal-feet": "ft",
    "decimal-inches": "in",
  }[format.unit];
  return `${decimal(metres * scale, format.precision, format.zeroSuppression)} ${suffix}`;
}

/** Area follows the chosen length unit squared while arithmetic stays in m2. */
export function formatArea(squareMetres: number, value?: Partial<MeasurementFormat>): string {
  if (!Number.isFinite(squareMetres)) return "-";
  const format = cleanFormat(value);
  if (format.unit === "auto") {
    if (Math.abs(squareMetres) >= 1) {
      return `${squareMetres.toFixed(Math.abs(squareMetres) >= 100 ? 1 : 2)} m2`;
    }
    return `${Math.round(squareMetres * 10000)} cm2`;
  }
  const unit = format.unit === "engineering" || format.unit === "architectural" ? "decimal-feet" : format.unit;
  const scale = {
    millimetres: 1_000_000,
    centimetres: 10_000,
    metres: 1,
    "decimal-feet": 1 / (0.3048 ** 2),
    "decimal-inches": 1 / (0.0254 ** 2),
  }[unit];
  const suffix = {
    millimetres: "mm2",
    centimetres: "cm2",
    metres: "m2",
    "decimal-feet": "ft2",
    "decimal-inches": "in2",
  }[unit];
  return `${decimal(squareMetres * scale, format.precision, format.zeroSuppression)} ${suffix}`;
}

export function formatCoordinate(point: Point3, value?: Partial<MeasurementFormat>): string {
  return `X ${formatLength(point[0], value)}  Y ${formatLength(point[1], value)}  Z ${formatLength(point[2], value)}`;
}
