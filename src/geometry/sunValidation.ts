export const SUN_DEFAULT_EPSILON = 0.02;
export const SUN_DEFAULT_MAX_DISTANCE = 500;
export const SUN_MIN_EPSILON = 1e-6;
export const SUN_MAX_EPSILON = 10;
export const SUN_MAX_DISTANCE = 1_000_000;
export const SUN_MAX_STEP_MINUTES = 24 * 60;

export interface SunScalars {
  epsilon: number;
  maxDistance: number;
  stepMinutes: number;
}

/** Validate the public/query scalars without silently repairing bad input. */
export function sunScalars(
  stepMinutes: number,
  requestedEpsilon?: number,
  requestedMaxDistance?: number,
): SunScalars {
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0 || stepMinutes > SUN_MAX_STEP_MINUTES) {
    throw new Error(`sun stepMinutes must be a finite number in (0, ${SUN_MAX_STEP_MINUTES}]`);
  }
  const epsilon = requestedEpsilon ?? SUN_DEFAULT_EPSILON;
  if (!Number.isFinite(epsilon) || epsilon < SUN_MIN_EPSILON || epsilon > SUN_MAX_EPSILON) {
    throw new Error(`sun epsilon must be a finite number from ${SUN_MIN_EPSILON} to ${SUN_MAX_EPSILON} metres`);
  }
  const maxDistance = requestedMaxDistance ?? SUN_DEFAULT_MAX_DISTANCE;
  if (!Number.isFinite(maxDistance) || maxDistance < epsilon || maxDistance > SUN_MAX_DISTANCE) {
    throw new Error(`sun maxDistance must be finite and between epsilon and ${SUN_MAX_DISTANCE} metres`);
  }
  return { epsilon, maxDistance, stepMinutes };
}

export function finiteXyz(x: number, y: number, z: number, label: string): void {
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) {
    throw new Error(`${label} must contain three finite coordinates`);
  }
}

/**
 * Normalize without squaring the original components. This remains sound for
 * finite vectors close to Number.MIN_VALUE or Number.MAX_VALUE.
 */
export function unitXyz(x: number, y: number, z: number, label: string): [number, number, number] {
  finiteXyz(x, y, z, label);
  const scale = Math.max(Math.abs(x), Math.abs(y), Math.abs(z));
  if (scale === 0) throw new Error(`${label} must be non-zero`);
  const sx = x / scale;
  const sy = y / scale;
  const sz = z / scale;
  const length = Math.hypot(sx, sy, sz);
  return [sx / length, sy / length, sz / length];
}

export function assertSunIds(ids: ArrayLike<number>): void {
  for (let index = 0; index < ids.length; index++) {
    const id = ids[index];
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("sun element ids must be positive safe integers");
    }
  }
}
