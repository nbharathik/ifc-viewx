"""Versioned Local Studio provider discovery and validation."""

from __future__ import annotations

import re
import uuid
from dataclasses import dataclass
from importlib import metadata
from importlib.util import find_spec
from pathlib import Path
from typing import Any, Callable, Mapping, Protocol

from .config import settings

PROTOCOL_MIN = 1
PROTOCOL_MAX = 1
PROTOCOL_CURRENT = 1
ENTRY_POINT_GROUP = "ifcviewx.providers"

ID_RE = re.compile(r"^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$")
CAPABILITY_RE = re.compile(r"^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$")
SHA_RE = re.compile(r"^[0-9a-f]{64}$")
PATH_FIELD_RE = re.compile(
    r"(?:^|[_-])(path|paths|file|files|filename|directory|folder|root|uri)(?:$|[_-])",
    re.IGNORECASE,
)
PATH_FIELD_PARTS = frozenset({"path", "paths", "file", "files", "filename", "directory", "folder", "root", "uri"})
EFFECTS = frozenset({"read", "compute", "staged-write"})
MODEL_REQUIREMENTS = frozenset({"none", "ifc-source"})
SCHEMA_TYPES = frozenset({"object", "array", "string", "number", "integer", "boolean", "null"})
SCHEMA_KEYS = frozenset(
    {
        "$schema",
        "type",
        "title",
        "description",
        "properties",
        "required",
        "additionalProperties",
        "items",
        "enum",
        "const",
        "default",
        "minimum",
        "maximum",
        "minLength",
        "maxLength",
        "minItems",
        "maxItems",
        "pattern",
    }
)


class ProviderProtocol(Protocol):
    manifest: Mapping[str, Any]

    def run(
        self,
        capability_id: str,
        context: Mapping[str, Any],
        inputs: Mapping[str, Any],
        progress: Callable[[Mapping[str, Any]], None],
    ) -> Any: ...


class ProviderValidationError(ValueError):
    def __init__(self, issues: list[str]) -> None:
        super().__init__("; ".join(issues))
        self.issues = issues


class ProviderLookupError(LookupError):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class ProviderRecord:
    provider: ProviderProtocol
    manifest: dict[str, Any]
    source: str

    def listing(self) -> dict[str, Any]:
        return {**self.manifest, "source": self.source, "trust": "trusted-native"}


def _parse_version(value: str) -> tuple[int, int, int] | None:
    match = re.match(r"^(\d+)(?:\.(\d+))?(?:\.(\d+))?", value)
    if not match:
        return None
    return (
        int(match.group(1) or 0),
        int(match.group(2) or 0),
        int(match.group(3) or 0),
    )


def version_satisfies(version: str, requirement: str) -> bool | None:
    current = _parse_version(version)
    if current is None or not requirement.strip() or "||" in requirement:
        return None
    for token in requirement.replace(",", " ").split():
        if token.lower() in {"*", "x"}:
            continue
        wildcard = re.fullmatch(r"(\d+)\.(?:x|\*)", token, re.IGNORECASE)
        if wildcard:
            if current[0] != int(wildcard.group(1)):
                return False
            continue
        ranged = re.fullmatch(r"(\^|~)(\d+(?:\.\d+){0,2})", token)
        if ranged:
            base = _parse_version(ranged.group(2))
            if base is None:
                return None
            upper = (base[0] + 1, 0, 0) if ranged.group(1) == "^" else (base[0], base[1] + 1, 0)
            if not base <= current < upper:
                return False
            continue
        compared = re.fullmatch(r"(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})", token)
        if not compared:
            return None
        target = _parse_version(compared.group(2))
        if target is None:
            return None
        relation = (current > target) - (current < target)
        operator = compared.group(1)
        if operator is None and len(compared.group(2).split(".")) == 1:
            matches = current[0] == target[0]
        elif operator in {None, "="}:
            matches = relation == 0
        elif operator == ">=":
            matches = relation >= 0
        elif operator == "<=":
            matches = relation <= 0
        elif operator == ">":
            matches = relation > 0
        else:
            matches = relation < 0
        if not matches:
            return False
    return True


