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
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import uuid
from importlib import metadata
from importlib.util import find_spec
from pathlib import Path
from urllib.parse import urlsplit

from fastapi import FastAPI, File, Request, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response

from . import audit, llm, store
from .config import settings
from .guard import guard_code
from .sandbox import child_env
from .sandbox import run as run_job
from .ws import BrowserHub

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
# The hosted build is served from /<repo>/; strip it so one build serves both.
BASE_PREFIX = "/ifc-viewx"
UPLOAD_CHUNK = 4 * 1024 * 1024
#: Paths that require the session token: everything that writes, executes, or
#: describes this machine. Matched exactly or by prefix so /models (public,
#: content-addressed reads) is never caught by /model.
GUARDED_EXACT = {"/model", "/convert", "/python", "/guard", "/validate", "/schedule", "/store", "/audit"}
GUARDED_PREFIX = ("/python/", "/jobs/", "/store/", "/llm/")
AUTH_FAIL_LIMIT = 5
AUTH_LOCK_S = 30.0
#: The token is 128 bits, so the throttle only has to be a speed bump. Capping
#: it stops a flood of wrong tokens from locking the real viewer out for hours.
AUTH_LOCK_MAX_S = 60.0
AUTH_CLIENTS_MAX = 256
#: Marks a response the middleware must not make cross-origin readable.
NO_CORS_MARK = "x-ifc-no-cors"
JOB_TTL_S = 3600.0
TERMINAL_STATUS = {"done", "error", "cancelled"}

_jobs: dict[str, dict] = {}
_procs: dict[str, subprocess.Popen] = {}
_jobs_lock = threading.Lock()
_results: dict[str, Path] = {}


def reset_state() -> None:
    """Drop conversion jobs and edit results. Used between tests."""
    with _jobs_lock:
        _jobs.clear()
    _procs.clear()
    _results.clear()


def _needs_token(path: str) -> bool:
    return path in GUARDED_EXACT or path.startswith(GUARDED_PREFIX)


def _version() -> str:
    try:
        return metadata.version("ifcviewx")
    except metadata.PackageNotFoundError:
        return "dev"


def _host_ok(host: str) -> bool:
    hostname = host.strip()
    if hostname.startswith("["):
        hostname = hostname[1:].partition("]")[0]
    else:
        hostname = hostname.partition(":")[0]
    return hostname.lower() in LOCAL_HOSTS


def _origin_ok(origin: str | None) -> bool:
    """Loopback only. Local Studio and Web Studio are separate apps that never
    talk, so a page from anywhere else has no business here."""
    if origin is None:
        return True  # non-browser client; the token still gates everything
    value = origin.strip().lower()
    if urlsplit(value).hostname in LOCAL_HOSTS:
        return True
    return value.rstrip("/") in settings().extra_origins


def _same_origin(origin: str | None) -> bool:
    """True only for the app this service served. A top-level navigation sends
    no Origin; anything else is another site asking on its own behalf."""
    if origin is None:
        return True
    return urlsplit(origin.strip().lower()).hostname in LOCAL_HOSTS


def _capabilities() -> list[str]:
    config = settings()
    caps = ["mcp", "models"]
    if find_spec("ifcopenshell") is not None:
        caps.append("convert")
        caps.append("inspect")
        if config.allow_python:
            caps.append("python")
    if llm.configured():
        caps.append("llm")
    return caps


def _app_root() -> Path | None:
    """The built viewer: an override, a checkout's dist/, or the packaged copy."""
    from .config import env

    override = env("APP")
    if override and (Path(override) / "index.html").is_file():
        return Path(override).resolve()
    repo_dist = Path(__file__).resolve().parents[3] / "dist"
    if (repo_dist / "index.html").is_file():
        return repo_dist
    packaged = (Path(__file__).parent / "app").resolve()
    if (packaged / "index.html").is_file():
        return packaged
    return None


def _set_job(job_id: str, **fields) -> None:
    with _jobs_lock:
        job = _jobs.setdefault(job_id, {})
        job.update(fields)
        if fields.get("status") in TERMINAL_STATUS:
            job["finishedAt"] = time.time()


def _get_job(job_id: str) -> dict | None:
    with _jobs_lock:
        job = _jobs.get(job_id)
        return dict(job) if job else None


