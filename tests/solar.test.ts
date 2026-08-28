import { describe, expect, it } from "vitest";

import { dayArc, daylightHours, siteLocalInstant, sunDirection, sunPosition } from "../src/geo/solar.js";

/** Rostock, where the project lives, and a couple of textbook places. */
const ROSTOCK = { latitude: 54.0887, longitude: 12.1405 };
const EQUATOR = { latitude: 0, longitude: 0 };

const utc = (iso: string): Date => new Date(iso);

describe("solar position", () => {
  it("constructs a site-local wall clock independently of the reviewing browser timezone", () => {
    expect(siteLocalInstant(2026, 6, 21, 14 * 60, 120).toISOString()).toBe("2026-06-21T12:00:00.000Z");
    expect(siteLocalInstant(2026, 6, 21, 14 * 60, -240).toISOString()).toBe("2026-06-21T18:00:00.000Z");
  });

  it("rejects invalid site dates and locations instead of normalizing them silently", () => {
    expect(() => siteLocalInstant(2026, 2, 30, 12 * 60, 60)).toThrow(/real calendar date/i);
    expect(() => sunPosition(new Date("invalid"), 0, 0)).toThrow(/date must be valid/i);
    expect(() => sunPosition(new Date(), 91, 0)).toThrow(/latitude/i);
  });
  it("puts the sun near its highest at solar noon on the summer solstice", () => {
    // Local solar noon at 12.14 E is about 11:11 UTC.
    const position = sunPosition(utc("2026-06-21T11:11:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    // 90 - latitude + declination, roughly 59 degrees at this latitude.
    expect(position.altitude).toBeGreaterThan(57);
    expect(position.altitude).toBeLessThan(61);
    expect(position.azimuth).toBeGreaterThan(170);
    expect(position.azimuth).toBeLessThan(190);
    expect(position.up).toBe(true);
  });

  it("is much lower at the same clock time on the winter solstice", () => {
    const summer = sunPosition(utc("2026-06-21T11:11:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    const winter = sunPosition(utc("2026-12-21T11:11:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    expect(winter.altitude).toBeLessThan(summer.altitude - 40);
    expect(winter.up).toBe(true);
  });

  it("reports the sun below the horizon at local midnight", () => {
    const position = sunPosition(utc("2026-06-21T23:11:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    expect(position.up).toBe(false);
    expect(position.altitude).toBeLessThan(0);
  });

  it("rises in the east and sets in the west", () => {
    const morning = sunPosition(utc("2026-03-20T06:00:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    const evening = sunPosition(utc("2026-03-20T16:00:00Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    expect(morning.azimuth).toBeGreaterThan(60);
    expect(morning.azimuth).toBeLessThan(130);
    expect(evening.azimuth).toBeGreaterThan(230);
    expect(evening.azimuth).toBeLessThan(300);
  });

  it("puts the equinox sun almost overhead at the equator", () => {
    const position = sunPosition(utc("2026-03-20T12:00:00Z"), EQUATOR.latitude, EQUATOR.longitude);
    expect(position.altitude).toBeGreaterThan(85);
  });
});

describe("sun direction in the scene frame", () => {
  it("points down while the sun is up", () => {
    const high = sunDirection({ altitude: 60, azimuth: 180, up: true });
    expect(high[1]).toBeLessThan(0);
  });

  it("puts a southern sun on the +Z side, since north is -Z", () => {
    const south = sunDirection({ altitude: 30, azimuth: 180, up: true });
    expect(south[2]).toBeLessThan(0);
    const north = sunDirection({ altitude: 30, azimuth: 0, up: true });
    expect(north[2]).toBeGreaterThan(0);
  });

  it("puts an eastern sun on the -X side, since east is +X", () => {
    const east = sunDirection({ altitude: 20, azimuth: 90, up: true });
    expect(east[0]).toBeLessThan(0);
  });

  it("rotates with the model's own north", () => {
    const plain = sunDirection({ altitude: 30, azimuth: 0, up: true });
    const turned = sunDirection({ altitude: 30, azimuth: 0, up: true }, 90);
    expect(turned[0]).not.toBeCloseTo(plain[0], 3);
  });

  it("returns a unit vector", () => {
    const direction = sunDirection({ altitude: 42, azimuth: 137, up: true });
    expect(Math.hypot(...direction)).toBeCloseTo(1, 9);
  });
});

describe("day arcs", () => {
  it("walks a whole day at the step it was given", () => {
    const arc = dayArc(new Date(2026, 5, 21), ROSTOCK.latitude, ROSTOCK.longitude, 60);
    expect(arc).toHaveLength(24);
    expect(arc[0].minutes).toBe(0);
    expect(arc[23].minutes).toBe(23 * 60);
  });

  it("starts at midnight in the explicit site offset", () => {
    const instant = siteLocalInstant(2026, 6, 21, 12 * 60, 120);
    const arc = dayArc(instant, ROSTOCK.latitude, ROSTOCK.longitude, 60, 120);
    const expected = sunPosition(new Date("2026-06-20T22:00:00.000Z"), ROSTOCK.latitude, ROSTOCK.longitude);
    expect(arc[0].position.altitude).toBeCloseTo(expected.altitude, 8);
  });

  it("gives a long midsummer day and a short midwinter one", () => {
    const summer = daylightHours(new Date(2026, 5, 21), ROSTOCK.latitude, ROSTOCK.longitude, 10);
    const winter = daylightHours(new Date(2026, 11, 21), ROSTOCK.latitude, ROSTOCK.longitude, 10);
    expect(summer).toBeGreaterThan(16);
    expect(winter).toBeLessThan(8);
    expect(summer).toBeGreaterThan(winter + 8);
  });

  it("reports polar night above the arctic circle", () => {
    expect(daylightHours(new Date(2026, 11, 21), 78, 15, 30)).toBe(0);
  });

  it("rejects unsafe day steps rather than entering an unbounded loop", () => {
    expect(() => dayArc(new Date(2026, 5, 21), 0, 0, 0)).toThrow(/step minutes/i);
    expect(() => dayArc(new Date(2026, 5, 21), 0, 0, Number.NaN)).toThrow(/step minutes/i);
  });
});
