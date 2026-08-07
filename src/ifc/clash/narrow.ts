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
/**
 * An arbitrary direction for the inside test, deliberately not axis aligned:
 * a ray along an axis in a building model grazes far too many coplanar faces.
 */
const _ray = new Ray(new Vector3(), new Vector3(0.573, 0.589, 0.57).normalize());

/** Merge an element's placements into one BVH-backed mesh around `centre`. */
export function buildElement(
  id: number,
  placements: Placement[],
  origin: [number, number, number],
  offset: [number, number, number],
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
  const indices =
    vertexCount > 65535 ? new Uint32Array(indexCount) : new Uint16Array(indexCount);
  let po = 0;
  let io = 0;
  let base = 0;
  for (const placement of placements) {
    const m = placement.matrix;
    const p = placement.positions;
    const dx = m[12] - origin[0] + offset[0] - centre[0];
    const dy = m[13] - origin[1] + offset[1] - centre[1];
    const dz = m[14] - origin[2] + offset[2] - centre[2];
    for (let v = 0; v < p.length; v += 3) {
      positions[po] = m[0] * p[v] + m[4] * p[v + 1] + m[8] * p[v + 2] + dx;
      positions[po + 1] = m[1] * p[v] + m[5] * p[v + 1] + m[9] * p[v + 2] + dy;
      positions[po + 2] = m[2] * p[v] + m[6] * p[v + 1] + m[10] * p[v + 2] + dz;
      po += 3;
    }
    for (let i = 0; i < placement.indices.length; i++) indices[io++] = base + placement.indices[i];
    base += p.length / 3;
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute("position", new BufferAttribute(positions, 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  const bvh = new MeshBVH(geometry);
  // closestPointToGeometry takes the accelerated path only when the geometry
  // it is handed carries its own tree.
  (geometry as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = bvh;
  return { id, geometry, bvh, centre, triangles: indexCount / 3 };
}

export function disposeElement(element: ElementMesh): void {
  (element.geometry as BufferGeometry & { boundsTree?: MeshBVH }).boundsTree = undefined;
  element.geometry.dispose();
}

/**
 * Where two elements actually intersect, or null when they do not.
 *
 * The intersecting region is described by the segments where their triangles
 * cross. Its thinnest dimension is what `depth` reports: it is how far one
 * element has to move along its tightest axis to come clear, so a duct laid
 * against a wall reads as a few millimetres and one driven through it reads as
 * the wall thickness. Anything at or under `tolerance` is a graze and is not a
 * clash.
 */
export function hardClash(a: ElementMesh, b: ElementMesh, tolerance: number): Contact | null {
  _matrix.makeTranslation(
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  );

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  let count = 0;

  const grow = (point: Vector3): void => {
    if (point.x < min[0]) min[0] = point.x;
    if (point.y < min[1]) min[1] = point.y;
    if (point.z < min[2]) min[2] = point.z;
    if (point.x > max[0]) max[0] = point.x;
    if (point.y > max[1]) max[1] = point.y;
    if (point.z > max[2]) max[2] = point.z;
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
      if (!(triangle1 as unknown as TriangleCross).intersectsTriangle(triangle2, _line, true)) return false;
      if (_line.start.lengthSq() === 0 && _line.end.lengthSq() === 0) growShared(triangle1, triangle2);
      else {
        grow(_line.start);
        grow(_line.end);
      }
      count += 1;
      return count >= CONTACT_LIMIT;
    },
  });

  // Nothing crossed. One element may still be entirely inside the other, which
  // is a clash with no intersecting triangles at all: a fitting swallowed by a
  // shaft, or a sleeve buried in a slab. Only worth asking when one box fits
  // inside the other, which is rare enough to cost nothing on a normal pair.
  if (count === 0) return swallowed(a, b) ?? swallowed(b, a);

  const extent: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const depth = Math.min(extent[0], extent[1], extent[2]);
  if (depth <= tolerance) return null;
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

  _inner.getCenter(_probe);
  _ray.origin.copy(_probe);
  const hit = outer.bvh.raycastFirst(_ray, DoubleSide);
  if (!hit?.face || hit.face.normal.dot(_ray.direction) <= 0) return null;

  _inner.getSize(_size);
  return {
    depth: Math.min(_size.x, _size.y, _size.z),
    point: [_probe.x + outer.centre[0], _probe.y + outer.centre[1], _probe.z + outer.centre[2]],
    extent: [_size.x, _size.y, _size.z],
    triangles: 0,
  };
}

/** The true minimum surface distance, when it falls under `limit`. */
export function clearanceGap(a: ElementMesh, b: ElementMesh, limit: number): Gap | null {
  _matrix.makeTranslation(
    b.centre[0] - a.centre[0],
    b.centre[1] - a.centre[1],
    b.centre[2] - a.centre[2],
  );
  const hit = a.bvh.closestPointToGeometry(b.geometry, _matrix, _target1, _target2, 0, limit);
  if (!hit || hit.distance > limit) return null;
  // target1 sits in A's frame and target2 in B's own frame; the midpoint of
  // the two, back in scene space, is the middle of the gap.
  return {
    distance: hit.distance,
    point: [
      (_target1.point.x + a.centre[0] + _target2.point.x + b.centre[0]) / 2,
      (_target1.point.y + a.centre[1] + _target2.point.y + b.centre[1]) / 2,
      (_target1.point.z + a.centre[2] + _target2.point.z + b.centre[2]) / 2,
    ],
  };
}
