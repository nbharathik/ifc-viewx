"""Child process entry point for one trusted native provider invocation."""

from __future__ import annotations

import json
import sys
from contextlib import nullcontext
from typing import Any, Mapping

from . import store
from .providers import ProviderRegistry
from .sandbox import _apply_limits


def _send(kind: str, **payload: Any) -> None:
    print(json.dumps({"type": kind, **payload}, default=str), flush=True)


def _progress(value: Mapping[str, Any]) -> None:
    _send("progress", progress=dict(value))


def _main() -> None:
    request = json.loads(sys.stdin.read())
    _apply_limits(int(request["memoryBytes"]), float(request["timeoutSeconds"]))
    registry = ProviderRegistry.discover()
    record, _ = registry.resolve(
        str(request["providerId"]),
        f"={request['providerVersion']}",
        str(request["capabilityId"]),
    )
    sha = request.get("modelSha")
    context: dict[str, Any] = {"protocolVersion": 1, "modelSha": sha}
    with store.lease(str(sha)) if sha else nullcontext():
        # Resolve after the lease marker is published. If eviction won the
        # lock first we report absence; if leasing won, sweep must retain it.
        if sha:
            model_path = store.source_path(str(sha))
            if not model_path.is_file():
                _send("error", code="unknown_model", message="the service does not hold that model")
                return
            context["modelPath"] = str(model_path)
        returned = record.provider.run(
            str(request["capabilityId"]),
            context,
            dict(request.get("input") or {}),
            _progress,
        )
    result = dict(returned) if isinstance(returned, Mapping) else returned
    if isinstance(result, dict) and result.get("error"):
        _send(
            "error",
            code=str(result.pop("error")),
            message=str(result.pop("message", "provider failed")),
            details=result,
        )
    else:
        _send("result", value=result)


def main() -> None:
    try:
        _main()
    except MemoryError:
        _send("error", code="out_of_memory", message="the provider exhausted its memory limit")
    except Exception as exc:
        _send("error", code="provider_crashed", message=f"{type(exc).__name__}: {exc}")


if __name__ == "__main__":
    main()