def _json_type(value: Any, expected: str) -> bool:
    if expected == "object":
        return isinstance(value, dict)
    if expected == "array":
        return isinstance(value, list)
    if expected == "string":
        return isinstance(value, str)
    if expected == "number":
        return isinstance(value, (int, float)) and not isinstance(value, bool)
    if expected == "integer":
        return isinstance(value, int) and not isinstance(value, bool)
    if expected == "boolean":
        return isinstance(value, bool)
    return value is None


def _is_path_field(value: str) -> bool:
    separated = re.sub(r"([a-z0-9])([A-Z])", r"\1_\2", value)
    parts = {part.lower() for part in re.split(r"[^A-Za-z0-9]+", separated) if part}
    return bool(parts & PATH_FIELD_PARTS) or bool(PATH_FIELD_RE.search(value))


def _looks_like_path(value: str) -> bool:
    stripped = value.strip()
    return bool(
        stripped.lower().startswith("file://")
        or re.match(r"^[A-Za-z]:[\\/]", stripped)
        or stripped.startswith(("/", "\\\\", "../", "..\\"))
    )


def validate_value(value: Any, schema: Mapping[str, Any], path: str = "input") -> list[str]:
    issues: list[str] = []
    expected = schema.get("type")
    if isinstance(expected, str) and not _json_type(value, expected):
        return [f"{path} must be {expected}"]
    if "enum" in schema and value not in schema["enum"]:
        issues.append(f"{path} is not an allowed value")
    if "const" in schema and value != schema["const"]:
        issues.append(f"{path} must equal the declared constant")
    if isinstance(value, dict):
        properties = schema.get("properties", {})
        required = schema.get("required", [])
        for name in required:
            if name not in value:
                issues.append(f"{path}.{name} is required")
        for name, child in value.items():
            child_schema = properties.get(name)
            if child_schema is None:
                if schema.get("additionalProperties", True) is False:
                    issues.append(f"{path}.{name} is not allowed")
                continue
            issues.extend(validate_value(child, child_schema, f"{path}.{name}"))
    elif isinstance(value, list):
        minimum = schema.get("minItems")
        maximum = schema.get("maxItems")
        if isinstance(minimum, int) and len(value) < minimum:
            issues.append(f"{path} must contain at least {minimum} items")
        if isinstance(maximum, int) and len(value) > maximum:
            issues.append(f"{path} must contain at most {maximum} items")
        if isinstance(schema.get("items"), dict):
            for index, item in enumerate(value):
                issues.extend(validate_value(item, schema["items"], f"{path}[{index}]"))
    elif isinstance(value, str):
        minimum = schema.get("minLength")
        maximum = schema.get("maxLength")
        if isinstance(minimum, int) and len(value) < minimum:
            issues.append(f"{path} is shorter than {minimum} characters")
        if isinstance(maximum, int) and len(value) > maximum:
            issues.append(f"{path} is longer than {maximum} characters")
        pattern = schema.get("pattern")
        if isinstance(pattern, str) and re.search(pattern, value) is None:
            issues.append(f"{path} does not match the required pattern")
    elif isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            issues.append(f"{path} is below the minimum")
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            issues.append(f"{path} is above the maximum")
    return issues


