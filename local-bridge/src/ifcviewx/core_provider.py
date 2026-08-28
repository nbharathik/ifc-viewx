"""Built-in Local Studio provider implementations."""

from __future__ import annotations

import uuid
from importlib.util import find_spec
from pathlib import Path
from typing import Any, Callable, Mapping

from ._version import installed_version
from .config import settings
from .provider_contract import VERSION_RE


def _object_schema(
    properties: dict[str, Any] | None = None,
    required: list[str] | None = None,
    *,
    additional: bool = False,
) -> dict:
    return {
        "type": "object",
        "properties": properties or {},
        "required": required or [],
        "additionalProperties": additional,
    }


class CoreProvider:
    def __init__(self) -> None:
        config = settings()
        has_ifc = find_spec("ifcopenshell") is not None
        version = _service_version()
        common_result = _object_schema(additional=True)
        self.manifest = {
            "schemaVersion": 1,
            "id": "org.ifcviewx.core",
            "version": version,
            "name": "IFCViewX Core",
            "description": "Conversion, model analysis and guarded IfcOpenShell jobs bundled with Local Studio.",
            "limits": {
                "maxConcurrency": 2,
                "timeoutSeconds": max(config.convert_timeout_s, config.analyze_timeout_s),
                "memoryBytes": config.memory_bytes,
                "resultTtlSeconds": config.result_ttl_s,
            },
            "capabilities": [
                {
                    "id": "ifc.convert",
                    "title": "Convert IFC",
                    "description": "Convert a stored IFC model to the browser-optimized IFCX format.",
                    "effect": "compute",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc and not config.readonly,
                    "unavailableReason": _reason(has_ifc, not config.readonly, "conversion"),
                    "inputSchema": _object_schema(),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.convert_timeout_s,
                },
                {
                    "id": "ifc.validate",
                    "title": "Validate model",
                    "description": "Run structural checks against a stored IFC model.",
                    "effect": "read",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc,
                    "unavailableReason": _reason(has_ifc, True, "validation"),
                    "inputSchema": _object_schema(),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.analyze_timeout_s,
                },
                {
                    "id": "ifc.schedule",
                    "title": "Element schedule",
                    "description": "Extract a typed element and property table from a stored IFC model.",
                    "effect": "read",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc,
                    "unavailableReason": _reason(has_ifc, True, "schedules"),
                    "inputSchema": _object_schema(
                        {
                            "type": {"type": "string", "minLength": 3, "maxLength": 100},
                            "properties": {
                                "type": "array",
                                "items": {"type": "string", "minLength": 1, "maxLength": 200},
                                "maxItems": 200,
                            },
                            "limit": {"type": "integer", "minimum": 1, "maximum": 20000},
                        }
                    ),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.analyze_timeout_s,
                },
                {
                    "id": "geometry.precise-distance",
                    "title": "Precise IFC distance",
                    "description": "Measure the shortest distance between two IFC products using a high-precision native tessellation.",
                    "effect": "read",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc,
                    "unavailableReason": _reason(has_ifc, True, "precise geometry"),
                    "inputSchema": _object_schema(
                        {
                            "a": {"type": "integer", "minimum": 1},
                            "b": {"type": "integer", "minimum": 1},
                            "maxDistance": {"type": "number", "minimum": 0.000001, "maximum": 1000000},
                        },
                        ["a", "b"],
                    ),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.analyze_timeout_s,
                },
                {
                    "id": "ifc.python.query",
                    "title": "Guarded Python query",
                    "description": "Run guarded IfcOpenShell query code in a limited child process.",
                    "effect": "read",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc and config.allow_python,
                    "unavailableReason": _reason(has_ifc, config.allow_python, "Python"),
                    "inputSchema": _object_schema(
                        {"code": {"type": "string", "minLength": 1, "maxLength": 500000}},
                        ["code"],
                    ),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.python_timeout_s,
                },
                {
                    "id": "ifc.python.edit",
                    "title": "Guarded Python edit",
                    "description": "Run guarded IfcOpenShell edit code and stage a separate IFC result.",
                    "effect": "staged-write",
                    "modelRequirement": "ifc-source",
                    "available": has_ifc and config.allow_python and not config.readonly,
                    "unavailableReason": _reason(
                        has_ifc,
                        config.allow_python and not config.readonly,
                        "Python edits",
                    ),
                    "inputSchema": _object_schema(
                        {"code": {"type": "string", "minLength": 1, "maxLength": 500000}},
                        ["code"],
                    ),
                    "resultSchema": common_result,
                    "timeoutSeconds": config.python_timeout_s,
                },
            ],
        }

    def run(
        self,
        capability_id: str,
        context: Mapping[str, Any],
        inputs: Mapping[str, Any],
        progress: Callable[[Mapping[str, Any]], None],
    ) -> Mapping[str, Any]:
        model_path = Path(str(context.get("modelPath", "")))
        model_sha = str(context.get("modelSha", ""))
        if capability_id == "ifc.convert":
            return self._convert(model_path, model_sha, progress)
        if capability_id in {"ifc.python.query", "ifc.python.edit"}:
            return self._python(capability_id, model_path, model_sha, inputs)
        if capability_id in {"ifc.validate", "ifc.schedule"}:
            from . import jobs

            kind = capability_id.rpartition(".")[2]
            return jobs.HANDLERS[kind]({"model": str(model_path), **inputs})
        if capability_id == "geometry.precise-distance":
            return self._precise_distance(model_path, inputs, progress)
        return {"error": "unknown_capability", "message": capability_id}

    def _precise_distance(
        self,
        source: Path,
        inputs: Mapping[str, Any],
        progress: Callable[[Mapping[str, Any]], None],
    ) -> Mapping[str, Any]:
        import ifcopenshell
        import ifcopenshell.geom

        model = ifcopenshell.open(str(source))
        a_id = int(inputs["a"])
        b_id = int(inputs["b"])
        try:
            a = model.by_id(a_id)
            b = model.by_id(b_id)
        except RuntimeError:
            a = b = None
        if a is None or b is None:
            return {"error": "unknown_element", "message": "one or both IFC ids do not exist"}
        progress({"phase": "geometry", "done": 0, "total": 1, "message": "Building precise shapes"})
        geometry_settings = ifcopenshell.geom.settings()
        geometry_settings.set("mesher-linear-deflection", 0.0001)
        geometry_settings.set("mesher-angular-deflection", 0.1)
        tree = ifcopenshell.geom.tree()
        iterator = ifcopenshell.geom.iterator(geometry_settings, model, 1, include=[a, b])
        if not iterator.initialize():
            return {"error": "geometry_unavailable", "message": "the selected IFC products have no usable geometry"}
        while True:
            tree.add_element(iterator.get())
            if not iterator.next():
                break
        intersections = tree.clash_intersection_many([a], [b], 0.000001, True)
        if intersections:
            hit = intersections[0]
            point = _native_point(hit.p1)
            progress({"phase": "geometry", "done": 1, "total": 1, "message": "Precise distance complete"})
            return {
                "a": a_id,
                "b": b_id,
                "distance": 0.0,
                "distanceMm": 0.0,
                "intersecting": True,
                "pointA": point,
                "pointB": _native_point(hit.p2),
                "fidelity": "native-mesh",
                "engine": "ifcopenshell-bvh",
            }
        limit = float(inputs.get("maxDistance", 1000.0))
        clearances = tree.clash_clearance_many([a], [b], limit, True)
        progress({"phase": "geometry", "done": 1, "total": 1, "message": "Precise distance complete"})
        if not clearances:
            return {
                "a": a_id,
                "b": b_id,
                "distance": None,
                "distanceMm": None,
                "intersecting": False,
                "beyondMaxDistance": True,
                "fidelity": "native-mesh",
                "engine": "ifcopenshell-bvh",
            }
        hit = min(clearances, key=lambda item: float(item.distance))
        distance = float(hit.distance)
        return {
            "a": a_id,
            "b": b_id,
            "distance": distance,
            "distanceMm": round(distance * 1000.0, 3),
            "intersecting": False,
            "pointA": _native_point(hit.p1),
            "pointB": _native_point(hit.p2),
            "fidelity": "native-mesh",
            "engine": "ifcopenshell-bvh",
        }

    def _convert(
        self,
        source: Path,
        sha: str,
        progress: Callable[[Mapping[str, Any]], None],
    ) -> Mapping[str, Any]:
        from . import store
        from .convert import cache_valid, convert, publish_cache

        target = store.converted_path(sha)
        if cache_valid(target):
            return {
                "sha": sha,
                "url": f"/models/{sha}.ifcx",
                "bytes": target.stat().st_size,
                "cached": True,
            }
        staging = target.with_name(f"{target.name}.{uuid.uuid4().hex}.part")

        def update(percent: int, meshes: int) -> None:
            progress(
                {
                    "phase": "geometry",
                    "done": percent,
                    "total": 100,
                    "message": f"Converted {meshes} meshes",
                }
            )

        try:
            stats = convert(source, staging, update)
            publish_cache(staging, target, sha)
        except Exception:
            staging.unlink(missing_ok=True)
            raise
        return {
            "sha": sha,
            "url": f"/models/{sha}.ifcx",
            "bytes": target.stat().st_size,
            "stats": stats,
        }

    def _python(
        self,
        capability_id: str,
        source: Path,
        sha: str,
        inputs: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        from . import jobs, store
        from .sandbox import _arm_sandbox

        mode = "edit" if capability_id.endswith(".edit") else "query"
        result_id = uuid.uuid4().hex if mode == "edit" else ""
        out_path = store.result_path(result_id) if result_id else None
        staging = (
            out_path.with_name(f"{out_path.name}.{uuid.uuid4().hex}.part")
            if out_path
            else None
        )
        _arm_sandbox()
        try:
            outcome = jobs.python(
                {
                    "model": str(source),
                    "code": str(inputs.get("code", "")),
                    "mode": mode,
                    "maxOutputChars": settings().max_output_chars,
                    "out": str(staging) if staging else None,
                }
            )
            if "error" not in outcome and out_path and staging and staging.is_file():
                try:
                    store.commit_staging(staging, out_path, keep={sha})
                except store.StoreError as exc:
                    return {"error": exc.code, "message": exc.message}
                outcome["resultId"] = result_id
                outcome["resultUrl"] = f"/python/result/{result_id}"
            return outcome
        finally:
            if staging:
                staging.unlink(missing_ok=True)


def _reason(has_ifc: bool, posture: bool, feature: str) -> str | None:
    if not has_ifc:
        return "IfcOpenShell is not installed for this Python version"
    if not posture:
        return f"{feature} is disabled by the Local Studio security posture"
    return None


def _native_point(value: Any) -> list[float] | None:
    if value is None:
        return None
    if all(hasattr(value, name) for name in ("X", "Y", "Z")):
        return [float(value.X()), float(value.Y()), float(value.Z())]
    try:
        point = list(value)
    except TypeError:
        return None
    return [float(point[0]), float(point[1]), float(point[2])] if len(point) >= 3 else None


def _service_version() -> str:
    value = installed_version() or "0.0.0-dev"
    return value if VERSION_RE.fullmatch(value) else "0.0.0-dev"
