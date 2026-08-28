"""Browser WebSocket and packaged-viewer routes."""

from __future__ import annotations

import json
import secrets
from pathlib import Path

from fastapi import FastAPI, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse, Response

from . import audit
from .config import env
from .http_security import NO_CORS_MARK, _host_ok, _origin_ok, _same_origin
from .ws import BrowserHub

BASE_PREFIX = "/ifc-viewx"


def _app_root() -> Path | None:
    """The built viewer: an override, a checkout's dist/, or the packaged copy."""
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


def _inject_token(html: str, token: str, port: int) -> str:
    """Inject the session token only into the app served by this service."""
    marker = json.dumps({"token": token, "port": port, "served": True})
    for raw, escaped in (
        ("&", "\\u0026"),
        ("<", "\\u003c"),
        (">", "\\u003e"),
        ("\u2028", "\\u2028"),
        ("\u2029", "\\u2029"),
    ):
        marker = marker.replace(raw, escaped)
    tag = f"<script>window.__IFC_SERVICE__={marker};</script>"
    return html.replace("</head>", f"{tag}</head>", 1) if "</head>" in html else tag + html


def register_browser_routes(
    app: FastAPI,
    hub: BrowserHub,
    app_root: Path | None,
    port: int,
) -> None:
    @app.websocket("/ws")
    async def bridge_socket(websocket: WebSocket) -> None:
        # HTTP middleware never sees WebSockets, so repeat every boundary check.
        if not _host_ok(websocket.headers.get("host", "")):
            audit.record("auth.ws_host_rejected")
            await websocket.close(code=4403)
            return
        if not _origin_ok(websocket.headers.get("origin")):
            audit.record(
                "auth.ws_origin_rejected",
                origin=websocket.headers.get("origin"),
            )
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

    if app_root is None:
        return

    @app.get("/{path:path}")
    async def static_files(request: Request, path: str) -> Response:
        if path.startswith(BASE_PREFIX.lstrip("/")):
            path = path[len(BASE_PREFIX.lstrip("/")) :].lstrip("/")
        candidate = (app_root / path).resolve() if path else app_root / "index.html"
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.is_file() or not candidate.is_relative_to(app_root):
            candidate = app_root / "index.html"
        if candidate.name == "index.html":
            html = candidate.read_text(encoding="utf-8")
            # Never inject into a service-worker/subresource response or a page
            # merely allowed through IFCVIEWX_ORIGINS.
            dest = request.headers.get("sec-fetch-dest", "document")
            if _same_origin(request.headers.get("origin")) and dest == "document":
                html = _inject_token(html, hub.token, port)
            return HTMLResponse(
                html,
                headers={
                    "Cache-Control": "no-cache",
                    "Content-Security-Policy": "frame-ancestors 'none'",
                    NO_CORS_MARK: "1",
                },
            )
        # No COOP/COEP: isolation selects a threaded web-ifc build that the
        # bundled worker cannot currently boot.
        cacheable = "/assets/" in candidate.as_posix() or candidate.suffix == ".wasm"
        return FileResponse(
            candidate,
            headers={
                "Cache-Control": (
                    "public, max-age=31536000, immutable"
                    if cacheable
                    else "no-cache"
                ),
            },
        )