def _validate_schema(
    value: Any,
    path: str,
    issues: list[str],
    *,
    input_schema: bool,
) -> None:
    if not isinstance(value, dict):
        issues.append(f"{path} must be an object")
        return
    unknown = sorted(set(value) - SCHEMA_KEYS)
    if unknown:
        issues.append(f"{path} uses unsupported keywords: {', '.join(unknown)}")
    schema_type = value.get("type")
    if schema_type not in SCHEMA_TYPES:
        issues.append(f"{path}.type must be one supported JSON type")
    properties = value.get("properties")
    if properties is not None:
        if not isinstance(properties, dict):
            issues.append(f"{path}.properties must be an object")
        else:
            for name, child in properties.items():
                if not isinstance(name, str) or not name:
                    issues.append(f"{path}.properties has an invalid name")
                    continue
                if input_schema and _is_path_field(name):
                    issues.append(f"{path}.properties.{name} cannot request a filesystem path")
                _validate_schema(child, f"{path}.properties.{name}", issues, input_schema=input_schema)
    required = value.get("required")
    if required is not None and (
        not isinstance(required, list)
        or any(not isinstance(name, str) for name in required)
    ):
        issues.append(f"{path}.required must be an array of property names")
    elif isinstance(required, list) and isinstance(properties, dict):
        missing = sorted(set(required) - set(properties))
        if missing:
            issues.append(f"{path}.required names undeclared properties: {', '.join(missing)}")
    if input_schema and schema_type == "object" and value.get("additionalProperties") is not False:
        issues.append(f"{path}.additionalProperties must be false")
    if "additionalProperties" in value and not isinstance(value["additionalProperties"], bool):
        issues.append(f"{path}.additionalProperties must be boolean")
    if "items" in value:
        _validate_schema(value["items"], f"{path}.items", issues, input_schema=input_schema)
    if "enum" in value and (not isinstance(value["enum"], list) or not value["enum"]):
        issues.append(f"{path}.enum must be a non-empty array")
    if "pattern" in value:
        try:
            re.compile(value["pattern"])
        except (TypeError, re.error):
            issues.append(f"{path}.pattern must be a valid regular expression")
    for name in ("minLength", "maxLength", "minItems", "maxItems"):
        number = value.get(name)
        if number is not None and (
            not isinstance(number, int) or isinstance(number, bool) or number < 0
        ):
            issues.append(f"{path}.{name} must be a non-negative integer")
    for name in ("minimum", "maximum"):
        number = value.get(name)
        if number is not None and (
            not isinstance(number, (int, float)) or isinstance(number, bool)
        ):
            issues.append(f"{path}.{name} must be a number")


