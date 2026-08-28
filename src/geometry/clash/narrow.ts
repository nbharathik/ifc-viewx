// Narrow phase: the answer itself, from triangles rather than from boxes.
//
// Each element is assembled once into a single indexed BufferGeometry and
// given a BVH. A hard clash is a real triangle-triangle intersection found by
// casting one BVH through the other; a clearance failure is the true minimum
// distance between the two surfaces. Boxes never decide anything here, they
// only got the pair this far.
//
// Geometry is built centred on the element's own box. Two elements a hundred
// metres apart in a georeferenced model would otherwise share an f32 frame
// wide enough to lose millimetres, and millimetres are the whole question.
import { Box3, BufferAttribute, BufferGeometry, DoubleSide, Line3, Matrix4, Ray, Triangle, Vector3 } from "three";
import { MeshBVH } from "three-mesh-bvh";
import type { ModelTransform } from "../../viewer-core/engine/types.js";
import { scenePlacementMatrix } from "../modelTransform.js";

const AXES = ["x", "y", "z"] as const;

/**
 * three-mesh-bvh takes a third argument that silences its coplanar warning,
 * which its own typings leave off. Coplanar faces are ordinary in IFC (a slab
 * on a wall is two of them), and without this a sweep prints thousands of
 * console warnings for a case that is handled here.
 */
interface TriangleCross {
  intersectsTriangle(other: Triangle, target: Line3, suppressLog: boolean): boolean;
}

/** One placed piece of geometry belonging to an element. */
export interface Placement {
  positions: Float32Array;
  indices: Uint32Array;
  /** 16 doubles, column-major, IFC coordinates. */
  matrix: Float64Array;
}

export interface ElementMesh {
  id: number;
  geometry: BufferGeometry;
  bvh: MeshBVH;
  /** Scene-space point the local frame is centred on. */
  centre: [number, number, number];
  triangles: number;
  /** Computed lazily because topology checks can be expensive on large meshes. */
  closed: boolean | null;
}

export interface Contact {
  /** Thinnest dimension of the intersecting region, in metres. */
  depth: number;
  /** Scene-space centre of the contact. */
  point: [number, number, number];
  extent: [number, number, number];
  triangles: number;
}

export interface Gap {
  distance: number;
  point: [number, number, number];
}

export interface SurfaceDistance extends Gap {
  pointA: [number, number, number];
  pointB: [number, number, number];
}

/**
 * Triangle pairs recorded per clash. Reached only by two large elements deeply
 * inside one another, where the contact region is already well described.
 */
const CONTACT_LIMIT = 4096;

const _line = new Line3();
const _matrix = new Matrix4();
const _target1 = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _target2 = { point: new Vector3(), distance: 0, faceIndex: 0 };
const _inner = new Box3();
const _probe = new Vector3();
const _shift = new Vector3();
const _size = new Vector3();
const _normal = new Vector3();
const _ray = new Ray();
/** Non-axis-aligned rays make parity tests less likely to pass through an edge. */
const INSIDE_RAYS = [
  new Vector3(0.573, 0.589, 0.57).normalize(),
  new Vector3(-0.311, 0.827, 0.468).normalize(),
  new Vector3(0.719, -0.214, 0.661).normalize(),
];

