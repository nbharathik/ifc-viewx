// Reading a scan, in the tab.
//
// LAS is a fixed-layout binary format: a header that says where the points
// are, how big each one is and what scale to multiply the integers by. That
// is small enough to read here, which matters, because the alternative is
// uploading a survey of somebody's building to a service.
//
// LAZ is LAS run through an arithmetic coder and E57 is an XML-plus-binary
// container; both are conversions rather than readers, and they belong in
// Local Studio where IfcOpenShell and laspy already live.

export interface PointCloud {
  name: string;
  /** Point coordinates in the file's own coordinate system, xyz interleaved. */
  positions: Float64Array;
  /** RGB per point, 0-1, or null when the scan carries no colour. */
  colors: Float32Array | null;
  /** Intensity per point, 0-1, or null. */
  intensity: Float32Array | null;
  /** Points in the file, before any subsampling. */
  total: number;
  /** Bounds in the file's own coordinates. */
  min: [number, number, number];
  max: [number, number, number];
  /** Which axis the file calls up. LAS is Z-up; the scene is Y-up. */
  upAxis: "z" | "y";
  format: string;
}

export interface ReadOptions {
  /** Points to keep. A scan is tens of millions; a viewport is two million. */
  limit?: number;
  signal?: AbortSignal;
}

export const DEFAULT_POINT_LIMIT = 2_000_000;
const MAX_POINT_LIMIT = 5_000_000;

const LAS_MAGIC = 0x4653414c; // "LASF" little-endian

/** Byte length of each LAS point record format, by format id. */
const RECORD_LENGTH: Record<number, number> = {
  0: 20, 1: 28, 2: 26, 3: 34, 4: 57, 5: 63, 6: 30, 7: 36, 8: 38, 9: 59, 10: 67,
};

const HAS_COLOR = new Set([2, 3, 5, 7, 8, 10]);

function pointLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_POINT_LIMIT;
  if (!Number.isFinite(limit) || limit <= 0) throw new Error("Point limit must be a positive finite number.");
  if (limit > MAX_POINT_LIMIT) throw new Error(`Point limit cannot exceed ${MAX_POINT_LIMIT.toLocaleString()}.`);
  return Math.max(1, Math.floor(limit));
}

export function isLas(name: string): boolean {
  return /\.la[sz]$/i.test(name);
}

export function isText(name: string): boolean {
  return /\.(xyz|pts|txt|csv|asc)$/i.test(name);
}

export function readPointCloud(name: string, bytes: Uint8Array, options: ReadOptions = {}): PointCloud {
  if (bytes.length >= 4) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, Math.min(4, bytes.byteLength));
    if (view.getUint32(0, true) === LAS_MAGIC) return readLas(name, bytes, options);
  }
  if (/\.laz$/i.test(name)) {
    throw new Error("LAZ is compressed LAS. Convert it to LAS or E57 in Local Studio first.");
  }
  return readAscii(name, bytes, options);
}

