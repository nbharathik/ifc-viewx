from __future__ import annotations

import json
import struct

from ifcviewx import server, store
from ifcviewx.convert import FORMAT_VERSION, MAGIC, MAGIC_END, mark_cache


def _ifcx_bytes() -> bytes:
    manifest = json.dumps({"stats": {}, "bounds": {}, "tree": []}).encode()
    return struct.pack("<2I", MAGIC, FORMAT_VERSION) + manifest + struct.pack(
        "<2I", len(manifest), MAGIC_END
    )


def test_mcp_server_imports_with_supported_dependency() -> None:
    assert server.mcp is not None


def test_mcp_conversion_respects_readonly(env, tmp_path) -> None:
    env(IFCVIEWX_READONLY="1")
    source = tmp_path / "model.ifc"
    source.write_text("ISO-10303-21;", encoding="ascii")
    result = server.convert_model(str(source))
    assert result["error"] == "readonly"


def test_mcp_lists_only_converted_models_that_can_be_served(env) -> None:
    bare = "a" * 64
    stale = "b" * 64
    store.converted_path(bare).write_bytes(_ifcx_bytes())
    store.source_path(stale).write_bytes(b"ISO-10303-21;")
    store.converted_path(stale).write_bytes(_ifcx_bytes())

    listed = {item["sha"] for item in server.list_converted_models()["models"]}
    assert bare in listed
    assert stale not in listed

    mark_cache(store.converted_path(stale))
    listed = {item["sha"] for item in server.list_converted_models()["models"]}
    assert stale in listed
