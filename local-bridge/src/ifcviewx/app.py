"""Local HTTP + WebSocket service (127.0.0.1 only).

Serves the viewer app, converts IFC to the .ifcx format with IfcOpenShell,
runs guarded Python natively, answers model questions without code, and
carries MCP tool calls to the browser.

Security model
- bound to 127.0.0.1, never 0.0.0.0
- the Host header must be localhost, which blocks DNS rebinding that a token
  check alone would not
- browser origins must be localhost: the only page this service answers is the
  copy of the viewer it served itself, so no web page on the internet is
  trusted (IFCVIEWX_ORIGINS adds one deliberately, and is empty by default)
- the same host and origin rules are repeated on the websocket route, which no
  HTTP middleware ever sees
- a 128-bit per-run session token gates every route that writes, executes or
  reveals machine state; comparisons are constant time and repeated failures
  are throttled per client
- uploads are content-addressed and sniffed, the store is capped, edit results
  expire, and every guarded action is written to an append-only audit log
- conversion, validation and generated code each run in a killable subprocess
  with their own resource limits
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import subprocess
import sys
import threading
import time
import uuid
from importlib.util import find_spec
from pathlib import Path

from fastapi import FastAPI, File, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse

from . import audit, llm, store
from ._version import installed_version
from .config import settings
from .convert import cache_valid, is_valid_ifcx
from .guard import guard_code
from .http_browser import _app_root as _app_root
from .http_browser import _inject_token as _inject_token
from .http_browser import register_browser_routes
from .http_security import HttpSecurity
from .provider_jobs import JobRequestError, ProviderJobManager
from .providers import PROTOCOL_MAX, PROTOCOL_MIN, ProviderRegistry
from .sandbox import run as run_job
from .ws import BrowserHub

UPLOAD_CHUNK = 4 * 1024 * 1024
_results: dict[str, Path] = {}


def reset_state() -> None:
    """Drop process-local edit result references between tests."""
    _results.clear()


def _version() -> str:
    return installed_version() or "dev"


def _capabilities() -> list[str]:
    config = settings()
    caps = ["mcp", "models"]
    if find_spec("ifcopenshell") is not None:
        if not config.readonly:
            caps.append("convert")
        caps.append("inspect")
        if config.allow_python:
            caps.append("python")
    if llm.configured():
        caps.append("llm")
    return caps


def _prune() -> None:
    """Drop edit result references whose files have expired."""
    for result_id, path in list(_results.items()):
        if not path.is_file():
            _results.pop(result_id, None)


def _legacy_job(manager: ProviderJobManager, job: dict) -> dict:
    status = job.get("status")
    progress = job.get("progress") or {}
    total = float(progress.get("total") or 0)
    percent = round(float(progress.get("done") or 0) * 100 / total) if total > 0 else 0
    body = {
        "jobId": job["id"],
        "status": {
            "succeeded": "done",
            "failed": "error",
        }.get(status, status),
        "percent": percent,
        "phase": progress.get("phase"),
        "message": progress.get("message"),
    }
    if status == "succeeded":
        state, result = manager.result(job["id"])
        if state == "ok" and isinstance(result, dict) and isinstance(result.get("value"), dict):
            body.update(result["value"])
    elif status in {"failed", "cancelled"}:
        error = job.get("error") or {}
        body["error"] = error.get("message") or error.get("code") or "job failed"
        body["errorCode"] = error.get("code")
    return body


def _legacy_outcome(manager: ProviderJobManager, job: dict) -> dict:
    if job.get("status") == "succeeded":
        state, result = manager.result(job["id"])
        if state == "ok" and isinstance(result, dict) and isinstance(result.get("value"), dict):
            return result["value"]
        return {"error": "result_expired", "message": "the provider result expired"}
    error = job.get("error") or {}
    details = error.get("details") if isinstance(error.get("details"), dict) else {}
    return {
        **details,
        "error": error.get("code") or job.get("status") or "provider_failed",
        "message": error.get("message") or "provider job failed",
    }


async def _run_core_job(
    manager: ProviderJobManager,
    capability: str,
    inputs: dict,
    model_sha: object,
    timeout_s: float,
) -> tuple[dict, dict]:
    job = manager.submit("org.ifcviewx.core", "*", capability, inputs, model_sha)
    finished = await asyncio.to_thread(manager.wait, job["id"], timeout_s + 5)
    current = finished or job
    return current, _legacy_outcome(manager, current)


def create_app(hub: BrowserHub) -> FastAPI:
    config = settings()
    app = FastAPI(title="ifcviewx", docs_url=None, redoc_url=None, openapi_url=None)
    app_root = _app_root()
    app.state.app_root = app_root
    providers = ProviderRegistry.discover()
    provider_jobs = ProviderJobManager(providers)
    app.state.providers = providers
    app.state.provider_jobs = provider_jobs

    security = HttpSecurity(hub.token)
    app.middleware("http")(security.middleware)

    # -- discovery ----------------------------------------------------------
    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        """Feature detection. Machine details need the token."""
        body = {
            "service": "ifcviewx",
            "version": _version(),
            "app": app_root is not None,
            "capabilities": _capabilities(),
            "providerApi": {"min": PROTOCOL_MIN, "max": PROTOCOL_MAX},
            "pythonTimeoutS": config.python_timeout_s,
            "readonly": config.readonly,
            "pythonEnabled": config.allow_python,
        }
        if security.authorized(request):
            body["store"] = store.stats()
            body["llm"] = llm.describe()
            body["browserConnected"] = hub.connected()
            # The viewer prints these verbatim in its privacy panel, so they
            # come from the running config rather than from a convention the
            # page would have to guess at and could get wrong.
            body["paths"] = {
                "store": str(config.store_dir),
                "state": str(config.state_dir),
                "audit": str(config.audit_path),
                "keySource": (
                    "The assistant key is read from IFCVIEWX_LLM_API_KEY in this"
                    " service's environment. It is never written to disk and"
                    " never sent to the page."
                ),
            }
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

    # -- native provider protocol ------------------------------------------
    @app.get("/api/v1/providers")
    async def provider_listing() -> JSONResponse:
        return JSONResponse(providers.listing(), headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/jobs")
    async def provider_job_start(request: Request) -> JSONResponse:
        body = await _json(request)
        allowed = {"providerId", "providerVersion", "capabilityId", "modelSha", "input"}
        extra = sorted(set(body) - allowed)
        if extra:
            return JSONResponse(
                {"error": "bad_request", "message": f"unknown fields: {', '.join(extra)}"},
                status_code=400,
            )
        required = ("providerId", "providerVersion", "capabilityId")
        if any(not isinstance(body.get(name), str) or not body[name].strip() for name in required):
            return JSONResponse(
                {"error": "bad_request", "message": "providerId, providerVersion and capabilityId are required"},
                status_code=400,
            )
        try:
            job = provider_jobs.submit(
                body["providerId"],
                body["providerVersion"],
                body["capabilityId"],
                body.get("input", {}),
                body.get("modelSha"),
            )
        except JobRequestError as exc:
            return JSONResponse(
                {"error": exc.code, "message": exc.message},
                status_code=exc.status_code,
            )
        return JSONResponse(job, status_code=202, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/jobs/{job_id}")
    async def provider_job_status(job_id: str) -> JSONResponse:
        job = provider_jobs.get(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        return JSONResponse(job, headers={"Cache-Control": "no-store"})

    @app.post("/api/v1/jobs/{job_id}/cancel")
    async def provider_job_cancel(job_id: str) -> JSONResponse:
        job = provider_jobs.cancel(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        return JSONResponse(job, headers={"Cache-Control": "no-store"})

    @app.get("/api/v1/jobs/{job_id}/result")
    async def provider_job_result(job_id: str) -> JSONResponse:
        state, result = provider_jobs.result(job_id)
        if state == "unknown":
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        if state == "expired":
            return JSONResponse(
                {"error": "result_expired", "message": "the provider result has expired"},
                status_code=410,
            )
        if state == "not_ready":
            return JSONResponse(
                {"error": "result_not_ready", "status": result.get("status") if result else "unknown"},
                status_code=409,
            )
        return JSONResponse(result, headers={"Cache-Control": "no-store"})

    # -- model store --------------------------------------------------------
    @app.post("/model")
    async def upload_model(file: UploadFile = File(...)) -> JSONResponse:
        """Store an IFC by content hash. Returns what already exists for it."""
        if config.readonly:
            return JSONResponse({"error": "readonly"}, status_code=403)
        digest = hashlib.sha256()
        staging = store.models_dir() / f"upload-{uuid.uuid4().hex}.part"
        size = 0
        head = b""
        try:
            with staging.open("wb") as out:
                while chunk := await file.read(UPLOAD_CHUNK):
                    if not head:
                        head = chunk[: store.SNIFF_BYTES]
                        if not store.looks_like_ifc(head):
                            raise store.StoreError("not_ifc", "this file is not an IFC (STEP) document")
                    projected = size + len(chunk)
                    store.require_space(projected, written=size)
                    size = projected
                    digest.update(chunk)
                    out.write(chunk)
                if size == 0:
                    raise store.StoreError("not_ifc", "this file is empty")
        except store.StoreError as exc:
            staging.unlink(missing_ok=True)
            code = 413 if exc.code == "too_large" else 400
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=code)
        except OSError as exc:
            staging.unlink(missing_ok=True)
            return JSONResponse({"error": "write_failed", "message": str(exc)}, status_code=507)

        sha = digest.hexdigest()
        source = store.source_path(sha)
        try:
            # Publish even over an existing target while holding the store
            # lock. Checking first could race eviction and recreate an empty
            # source after discarding this valid staging file.
            store.commit_staging(staging, source, keep={sha})
        except store.StoreError as exc:
            staging.unlink(missing_ok=True)
            return JSONResponse(
                {"error": exc.code, "message": exc.message},
                status_code=507,
            )
        except OSError as exc:
            staging.unlink(missing_ok=True)
            return JSONResponse(
                {"error": "write_failed", "message": str(exc)},
                status_code=507,
            )
        audit.record("model.upload", sha=sha[:12], bytes=size, name=file.filename)
        store.sweep(keep={sha})
        return JSONResponse(
            {
                "sha": sha,
                "bytes": size,
                "converted": cache_valid(store.converted_path(sha)),
                "url": f"/models/{sha}.ifcx",
            }
        )

    @app.get("/store")
    async def store_stats() -> JSONResponse:
        return JSONResponse(store.stats(), headers={"Cache-Control": "no-store"})

    @app.post("/store/prune")
    async def store_prune(request: Request) -> JSONResponse:
        if config.readonly:
            return JSONResponse({"error": "readonly"}, status_code=403)
        body = await _json(request)
        keep = {str(s) for s in (body.get("keep") or []) if store.is_sha(str(s))}
        result = store.sweep(keep=keep)
        audit.record("store.prune", **result)
        return JSONResponse(result)

    @app.post("/store/reveal")
    async def store_reveal(request: Request) -> JSONResponse:
        """Show one of this service's own folders in the file manager.

        Deliberately not a general "open this path" call: the body picks one of
        two directories this service already owns, and nothing else is
        reachable. The privacy panel is worth little if the user cannot go and
        look at what it is describing.
        """
        body = await _json(request)
        which = str(body.get("which") or "")
        target = {"store": config.store_dir, "state": config.state_dir}.get(which)
        if target is None:
            return JSONResponse({"error": "bad_request", "message": "which must be store or state"}, status_code=400)
        try:
            if sys.platform == "win32":
                os.startfile(target)  # noqa: S606 - a directory this service made
            else:
                opener = "open" if sys.platform == "darwin" else "xdg-open"
                subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                    [opener, str(target)],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
        except Exception as exc:  # noqa: BLE001 - a headless box has no file manager
            return JSONResponse({"error": "no_opener", "message": str(exc)}, status_code=501)
        audit.record("store.reveal", which=which)
        return JSONResponse({"ok": True, "path": str(target)})

    @app.get("/models/{name}")
    async def serve_model(name: str) -> Response:
        stem, _, suffix = name.partition(".")
        if suffix not in {"ifcx", "ifc"} or not store.is_sha(stem):
            return JSONResponse({"error": "unknown_model"}, status_code=404)
        target = store.models_dir() / name
        if not target.is_file():
            return JSONResponse({"error": "unknown_model"}, status_code=404)
        if suffix == "ifcx":
            source_backed = store.source_path(stem).is_file()
            valid = cache_valid(target) if source_backed else is_valid_ifcx(target)
            if not valid:
                return JSONResponse({"error": "invalid_model"}, status_code=404)
        # A 256-bit name is the capability; the middleware already vetted the origin.
        return FileResponse(
            target,
            media_type="application/octet-stream",
            headers={
                "Cache-Control": "public, max-age=31536000, immutable",
                "Cross-Origin-Resource-Policy": "cross-origin",
            },
        )

    # -- conversion ---------------------------------------------------------
    @app.post("/convert")
    async def convert_model(request: Request) -> JSONResponse:
        if config.readonly:
            return JSONResponse({"error": "readonly"}, status_code=403)
        if find_spec("ifcopenshell") is None:
            return JSONResponse({"error": "no_ifcopenshell"}, status_code=501)
        body = await _json(request)
        sha = str(body.get("sha", ""))
        if store.is_sha(sha) and cache_valid(store.converted_path(sha)):
            return JSONResponse({"status": "done", "percent": 100, "url": f"/models/{sha}.ifcx"})
        try:
            job = provider_jobs.submit(
                "org.ifcviewx.core",
                "*",
                "ifc.convert",
                {},
                sha,
            )
        except JobRequestError as exc:
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status_code)
        return JSONResponse(_legacy_job(provider_jobs, job))

    @app.get("/jobs/{job_id}")
    async def job_status(job_id: str) -> JSONResponse:
        job = provider_jobs.get(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        return JSONResponse(_legacy_job(provider_jobs, job), headers={"Cache-Control": "no-store"})

    @app.post("/jobs/{job_id}/cancel")
    async def job_cancel(job_id: str) -> JSONResponse:
        job = provider_jobs.cancel(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        return JSONResponse(_legacy_job(provider_jobs, job))

    # -- native execution ---------------------------------------------------
    @app.post("/python")
    async def python_endpoint(request: Request) -> JSONResponse:
        """Run guarded IfcOpenShell code natively, for the viewer's Python Console."""
        if not config.allow_python:
            return JSONResponse(
                {"error": "python_disabled", "message": "code execution is disabled on this service"},
                status_code=403,
            )
        body = await _json(request)
        code = str(body.get("code", ""))
        mode = "edit" if body.get("mode") == "edit" else "query"
        try:
            current, outcome = await _run_core_job(
                provider_jobs,
                f"ifc.python.{mode}",
                {"code": code},
                body.get("sha"),
                config.provider_timeout_s,
            )
        except JobRequestError as exc:
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status_code)
        audit.record(
            "python.run",
            sha=str(body.get("sha", ""))[:12],
            mode=mode,
            outcome=outcome.get("error", "ok"),
            elapsedMs=current.get("elapsedMs"),
            changed=outcome.get("diff", {}).get("modified") if isinstance(outcome.get("diff"), dict) else None,
            code=audit.code_fingerprint(code),
        )
        return JSONResponse(outcome)

    @app.get("/python/result/{result_id}")
    async def python_result(result_id: str) -> Response:
        try:
            target = store.result_path(result_id)
        except store.StoreError:
            return JSONResponse({"error": "unknown_result"}, status_code=404)
        if not target.is_file() or time.time() - target.stat().st_mtime > config.result_ttl_s:
            return JSONResponse({"error": "unknown_result"}, status_code=404)
        return FileResponse(target, media_type="application/octet-stream")

    @app.post("/guard")
    async def guard_endpoint(request: Request) -> JSONResponse:
        body = await _json(request)
        violations = guard_code(str(body.get("code", "")), body.get("mode") == "edit")
        return JSONResponse({"ok": not violations, "violations": violations})

    # -- analysis without code ---------------------------------------------
    @app.post("/validate")
    async def validate_endpoint(request: Request) -> JSONResponse:
        body = await _json(request)
        try:
            _, outcome = await _run_core_job(
                provider_jobs,
                "ifc.validate",
                {},
                body.get("sha"),
                config.provider_timeout_s,
            )
        except JobRequestError as exc:
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status_code)
        return JSONResponse(outcome)

    @app.post("/schedule")
    async def schedule_endpoint(request: Request) -> JSONResponse:
        body = await _json(request)
        inputs = {
            key: value
            for key, value in {
                "type": body.get("type"),
                "properties": body.get("properties") or [],
                "limit": body.get("limit"),
            }.items()
            if value is not None
        }
        try:
            _, outcome = await _run_core_job(
                provider_jobs,
                "ifc.schedule",
                inputs,
                body.get("sha"),
                config.provider_timeout_s,
            )
        except JobRequestError as exc:
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=exc.status_code)
        return JSONResponse(outcome)

    # -- assistant proxy ----------------------------------------------------
    @app.post("/llm/chat")
    async def llm_chat(request: Request) -> JSONResponse:
        body = await _json(request)
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return JSONResponse({"error": "bad_request", "message": "messages required"}, status_code=400)
        tools = body.get("tools")
        if isinstance(tools, list):
            outcome = await asyncio.to_thread(llm.chat_turn, messages, tools, body.get("model"))
        else:
            outcome = await asyncio.to_thread(llm.chat, messages, body.get("model"))
        audit.record(
            "llm.chat",
            turns=len(messages),
            tools=len(tools) if isinstance(tools, list) else 0,
            imageAttached=any(isinstance(message, dict) and "image" in message for message in messages),
            outcome=outcome.get("error", "ok"),
        )
        return JSONResponse(outcome)

    @app.post("/llm/stream")
    async def llm_stream(request: Request) -> Response:
        body = await _json(request)
        messages = body.get("messages")
        tools = body.get("tools") or []
        if not isinstance(messages, list) or not messages:
            return JSONResponse({"error": "bad_request", "message": "messages required"}, status_code=400)
        if not isinstance(tools, list):
            return JSONResponse({"error": "bad_request", "message": "tools must be an array"}, status_code=400)
        image_attached = any(isinstance(message, dict) and "image" in message for message in messages)
        audit.record(
            "llm.stream",
            turns=len(messages),
            tools=len(tools),
            imageAttached=image_attached,
        )

        def events():
            for event in llm.stream_chat(messages, tools, body.get("model")):
                yield f"data: {json.dumps(event, separators=(',', ':'))}\n\n"

        return StreamingResponse(
            events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
        )

    @app.get("/audit")
    async def audit_tail(limit: int = 50) -> JSONResponse:
        return JSONResponse({"entries": audit.tail(limit)}, headers={"Cache-Control": "no-store"})

    register_browser_routes(app, hub, app_root, config.port)
    return app