/** Merge an element's placements into one BVH-backed mesh around `centre`. */
export function buildElement(
  id: number,
  placements: Placement[],
  origin: [number, number, number],
  modelTransform: ModelTransform | [number, number, number],
  centre: [number, number, number],
): ElementMesh | null {
  let vertexCount = 0;
  let indexCount = 0;
  for (const placement of placements) {
    vertexCount += placement.positions.length / 3;
    indexCount += placement.indices.length;
  }
  if (indexCount === 0) return null;

  const positions = new Float32Array(vertexCount * 3);
  const rawIndices =
    vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let po = 0;
  let io = 0;
  let base = 0;
  for (const placement of placements) {
    const m = scenePlacementMatrix(placement.matrix, origin, modelTransform, _matrix).elements;
    const p = placement.positions;
    const dx = m[12] - centre[0];
    const dy = m[13] - centre[1];
    const dz = m[14] - centre[2];
    for (let v = 0; v < p.length; v += 3) {
      positions[po] = m[0] * p[v] + m[4] * p[v + 1] + m[8] * p[v + 2] + dx;
      positions[po + 1] = m[1] * p[v] + m[5] * p[v + 1] + m[9] * p[v + 2] + dy;
      positions[po + 2] = m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + dz;
      po += 3;
    }
    const vertices = p.length / 3;
    // Malformed exporters occasionally leave a trailing index, an out-of-range
    // reference, or a zero-area triangle. MeshBVH assumes valid triangles, so
    // filter those here instead of letting one bad face poison the whole check.
    for (let i = 0; i + 2 < placement.indices.length; i += 3) {
      const ia = placement.indices[i];
      const ib = placement.indices[i + 1];
      const ic = placement.indices[i + 2];
      if (!Number.isInteger(ia) || !Number.isInteger(ib) || !Number.isInteger(ic) ||
        ia >= vertices || ib >= vertices || ic >= vertices || ia === ib || ib === ic || ic === ia) continue;
      const a = (base + ia) * 3;
      const b = (base + ib) * 3;
      const c = (base + ic) * 3;
      const abx = positions[b] - positions[a];
      const aby = positions[b + 1] - positions[a + 1];
      const abz = positions[b + 2] - positions[a + 2];
      const acx = positions[c] - positions[a];
      const acy = positions[c + 1] - positions[a + 1];
      const acz = positions[c + 2] - positions[a + 2];
      const cx = aby * acz - abz * acy;
      const cy = abz * acx - abx * acz;
      const cz = abx * acy - aby * acx;
      const areaSq = cx * cx + cy * cy + cz * cz;
      if (!Number.isFinite(areaSq) || areaSq <= 1e-24) continue;
      rawIndices[io++] = base + ia;
      rawIndices[io++] = base + ib;
      rawIndices[io++] = base + ic;
    }
    base += p.length / 3;
  }
  if (io === 0) return null;
  const indices = rawIndices.slice(0, io);

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const bvh = new MeshBVH(geometry, { verbose: false });
  // Derive bounds from retained triangles. BufferGeometry.computeBoundingBox
  // also scans unreferenced vertices, including malformed ones we filtered.
  geometry.boundingBox = bvh.getBoundingBox(new Box3());
  // closestPointToGeometry takes the accelerated path only when the geometry
  // it is handed carries its own tree.
  (geometry as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = bvh;
  return { id, geometry, bvh, centre, triangles: io / 3, closed: null };
}

export function disposeElement(element: ElementMesh): void {
  (element.geometry as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = undefined;
  element.geometry.dispose();
}

/**
 * Raw contact between two elements, before a user tolerance is applied.
 *
 * The intersecting region is described by the segments where their triangles
 * cross. Its thinnest dimension is what `depth` reports: it is how far one
 * element has to move along its tightest axis to come clear, so a duct laid
 * against a wall reads as a few millimetres and one driven through it reads as
 * the wall thickness. The caller decides whether that depth is material.
 */
export function meshContact(a: ElementMesh, b: ElementMesh): Contact | null {
  _matrix.makeTranslation(
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  );

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  const points: number[] = [];
  const axes = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)];
  let count = 0;
  let limited = false;

  const grow = (point: Vector3): void => {
    if (point.x < min[0]) min[0] = point.x;
    if (point.y < min[1]) min[1] = point.y;
    if (point.z < min[2]) min[2] = point.z;
    if (point.x > max[0]) max[0] = point.x;
    if (point.y > max[1]) max[1] = point.y;
    if (point.z > max[2]) max[2] = point.z;
    points.push(point.x, point.y, point.z);
  };

  const addAxis = (axis: Vector3): void => {
    if (axis.lengthSq() < 1e-16 || axes.length >= 96) return;
    axis.normalize();
    // An axis and its inverse describe the same projection. Canonicalising and
    // deduplicating keeps tessellated cylinders from adding thousands of axes.
    if (axis.x < -1e-8 || (Math.abs(axis.x) <= 1e-8 && axis.y < -1e-8) ||
      (Math.abs(axis.x) <= 1e-8 && Math.abs(axis.y) <= 1e-8 && axis.z < 0)) axis.negate();
    if (axes.some((candidate) => Math.abs(candidate.dot(axis)) > 0.9995)) return;
    axes.push(axis.clone());
  };

  const growShared = (one: Triangle, two: Triangle): void => {
    for (let axis = 0; axis < 3; axis++) {
      const key = AXES[axis];
      const lo = Math.max(
        Math.min(one.a[key], one.b[key], one.c[key]),
        Math.min(two.a[key], two.b[key], two.c[key]),
      );
      const hi = Math.min(
        Math.max(one.a[key], one.b[key], one.c[key]),
        Math.max(two.a[key], two.b[key], two.c[key]),
      );
      if (lo < min[axis]) min[axis] = lo;
      if (hi > max[axis]) max[axis] = hi;
    }
  };

  a.bvh.bvhcast(b.bvh, _matrix, {
    intersectsTriangles: (triangle1, triangle2) => {
      // Coplanar faces intersect in a polygon rather than a segment, which
      // three-mesh-bvh reports as a zero segment at the origin. Their shared
      // box bounds that polygon, and being flat it adds no thickness, which is
      // what keeps two touching slabs reading as a graze rather than a clash.
      _line.start.set(0, 0, 0);
      _line.end.set(0, 0, 0);
      if (!(triangle1 as unknown as TriangleCross).intersectsTriangle(triangle2, _line, true)) return false;
      addAxis(triangle1.getNormal(_normal));
      addAxis(triangle2.getNormal(_normal));
      if (_line.start.lengthSq() === 0 && _line.end.lengthSq() === 0) growShared(triangle1, triangle2);
      else {
        grow(_line.start);
        grow(_line.end);
      }
      count += 1;
      limited = count >= CONTACT_LIMIT;
      return limited;
    },
  });

  // Nothing crossed. One element may still be entirely inside the other, which
  // is a clash with no intersecting triangles at all: a fitting swallowed by a
  // shaft, or a sleeve buried in a slab. Only worth asking when one box fits
  // inside the other, which is rare enough to cost nothing on a normal pair.
  if (count === 0) return swallowed(a, b) ?? swallowed(b, a);

  const extent: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  let depth = Math.min(extent[0], extent[1], extent[2]);
  // Coordinate-axis extents change when a model is rotated. Project the full
  // contact contour onto the intersecting face normals as a compact SAT-style
  // minimum translation estimate. Keep the legacy extent for capped contacts,
  // where a partial contour is not representative.
  if (!limited && points.length >= 6) {
    for (const axis of axes) {
      let lo = Infinity;
      let hi = -Infinity;
      for (let index = 0; index < points.length; index += 3) {
        const value = points[index] * axis.x + points[index + 1] * axis.y + points[index + 2] * axis.z;
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
      depth = Math.min(depth, Math.max(0, hi - lo));
    }
  }
  return {
    depth,
    point: [
      (min[0] + max[0]) / 2 + a.centre[0],
      (min[1] + max[1]) / 2 + a.centre[1],
      (min[2] + max[2]) / 2 + a.centre[2],
    ],
    extent,
    triangles: count,
  };
}

/** Apply the user's tolerance after contact classification has been established. */
export function hardClash(a: ElementMesh, b: ElementMesh, tolerance: number): Contact | null {
  const contact = meshContact(a, b);
  return contact && contact.depth > Math.max(0, tolerance) ? contact : null;
}

/**
 * `inner` completely inside `outer`, reported as a clash the size of the
 * buried element. Checked by shooting one ray out of the inner element: a ray
 * leaving a closed solid meets a face turned away from it, and web-ifc gives
 * closed solids.
 */
function swallowed(outer: ElementMesh, inner: ElementMesh): Contact | null {
  const outerBox = outer.geometry.boundingBox;
  const innerBox = inner.geometry.boundingBox;
  if (!outerBox || !innerBox) return null;
  _shift.set(
    inner.centre[0] - outer.centre[0],
    inner.centre[1] - outer.centre[1],
    inner.centre[2] - outer.centre[2],
  );
  _inner.copy(innerBox).translate(_shift);
  if (!outerBox.containsBox(_inner)) return null;

  if (!watertight(outer)) return null;
  // With no crossing triangles and the inner bounds contained, any inner
  // vertex is a valid probe. Ray parity is independent of face winding, unlike
  // checking the exit face normal, and a majority of three skew rays avoids
  // ambiguous edge/vertex hits.
  const position = inner.geometry.getAttribute("position");
  if (!position || position.count === 0) return null;
  _probe.fromBufferAttribute(position, 0).add(_shift);
  let insideVotes = 0;
  for (const direction of INSIDE_RAYS) {
    _ray.set(_probe, direction);
    const hits = outer.bvh.raycast(_ray, DoubleSide, 1e-8)
      .map((hit) => hit.distance)
      .filter((distance) => Number.isFinite(distance) && distance > 1e-8)
      .sort((a, b) => a - b);
    let crossings = 0;
    let previous = -Infinity;
    for (const distance of hits) {
      const epsilon = Math.max(1e-7, Math.abs(distance) * 1e-7);
      if (distance - previous <= epsilon) continue;
      previous = distance;
      crossings += 1;
    }
    if (crossings % 2 === 1) insideVotes += 1;
  }
  if (insideVotes < 2) return null;

  _inner.getSize(_size);
  return {
    depth: Math.min(_size.x, _size.y, _size.z),
    point: [
      (_inner.min.x + _inner.max.x) / 2 + outer.centre[0],
      (_inner.min.y + _inner.max.y) / 2 + outer.centre[1],
      (_inner.min.z + _inner.max.z) / 2 + outer.centre[2],
    ],
    extent: [_size.x, _size.y, _size.z],
    triangles: 0,
  };
}

function watertight(element: ElementMesh): boolean {
  if (element.closed !== null) return element.closed;
  const index = element.geometry.index;
  if (!index || index.count === 0 || index.count % 3 !== 0) return (element.closed = false);
  const position = element.geometry.getAttribute("position");
  if (!position) return (element.closed = false);
  // web-ifc emits flat-shaded vertices duplicated at creases, so weld by
  // quantized position first or every crease edge counts once and fails.
  const scale = 1e5;
  const canonical = new Map<string, number>();
  const remap = new Uint32Array(position.count);
  for (let vertex = 0; vertex < position.count; vertex++) {
    const key = `${Math.round(position.getX(vertex) * scale)}:` +
      `${Math.round(position.getY(vertex) * scale)}:${Math.round(position.getZ(vertex) * scale)}`;
    let welded = canonical.get(key);
    if (welded === undefined) canonical.set(key, (welded = vertex));
    remap[vertex] = welded;
  }
  const edges = new Map<string, number>();
  const add = (a: number, b: number): void => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    edges.set(key, (edges.get(key) ?? 0) + 1);
  };
  for (let offset = 0; offset < index.count; offset += 3) {
    const a = remap[index.getX(offset)];
    const b = remap[index.getX(offset + 1)];
    const c = remap[index.getX(offset + 2)];
    if (a === b || b === c || c === a) continue;
    add(a, b);
    add(b, c);
    add(c, a);
  }
  element.closed = edges.size > 0 && [...edges.values()].every((count) => count === 2);
  return element.closed;
}

/** The true minimum surface distance, when it falls under `limit`. */
export function clearanceGap(a: ElementMesh, b: ElementMesh, limit: number): Gap | null {
  const hit = surfaceDistance(a, b, limit);
  return hit ? { distance: hit.distance, point: hit.point } : null;
}

export function surfaceDistance(a: ElementMesh, b: ElementMesh, limit = Infinity): SurfaceDistance | null {
  _matrix.makeTranslation(
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  );
  const hit = a.bvh.closestPointToGeometry(b.geometry, _matrix, _target1, _target2, 0, limit);
  if (!hit || hit.distance > limit) return null;
  const pointA: [number, number, number] = [
    _target1.point.x + a.centre[0],
    _target1.point.y + a.centre[1],
    _target1.point.z + a.centre[2],
  ];
  const pointB: [number, number, number] = [
    _target2.point.x + b.centre[0],
    _target2.point.y + b.centre[1],
    _target2.point.z + b.centre[2],
  ];
  return {
    distance: hit.distance,
    pointA,
    pointB,
    point: [
      (pointA[0] + pointB[0]) / 2,
      (pointA[1] + pointB[1]) / 2,
      (pointA[2] + pointB[2]) / 2,
    ],
  };
}
