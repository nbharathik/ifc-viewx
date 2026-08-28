from __future__ import annotations

import asyncio
import json

from ifcviewx.ws import BrowserHub


class _Socket:
    def __init__(self) -> None:
        self.incoming: asyncio.Queue[str | BaseException] = asyncio.Queue()
        self.sent: list[str] = []
        self.closed = False

    async def receive_text(self) -> str:
        value = await self.incoming.get()
        if isinstance(value, BaseException):
            raise value
        return value

    async def send_text(self, value: str) -> None:
        self.sent.append(value)

    async def close(self, code: int = 1000) -> None:
        self.closed = True


def test_replaced_socket_cannot_clear_or_resolve_new_calls() -> None:
    async def scenario() -> None:
        hub = BrowserHub("token")
        hub.bind_loop(asyncio.get_running_loop())
        first = _Socket()
        second = _Socket()
        first_task = asyncio.create_task(hub.serve(first))
        await asyncio.sleep(0)
        second_task = asyncio.create_task(hub.serve(second))
        await asyncio.sleep(0)
        assert first.closed

        call = asyncio.create_task(hub._call("selection.get", {}, 1))
        await asyncio.sleep(0)
        call_id = json.loads(second.sent[0])["id"]
        await first.incoming.put(json.dumps({"id": call_id, "result": "stale"}))
        await first.incoming.put(RuntimeError("old socket done"))
        await asyncio.gather(first_task, return_exceptions=True)
        assert not call.done()

        await second.incoming.put(json.dumps({"id": call_id, "result": "current"}))
        assert await call == "current"
        await second.incoming.put(RuntimeError("done"))
        await asyncio.gather(second_task, return_exceptions=True)

    asyncio.run(scenario())


def test_non_object_frames_are_ignored() -> None:
    async def scenario() -> None:
        hub = BrowserHub("token")
        hub.bind_loop(asyncio.get_running_loop())
        socket = _Socket()
        serving = asyncio.create_task(hub.serve(socket))
        await socket.incoming.put("[]")
        await socket.incoming.put("null")
        await asyncio.sleep(0)
        assert not serving.done()
        await socket.incoming.put(RuntimeError("done"))
        await asyncio.gather(serving, return_exceptions=True)

    asyncio.run(scenario())
