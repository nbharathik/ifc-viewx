"""Content-addressed model store.

Names are always derived from the SHA-256 of the bytes, never from anything a
client sends, so no request can reach outside the store directory. The store
also owns its own growth: uploads are sniffed before they are kept, the total
size is capped, and edit results expire.
"""

from __future__ import annotations

import re
import shutil
import time
from dataclasses import dataclass
from pathlib import Path

from .config import settings

SHA_RE = re.compile(r"^[0-9a-f]{64}$")
#: STEP physical file header; .ifczip is a zip whose entry is one of these.
IFC_MAGIC = b"ISO-10303-21"
ZIP_MAGIC = b"PK\x03\x04"
SNIFF_BYTES = 4096


class StoreError(Exception):
    """Refusals that map to a 4xx: bad sha, junk upload, no room."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


def models_dir() -> Path:
    return settings().store_dir


def is_sha(value: str) -> bool:
    return bool(SHA_RE.match(value or ""))


def source_path(sha: str) -> Path:
    if not is_sha(sha):
        raise StoreError("bad_sha", "not a content hash")
    return models_dir() / f"{sha}.ifc"


def converted_path(sha: str) -> Path:
    if not is_sha(sha):
        raise StoreError("bad_sha", "not a content hash")
    return models_dir() / f"{sha}.ifcx"


def result_path(result_id: str) -> Path:
    if not re.fullmatch(r"[0-9a-f]{8,64}", result_id or ""):
        raise StoreError("bad_id", "not a result id")
    return models_dir() / f"edit-{result_id}.ifc"


def looks_like_ifc(head: bytes) -> bool:
    """Cheap format check so the store never fills with unrelated files."""
    if head.startswith(ZIP_MAGIC):
        return True  # .ifczip; the converter reports a real error if it is not
    return IFC_MAGIC in head[:SNIFF_BYTES]


def require_space(size: int) -> None:
    """Refuse before writing rather than half-way through."""
    limits = settings()
    if size > limits.max_upload_bytes:
        raise StoreError(
            "too_large",
            f"{size / 1e6:.0f} MB exceeds the {limits.max_upload_bytes / 1e6:.0f} MB upload limit",
        )
    free = shutil.disk_usage(models_dir()).free
    if size + 512 * 1024**2 > free:
        raise StoreError("no_space", "not enough free disk space for this model")


@dataclass(frozen=True)
class Entry:
    sha: str
    kind: str
    bytes: int
    at: float

    def as_dict(self) -> dict:
        return {
            "sha": self.sha,
            "kind": self.kind,
            "bytes": self.bytes,
            "at": round(self.at, 3),
            "url": f"/models/{self.sha}.{self.kind}",
        }


def entries() -> list[Entry]:
    """Stored models, newest first. Partial and result files are excluded."""
    out: list[Entry] = []
    for path in models_dir().iterdir():
        stem, _, suffix = path.name.partition(".")
        if suffix not in {"ifc", "ifcx"} or not is_sha(stem):
            continue
        try:
            stat = path.stat()
        except OSError:
            continue
        out.append(Entry(stem, suffix, stat.st_size, stat.st_mtime))
    out.sort(key=lambda e: e.at, reverse=True)
    return out


def stats() -> dict:
    listing = entries()
    used = sum(e.bytes for e in listing)
    results = list(models_dir().glob("edit-*.ifc"))
    return {
        "dir": str(models_dir()),
        "files": len(listing),
        "bytes": used,
        "quotaBytes": settings().store_quota_bytes,
        "freeBytes": shutil.disk_usage(models_dir()).free,
        "pendingResults": len(results),
        "models": [e.as_dict() for e in listing[:50]],
    }


def sweep(keep: set[str] | None = None) -> dict:
    """Expire edit results and evict the oldest models over quota.

    `keep` holds shas the session still needs; they are never evicted.
    """
    limits = settings()
    keep = keep or set()
    now = time.time()
    removed_results = 0
    for path in models_dir().glob("edit-*.ifc"):
        try:
            if now - path.stat().st_mtime > limits.result_ttl_s:
                path.unlink()
                removed_results += 1
        except OSError:
            continue
    for partial in models_dir().glob("*.part"):
        try:
            if now - partial.stat().st_mtime > 3600:
                partial.unlink()
        except OSError:
            continue

    listing = entries()
    used = sum(e.bytes for e in listing)
    evicted: list[str] = []
    # Oldest first, and a converted model outlives its heavier source.
    for entry in sorted(listing, key=lambda e: (e.at, e.kind == "ifcx")):
        if used <= limits.store_quota_bytes:
            break
        if entry.sha in keep or now - entry.at < 300:
            continue
        try:
            (models_dir() / f"{entry.sha}.{entry.kind}").unlink()
        except OSError:
            continue
        used -= entry.bytes
        evicted.append(f"{entry.sha[:12]}.{entry.kind}")
    return {"expiredResults": removed_results, "evicted": evicted, "bytes": used}