def execute_python(sha: str, code: str, mode: str) -> dict:
    """Run guarded code against a stored model. Blocking; shared by HTTP and MCP.

    An `edit` never touches the stored source: it writes a separate result file
    that the user still has to apply in the viewer.
    """
    config = settings()
    if not config.allow_python:
        return {"error": "python_disabled", "message": "code execution is disabled on this service"}
    if mode == "edit" and config.readonly:
        return {"error": "readonly", "message": "this service is running read-only"}
    source = _source_or_none(sha)
    if source is None:
        return {"error": "unknown_model", "message": "the service does not hold that model"}

    _prune()
    result_id = uuid.uuid4().hex
    out_path = store.result_path(result_id) if mode == "edit" else None
    staging = (
        out_path.with_name(f"{out_path.name}.{uuid.uuid4().hex}.part")
        if out_path
        else None
    )
    payload = {
        "model": str(source),
        "code": code,
        "mode": mode,
        "maxOutputChars": config.max_output_chars,
        "out": str(staging) if staging else None,
    }
    started = time.time()
    try:
        outcome = run_job("python", payload, config.python_timeout_s, config.memory_bytes)
        if "error" not in outcome and out_path and staging and staging.is_file():
            try:
                store.commit_staging(staging, out_path, keep={sha})
            except store.StoreError as exc:
                outcome = {"error": exc.code, "message": exc.message}
            else:
                _results[result_id] = out_path
                outcome["resultId"] = result_id
                outcome["resultUrl"] = f"/python/result/{result_id}"
    finally:
        if staging:
            staging.unlink(missing_ok=True)
    audit.record(
        "python.run",
        sha=sha[:12],
        mode=mode,
        outcome=outcome.get("error", "ok"),
        elapsedMs=round((time.time() - started) * 1000),
        changed=outcome.get("diff", {}).get("modified") if "diff" in outcome else None,
        code=audit.code_fingerprint(code),
    )
    return outcome


