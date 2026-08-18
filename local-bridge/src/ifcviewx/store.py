"""Content-addressed model store.

Names are always derived from the SHA-256 of the bytes, never from anything a
client sends, so no request can reach outside the store directory. The store
also owns its own growth: uploads are sniffed before they are kept, the total
size is capped, and edit results expire.
"""

from __future__ import annotations

import os
import re
import shutil
import threading
import time
import uuid
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

from .config import settings

SHA_RE = re.compile(r"^[0-9a-f]{64}$")
#: STEP physical file header; .ifczip is a zip whose entry is one of these.
IFC_MAGIC = b"ISO-10303-21"
ZIP_MAGIC = b"PK\x03\x04"
SNIFF_BYTES = 4096
_STORE_LOCK = threading.RLock()
_STORE_LOCK_TIMEOUT_S = 30.0


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


def require_space(size: int, written: int = 0) -> None:
    """Refuse before writing rather than half-way through."""
    limits = settings()
    if size > limits.max_upload_bytes:
        raise StoreError(
            "too_large",
            f"{size / 1e6:.0f} MB exceeds the {limits.max_upload_bytes / 1e6:.0f} MB upload limit",
        )
    free = shutil.disk_usage(models_dir()).free
    remaining = max(0, size - max(0, written))
    if remaining + 512 * 1024**2 > free:
        raise StoreError("no_space", "not enough free disk space for this model")


@contextmanager
def lease(sha: str):
    """Keep a stored model alive while a worker is reading it."""
    if not is_sha(sha):
        raise StoreError("bad_sha", "not a content hash")
    marker = models_dir() / f"{sha}.{uuid.uuid4().hex}.lease"
    # Publish the lease under the same lock used to enumerate leases and pick
    # eviction candidates. Otherwise sweep can miss a just-starting worker.
    with _locked_store():
        marker.touch()
    try:
        yield
    finally:
        marker.unlink(missing_ok=True)


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


@contextmanager
def _locked_store():
    """Serialize quota decisions and commits across threads and processes."""
    lock_path = models_dir() / ".store.lock"
    with _STORE_LOCK, lock_path.open("a+b") as handle:
        handle.seek(0, 2)
        if handle.tell() == 0:
            handle.write(b"\0")
            handle.flush()
        deadline = time.monotonic() + _STORE_LOCK_TIMEOUT_S
        while True:
            try:
                handle.seek(0)
                if os.name == "nt":
                    import msvcrt

                    msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
                else:
                    import fcntl

                    fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except OSError as exc:
                if time.monotonic() >= deadline:
                    raise StoreError("store_busy", "the model store is busy; try again") from exc
                time.sleep(0.05)
        try:
            yield
        finally:
            handle.seek(0)
            if os.name == "nt":
                import msvcrt

                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl

                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def _sweep_unlocked(keep: set[str] | None = None, reserve: int = 0) -> dict:
    """Expire edit results and evict the oldest models over quota.

    `keep` holds shas the session still needs; they are never evicted.
    """
    limits = settings()
    keep = set(keep or ())
    now = time.time()
    leased: set[str] = set()
    lease_ttl = max(limits.convert_timeout_s, limits.provider_timeout_s) + 300
    for marker in models_dir().glob("*.lease"):
        sha = marker.name.partition(".")[0]
        try:
            if not is_sha(sha) or now - marker.stat().st_mtime > lease_ttl:
                marker.unlink(missing_ok=True)
            else:
                leased.add(sha)
        except OSError:
            continue
    keep |= leased
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

    reserve = max(0, reserve)
    if reserve > limits.store_quota_bytes:
        raise StoreError("quota_exceeded", "this model is larger than the model store quota")
    listing = entries()
    used = sum(e.bytes for e in listing)
    evicted: list[str] = []
    # Oldest first, and a converted model outlives its heavier source.
    ordered = sorted(listing, key=lambda e: (e.at, e.kind == "ifcx"))
    candidates = [
        entry
        for entry in ordered
        if entry.sha not in keep and now - entry.at >= 300
    ]
    needed = max(0, used + reserve - limits.store_quota_bytes)
    if reserve and sum(entry.bytes for entry in candidates) < needed:
        # Do not evict useful caches when the protected/recent remainder means
        # the incoming reservation cannot succeed anyway.
        raise StoreError("quota_exceeded", "the model store quota is full")
    for entry in candidates:
        if used + reserve <= limits.store_quota_bytes:
            break
        try:
            target = models_dir() / f"{entry.sha}.{entry.kind}"
            target.unlink()
            if entry.kind == "ifcx":
                target.with_name(f"{target.name}.meta").unlink(missing_ok=True)
        except OSError:
            continue
        used -= entry.bytes
        evicted.append(f"{entry.sha[:12]}.{entry.kind}")
    if reserve and used + reserve > limits.store_quota_bytes:
        raise StoreError("quota_exceeded", "the model store quota is full")
    return {"expiredResults": removed_results, "evicted": evicted, "bytes": used}


def sweep(keep: set[str] | None = None, reserve: int = 0) -> dict:
    """Expire old data and reserve quota under the store-wide lock."""
    with _locked_store():
        return _sweep_unlocked(keep=keep, reserve=reserve)


def commit_staging(staging: Path, target: Path, *, keep: set[str] | None = None) -> dict:
    """Reserve the staging file's net growth and atomically publish it.

    The target size is measured while holding the same cross-process lock as
    eviction. This prevents concurrent uploads/conversions from both claiming
    the same quota, including two writers racing on one content hash.
    """
    with _locked_store():
        incoming = staging.stat().st_size
        try:
            old_size = target.stat().st_size
        except FileNotFoundError:
            old_size = 0
        result = _sweep_unlocked(keep=keep, reserve=max(0, incoming - old_size))
        staging.replace(target)
        return result
