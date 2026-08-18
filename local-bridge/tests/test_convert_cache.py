from __future__ import annotations

import json
import struct

from ifcviewx.convert import (
    CACHE_REVISION,
    FORMAT_VERSION,
    MAGIC,
    MAGIC_END,
    cache_marker_path,
    cache_valid,
    is_valid_ifcx,
    mark_cache,
)


def _container() -> bytes:
    manifest = json.dumps({"stats": {}, "bounds": {}, "tree": []}).encode()
    return (
        struct.pack("<2I", MAGIC, FORMAT_VERSION)
        + manifest
        + struct.pack("<2I", len(manifest), MAGIC_END)
    )


def test_cache_requires_a_valid_container_and_current_marker(tmp_path) -> None:
    target = tmp_path / "model.ifcx"
    target.write_bytes(_container())
    assert is_valid_ifcx(target)
    assert not cache_valid(target)
    mark_cache(target)
    assert cache_valid(target)
    cache_marker_path(target).write_text(f"{FORMAT_VERSION}:{CACHE_REVISION + 1}")
    assert not cache_valid(target)


def test_truncated_or_wrong_version_container_is_invalid(tmp_path) -> None:
    target = tmp_path / "model.ifcx"
    target.write_bytes(_container()[:-3])
    assert not is_valid_ifcx(target)
    data = bytearray(_container())
    struct.pack_into("<I", data, 4, FORMAT_VERSION + 1)
    target.write_bytes(data)
    assert not is_valid_ifcx(target)
