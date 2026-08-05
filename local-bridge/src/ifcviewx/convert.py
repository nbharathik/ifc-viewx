"""Format v1 writer: converts an IFC file into the viewer's chunked container
using IfcOpenShell. Layout spec: dev/FORMAT.md; the TypeScript reader in
src/viewer-core/engine/cache.ts is the conformance reference.

Geometry is emitted in world coordinates with identity placement matrices;
representation instancing is a later optimisation. Elements are split into
one placement per material so colors survive.

CLI: ifcx-convert model.ifc [-o out.ifcx] [--serve]
--serve writes <sha256>.ifcx into the bridge's models directory so the
running bridge can serve it at /models/.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import struct
import sys
import time
from array import array
from pathlib import Path

MAGIC = 0x58434649
MAGIC_END = 0x444E4558
FORMAT_VERSION = 1
CHUNK_PLACEMENTS = 2048
CHUNK_BYTES = 24 * 1024 * 1024
DEFAULT_COLOR = (0.75, 0.75, 0.75, 1.0)
SPATIAL_SKIP = {"IfcSpace", "IfcOpeningElement"}


def models_dir() -> Path:
    """The shared store directory (re-exported so the CLI needs no imports)."""
    from .store import models_dir as _dir

    return _dir()


def _align(n: int, to: int) -> int:
    return (n + to - 1) & ~(to - 1)


class _ChunkWriter:
    """Accumulates geometries/placements and serialises chunk payloads."""

    def __init__(self, out) -> None:
        self.out = out
        self.reset()

    def reset(self) -> None:
        self.geo_ids: list[int] = []
        self.vertex_counts: list[int] = []
        self.index_counts: list[int] = []
        self.local_bounds = array("d")
        self.positions = array("f")
        self.normals = array("f")
        self.indices = array("I")
        self.express_ids: list[int] = []
        self.geometry_ids: list[int] = []
        self.matrices = array("d")
        self.colors = array("f")
        self.types: list[str] = []

    def add(self, geo_id, express_id, ifc_type, verts, normals, faces, color) -> None:
        if verts:
            lo = list(verts[:3])
            hi = list(verts[:3])
            for i in range(3, len(verts), 3):
                x, y, z = verts[i], verts[i + 1], verts[i + 2]
                if x < lo[0]:
                    lo[0] = x
                elif x > hi[0]:
                    hi[0] = x
                if y < lo[1]:
                    lo[1] = y
                elif y > hi[1]:
                    hi[1] = y
                if z < lo[2]:
                    lo[2] = z
                elif z > hi[2]:
                    hi[2] = z
        else:
            lo = [0.0, 0.0, 0.0]
            hi = [0.0, 0.0, 0.0]
        self.geo_ids.append(geo_id)
        self.vertex_counts.append(len(verts) // 3)
        self.index_counts.append(len(faces))
        self.local_bounds.extend(lo + hi)
        self.positions.extend(verts)
        self.normals.extend(normals)
        self.indices.extend(faces)
        self.express_ids.append(express_id)
        self.geometry_ids.append(geo_id)
        self.matrices.extend((1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1))
        self.colors.extend(color)
        self.types.append(ifc_type)

    @property
    def placements(self) -> int:
        return len(self.express_ids)

    @property
    def pending_bytes(self) -> int:
        return len(self.positions) * 8 + len(self.indices) * 4

    def flush(self) -> None:
        if not self.express_ids:
            return
        table: list[str] = []
        index: dict[str, int] = {}
        type_idx = array("H")
        for name in self.types:
            if name not in index:
                index[name] = len(table)
                table.append(name)
            type_idx.append(index[name])
        type_json = json.dumps(table).encode()

        g, p = len(self.geo_ids), len(self.express_ids)
        sections = [
            (array("I", self.geo_ids), 4),
            (array("I", self.vertex_counts), 4),
            (array("I", self.index_counts), 4),
            (self.local_bounds, 8),
            (self.positions, 4),
            (self.normals, 4),
            (self.indices, 4),
            (array("I", self.express_ids), 4),
            (array("I", self.geometry_ids), 4),
            (self.matrices, 8),
            (self.colors, 4),
            (type_idx, 2),
            (type_json, 1),
        ]
        payload = bytearray(struct.pack("<5I", g, p, len(self.positions), len(self.indices), len(type_json)))
        for data, alignment in sections:
            pad = _align(len(payload), alignment) - len(payload)
            payload.extend(b"\0" * pad)
            payload.extend(data.tobytes() if isinstance(data, array) else data)

        self.out.write(struct.pack("<I", len(payload)))
        self.out.write(payload)
        self.reset()


def _flat_normals(verts, faces):
    """Unwelded copy with one normal per face corner, for shapes without normals."""
    out_v = array("f")
    out_n = array("f")
    out_f = array("I")
    for t in range(0, len(faces), 3):
        idx = faces[t : t + 3]
        p = [verts[3 * i : 3 * i + 3] for i in idx]
        ux, uy, uz = (p[1][k] - p[0][k] for k in range(3))
        vx, vy, vz = (p[2][k] - p[0][k] for k in range(3))
        n = (uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
        length = max((n[0] ** 2 + n[1] ** 2 + n[2] ** 2) ** 0.5, 1e-12)
        n = (n[0] / length, n[1] / length, n[2] / length)
        base = len(out_v) // 3
        for corner in p:
            out_v.extend(corner)
            out_n.extend(n)
        out_f.extend((base, base + 1, base + 2))
    return out_v, out_n, out_f


def _submesh(verts, normals, faces, keep):
    """Extract the faces whose index is in `keep`, compacting vertices."""
    remap: dict[int, int] = {}
    out_v = array("f")
    out_n = array("f")
    out_f = array("I")
    for f in keep:
        for i in faces[3 * f : 3 * f + 3]:
            j = remap.get(i)
            if j is None:
                j = len(remap)
                remap[i] = j
                out_v.extend(verts[3 * i : 3 * i + 3])
                out_n.extend(normals[3 * i : 3 * i + 3])
            out_f.append(j)
    return out_v, out_n, out_f


def _color_of(material) -> tuple[float, float, float, float]:
    alpha = 1.0 - (getattr(material, "transparency", None) or 0.0)
    diffuse = getattr(material, "diffuse", None)
    try:
        return (float(diffuse.r()), float(diffuse.g()), float(diffuse.b()), alpha)
    except Exception:
        return (*DEFAULT_COLOR[:3], alpha)


def _spatial_tree(model) -> dict:
    """An empty tree beats an IndexError after the whole geometry pass."""
    roots = model.by_type("IfcProject")
    if not roots:
        return {"expressID": 0, "type": "IfcProject", "name": None, "children": []}
    visited: set[int] = set()

    def node(el) -> dict:
        visited.add(el.id())
        children = []
        for rel in el.IsDecomposedBy or []:
            children.extend(rel.RelatedObjects)
        if hasattr(el, "ContainsElements"):
            for rel in el.ContainsElements or []:
                children.extend(rel.RelatedElements)
        return {
            "expressID": el.id(),
            "type": el.is_a(),
            "name": getattr(el, "Name", None),
            "children": [node(c) for c in children if c.id() not in visited],
        }

    return node(roots[0])


def convert(source: Path, target: Path, progress=None) -> dict:
    """Write `target`; `progress(percent, meshes)` is called as shapes arrive."""
    import ifcopenshell
    import ifcopenshell.geom
    import multiprocessing

    t0 = time.time()
    model = ifcopenshell.open(str(source))
    parse_ms = (time.time() - t0) * 1000
    expected = max(1, len(model.by_type("IfcProduct")))
    processed = 0
    last_report = 0.0

    settings = ifcopenshell.geom.settings()
    settings.set("use-world-coords", True)
    settings.set("weld-vertices", True)

    t1 = time.time()
    mesh_count = 0
    triangles = 0
    world_lo = [float("inf")] * 3
    world_hi = [float("-inf")] * 3
    next_geo = 1

    with open(target, "wb") as out:
        out.write(struct.pack("<2I", MAGIC, FORMAT_VERSION))
        chunk = _ChunkWriter(out)

        iterator = ifcopenshell.geom.iterator(
            settings, model, multiprocessing.cpu_count()
        )
        if iterator.initialize():
            while True:
                shape = iterator.get()
                element = model.by_id(shape.id)
                ifc_type = element.is_a()
                if ifc_type not in SPATIAL_SKIP:
                    geometry = shape.geometry
                    verts = geometry.verts
                    faces = array("I", geometry.faces)
                    normals = array("f", geometry.normals)
                    if len(normals) != len(verts):
                        verts, normals, faces = _flat_normals(verts, faces)
                    else:
                        verts = array("f", verts)

                    material_ids = list(geometry.material_ids)
                    materials = list(geometry.materials)
                    face_count = len(faces) // 3
                    groups: dict[int, list[int]] = {}
                    for f in range(face_count):
                        mid = material_ids[f] if f < len(material_ids) else -1
                        groups.setdefault(mid, []).append(f)

                    for mid, keep in groups.items():
                        if len(groups) == 1:
                            sub = (verts, normals, faces)
                        else:
                            sub = _submesh(verts, normals, faces, keep)
                        color = (
                            _color_of(materials[mid])
                            if 0 <= mid < len(materials)
                            else DEFAULT_COLOR
                        )
                        if len(sub[0]) == 0:
                            continue
                        chunk.add(next_geo, shape.id, ifc_type, sub[0], sub[1], sub[2], color)
                        next_geo += 1
                        mesh_count += 1
                        triangles += len(sub[2]) // 3
                        for i in range(3):
                            axis = sub[0][i::3]
                            world_lo[i] = min(world_lo[i], min(axis))
                            world_hi[i] = max(world_hi[i], max(axis))
                    if chunk.placements >= CHUNK_PLACEMENTS or chunk.pending_bytes >= CHUNK_BYTES:
                        chunk.flush()
                processed += 1
                now = time.time()
                if progress is not None and now - last_report > 0.4:
                    last_report = now
                    progress(min(99, round(processed * 100 / expected)), mesh_count)
                if not iterator.next():
                    break
        chunk.flush()
        geometry_ms = (time.time() - t1) * 1000

        if mesh_count == 0:
            world_lo = [0.0] * 3
            world_hi = [0.0] * 3
        manifest = {
            "stats": {
                "totalEntities": len(model.by_type("IfcRoot")),
                "meshCount": mesh_count,
                "triangleCount": triangles,
                "parseMs": round(parse_ms, 1),
                "geometryMs": round(geometry_ms, 1),
                "fileBytes": source.stat().st_size,
            },
            "bounds": {
                "min": dict(zip("xyz", world_lo)),
                "max": dict(zip("xyz", world_hi)),
            },
            "tree": _spatial_tree(model),
        }
        body = json.dumps(manifest).encode()
        out.write(body)
        out.write(struct.pack("<2I", len(body), MAGIC_END))

    return manifest["stats"]


def main() -> None:
    parser = argparse.ArgumentParser(description="Convert IFC to the viewer's .ifcx format")
    parser.add_argument("source", type=Path)
    parser.add_argument("-o", "--out", type=Path)
    parser.add_argument(
        "--serve",
        action="store_true",
        help="write <sha256>.ifcx into the bridge models directory",
    )
    parser.add_argument(
        "--progress",
        action="store_true",
        help="emit one JSON progress object per line on stdout (used by the service)",
    )
    args = parser.parse_args()

    if args.serve:
        sha = hashlib.sha256(args.source.read_bytes()).hexdigest()
        target = models_dir() / f"{sha}.ifcx"
        staging = target.with_suffix(".ifcx.part")
    else:
        target = args.out or args.source.with_suffix(".ifcx")
        staging = target

    def report(percent: int, meshes: int) -> None:
        print(json.dumps({"percent": percent, "meshes": meshes}), flush=True)

    stats = convert(args.source, staging, report if args.progress else None)
    if args.serve:
        staging.replace(target)
    print(
        f"{target}\n"
        f"entities {stats['totalEntities']}  meshes {stats['meshCount']}  "
        f"triangles {stats['triangleCount']}  parse {stats['parseMs']:.0f} ms  "
        f"geometry {stats['geometryMs']:.0f} ms",
        file=sys.stderr,
    )


if __name__ == "__main__":
    main()
