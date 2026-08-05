"""Runtime configuration, read once from the environment.

Every tunable and every security posture flag lives here so the rest of the
service never reads os.environ directly and the startup banner can print the
posture it actually runs with.
"""

from __future__ import annotations

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
        return float(env(name) or default)
    except ValueError:
        return default


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
    path = Path(raw).expanduser() if raw else default
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
    return Settings(
        # 128 bits: the token is what stands between anything else on this
        # machine and code execution, so it must not be guessable.
        token=env("TOKEN") or secrets.token_hex(16),
        port=int(_num("PORT", 8765)),
        allow_python=_flag("ALLOW_PYTHON", True),
        readonly=_flag("READONLY", False),
        python_timeout_s=_num("PYTHON_TIMEOUT", 120),
        convert_timeout_s=_num("CONVERT_TIMEOUT", 900),
        analyze_timeout_s=_num("ANALYZE_TIMEOUT", 300),
        memory_bytes=int(_num("MEMORY_GB", 4) * 1024**3),
        max_upload_bytes=int(_num("MAX_UPLOAD_MB", 2048) * 1024**2),
        store_quota_bytes=int(_num("STORE_GB", 20) * 1024**3),
        result_ttl_s=_num("RESULT_TTL_S", 3600),
        max_output_chars=int(_num("MAX_OUTPUT_CHARS", 200_000)),
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
