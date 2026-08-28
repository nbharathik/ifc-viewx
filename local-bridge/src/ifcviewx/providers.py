"""Provider discovery facade preserving the original import surface."""

from __future__ import annotations

from importlib import metadata
from typing import Any

from .core_provider import CoreProvider
from .provider_contract import (
    CAPABILITY_RE,
    EFFECTS,
    ENTRY_POINT_GROUP,
    ID_RE,
    MODEL_REQUIREMENTS,
    PATH_FIELD_PARTS,
    PATH_FIELD_RE,
    PROTOCOL_CURRENT,
    PROTOCOL_MAX,
    PROTOCOL_MIN,
    SCHEMA_KEYS,
    SCHEMA_TYPES,
    SHA_RE,
    VERSION_RE,
    ProviderLookupError,
    ProviderProtocol,
    ProviderRecord,
    ProviderValidationError,
    model_sha,
    reject_path_inputs,
    validate_manifest,
    validate_value,
    version_satisfies,
)

__all__ = [
    "CAPABILITY_RE",
    "CoreProvider",
    "EFFECTS",
    "ENTRY_POINT_GROUP",
    "ID_RE",
    "MODEL_REQUIREMENTS",
    "PATH_FIELD_PARTS",
    "PATH_FIELD_RE",
    "PROTOCOL_CURRENT",
    "PROTOCOL_MAX",
    "PROTOCOL_MIN",
    "ProviderLookupError",
    "ProviderProtocol",
    "ProviderRecord",
    "ProviderRegistry",
    "ProviderValidationError",
    "SCHEMA_KEYS",
    "SCHEMA_TYPES",
    "SHA_RE",
    "VERSION_RE",
    "model_sha",
    "reject_path_inputs",
    "validate_manifest",
    "validate_value",
    "version_satisfies",
]


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
    def __init__(
        self,
        records: list[ProviderRecord],
        errors: list[dict[str, str]] | None = None,
    ) -> None:
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
                    raise ProviderValidationError(
                        [f"provider id {manifest['id']} is already registered"]
                    )
                seen.add(manifest["id"])
                source = getattr(
                    entry_point,
                    "value",
                    getattr(entry_point, "name", "entry-point"),
                )
                records.append(ProviderRecord(provider, manifest, str(source)))
            except Exception as exc:  # noqa: BLE001 - discovery reports broken providers
                errors.append(
                    {
                        "entryPoint": str(getattr(entry_point, "name", "unknown")),
                        "error": str(exc)[:500],
                    }
                )
        return cls(records, errors)

    def listing(self) -> dict[str, Any]:
        return {
            "protocol": {
                "min": PROTOCOL_MIN,
                "max": PROTOCOL_MAX,
                "current": PROTOCOL_CURRENT,
            },
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
            raise ProviderLookupError(
                "unknown_provider",
                f"Local provider {provider_id} is not installed",
            )
        match = version_satisfies(record.manifest["version"], version_requirement)
        if match is None:
            raise ProviderLookupError(
                "invalid_version_range",
                "providerVersion is not a supported version range",
            )
        if not match:
            raise ProviderLookupError(
                "provider_version_mismatch",
                f"Installed {provider_id} {record.manifest['version']} does not match {version_requirement}",
            )
        capability = next(
            (
                item
                for item in record.manifest["capabilities"]
                if item["id"] == capability_id
            ),
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
                capability.get("unavailableReason")
                or f"{capability_id} is unavailable",
            )
        return record, capability
