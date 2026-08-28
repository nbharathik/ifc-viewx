"""Installed package metadata without adapter-specific fallback policy."""

from importlib import metadata


def installed_version() -> str | None:
    try:
        return metadata.version("ifcviewx")
    except metadata.PackageNotFoundError:
        return None
