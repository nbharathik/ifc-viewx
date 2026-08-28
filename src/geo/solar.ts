// Where the sun is, from a date, a time and a place.
//
// The NOAA solar position algorithm, which is accurate to about a minute of
// arc over the range a building study cares about. Everything here is pure
// arithmetic: the renderer only ever asks for a direction.
export interface SunPosition {
  /** Degrees above the horizon. Negative means the sun has set. */
  altitude: number;
  /** Degrees clockwise from true north. */
  azimuth: number;
  /** True while the sun is above the horizon. */
  up: boolean;
}

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

function finite(value: number, label: string): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be finite`);
}

function validateMomentAndPlace(date: Date, latitude: number, longitude: number): void {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError("date must be valid");
  finite(latitude, "latitude");
  finite(longitude, "longitude");
  if (latitude < -90 || latitude > 90) throw new RangeError("latitude must be between -90 and 90 degrees");
  if (longitude < -180 || longitude > 180) throw new RangeError("longitude must be between -180 and 180 degrees");
}

/** Days since J2000.0 for a UTC instant. */
function julianCenturies(date: Date): number {
  const julianDay = date.getTime() / 86400000 + 2440587.5;
  return (julianDay - 2451545) / 36525;
}

/**
 * Solar altitude and azimuth for a moment and a place.
 *
 * `date` is read as an absolute instant, so the caller decides what local
 * time means. A study that says "21 June, 14:00 on site" builds the Date from
 * the site's own offset.
 */
export function sunPosition(date: Date, latitude: number, longitude: number): SunPosition {
  validateMomentAndPlace(date, latitude, longitude);
  const t = julianCenturies(date);

  const meanLongitude = (280.46646 + t * (36000.76983 + t * 0.0003032)) % 360;
  const meanAnomaly = 357.52911 + t * (35999.05029 - 0.0001537 * t);
  const eccentricity = 0.016708634 - t * (0.000042037 + 0.0000001267 * t);
  const centre =
    Math.sin(meanAnomaly * RAD) * (1.914602 - t * (0.004817 + 0.000014 * t)) +
    Math.sin(2 * meanAnomaly * RAD) * (0.019993 - 0.000101 * t) +
    Math.sin(3 * meanAnomaly * RAD) * 0.000289;
  const trueLongitude = meanLongitude + centre;
  const apparentLongitude = trueLongitude - 0.00569 - 0.00478 * Math.sin((125.04 - 1934.136 * t) * RAD);

  const meanObliquity =
    23 + (26 + (21.448 - t * (46.815 + t * (0.00059 - t * 0.001813))) / 60) / 60;
  const obliquity = meanObliquity + 0.00256 * Math.cos((125.04 - 1934.136 * t) * RAD);

  const declination = Math.asin(Math.sin(obliquity * RAD) * Math.sin(apparentLongitude * RAD)) * DEG;

  const y = Math.tan((obliquity / 2) * RAD) ** 2;
  const equationOfTime =
    4 *
    DEG *
    (y * Math.sin(2 * meanLongitude * RAD) -
      2 * eccentricity * Math.sin(meanAnomaly * RAD) +
      4 * eccentricity * y * Math.sin(meanAnomaly * RAD) * Math.cos(2 * meanLongitude * RAD) -
      0.5 * y * y * Math.sin(4 * meanLongitude * RAD) -
      1.25 * eccentricity * eccentricity * Math.sin(2 * meanAnomaly * RAD));

  const minutesUtc = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
  const trueSolarTime = (minutesUtc + equationOfTime + 4 * longitude + 1440) % 1440;
  const hourAngle = trueSolarTime / 4 < 0 ? trueSolarTime / 4 + 180 : trueSolarTime / 4 - 180;

  const zenith =
    Math.acos(
      Math.min(
        1,
        Math.max(
          -1,
          Math.sin(latitude * RAD) * Math.sin(declination * RAD) +
            Math.cos(latitude * RAD) * Math.cos(declination * RAD) * Math.cos(hourAngle * RAD),
        ),
      ),
    ) * DEG;
  const altitude = 90 - zenith;

  let azimuth: number;
  const denominator = Math.cos(latitude * RAD) * Math.sin(zenith * RAD);
  if (Math.abs(denominator) > 1e-9) {
    const cosAzimuth = Math.min(
      1,
      Math.max(
        -1,
        (Math.sin(latitude * RAD) * Math.cos(zenith * RAD) - Math.sin(declination * RAD)) / denominator,
      ),
    );
    azimuth = Math.acos(cosAzimuth) * DEG;
    azimuth = hourAngle > 0 ? (azimuth + 180) % 360 : (540 - azimuth) % 360;
  } else {
    azimuth = latitude > 0 ? 180 : 0;
  }

  // Refraction lifts a low sun; a study that says "sunlit" at sunrise should
  // agree with what somebody standing there would see.
  const refracted = altitude + (altitude > -0.575 ? refraction(altitude) : 0);
  return { altitude: refracted, azimuth, up: refracted > 0 };
}

/** Convert a wall-clock time at the site into the UTC instant solar math needs. */
export function siteLocalInstant(
  year: number,
  month: number,
  day: number,
  minutes: number,
  utcOffsetMinutes: number,
): Date {
  if (![year, month, day, minutes, utcOffsetMinutes].every(Number.isInteger)) {
    throw new RangeError("site-local date, minutes, and UTC offset must be whole numbers");
  }
  if (year < 100 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31) {
    throw new RangeError("site-local date is outside the supported calendar range");
  }
  if (minutes < 0 || minutes >= 1440) throw new RangeError("minutes must be between 0 and 1439");
  if (utcOffsetMinutes < -720 || utcOffsetMinutes > 840) {
    throw new RangeError("UTC offset must be between -12 and +14 hours");
  }
  const localMidnight = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  if (
    localMidnight.getUTCFullYear() !== year ||
    localMidnight.getUTCMonth() !== month - 1 ||
    localMidnight.getUTCDate() !== day
  ) throw new RangeError("site-local date is not a real calendar date");
  return new Date(localMidnight.getTime() + minutes * 60_000 - utcOffsetMinutes * 60_000);
}

function refraction(altitude: number): number {
  if (altitude > 85) return 0;
  const tangent = Math.tan(altitude * RAD);
  if (altitude > 5) return (58.1 / tangent - 0.07 / tangent ** 3 + 0.000086 / tangent ** 5) / 3600;
  if (altitude > -0.575) return (1735 + altitude * (-518.2 + altitude * (103.4 + altitude * (-12.79 + altitude * 0.711)))) / 3600;
  return -20.774 / tangent / 3600;
}

/**
 * The sun as a scene-space direction, pointing from the sun toward the model.
 *
 * The scene is Y-up with X east and -Z north, which is the frame the viewer's
 * georeferencing already speaks. `northOffset` rotates for a model whose plan
 * north is not scene north, in degrees clockwise.
 */
export function sunDirection(position: SunPosition, northOffset = 0): [number, number, number] {
  finite(position.altitude, "solar altitude");
  finite(position.azimuth, "solar azimuth");
  finite(northOffset, "north offset");
  const altitude = position.altitude * RAD;
  const azimuth = (position.azimuth + northOffset) * RAD;
  // Azimuth is clockwise from north: north is -Z, east is +X.
  const horizontal = Math.cos(altitude);
  return [
    -(horizontal * Math.sin(azimuth)),
    -Math.sin(altitude),
    horizontal * Math.cos(azimuth),
  ];
}

/** Sunrise, solar noon and sunset for a day, as minutes past local midnight. */
export function dayArc(
  date: Date,
  latitude: number,
  longitude: number,
  stepMinutes = 5,
  utcOffsetMinutes?: number,
): Array<{ minutes: number; position: SunPosition }> {
  validateMomentAndPlace(date, latitude, longitude);
  if (!Number.isFinite(stepMinutes) || stepMinutes <= 0 || stepMinutes > 1440) {
    throw new RangeError("step minutes must be greater than zero and no more than one day");
  }
  if (utcOffsetMinutes !== undefined &&
    (!Number.isInteger(utcOffsetMinutes) || utcOffsetMinutes < -720 || utcOffsetMinutes > 840)) {
    throw new RangeError("UTC offset must be a whole number of minutes between -12 and +14 hours");
  }
  const out: Array<{ minutes: number; position: SunPosition }> = [];
  let midnight: Date;
  if (utcOffsetMinutes === undefined) {
    midnight = new Date(date);
    midnight.setHours(0, 0, 0, 0);
  } else {
    const site = new Date(date.getTime() + utcOffsetMinutes * 60_000);
    midnight = siteLocalInstant(
      site.getUTCFullYear(), site.getUTCMonth() + 1, site.getUTCDate(), 0, utcOffsetMinutes,
    );
  }
  for (let minutes = 0; minutes < 1440; minutes += stepMinutes) {
    const at = new Date(midnight.getTime() + minutes * 60000);
    out.push({ minutes, position: sunPosition(at, latitude, longitude) });
  }
  return out;
}

/** Hours the sun is above the horizon on this day, at this place. */
export function daylightHours(
  date: Date,
  latitude: number,
  longitude: number,
  stepMinutes = 5,
  utcOffsetMinutes?: number,
): number {
  const arc = dayArc(date, latitude, longitude, stepMinutes, utcOffsetMinutes);
  return (arc.filter((entry) => entry.position.up).length * stepMinutes) / 60;
}
