"""Runtime configuration, read once from the environment.

Every tunable and every security posture flag lives here so the rest of the
service never reads os.environ directly and the startup banner can print the
posture it actually runs with.
"""

from __future__ import annotations

import math
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path


def env(name: str) -> str | None:
    """IFCVIEWX_<name>, or the pre-rename IFC_BRIDGE_<name> as a fallback."""
    return os.environ.get(f"IFCVIEWX_{name}", os.environ.get(f"IFC_BRIDGE_{name}"))


def _flag(name: str, default: bool) -> bool:
    raw = env(name)
    if raw is None:
        return default
    return raw.strip().lower() not in {"0", "false", "no", "off", ""}


def _num(name: str, default: float) -> float:
    try:
        value = float(env(name) or default)
    except ValueError:
        return default
    return value if math.isfinite(value) else default


def _positive(
    name: str,
    default: float,
    *,
    zero: bool = False,
    maximum: float = 1_000_000_000,
) -> float:
    value = _num(name, default)
    lower_ok = value > 0 or (zero and value == 0)
    return value if lower_ok and value <= maximum else default


def _origins() -> frozenset[str]:
    """Extra browser origins, empty by default.

    Local Studio serves its own copy of the viewer, so the only page that ever
    needs to talk to this service is the one it served itself: no web page on
    the internet is trusted, including the hosted copy of this same viewer.
    IFCVIEWX_ORIGINS is the escape hatch for someone hosting the viewer
    themselves, and pointing it at a page you do not control hands that page
    everything the token protects.
    """
    raw = (env("ORIGINS") or "").strip()
    if raw.lower() in {"", "none"}:
        return frozenset()
    return frozenset(o.strip().lower().rstrip("/") for o in raw.split(",") if o.strip())


@dataclass(frozen=True)
class Settings:
    token: str
    port: int
    # Posture
    allow_python: bool
    readonly: bool
    # Limits
    python_timeout_s: float
    convert_timeout_s: float
    analyze_timeout_s: float
    memory_bytes: int
    max_upload_bytes: int
    store_quota_bytes: int
    result_ttl_s: float
    max_output_chars: int
    provider_timeout_s: float
    job_ttl_s: float
    job_concurrency: int
    max_queued_jobs: int
    # Paths
    store_dir: Path
    state_dir: Path
    #: Browser origins trusted besides localhost. Empty unless asked for.
    extra_origins: frozenset[str]
    # Files the MCP client may ask the service to read from disk
    read_roots: tuple[Path, ...] = field(default=())

    @property
    def audit_path(self) -> Path:
        return self.state_dir / "audit.jsonl"


def _dir(name: str, default: Path) -> Path:
    raw = env(name)
    path = (Path(raw).expanduser() if raw else default).resolve()
    path.mkdir(parents=True, exist_ok=True)
    return path


def load() -> Settings:
    home = Path.home() / ".cache" / "ifcviewx"
    store = _dir("MODELS", home / "models")
    roots = tuple(
        Path(p).expanduser().resolve()
        for p in (env("ROOTS") or "").split(os.pathsep)
        if p.strip()
    )
    port = int(_positive("PORT", 8765))
    if not 1 <= port <= 65535:
        port = 8765
    return Settings(
        # 128 bits: the token is what stands between anything else on this
        # machine and code execution, so it must not be guessable.
        token=env("TOKEN") or secrets.token_hex(16),
        port=port,
        allow_python=_flag("ALLOW_PYTHON", True),
        readonly=_flag("READONLY", False),
        python_timeout_s=_positive("PYTHON_TIMEOUT", 120, maximum=604_800),
        convert_timeout_s=_positive("CONVERT_TIMEOUT", 900, maximum=604_800),
        analyze_timeout_s=_positive("ANALYZE_TIMEOUT", 300, maximum=604_800),
        memory_bytes=max(
            64 * 1024**2,
            int(_positive("MEMORY_GB", 4, maximum=1024) * 1024**3),
        ),
        max_upload_bytes=max(
            1,
            int(_positive("MAX_UPLOAD_MB", 2048, maximum=1_000_000) * 1024**2),
        ),
        store_quota_bytes=max(
            1,
            int(_positive("STORE_GB", 20, maximum=1_000_000) * 1024**3),
        ),
        result_ttl_s=_positive("RESULT_TTL_S", 3600, zero=True, maximum=31_536_000),
        max_output_chars=max(
            1024,
            int(_positive("MAX_OUTPUT_CHARS", 200_000, maximum=10_000_000)),
        ),
        provider_timeout_s=_positive("PROVIDER_TIMEOUT", 900, maximum=604_800),
        job_ttl_s=_positive("JOB_TTL_S", 86_400, zero=True, maximum=31_536_000),
        job_concurrency=max(1, min(int(_positive("JOB_CONCURRENCY", 4)), 32)),
        max_queued_jobs=max(1, min(int(_positive("JOB_QUEUE", 64)), 1024)),
        store_dir=store,
        state_dir=_dir("STATE", store.parent),
        extra_origins=_origins(),
        read_roots=roots,
    )


_settings: Settings | None = None


def settings() -> Settings:
    """Process-wide settings; loaded on first use."""
    global _settings
    if _settings is None:
        _settings = load()
    return _settings


def reset(new: Settings | None = None) -> None:
    """Test hook: replace or clear the cached settings."""
    global _settings
    _settings = new
