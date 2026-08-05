"""Append-only activity log.

A service that executes model-authored code should be able to answer "what ran
on my machine, and what did it change?" after the fact. One JSON object per
line, rotated by size. Code is recorded by hash and first line, never in full,
so the log itself never becomes a place secrets accumulate.
"""

from __future__ import annotations

import hashlib
import json
import os
import threading
import time
from typing import Any

from .config import settings

MAX_BYTES = 4 * 1024 * 1024
_lock = threading.Lock()


def code_fingerprint(code: str) -> dict:
    """Enough to correlate a run with its source without storing the source."""
    first = next((line for line in code.splitlines() if line.strip()), "")
    return {
        "sha256": hashlib.sha256(code.encode("utf-8", "replace")).hexdigest()[:16],
        "chars": len(code),
        "firstLine": first[:120],
    }


def record(event: str, **fields: Any) -> None:
    """Never raises: a failed audit write must not fail the request."""
    entry = {"ts": round(time.time(), 3), "event": event, **fields}
    path = settings().audit_path
    line = json.dumps(entry, default=str, ensure_ascii=False)
    try:
        with _lock:
            if path.exists() and path.stat().st_size > MAX_BYTES:
                path.replace(path.with_suffix(".jsonl.1"))
            with path.open("a", encoding="utf-8") as handle:
                handle.write(line + "\n")
                handle.flush()
                os.fsync(handle.fileno())
    except OSError:
        pass


def tail(limit: int = 50) -> list[dict]:
    """Most recent entries, newest last."""
    path = settings().audit_path
    if not path.is_file():
        return []
    try:
        with path.open("r", encoding="utf-8") as handle:
            lines = handle.readlines()[-max(1, min(limit, 500)) :]
    except OSError:
        return []
    out: list[dict] = []
    for line in lines:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out