def _job_for_sha(sha: str) -> str | None:
    """The conversion already running for this model, if there is one."""
    with _jobs_lock:
        for job_id, job in _jobs.items():
            if job.get("sha") == sha and job.get("status") not in TERMINAL_STATUS:
                return job_id
    return None


def _prune() -> None:
    """Drop long-finished jobs and results whose file the store already swept.

    A job is kept until well after it finishes so the browser can still read
    its final status; nothing running is ever removed.
    """
    cutoff = time.time() - JOB_TTL_S
    with _jobs_lock:
        for job_id in [j for j, job in _jobs.items() if 0 < job.get("finishedAt", 0) < cutoff]:
            del _jobs[job_id]
    for result_id, path in list(_results.items()):
        if not path.is_file():
            _results.pop(result_id, None)


def _convert_worker(job_id: str, source: Path, sha: str) -> None:
    """Convert in a subprocess so a hostile file cannot wedge the service."""
    config = settings()
    target = store.converted_path(sha)
    staging = target.with_suffix(".ifcx.part")
    started = time.time()
    _set_job(job_id, status="running", startedAt=started, percent=0)
    # stderr goes to a file rather than a pipe: nothing drains a second pipe
    # while the loop below reads progress from stdout, and a chatty geometry
    # kernel filling that pipe would stop the child dead.
    with tempfile.TemporaryFile(mode="w+", encoding="utf-8", errors="replace") as errors:
        try:
            process = subprocess.Popen(  # noqa: S603 - fixed argv, no shell
                [
                    sys.executable,
                    "-B",
                    "-m",
                    "ifcviewx.convert",
                    str(source),
                    "-o",
                    str(staging),
                    "--progress",
                ],
                stdout=subprocess.PIPE,
                stderr=errors,
                text=True,
                env=child_env(),
            )
        except OSError as exc:
            _set_job(job_id, status="error", error=str(exc))
            return

        _procs[job_id] = process
        expired = threading.Event()

        def _expire() -> None:
            expired.set()
            process.kill()

        # Armed here instead of waited on below: the drain only ends when the
        # child exits, so a converter that hangs mid-geometry would never reach
        # a wait(timeout=...) and the deadline would never be enforced.
        watchdog = threading.Timer(config.convert_timeout_s, _expire)
        watchdog.daemon = True
        watchdog.start()
        try:
            assert process.stdout is not None
            for line in process.stdout:
                try:
                    update = json.loads(line)
                except ValueError:
                    continue
                _set_job(job_id, percent=update.get("percent", 0), meshes=update.get("meshes", 0))
            process.wait()
        finally:
            watchdog.cancel()
            _procs.pop(job_id, None)

        if expired.is_set():
            staging.unlink(missing_ok=True)
            _set_job(
                job_id,
                status="error",
                error=f"conversion exceeded {config.convert_timeout_s:.0f}s",
            )
            audit.record("convert.failed", sha=sha[:12], reason="timeout")
            return
        if (_get_job(job_id) or {}).get("status") == "cancelled":
            staging.unlink(missing_ok=True)
            return
        if process.returncode != 0 or not staging.is_file():
            staging.unlink(missing_ok=True)
            errors.seek(0)
            detail = errors.read().strip().splitlines()
            _set_job(job_id, status="error", error=detail[-1] if detail else "conversion failed")
            audit.record("convert.failed", sha=sha[:12])
            return

    staging.replace(target)
    elapsed = round((time.time() - started) * 1000)
    _set_job(
        job_id,
        status="done",
        percent=100,
        url=f"/models/{sha}.ifcx",
        bytes=target.stat().st_size,
        elapsedMs=elapsed,
    )
    audit.record("convert.done", sha=sha[:12], bytes=target.stat().st_size, elapsedMs=elapsed)
    store.sweep(keep={sha})