def validate_manifest(raw: Any) -> dict[str, Any]:
    issues: list[str] = []
    if not isinstance(raw, Mapping):
        raise ProviderValidationError(["manifest must be an object"])
    value = dict(raw)
    manifest_keys = {"schemaVersion", "id", "version", "name", "description", "limits", "capabilities"}
    unknown_manifest = sorted(set(value) - manifest_keys)
    if unknown_manifest:
        issues.append(f"manifest has unknown fields: {', '.join(unknown_manifest)}")
    if value.get("schemaVersion") != 1:
        issues.append("manifest.schemaVersion must be 1")
    for key in ("id", "version", "name", "description"):
        if not isinstance(value.get(key), str) or not value[key].strip():
            issues.append(f"manifest.{key} must be a non-empty string")
    if isinstance(value.get("id"), str) and (
        not ID_RE.fullmatch(value["id"]) or "." not in value["id"]
    ):
        issues.append("manifest.id must use reverse-domain notation")
    if isinstance(value.get("version"), str) and not VERSION_RE.fullmatch(value["version"]):
        issues.append("manifest.version must be semantic versioning")
    limits = value.get("limits")
    if not isinstance(limits, Mapping):
        issues.append("manifest.limits must be an object")
    else:
        unknown_limits = sorted(
            set(limits) - {"maxConcurrency", "timeoutSeconds", "memoryBytes", "resultTtlSeconds"}
        )
        if unknown_limits:
            issues.append(f"manifest.limits has unknown fields: {', '.join(unknown_limits)}")
        for name in ("maxConcurrency", "timeoutSeconds", "memoryBytes", "resultTtlSeconds"):
            number = limits.get(name)
            if not isinstance(number, (int, float)) or isinstance(number, bool) or number <= 0:
                issues.append(f"manifest.limits.{name} must be positive")
    capabilities = value.get("capabilities")
    if not isinstance(capabilities, list) or not capabilities:
        issues.append("manifest.capabilities must be a non-empty array")
    else:
        seen: set[str] = set()
        for index, capability in enumerate(capabilities):
            prefix = f"manifest.capabilities[{index}]"
            if not isinstance(capability, Mapping):
                issues.append(f"{prefix} must be an object")
                continue
            cap = dict(capability)
            capability_keys = {
                "id",
                "title",
                "description",
                "effect",
                "modelRequirement",
                "available",
                "unavailableReason",
                "inputSchema",
                "resultSchema",
                "timeoutSeconds",
            }
            unknown_capability = sorted(set(cap) - capability_keys)
            if unknown_capability:
                issues.append(f"{prefix} has unknown fields: {', '.join(unknown_capability)}")
            for key in ("id", "title", "description"):
                if not isinstance(cap.get(key), str) or not cap[key].strip():
                    issues.append(f"{prefix}.{key} must be a non-empty string")
            cap_id = cap.get("id")
            if isinstance(cap_id, str):
                if not CAPABILITY_RE.fullmatch(cap_id):
                    issues.append(f"{prefix}.id is invalid")
                if cap_id in seen:
                    issues.append(f"{prefix}.id is duplicated")
                seen.add(cap_id)
            if cap.get("effect") not in EFFECTS:
                issues.append(f"{prefix}.effect is invalid")
            if cap.get("modelRequirement") not in MODEL_REQUIREMENTS:
                issues.append(f"{prefix}.modelRequirement is invalid")
            if not isinstance(cap.get("available"), bool):
                issues.append(f"{prefix}.available must be boolean")
            if cap.get("available") is False and not isinstance(cap.get("unavailableReason"), str):
                issues.append(f"{prefix}.unavailableReason is required when unavailable")
            if "timeoutSeconds" in cap and (
                not isinstance(cap["timeoutSeconds"], (int, float))
                or isinstance(cap["timeoutSeconds"], bool)
                or cap["timeoutSeconds"] <= 0
            ):
                issues.append(f"{prefix}.timeoutSeconds must be positive")
            _validate_schema(cap.get("inputSchema"), f"{prefix}.inputSchema", issues, input_schema=True)
            _validate_schema(cap.get("resultSchema"), f"{prefix}.resultSchema", issues, input_schema=False)
    if issues:
        raise ProviderValidationError(issues)
    return value


def reject_path_inputs(value: Any, path: str = "input") -> list[str]:
    issues: list[str] = []
    if isinstance(value, dict):
        for key, child in value.items():
            if _is_path_field(str(key)):
                issues.append(f"{path}.{key} cannot carry a filesystem path")
            issues.extend(reject_path_inputs(child, f"{path}.{key}"))
    elif isinstance(value, list):
        for index, child in enumerate(value):
            issues.extend(reject_path_inputs(child, f"{path}[{index}]"))
    elif isinstance(value, str) and _looks_like_path(value):
        issues.append(f"{path} cannot carry a filesystem path")
    return issues


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
            return self._python(capability_id, model_path, inputs)
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
        from .convert import cache_valid, convert, mark_cache

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
            store.commit_staging(staging, target, keep={sha})
            mark_cache(target)
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
        inputs: Mapping[str, Any],
    ) -> Mapping[str, Any]:
        from . import jobs, store
        from .sandbox import _arm_sandbox

        mode = "edit" if capability_id.endswith(".edit") else "query"
        result_id = uuid.uuid4().hex
        out_path = store.result_path(result_id) if mode == "edit" else None
        _arm_sandbox()
        outcome = jobs.python(
            {
                "model": str(source),
                "code": str(inputs.get("code", "")),
                "mode": mode,
                "maxOutputChars": settings().max_output_chars,
                "out": str(out_path) if out_path else None,
            }
        )
        if mode == "edit" and "error" not in outcome and out_path and out_path.is_file():
            outcome["resultId"] = result_id
            outcome["resultUrl"] = f"/python/result/{result_id}"
        return outcome


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
    try:
        value = metadata.version("ifcviewx")
    except metadata.PackageNotFoundError:
        value = "0.0.0-dev"
    return value if VERSION_RE.fullmatch(value) else "0.0.0-dev"