def analyze(kind: str, sha: str, **payload) -> dict:
    """Run a read-only analysis job (validate / schedule) on a stored model."""
    config = settings()
    source = _source_or_none(sha)
    if source is None:
        return {"error": "unknown_model", "message": "the service does not hold that model"}
    outcome = run_job(
        kind, {"model": str(source), **payload}, config.analyze_timeout_s, config.memory_bytes
    )
    audit.record(f"model.{kind}", sha=sha[:12], outcome=outcome.get("error", "ok"))
    return outcome


def _source_or_none(sha: str) -> Path | None:
    if not store.is_sha(sha):
        return None
    source = store.source_path(sha)
    return source if source.is_file() else None


async def _json(request: Request) -> dict:
    try:
        body = await request.json()
    except (ValueError, UnicodeDecodeError):
        return {}
    return body if isinstance(body, dict) else {}


def serve(hub: BrowserHub, port: int) -> threading.Thread:
    """Run uvicorn on a daemon thread and return once it is accepting."""
    import uvicorn

    store.sweep()
    app = create_app(hub)
    uv = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning", access_log=False)
    server = uvicorn.Server(uv)
    server.install_signal_handlers = lambda: None

    def _run() -> None:
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        hub.bind_loop(loop)
        loop.run_until_complete(server.serve())

    thread = threading.Thread(target=_run, daemon=True, name="ifc-bridge-http")
    thread.start()
    deadline = time.time() + 15
    while time.time() < deadline:
        if server.started:
            audit.record("service.start", port=port, capabilities=_capabilities())
            return thread
        time.sleep(0.05)
    raise RuntimeError("HTTP service failed to start within 15s")
