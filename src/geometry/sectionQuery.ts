import { modelOf } from "../viewer-core/ids.js";
import { Matrix4, Plane, Vector3 } from "three";
import type { GeometryIndex } from "./geometryIndex.js";
import type {
  SectionAxis, SectionContourResult, SectionContourSpec, SectionPolyline,
} from "./types.js";
import { scenePlacementMatrix, unpackModelTransforms } from "./modelTransform.js";
import type { ModelTransform } from "../viewer-core/engine/types.js";

export interface SectionRunOptions {
  cancelled?: () => boolean;
  yieldTurn?: () => Promise<void>;
}

type Point2 = [number, number];
type Point3 = [number, number, number];
type Segment = [Point2, Point2];

const axisIndex = (axis: SectionAxis): number => axis === "x" ? 0 : axis === "y" ? 1 : 2;

function project(point: Point3, axis: SectionAxis): Point2 {
  if (axis === "x") return [point[2], point[1]];
  if (axis === "y") return [point[0], point[2]];
  return [point[0], point[1]];
}

function distance(a: Point2, b: Point2): number {
  return Math.hypot(b[0] - a[0], b[1] - a[1]);
}

function simplify(points: Point2[], closed: boolean, tolerance: number): Point2[] {
  if (points.length < 3) return points;
  const out = [...points];
  let changed = true;
  while (changed && out.length >= (closed ? 3 : 2)) {
    changed = false;
    for (let index = closed ? 0 : 1; index < (closed ? out.length : out.length - 1); index++) {
      const previous = out[(index - 1 + out.length) % out.length];
      const current = out[index];
      const next = out[(index + 1) % out.length];
      const ab: Point2 = [current[0] - previous[0], current[1] - previous[1]];
      const bc: Point2 = [next[0] - current[0], next[1] - current[1]];
      const scale = Math.hypot(...ab) + Math.hypot(...bc);
      const cross = Math.abs(ab[0] * bc[1] - ab[1] * bc[0]);
      const forward = ab[0] * bc[0] + ab[1] * bc[1] >= 0;
      if (forward && cross <= tolerance * Math.max(tolerance, scale)) {
        out.splice(index, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

function unique(points: Point3[], tolerance: number): Point3[] {
  const out: Point3[] = [];
  for (const point of points) {
    if (!out.some((item) => Math.hypot(item[0] - point[0], item[1] - point[1], item[2] - point[2]) <= tolerance)) {
      out.push(point);
    }
  }
  return out;
}

function triangleSegment(
  vertices: [Point3, Point3, Point3],
  axis: number,
  offset: number,
  tolerance: number,
): [Point3, Point3] | null {
  const signed = vertices.map((point) => point[axis] - offset);
  if (signed.every((value) => Math.abs(value) <= tolerance)) return null;
  if (signed.every((value) => value > tolerance) || signed.every((value) => value < -tolerance)) return null;
  const points: Point3[] = [];
  for (const [from, to] of [[0, 1], [1, 2], [2, 0]] as const) {
    const a = vertices[from];
    const b = vertices[to];
    const da = signed[from];
    const db = signed[to];
    if (Math.abs(da) <= tolerance) points.push(a);
    if ((da < -tolerance && db > tolerance) || (da > tolerance && db < -tolerance)) {
      const ratio = da / (da - db);
      points.push([
        a[0] + (b[0] - a[0]) * ratio,
        a[1] + (b[1] - a[1]) * ratio,
        a[2] + (b[2] - a[2]) * ratio,
      ]);
    }
  }
  const hits = unique(points, tolerance);
  if (hits.length < 2) return null;
  let pair: [Point3, Point3] = [hits[0], hits[1]];
  let farthest = 0;
  for (let a = 0; a < hits.length; a++) {
    for (let b = a + 1; b < hits.length; b++) {
      const span = Math.hypot(hits[a][0] - hits[b][0], hits[a][1] - hits[b][1], hits[a][2] - hits[b][2]);
      if (span > farthest) {
        farthest = span;
        pair = [hits[a], hits[b]];
      }
    }
  }
  return farthest > tolerance ? pair : null;
}

function stitch(
  elementId: number,
  elementType: string,
  segments: Segment[],
  tolerance: number,
): SectionPolyline[] {
  const nodes: Point2[] = [];
  const byKey = new Map<string, number[]>();
  const node = (point: Point2): number => {
    const cellX = Math.round(point[0] / tolerance);
    const cellY = Math.round(point[1] / tolerance);
    for (let x = cellX - 1; x <= cellX + 1; x++) {
      for (let y = cellY - 1; y <= cellY + 1; y++) {
        for (const existing of byKey.get(`${x},${y}`) ?? []) {
          if (distance(nodes[existing], point) <= tolerance) return existing;
        }
      }
    }
    const index = nodes.length;
    nodes.push(point);
    const key = `${cellX},${cellY}`;
    byKey.set(key, [...byKey.get(key) ?? [], index]);
    return index;
  };
  const edges: Array<[number, number]> = [];
  const edgeKeys = new Set<string>();
  for (const [a, b] of segments) {
    const first = node(a);
    const second = node(b);
    if (first === second) continue;
    const key = first < second ? `${first}:${second}` : `${second}:${first}`;
    if (edgeKeys.has(key)) continue;
    edgeKeys.add(key);
    edges.push([first, second]);
  }
  const adjacency = new Map<number, number[]>();
  edges.forEach(([a, b], index) => {
    adjacency.set(a, [...adjacency.get(a) ?? [], index]);
    adjacency.set(b, [...adjacency.get(b) ?? [], index]);
  });
  const used = new Set<number>();
  const trace = (start: number): SectionPolyline | null => {
    const points: Point2[] = [nodes[start]];
    let current = start;
    let total = 0;
    let closed = false;
    let first = true;
    while (true) {
      if (!first && current !== start && adjacency.get(current)?.length !== 2) break;
      const edgeIndex = adjacency.get(current)?.find((index) => !used.has(index));
      if (edgeIndex === undefined) break;
      used.add(edgeIndex);
      const edge = edges[edgeIndex];
      const next = edge[0] === current ? edge[1] : edge[0];
      total += distance(nodes[current], nodes[next]);
      if (next === start) {
        closed = true;
        break;
      }
      points.push(nodes[next]);
      current = next;
      first = false;
    }
    const simplified = simplify(points, closed, tolerance);
    return simplified.length >= 2
      ? { elementId, elementType, closed, points: simplified, length: total }
      : null;
  };
  const out: SectionPolyline[] = [];
  for (const [index, connected] of adjacency) {
    if (connected.length === 2) continue;
    while (connected.some((edge) => !used.has(edge))) {
      const line = trace(index);
      if (line) out.push(line);
    }
  }
  for (let index = 0; index < edges.length; index++) {
    if (used.has(index)) continue;
    const line = trace(edges[index][0]);
    if (line) out.push(line);
  }
  return out;
}

export async function runSectionContours(
  index: GeometryIndex,
  spec: SectionContourSpec,
  options: SectionRunOptions = {},
): Promise<SectionContourResult> {
  const started = Date.now();
  const tolerance = Math.max(1e-7, spec.tolerance ?? 1e-5);
  const maxSegments = Math.max(1, Math.floor(spec.maxSegments ?? 100_000));
  const transforms = unpackModelTransforms(spec.transforms, spec.offsets);
  const axis = axisIndex(spec.axis);
  const polylines: SectionPolyline[] = [];
  let segmentCount = 0;
  let missing = 0;
  let truncated = false;
  const worldNormal = new Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
  const worldPlane = new Plane(worldNormal, -spec.offset);
  const localPlane = new Plane();
  const worldMatrix = new Matrix4();
  const inverseMatrix = new Matrix4();

  elementLoop: for (let elementIndex = 0; elementIndex < spec.ids.length; elementIndex++) {
    if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    if (elementIndex > 0 && elementIndex % 64 === 0) await options.yieldTurn?.();
    const id = spec.ids[elementIndex];
    const modelTransform: ModelTransform = transforms.get(modelOf(id)) ?? {
      translation: [0, 0, 0], rotationZ: 0, scale: 1, source: "none",
    };
    const bounds = index.worldBounds(id, spec.modelOrigin, modelTransform);
    if (!bounds) {
      missing += 1;
      continue;
    }
    if (spec.offset < bounds.min[axis] - tolerance || spec.offset > bounds.max[axis] + tolerance) continue;
    const segments: Segment[] = [];
    if (index.placements(id).some((placement) => placement.indices.length >= 12_288)) {
      await options.yieldTurn?.();
      if (options.cancelled?.()) throw new DOMException("Geometry query cancelled", "AbortError");
    }
    for (const placement of index.bvhPlacements(id)) {
      const matrix = scenePlacementMatrix(placement.matrix, spec.modelOrigin, modelTransform, worldMatrix);
      inverseMatrix.copy(matrix).invert();
      localPlane.copy(worldPlane).applyMatrix4(inverseMatrix);
      const normal = localPlane.normal;
      placement.bvh.shapecast({
        intersectsBounds: (box) => {
          const low = localPlane.constant
            + normal.x * (normal.x >= 0 ? box.min.x : box.max.x)
            + normal.y * (normal.y >= 0 ? box.min.y : box.max.y)
            + normal.z * (normal.z >= 0 ? box.min.z : box.max.z);
          const high = localPlane.constant
            + normal.x * (normal.x >= 0 ? box.max.x : box.min.x)
            + normal.y * (normal.y >= 0 ? box.max.y : box.min.y)
            + normal.z * (normal.z >= 0 ? box.max.z : box.min.z);
          return low <= tolerance && high >= -tolerance;
        },
        intersectsTriangle: (triangle) => {
          const a = triangle.a.clone().applyMatrix4(matrix);
          const b = triangle.b.clone().applyMatrix4(matrix);
          const c = triangle.c.clone().applyMatrix4(matrix);
          const hit = triangleSegment(
            [[a.x, a.y, a.z], [b.x, b.y, b.z], [c.x, c.y, c.z]],
            axis,
            spec.offset,
            tolerance,
          );
          if (!hit) return false;
          segments.push([project(hit[0], spec.axis), project(hit[1], spec.axis)]);
          segmentCount += 1;
          truncated = segmentCount >= maxSegments;
          return truncated;
        },
      });
      if (truncated) {
        polylines.push(...stitch(id, index.typeOf(id), segments, tolerance));
        break elementLoop;
      }
    }
    polylines.push(...stitch(id, index.typeOf(id), segments, tolerance));
  }

  let bounds: SectionContourResult["bounds"] = null;
  for (const line of polylines) {
    for (const point of line.points) {
      if (!bounds) bounds = { min: [...point], max: [...point] };
      else {
        bounds.min[0] = Math.min(bounds.min[0], point[0]);
        bounds.min[1] = Math.min(bounds.min[1], point[1]);
        bounds.max[0] = Math.max(bounds.max[0], point[0]);
        bounds.max[1] = Math.max(bounds.max[1], point[1]);
      }
    }
  }
  const closedCount = polylines.filter((line) => line.closed).length;
  return {
    axis: spec.axis,
    offset: spec.offset,
    polylines,
    bounds,
    segmentCount,
    closedCount,
    openCount: polylines.length - closedCount,
    testedElements: spec.ids.length - missing,
    missing,
    truncated,
    elapsedMs: Date.now() - started,
    fidelity: "mesh",
    engine: "browser-section",
    geometryRevision: index.revision,
  };
}