def _provider_from_entry_point(entry_point: Any) -> ProviderProtocol:
    loaded = entry_point.load()
    if isinstance(loaded, type):
        loaded = loaded()
    elif callable(loaded) and not hasattr(loaded, "run"):
        loaded = loaded()
    if not hasattr(loaded, "manifest") or not callable(getattr(loaded, "run", None)):
        raise ProviderValidationError(["entry point must expose manifest and run"])
    return loaded


class ProviderRegistry:
    def __init__(self, records: list[ProviderRecord], errors: list[dict[str, str]] | None = None) -> None:
        self._records = {record.manifest["id"]: record for record in records}
        self.errors = errors or []

    @classmethod
    def discover(cls) -> "ProviderRegistry":
        records: list[ProviderRecord] = []
        errors: list[dict[str, str]] = []
        core = CoreProvider()
        records.append(ProviderRecord(core, validate_manifest(core.manifest), "built-in"))
        seen = {core.manifest["id"]}
        try:
            entry_points = metadata.entry_points(group=ENTRY_POINT_GROUP)
        except TypeError:
            entry_points = metadata.entry_points().get(ENTRY_POINT_GROUP, [])
        for entry_point in entry_points:
            try:
                provider = _provider_from_entry_point(entry_point)
                manifest = validate_manifest(provider.manifest)
                if manifest["id"] in seen:
                    raise ProviderValidationError([f"provider id {manifest['id']} is already registered"])
                seen.add(manifest["id"])
                source = getattr(entry_point, "value", getattr(entry_point, "name", "entry-point"))
                records.append(ProviderRecord(provider, manifest, str(source)))
            except Exception as exc:
                errors.append(
                    {
                        "entryPoint": str(getattr(entry_point, "name", "unknown")),
                        "error": str(exc)[:500],
                    }
                )
        return cls(records, errors)

    def listing(self) -> dict[str, Any]:
        return {
            "protocol": {"min": PROTOCOL_MIN, "max": PROTOCOL_MAX, "current": PROTOCOL_CURRENT},
            "providers": [record.listing() for record in self._records.values()],
            "errors": list(self.errors),
        }

    def get(self, provider_id: str) -> ProviderRecord | None:
        return self._records.get(provider_id)

    def resolve(
        self,
        provider_id: str,
        version_requirement: str,
        capability_id: str,
    ) -> tuple[ProviderRecord, dict[str, Any]]:
        record = self.get(provider_id)
        if record is None:
            raise ProviderLookupError("unknown_provider", f"Local provider {provider_id} is not installed")
        match = version_satisfies(record.manifest["version"], version_requirement)
        if match is None:
            raise ProviderLookupError("invalid_version_range", "providerVersion is not a supported version range")
        if not match:
            raise ProviderLookupError(
                "provider_version_mismatch",
                f"Installed {provider_id} {record.manifest['version']} does not match {version_requirement}",
            )
        capability = next(
            (item for item in record.manifest["capabilities"] if item["id"] == capability_id),
            None,
        )
        if capability is None:
            raise ProviderLookupError(
                "unknown_capability",
                f"Provider {provider_id} does not offer {capability_id}",
            )
        if not capability["available"]:
            raise ProviderLookupError(
                "capability_unavailable",
                capability.get("unavailableReason") or f"{capability_id} is unavailable",
            )
        return record, capability


def model_sha(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if SHA_RE.fullmatch(text) else None
