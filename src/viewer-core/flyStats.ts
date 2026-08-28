// Readouts for the flight HUD. Kept away from three and the DOM so the
// arithmetic that decides what the panel says is testable on its own.

export interface StoreyBand {
  name: string;
  /** Base elevation in scene units. */
  elevation: number;
}

const POINTS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/**
 * Compass bearing from a view direction. Plan screen-up is scene -Z, so that
 * is north; bearings run clockwise from it the way a compass reads.
 */
export function bearing(dx: number, dz: number): number {
  const deg = (Math.atan2(dx, -dz) * 180) / Math.PI;
  return (deg + 360) % 360;
}

export function compassPoint(degrees: number): string {
  return POINTS[Math.round(((degrees % 360) + 360) % 360 / 45) % 8];
}

/**
 * Which way the view faces on a map. Looking straight up or down leaves no
 * horizontal direction to read, and the residue there is numerical noise, so
 * the heading comes from the top of the screen instead, which is what a map
 * follows when the camera is vertical.
 */
export function heading(
  forward: [number, number, number],
  screenUp: [number, number, number],
): number {
  const flat = Math.hypot(forward[0], forward[2]);
  return flat > 0.08 ? bearing(forward[0], forward[2]) : bearing(screenUp[0], screenUp[2]);
}

/**
 * The storey a height sits in: the highest one at or below it. Below the
 * lowest storey it reports none rather than guessing, which is the honest
 * answer when flying under the building.
 */
export function storeyAt(bands: StoreyBand[], y: number): string | null {
  let found: StoreyBand | null = null;
  for (const band of bands) {
    if (band.elevation <= y + 1e-6 && (!found || band.elevation > found.elevation)) found = band;
  }
  return found?.name ?? null;
}

/** Metres with one decimal, and no negative zero. */
export function metres(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return (Object.is(rounded, -0) ? 0 : rounded).toFixed(1);
}

/** Speed reads in m/s under walking pace and rounds off above it. */
export function speedLabel(metresPerSecond: number): string {
  return metresPerSecond < 10 ? `${metresPerSecond.toFixed(1)} m/s` : `${Math.round(metresPerSecond)} m/s`;
}
