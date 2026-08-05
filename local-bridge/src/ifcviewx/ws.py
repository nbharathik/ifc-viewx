"""Browser hub: correlates MCP tool calls with the connected viewer.

The MCP server runs synchronously on the main thread; the WebSocket lives on
the service event loop. `call()` bridges between them. One browser at a time;
a new connection replaces the previous one. Transport and auth belong to
app.py, this module only owns the request/response protocol.
"""

from __future__ import annotations

import asyncio
import itertools
import json
from typing import Any


class BrowserHub:
    def __init__(self, token: str) -> None:
        self.token = token
        self._loop: asyncio.AbstractEventLoop | None = None
        self._conn: Any = None
        self._pending: dict[int, asyncio.Future] = {}
        self._ids = itertools.count(1)

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def connected(self) -> bool:
        return self._conn is not None

    async def serve(self, websocket: Any) -> None:
        """Own an accepted socket until it closes, resolving pending calls."""
        self._conn = websocket
        try:
            while True:
                raw = await websocket.receive_text()
                try:
                    message = json.loads(raw)
                except ValueError:
                    continue
                future = self._pending.pop(message.get("id"), None)
                if future is not None and not future.done():
                    future.set_result(message)
        finally:
            if self._conn is websocket:
                self._conn = None
            # Nothing will answer these now; waiting out the full timeout only
            # makes an MCP client look hung after the tab has already closed.
            for future in list(self._pending.values()):
                if not future.done():
                    future.set_exception(RuntimeError("the viewer tab disconnected"))
            self._pending.clear()

    def call(self, method: str, params: dict | None = None, timeout: float = 120.0) -> Any:
        """Thread-safe request to the browser. Raises on transport problems;
        tool-level errors come back as the browser's error string."""
        if self._loop is None:
            raise RuntimeError("service not started")
        future = asyncio.run_coroutine_threadsafe(
            self._call(method, params or {}, timeout), self._loop
        )
        return future.result(timeout=timeout + 5)

    async def _call(self, method: str, params: dict, timeout: float) -> Any:
        socket = self._conn
        if socket is None:
            raise ConnectionError(
                "no browser connected: open the viewer and connect it to this service"
            )
        call_id = next(self._ids)
        assert self._loop is not None
        pending: asyncio.Future = self._loop.create_future()
        self._pending[call_id] = pending
        try:
            await socket.send_text(json.dumps({"id": call_id, "method": method, "params": params}))
            reply = await asyncio.wait_for(pending, timeout)
        finally:
            self._pending.pop(call_id, None)
        if reply.get("error"):
            raise RuntimeError(str(reply["error"]))
        return reply.get("result")