function readLas(name: string, bytes: Uint8Array, options: ReadOptions): PointCloud {
  if (bytes.byteLength < 227) throw new Error("This LAS file has a truncated header.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const versionMajor = view.getUint8(24);
  const versionMinor = view.getUint8(25);
  const headerSize = view.getUint16(94, true);
  const pointOffset = view.getUint32(96, true);
  const recordFormatByte = view.getUint8(104);
  // The top two bits mark LAZ compression inside an otherwise normal header.
  if (recordFormatByte & 0x80) {
    throw new Error("This LAS file is LAZ-compressed. Convert it in Local Studio first.");
  }
  const recordFormat = recordFormatByte & 0x3f;
  const recordLength = view.getUint16(105, true);
  if (versionMajor !== 1 || versionMinor > 4) throw new Error(`LAS ${versionMajor}.${versionMinor} is not supported.`);
  const minimumHeader = versionMinor >= 4 ? 375 : versionMinor >= 3 ? 235 : 227;
  if (headerSize < minimumHeader) throw new Error("This LAS file has an invalid header size for its version.");
  if (recordFormat >= 6 && versionMinor < 4) throw new Error("This LAS point format requires a LAS 1.4 header.");
  const expectedLength = RECORD_LENGTH[recordFormat];
  if (!expectedLength) throw new Error(`LAS point format ${recordFormat} is not supported.`);
  if (recordLength < expectedLength) throw new Error("This LAS file has invalid point records.");
  if (headerSize < 227 || pointOffset < headerSize || pointOffset > bytes.byteLength) {
    throw new Error("This LAS file has an invalid header or point-data offset.");
  }
  const legacyCount = view.getUint32(107, true);
  const scale: [number, number, number] = [
    view.getFloat64(131, true),
    view.getFloat64(139, true),
    view.getFloat64(147, true),
  ];
  const offset: [number, number, number] = [
    view.getFloat64(155, true),
    view.getFloat64(163, true),
    view.getFloat64(171, true),
  ];
  if ([...scale, ...offset].some((value) => !Number.isFinite(value)) || scale.some((value) => value === 0)) {
    throw new Error("This LAS file has an invalid coordinate scale or offset.");
  }
  const max: [number, number, number] = [
    view.getFloat64(179, true),
    view.getFloat64(195, true),
    view.getFloat64(211, true),
  ];
  const min: [number, number, number] = [
    view.getFloat64(187, true),
    view.getFloat64(203, true),
    view.getFloat64(219, true),
  ];
  if ([...min, ...max].some((value) => !Number.isFinite(value)) ||
    min.some((value, axis) => value > max[axis])) {
    throw new Error("This LAS file has invalid coordinate bounds.");
  }
  // 1.4 moved the count to a 64-bit field and leaves the legacy one at zero
  // for files with more than four billion points.
  let total = legacyCount;
  if (versionMajor === 1 && versionMinor >= 4 && headerSize >= 375) {
    const extended = Number(view.getBigUint64(247, true));
    if (extended > 0) total = extended;
  }
  const stride = recordLength;
  const available = Math.floor((bytes.byteLength - pointOffset) / stride);
  if (total > available) throw new Error("This LAS file ends before its declared point records are complete.");
  total = total || available;
  if (total <= 0) throw new Error("This LAS file carries no point records.");

  const limit = pointLimit(options.limit);
  const step = Math.max(1, Math.ceil(total / limit));
  const kept = Math.ceil(total / step);
  const positions = new Float64Array(kept * 3);
  const withColor = HAS_COLOR.has(recordFormat);
  const colors = withColor ? new Float32Array(kept * 3) : null;
  const intensity = new Float32Array(kept);

  let out = 0;
  for (let index = 0; index < total; index += step) {
    if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const at = pointOffset + index * stride;
    if (at + 12 > bytes.byteLength) break;
    positions[out * 3] = view.getInt32(at, true) * scale[0] + offset[0];
    positions[out * 3 + 1] = view.getInt32(at + 4, true) * scale[1] + offset[1];
    positions[out * 3 + 2] = view.getInt32(at + 8, true) * scale[2] + offset[2];
    intensity[out] = view.getUint16(at + 12, true) / 65535;
    if (colors) {
      // Colour sits after the point's own fields, and where that is depends
      // on the record format; the offsets below are the ones the spec gives.
      const colorAt = at + (recordFormat === 2 ? 20 : recordFormat === 3 || recordFormat === 5 ? 28 : recordFormat === 7 ? 30 : 30);
      if (colorAt + 6 <= at + stride && colorAt + 6 <= bytes.byteLength) {
        colors[out * 3] = view.getUint16(colorAt, true) / 65535;
        colors[out * 3 + 1] = view.getUint16(colorAt + 2, true) / 65535;
        colors[out * 3 + 2] = view.getUint16(colorAt + 4, true) / 65535;
      }
    }
    out++;
    if (out >= kept) break;
  }

  return {
    name,
    positions: positions.subarray(0, out * 3),
    colors: colors ? colors.subarray(0, out * 3) : null,
    intensity: intensity.subarray(0, out),
    total,
    min,
    max,
    upAxis: "z",
    format: `LAS ${versionMajor}.${versionMinor} format ${recordFormat}`,
  };
}

/**
 * Plain text: X Y Z, optionally followed by intensity and RGB. This is what
 * every scanner exports when asked for something universal, and what a
 * surveyor is most likely to be able to hand over without a conversion.
 */
function readAscii(name: string, bytes: Uint8Array, options: ReadOptions): PointCloud {
  const text = new TextDecoder().decode(bytes);
  const limit = pointLimit(options.limit);
  // Even the shortest repeated valid row needs six bytes including its line
  // break. Avoid reserving the two-million-point default for a tiny file.
  const capacity = Math.min(limit, Math.max(1, Math.floor(bytes.byteLength / 6) + 1));
  const positions = new Float64Array(capacity * 3);
  const colors = new Float32Array(capacity * 3);
  const intensity = new Float32Array(capacity);
  let kept = 0;
  let stride = 1;
  let total = 0;
  let sawColor = false;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  // Iterate matches instead of splitting the whole export into another huge
  // array; survey text files can contain millions of rows.
  for (const match of text.matchAll(/[^\r\n]+/g)) {
    const line = match[0];
    if (options.signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("#")) continue;
    const parts = trimmed.split(/[\s,;]+/);
    if (parts.length < 3) continue;
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const z = Number(parts[2]);
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
    total++;
    const coordinate = [x, y, z] as const;
    for (let axis = 0; axis < 3; axis++) {
      const value = coordinate[axis];
      if (value < min[axis]) min[axis] = value;
      if (value > max[axis]) max[axis] = value;
    }
    const sourceIndex = total - 1;
    if (sourceIndex % stride !== 0 || (capacity === 1 && kept === 1)) continue;
    if (kept >= capacity) {
      // Make room for the rest of the file while retaining samples across
      // its whole extent. Keeping only the first N rows badly biases scans
      // that are ordered by strip or acquisition time.
      let write = 0;
      for (let read = 0; read < kept; read += 2) {
        positions.copyWithin(write * 3, read * 3, read * 3 + 3);
        colors.copyWithin(write * 3, read * 3, read * 3 + 3);
        intensity[write] = intensity[read];
        write += 1;
      }
      kept = write;
      stride *= 2;
      if (sourceIndex % stride !== 0) continue;
    }
    positions[kept * 3] = x;
    positions[kept * 3 + 1] = y;
    positions[kept * 3 + 2] = z;
    // PTS writes X Y Z intensity R G B; XYZ often writes X Y Z R G B.
    const rgb = parts.length >= 7 ? parts.slice(4, 7) : parts.length >= 6 ? parts.slice(3, 6) : null;
    if (rgb) {
      const values = rgb.map(Number);
      if (values.every((value) => Number.isFinite(value))) {
        sawColor = true;
        // 0-255 in nearly every export, 0-1 in a few.
        const scale = values.some((value) => Math.abs(value) > 1) ? 1 / 255 : 1;
        colors[kept * 3] = Math.min(1, Math.max(0, values[0] * scale));
        colors[kept * 3 + 1] = Math.min(1, Math.max(0, values[1] * scale));
        colors[kept * 3 + 2] = Math.min(1, Math.max(0, values[2] * scale));
      } else {
        colors.fill(1, kept * 3, kept * 3 + 3);
      }
    } else colors.fill(1, kept * 3, kept * 3 + 3);
    const raw = parts.length >= 7 ? Number(parts[3]) : NaN;
    intensity[kept] = Number.isFinite(raw) ? Math.min(1, Math.abs(raw) / 4096) : 0;
    kept += 1;
  }

  if (kept === 0) throw new Error("No X Y Z rows were found in that file.");
  return {
    name,
    positions: positions.subarray(0, kept * 3),
    colors: sawColor ? colors.subarray(0, kept * 3) : null,
    intensity: intensity.subarray(0, kept),
    total,
    min,
    max,
    // A text export carries no axis convention. Survey data is Z-up far more
    // often than not, and the panel offers the switch either way.
    upAxis: "z",
    format: "text XYZ",
  };
}

/**
 * Scan coordinates into scene coordinates.
 *
 * A scan is normally in the site's projected CRS, so a georeferenced model
 * can place it exactly; without one, the two are centred on each other, which
 * is a starting point rather than an alignment and is reported as such.
 */
export interface CloudPlacement {
  /** Added to the scan point after the axis swap. */
  offset: [number, number, number];
  /** Rotation about the scene's up axis, in radians. */
  rotation: number;
  scale: number;
  swapUp: boolean;
  exact: boolean;
}

export function toScene(
  point: [number, number, number],
  placement: CloudPlacement,
): [number, number, number] {
  // LAS is Z-up east-north-height; the scene is Y-up with -Z as north.
  const local = placement.swapUp
    ? [point[0], point[2], -point[1]]
    : [point[0], point[1], point[2]];
  const cos = Math.cos(placement.rotation);
  const sin = Math.sin(placement.rotation);
  const x = local[0] * cos + local[2] * sin;
  const z = -local[0] * sin + local[2] * cos;
  return [
    x * placement.scale + placement.offset[0],
    local[1] * placement.scale + placement.offset[1],
    z * placement.scale + placement.offset[2],
  ];
}

/** A placement that centres the scan on a target box, with no rotation. */
export function centreOn(
  cloud: PointCloud,
  target: { min: [number, number, number]; max: [number, number, number] },
  swapUp = true,
): CloudPlacement {
  const base: CloudPlacement = { offset: [0, 0, 0], rotation: 0, scale: 1, swapUp, exact: false };
  const centre = toScene(
    [(cloud.min[0] + cloud.max[0]) / 2, (cloud.min[1] + cloud.max[1]) / 2, (cloud.min[2] + cloud.max[2]) / 2],
    base,
  );
  // The floor is matched rather than the centre: a scan usually reaches
  // higher than the model does, and a matched floor is what a reviewer wants.
  const floor = toScene([cloud.min[0], cloud.min[1], cloud.min[2]], base)[1];
  return {
    ...base,
    offset: [
      (target.min[0] + target.max[0]) / 2 - centre[0],
      target.min[1] - floor,
      (target.min[2] + target.max[2]) / 2 - centre[2],
    ],
  };
}