def create_app(hub: BrowserHub) -> FastAPI:
    config = settings()
    app = FastAPI(title="ifcviewx", docs_url=None, redoc_url=None, openapi_url=None)
    app_root = _app_root()
    app.state.app_root = app_root

    # Per-service, so a wrong token slows that client down without leaking
    # state between services in the same process.
    auth_fails: dict[str, tuple[int, float]] = {}

    def authorized(request: Request) -> bool:
        supplied = request.headers.get("x-ifc-token") or ""
        # Bytes, not str: compare_digest rejects non-ASCII str, and headers are
        # decoded as latin-1, so one high byte would otherwise raise in here.
        return secrets.compare_digest(supplied.encode(), hub.token.encode())

    def throttled(client: str) -> float:
        fails, until = auth_fails.get(client, (0, 0.0))
        if fails < AUTH_FAIL_LIMIT:
            return 0.0
        wait = until - time.time()
        if wait <= 0:
            auth_fails.pop(client, None)  # lock served: start clean, never ratchet
            return 0.0
        return wait

    def note_auth(client: str, ok: bool) -> None:
        if ok:
            auth_fails.pop(client, None)
            return
        fails, _ = auth_fails.get(client, (0, 0.0))
        fails += 1
        if len(auth_fails) > AUTH_CLIENTS_MAX:
            auth_fails.clear()
        lock = min(AUTH_LOCK_S * max(1, fails - AUTH_FAIL_LIMIT + 1), AUTH_LOCK_MAX_S)
        auth_fails[client] = (fails, time.time() + lock)

    @app.middleware("http")
    async def security(request: Request, call_next):
        if not _host_ok(request.headers.get("host", "")):
            return JSONResponse({"error": "forbidden_host"}, status_code=403)
        origin = request.headers.get("origin")
        if not _origin_ok(origin):
            audit.record("auth.origin_rejected", origin=origin)
            return JSONResponse({"error": "forbidden_origin"}, status_code=403)

        if request.method == "OPTIONS":
            response: Response = Response(status_code=204)
        elif _needs_token(request.url.path):
            # Keyed by peer and origin: everything reaches this service as
            # 127.0.0.1, so a bare peer key lets any page spend the viewer's
            # own budget and lock the user out of their own Local Studio.
            peer = request.client.host if request.client else "?"
            client = f"{peer}|{origin or '-'}"
            wait = throttled(client)
            if wait > 0:
                response = JSONResponse(
                    {"error": "too_many_attempts", "retryAfterS": round(wait, 1)},
                    status_code=429,
                )
            else:
                # Checked here so an unauthorized caller never reaches body parsing.
                ok = authorized(request)
                note_auth(client, ok)
                if not ok:
                    audit.record("auth.rejected", path=request.url.path, client=client)
                    response = JSONResponse({"error": "unauthorized"}, status_code=401)
                else:
                    response = await call_next(request)
        else:
            response = await call_next(request)

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        # The app shell carries the session token, so it must never be readable
        # by another site even though that site is allowed to talk to us.
        no_cors = NO_CORS_MARK in response.headers
        if no_cors:
            del response.headers[NO_CORS_MARK]
        if origin and not no_cors:
            response.headers["Access-Control-Allow-Origin"] = origin
            response.headers["Access-Control-Allow-Headers"] = "content-type, x-ifc-token"
            response.headers["Access-Control-Allow-Methods"] = "GET, POST, OPTIONS"
            response.headers["Access-Control-Max-Age"] = "600"
        response.headers["Vary"] = "Origin"
        return response

    # -- discovery ----------------------------------------------------------
    @app.get("/health")
    async def health(request: Request) -> JSONResponse:
        """Feature detection. Machine details need the token."""
        body = {
            "service": "ifcviewx",
            "version": _version(),
            "app": app_root is not None,
            "capabilities": _capabilities(),
            "pythonTimeoutS": config.python_timeout_s,
            "readonly": config.readonly,
            "pythonEnabled": config.allow_python,
        }
        if authorized(request):
            body["store"] = store.stats()
            body["llm"] = llm.describe()
            body["browserConnected"] = hub.connected()
        return JSONResponse(body, headers={"Cache-Control": "no-store"})

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
                    size += len(chunk)
                    if size > config.max_upload_bytes:
                        raise store.StoreError(
                            "too_large",
                            f"the upload exceeds {config.max_upload_bytes / 1e6:.0f} MB",
                        )
                    digest.update(chunk)
                    out.write(chunk)
                    if size % (64 * 1024 * 1024) == 0:
                        store.require_space(0)
        except store.StoreError as exc:
            staging.unlink(missing_ok=True)
            code = 413 if exc.code == "too_large" else 400
            return JSONResponse({"error": exc.code, "message": exc.message}, status_code=code)
        except OSError as exc:
            staging.unlink(missing_ok=True)
            return JSONResponse({"error": "write_failed", "message": str(exc)}, status_code=507)

        sha = digest.hexdigest()
        source = store.source_path(sha)
        if source.exists():
            staging.unlink(missing_ok=True)
            source.touch()
        else:
            staging.replace(source)
        audit.record("model.upload", sha=sha[:12], bytes=size, name=file.filename)
        store.sweep(keep={sha})
        return JSONResponse(
            {
                "sha": sha,
                "bytes": size,
                "converted": store.converted_path(sha).is_file(),
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

    @app.get("/models/{name}")
    async def serve_model(name: str) -> Response:
        stem, _, suffix = name.partition(".")
        if suffix not in {"ifcx", "ifc"} or not store.is_sha(stem):
            return JSONResponse({"error": "unknown_model"}, status_code=404)
        target = store.models_dir() / name
        if not target.is_file():
            return JSONResponse({"error": "unknown_model"}, status_code=404)
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
        if not store.is_sha(sha):
            return JSONResponse({"error": "bad_sha"}, status_code=400)
        source = store.source_path(sha)
        if not source.is_file():
            return JSONResponse({"error": "unknown_model"}, status_code=404)
        if store.converted_path(sha).is_file():
            return JSONResponse({"status": "done", "percent": 100, "url": f"/models/{sha}.ifcx"})
        _prune()
        # Two conversions of one model would write the same .ifcx.part, and the
        # loser's half-written file would be published under a cache key that is
        # never checked again. The second caller joins the first job instead.
        running = _job_for_sha(sha)
        if running:
            return JSONResponse({"jobId": running, "status": _get_job(running)["status"]})
        job_id = uuid.uuid4().hex
        _set_job(job_id, status="queued", sha=sha, percent=0)
        threading.Thread(
            target=_convert_worker, args=(job_id, source, sha), daemon=True, name=f"convert-{sha[:8]}"
        ).start()
        audit.record("convert.start", sha=sha[:12], jobId=job_id)
        return JSONResponse({"jobId": job_id, "status": "queued"})

    @app.get("/jobs/{job_id}")
    async def job_status(job_id: str) -> JSONResponse:
        job = _get_job(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        return JSONResponse(job, headers={"Cache-Control": "no-store"})

    @app.post("/jobs/{job_id}/cancel")
    async def job_cancel(job_id: str) -> JSONResponse:
        job = _get_job(job_id)
        if job is None:
            return JSONResponse({"error": "unknown_job"}, status_code=404)
        process = _procs.get(job_id)
        if process is not None and process.poll() is None:
            _set_job(job_id, status="cancelled")
            process.kill()
            audit.record("convert.cancelled", jobId=job_id)
            return JSONResponse({"status": "cancelled"})
        return JSONResponse({"status": job.get("status", "unknown")})

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
        sha = str(body.get("sha", ""))
        code = str(body.get("code", ""))
        mode = "edit" if body.get("mode") == "edit" else "query"
        if mode == "edit" and config.readonly:
            return JSONResponse({"error": "readonly"}, status_code=403)
        if not store.is_sha(sha):
            return JSONResponse({"error": "bad_sha"}, status_code=400)
        source = store.source_path(sha)
        if not source.is_file():
            return JSONResponse({"error": "unknown_model"}, status_code=404)

        outcome = await asyncio.to_thread(execute_python, sha, code, mode)
        return JSONResponse(outcome)

    @app.get("/python/result/{result_id}")
    async def python_result(result_id: str) -> Response:
        target = _results.get(result_id)
        if target is None or not target.is_file():
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
        outcome = await asyncio.to_thread(analyze, "validate", str(body.get("sha", "")))
        status = 404 if outcome.get("error") == "unknown_model" else 200
        return JSONResponse(outcome, status_code=status)

    @app.post("/schedule")
    async def schedule_endpoint(request: Request) -> JSONResponse:
        body = await _json(request)
        outcome = await asyncio.to_thread(
            analyze,
            "schedule",
            str(body.get("sha", "")),
            type=body.get("type"),
            properties=body.get("properties") or [],
            limit=body.get("limit"),
        )
        status = 404 if outcome.get("error") == "unknown_model" else 200
        return JSONResponse(outcome, status_code=status)

    # -- assistant proxy ----------------------------------------------------
    @app.post("/llm/chat")
    async def llm_chat(request: Request) -> JSONResponse:
        body = await _json(request)
        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            return JSONResponse({"error": "bad_request", "message": "messages required"}, status_code=400)
        outcome = await asyncio.to_thread(llm.chat, messages, body.get("model"))
        audit.record("llm.chat", turns=len(messages), outcome=outcome.get("error", "ok"))
        return JSONResponse(outcome)

    @app.get("/audit")
    async def audit_tail(limit: int = 50) -> JSONResponse:
        return JSONResponse({"entries": audit.tail(limit)}, headers={"Cache-Control": "no-store"})

    # -- browser bridge -----------------------------------------------------
    @app.websocket("/ws")
    async def bridge_socket(websocket: WebSocket) -> None:
        # The HTTP middleware does not run for websockets, so the host check
        # that blocks DNS rebinding has to be repeated here rather than assumed.
        if not _host_ok(websocket.headers.get("host", "")):
            audit.record("auth.ws_host_rejected")
            await websocket.close(code=4403)
            return
        if not _origin_ok(websocket.headers.get("origin")):
            audit.record("auth.ws_origin_rejected", origin=websocket.headers.get("origin"))
            await websocket.close(code=4403)
            return
        supplied = websocket.query_params.get("token") or ""
        if not secrets.compare_digest(supplied.encode(), hub.token.encode()):
            audit.record("auth.ws_rejected")
            await websocket.close(code=4401)
            return
        await websocket.accept()
        audit.record("bridge.connected", origin=websocket.headers.get("origin"))
        try:
            await hub.serve(websocket)
        except WebSocketDisconnect:
            pass
        finally:
            audit.record("bridge.disconnected")

    if app_root is not None:

        @app.get("/{path:path}")
        async def static_files(request: Request, path: str) -> Response:
            if path.startswith(BASE_PREFIX.lstrip("/")):
                path = path[len(BASE_PREFIX.lstrip("/")) :].lstrip("/")
            candidate = (app_root / path).resolve() if path else app_root / "index.html"
            if candidate.is_dir():
                candidate = candidate / "index.html"
            if not candidate.is_file() or not candidate.is_relative_to(app_root):
                candidate = app_root / "index.html"  # SPA fallback
            if candidate.name == "index.html":
                html = candidate.read_text(encoding="utf-8")
                # Only the app this service itself served is handed the token.
                # Every unguarded path falls back to this shell, so a site that
                # is merely allowed to call us must never read one out of it.
                if _same_origin(request.headers.get("origin")):
                    html = _inject_token(html, hub.token, config.port)
                return HTMLResponse(
                    html,
                    headers={
                        "Cache-Control": "no-cache",
                        "Content-Security-Policy": "frame-ancestors 'none'",
                        NO_CORS_MARK: "1",
                    },
                )
            # Hashed asset names are immutable. No COOP/COEP: cross-origin
            # isolation would switch web-ifc to a threaded build that cannot
            # boot from the bundled worker (see PLAN.md decision log).
            cacheable = "/assets/" in candidate.as_posix() or candidate.suffix == ".wasm"
            return FileResponse(
                candidate,
                headers={
                    "Cache-Control": "public, max-age=31536000, immutable" if cacheable else "no-cache",
                },
            )

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
    payload = {
        "model": str(source),
        "code": code,
        "mode": mode,
        "maxOutputChars": config.max_output_chars,
        "out": str(out_path) if out_path else None,
    }
    started = time.time()
    outcome = run_job("python", payload, config.python_timeout_s, config.memory_bytes)
    if mode == "edit" and "error" not in outcome and out_path and out_path.is_file():
        _results[result_id] = out_path
        outcome["resultId"] = result_id
        outcome["resultUrl"] = f"/python/result/{result_id}"
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


def _inject_token(html: str, token: str, port: int) -> str:
    """Hand the app this service served its session token, so Local Studio
    opens ready to work and no human ever handles the token."""
    marker = json.dumps({"token": token, "port": port, "served": True})
    tag = f"<script>window.__IFC_SERVICE__={marker};</script>"
    return html.replace("</head>", f"{tag}</head>", 1) if "</head>" in html else tag + html


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
