"""HTTP host, origin, token, throttle, and CORS policy."""

from __future__ import annotations

import secrets
import time
from urllib.parse import urlsplit

from fastapi import Request
from fastapi.responses import JSONResponse, Response

from . import audit
from .config import settings

LOCAL_HOSTS = {"127.0.0.1", "localhost", "::1"}
GUARDED_EXACT = {
    "/model",
    "/convert",
    "/python",
    "/guard",
    "/validate",
    "/schedule",
    "/store",
    "/audit",
}
GUARDED_PREFIX = ("/python/", "/jobs/", "/store/", "/llm/", "/api/")
AUTH_FAIL_LIMIT = 5
AUTH_LOCK_S = 30.0
AUTH_LOCK_MAX_S = 60.0
AUTH_CLIENTS_MAX = 256
NO_CORS_MARK = "x-ifc-no-cors"


def _needs_token(path: str) -> bool:
    return path in GUARDED_EXACT or path.startswith(GUARDED_PREFIX)


def _host_ok(host: str) -> bool:
    hostname = host.strip()
    if hostname.startswith("["):
        hostname = hostname[1:].partition("]")[0]
    else:
        hostname = hostname.partition(":")[0]
    return hostname.lower() in LOCAL_HOSTS


def _origin_ok(origin: str | None) -> bool:
    """Allow loopback and explicitly configured browser origins."""
    if origin is None:
        return True
    value = origin.strip().lower()
    if urlsplit(value).hostname in LOCAL_HOSTS:
        return True
    return value.rstrip("/") in settings().extra_origins


def _same_origin(origin: str | None) -> bool:
    """True only for the app served by this loopback service."""
    if origin is None:
        return True
    return urlsplit(origin.strip().lower()).hostname in LOCAL_HOSTS


class HttpSecurity:
    """Per-service policy state; failed-token budgets never leak across apps."""

    def __init__(self, token: str) -> None:
        self.token = token
        self._auth_fails: dict[str, tuple[int, float]] = {}

    def authorized(self, request: Request) -> bool:
        supplied = request.headers.get("x-ifc-token") or ""
        # compare_digest rejects non-ASCII str while headers are latin-1.
        return secrets.compare_digest(supplied.encode(), self.token.encode())

    def _throttled(self, client: str) -> float:
        fails, until = self._auth_fails.get(client, (0, 0.0))
        if fails < AUTH_FAIL_LIMIT:
            return 0.0
        wait = until - time.time()
        if wait <= 0:
            self._auth_fails.pop(client, None)
            return 0.0
        return wait

    def _note_auth(self, client: str, ok: bool) -> None:
        if ok:
            self._auth_fails.pop(client, None)
            return
        fails, _ = self._auth_fails.get(client, (0, 0.0))
        fails += 1
        if len(self._auth_fails) > AUTH_CLIENTS_MAX:
            self._auth_fails.clear()
        lock = min(
            AUTH_LOCK_S * max(1, fails - AUTH_FAIL_LIMIT + 1),
            AUTH_LOCK_MAX_S,
        )
        self._auth_fails[client] = (fails, time.time() + lock)

    async def middleware(self, request: Request, call_next) -> Response:
        if not _host_ok(request.headers.get("host", "")):
            return JSONResponse({"error": "forbidden_host"}, status_code=403)
        origin = request.headers.get("origin")
        if not _origin_ok(origin):
            audit.record("auth.origin_rejected", origin=origin)
            return JSONResponse({"error": "forbidden_origin"}, status_code=403)

        if request.method == "OPTIONS":
            response: Response = Response(status_code=204)
        elif _needs_token(request.url.path):
            # Include origin because every browser peer appears as loopback.
            peer = request.client.host if request.client else "?"
            client = f"{peer}|{origin or '-'}"
            wait = self._throttled(client)
            if wait > 0:
                response = JSONResponse(
                    {"error": "too_many_attempts", "retryAfterS": round(wait, 1)},
                    status_code=429,
                )
            else:
                ok = self.authorized(request)
                self._note_auth(client, ok)
                if not ok:
                    audit.record("auth.rejected", path=request.url.path, client=client)
                    response = JSONResponse({"error": "unauthorized"}, status_code=401)
                else:
                    response = await call_next(request)
        else:
            response = await call_next(request)

        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
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
