"""Native-provider protocol, manifests, schemas, and input validation."""

from __future__ import annotations

import math
import re
from dataclasses import dataclass
from typing import Any, Callable, Mapping, Protocol

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
PATH_FIELD_PARTS = frozenset(
    {"path", "paths", "file", "files", "filename", "directory", "folder", "root", "uri"}
)
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
        if isinstance(value, float) and not math.isfinite(value):
            return [f"{path} must be finite"]
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
            not isinstance(number, (int, float))
            or isinstance(number, bool)
            or (isinstance(number, float) and not math.isfinite(number))
        ):
            issues.append(f"{path}.{name} must be a finite number")


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
        for name in ("maxConcurrency", "memoryBytes"):
            number = limits.get(name)
            if not isinstance(number, int) or isinstance(number, bool) or number <= 0:
                issues.append(f"manifest.limits.{name} must be a positive integer")
        timeout = limits.get("timeoutSeconds")
        if (
            not isinstance(timeout, (int, float))
            or isinstance(timeout, bool)
            or (isinstance(timeout, float) and not math.isfinite(timeout))
            or timeout <= 0
        ):
            issues.append("manifest.limits.timeoutSeconds must be positive and finite")
        ttl = limits.get("resultTtlSeconds")
        if (
            not isinstance(ttl, (int, float))
            or isinstance(ttl, bool)
            or (isinstance(ttl, float) and not math.isfinite(ttl))
            or ttl < 0
        ):
            issues.append("manifest.limits.resultTtlSeconds must be non-negative and finite")
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
                or (
                    isinstance(cap["timeoutSeconds"], float)
                    and not math.isfinite(cap["timeoutSeconds"])
                )
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


def model_sha(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if SHA_RE.fullmatch(text) else None
