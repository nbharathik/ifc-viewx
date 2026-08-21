import { describe, expect, it } from "vitest";

import { centreOn, isLas, isText, readPointCloud, toScene, type PointCloud } from "../src/pointcloud/las.js";

/** A minimal but real LAS 1.2 file, point record format 2 (xyz + colour). */
function lasFile(points: Array<[number, number, number, [number, number, number]?]>): Uint8Array {
  const headerSize = 227;
  const stride = 26;
  const bytes = new Uint8Array(headerSize + points.length * stride);
  const view = new DataView(bytes.buffer);
  bytes.set(new TextEncoder().encode("LASF"), 0);
  view.setUint8(24, 1);
  view.setUint8(25, 2);
  view.setUint16(94, headerSize, true);
  view.setUint32(96, headerSize, true);
  view.setUint8(104, 2);
  view.setUint16(105, stride, true);
  view.setUint32(107, points.length, true);
  const scale = 0.001;
  view.setFloat64(131, scale, true);
  view.setFloat64(139, scale, true);
  view.setFloat64(147, scale, true);
  view.setFloat64(155, 0, true);
  view.setFloat64(163, 0, true);
  view.setFloat64(171, 0, true);
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  const zs = points.map((point) => point[2]);
  view.setFloat64(179, Math.max(...xs), true);
  view.setFloat64(187, Math.min(...xs), true);
  view.setFloat64(195, Math.max(...ys), true);
  view.setFloat64(203, Math.min(...ys), true);
  view.setFloat64(211, Math.max(...zs), true);
  view.setFloat64(219, Math.min(...zs), true);
  points.forEach((point, index) => {
    const at = headerSize + index * stride;
    view.setInt32(at, Math.round(point[0] / scale), true);
    view.setInt32(at + 4, Math.round(point[1] / scale), true);
    view.setInt32(at + 8, Math.round(point[2] / scale), true);
    view.setUint16(at + 12, 32768, true);
    const color = point[3] ?? [65535, 0, 0];
    view.setUint16(at + 20, color[0], true);
    view.setUint16(at + 22, color[1], true);
    view.setUint16(at + 24, color[2], true);
  });
  return bytes;
}

describe("reading LAS", () => {
  it("reads coordinates through the file's own scale and offset", () => {
    const cloud = readPointCloud("scan.las", lasFile([[1.5, 2.25, 3.125], [-4, 5, 6]]));
    expect(cloud.total).toBe(2);
    expect([...cloud.positions].map((value) => Number(value.toFixed(3)))).toEqual([1.5, 2.25, 3.125, -4, 5, 6]);
    expect(cloud.format).toContain("LAS 1.2");
  });

  it("reads colour where the record format carries it", () => {
    const cloud = readPointCloud("scan.las", lasFile([[0, 0, 0, [65535, 32768, 0]]]));
    expect(cloud.colors).not.toBeNull();
    expect(cloud.colors?.[0]).toBeCloseTo(1, 3);
    expect(cloud.colors?.[1]).toBeCloseTo(0.5, 2);
    expect(cloud.colors?.[2]).toBeCloseTo(0, 3);
  });

  it("subsamples to the limit and still reports the real total", () => {
    const points: Array<[number, number, number]> = [];
    for (let index = 0; index < 100; index++) points.push([index, 0, 0]);
    const cloud = readPointCloud("scan.las", lasFile(points), { limit: 10 });
    expect(cloud.total).toBe(100);
    expect(cloud.positions.length / 3).toBeLessThanOrEqual(10);
  });

  it("carries the file's own bounds, not the bounds of what it kept", () => {
    const cloud = readPointCloud("scan.las", lasFile([[0, 0, 0], [10, 20, 30]]), { limit: 1 });
    expect(cloud.max).toEqual([10, 20, 30]);
    expect(cloud.min).toEqual([0, 0, 0]);
  });

  it("refuses a compressed file by name and by header flag, and says why", () => {
    expect(() => readPointCloud("scan.laz", new Uint8Array([0, 1, 2]))).toThrow(/LAZ/);
    const compressed = lasFile([[0, 0, 0]]);
    new DataView(compressed.buffer).setUint8(104, 2 | 0x80);
    expect(() => readPointCloud("scan.las", compressed)).toThrow(/Local Studio/);
  });

  it("reports a truncated LAS header as a format error", () => {
    expect(() => readPointCloud("scan.las", new TextEncoder().encode("LASF"))).toThrow(/truncated header/);
  });

  it("rejects impossible bounds and truncated declared point data", () => {
    const badBounds = lasFile([[0, 0, 0]]);
    new DataView(badBounds.buffer).setFloat64(187, 2, true);
    expect(() => readPointCloud("scan.las", badBounds)).toThrow(/bounds/);

    const truncated = lasFile([[0, 0, 0]]);
    new DataView(truncated.buffer).setUint32(107, 2, true);
    expect(() => readPointCloud("scan.las", truncated)).toThrow(/declared point records/);
  });
});

describe("reading text exports", () => {
  it("reads X Y Z and skips comments and blank lines", () => {
    const text = "// header\n\n1 2 3\n4,5,6\n# note\n";
    const cloud = readPointCloud("scan.xyz", new TextEncoder().encode(text));
    expect(cloud.total).toBe(2);
    expect([...cloud.positions]).toEqual([1, 2, 3, 4, 5, 6]);
    expect(cloud.colors).toBeNull();
  });

  it("reads PTS with intensity and 0-255 colour", () => {
    const cloud = readPointCloud("scan.pts", new TextEncoder().encode("1 2 3 100 255 128 0\n"));
    expect(cloud.colors?.[0]).toBeCloseTo(1, 3);
    expect(cloud.colors?.[1]).toBeCloseTo(128 / 255, 3);
    expect(cloud.intensity?.[0]).toBeGreaterThan(0);
  });

  it("reads XYZ with colour and no intensity column", () => {
    const cloud = readPointCloud("scan.xyz", new TextEncoder().encode("1 2 3 10 20 30\n"));
    expect(cloud.colors?.[0]).toBeCloseTo(10 / 255, 4);
  });

  it("keeps full-file bounds when the retained point limit is reached", () => {
    const cloud = readPointCloud("scan.xyz", new TextEncoder().encode("1 2 3\n50 60 70\n"), { limit: 1 });
    expect(cloud.positions).toHaveLength(3);
    expect(cloud.min).toEqual([1, 2, 3]);
    expect(cloud.max).toEqual([50, 60, 70]);
  });

  it("samples text rows across the file instead of keeping only its first block", () => {
    const rows = Array.from({ length: 10 }, (_, index) => `${index} 0 0`).join("\n");
    const cloud = readPointCloud("scan.xyz", new TextEncoder().encode(rows), { limit: 2 });
    expect(cloud.positions).toHaveLength(6);
    expect(cloud.positions[0]).toBe(0);
    expect(cloud.positions[3]).toBeGreaterThan(5);
  });

  it("keeps colors aligned when only some retained rows carry RGB", () => {
    const cloud = readPointCloud("scan.xyz", new TextEncoder().encode("1 2 3\n4 5 6 255 0 0\n"));
    expect(cloud.colors).toHaveLength(cloud.positions.length);
    expect([...cloud.colors!]).toEqual([1, 1, 1, 1, 0, 0]);
  });

  it("refuses a file with no coordinates rather than drawing nothing", () => {
    expect(() => readPointCloud("scan.xyz", new TextEncoder().encode("hello\nworld\n"))).toThrow(/X Y Z/);
  });
});

describe("placing a scan", () => {
  const cloud = (): PointCloud => ({
    name: "s",
    positions: Float64Array.from([0, 0, 0, 10, 20, 4]),
    colors: null,
    intensity: null,
    total: 2,
    min: [0, 0, 0],
    max: [10, 20, 4],
    upAxis: "z",
    format: "test",
  });

  it("swaps a Z-up scan into the Y-up scene", () => {
    const placed = toScene([1, 2, 3], { offset: [0, 0, 0], rotation: 0, scale: 1, swapUp: true, exact: false });
    expect(placed).toEqual([1, 3, -2]);
  });

  it("leaves a Y-up scan alone when told to", () => {
    const placed = toScene([1, 2, 3], { offset: [0, 0, 0], rotation: 0, scale: 1, swapUp: false, exact: false });
    expect(placed).toEqual([1, 2, 3]);
  });

  it("applies rotation about the scene's up axis", () => {
    const placed = toScene([1, 0, 0], { offset: [0, 0, 0], rotation: Math.PI / 2, scale: 1, swapUp: false, exact: false });
    expect(placed[0]).toBeCloseTo(0, 6);
    expect(placed[2]).toBeCloseTo(-1, 6);
  });

  it("applies scale and offset, in that order", () => {
    const placed = toScene([2, 0, 0], { offset: [5, 0, 0], rotation: 0, scale: 3, swapUp: false, exact: false });
    expect(placed[0]).toBeCloseTo(11, 6);
  });

  it("centres a scan on the model and matches their floors", () => {
    const placement = centreOn(cloud(), { min: [0, 0, 0], max: [10, 3, 10] });
    const floor = toScene([0, 0, 0], placement);
    expect(floor[1]).toBeCloseTo(0, 6);
    const middle = toScene([5, 10, 2], placement);
    expect(middle[0]).toBeCloseTo(5, 6);
    expect(middle[2]).toBeCloseTo(5, 6);
    expect(placement.exact).toBe(false);
  });
});

describe("format sniffing", () => {
  it("knows what it can read from the name", () => {
    expect(isLas("a.las")).toBe(true);
    expect(isLas("a.LAZ")).toBe(true);
    expect(isText("a.pts")).toBe(true);
    expect(isText("a.ifc")).toBe(false);
  });
});
