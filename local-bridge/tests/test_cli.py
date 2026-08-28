from __future__ import annotations

import hashlib
import json
import struct
import sys

import pytest

from ifcviewx import cli, store
from ifcviewx.convert import FORMAT_VERSION, MAGIC, MAGIC_END


def _ifcx_bytes() -> bytes:
    manifest = json.dumps({"stats": {}, "bounds": {}, "tree": []}).encode()
    return struct.pack("<2I", MAGIC, FORMAT_VERSION) + manifest + struct.pack(
        "<2I", len(manifest), MAGIC_END
    )


def test_stage_classifies_content_instead_of_the_filename(env, sample_ifc, tmp_path) -> None:
    disguised_step = tmp_path / "source.ifcx"
    disguised_step.write_bytes(sample_ifc.read_bytes())
    step_sha, _ = cli._stage(disguised_step)
    assert store.source_path(step_sha).is_file()

    disguised_ifcx = tmp_path / "converted.ifc"
    disguised_ifcx.write_bytes(_ifcx_bytes())
    ifcx_sha, _ = cli._stage(disguised_ifcx)
    assert store.converted_path(ifcx_sha).is_file()
    assert not store.source_path(ifcx_sha).exists()


def test_stage_rejects_a_truncated_ifcx(env, tmp_path) -> None:
    broken = tmp_path / "broken.ifcx"
    broken.write_bytes(b"IFCX" + b"\0" * 20)
    with pytest.raises(SystemExit, match="corrupt or unsupported"):
        cli._stage(broken)


def test_stage_enforces_store_quota_without_leaving_a_partial(env, sample_ifc) -> None:
    env(IFCVIEWX_STORE_GB="0.000000001")
    sha = hashlib.sha256(sample_ifc.read_bytes()).hexdigest()
    with pytest.raises(SystemExit, match="larger than the model store quota"):
        cli._stage(sample_ifc)
    assert not store.source_path(sha).exists()
    assert not list(store.models_dir().glob("*.part"))


def test_stage_streams_the_model_instead_of_loading_it_whole(env, sample_ifc, monkeypatch) -> None:
    expected = hashlib.sha256(sample_ifc.read_bytes()).hexdigest()

    def no_read_bytes(_path):
        raise AssertionError("staging must stream the model")

    monkeypatch.setattr(type(sample_ifc), "read_bytes", no_read_bytes)
    sha, _ = cli._stage(sample_ifc)
    assert sha == expected


def test_readonly_stage_reuses_cached_models_but_writes_nothing_new(
    env, sample_ifc
) -> None:
    sha = hashlib.sha256(sample_ifc.read_bytes()).hexdigest()
    env(IFCVIEWX_READONLY="1")
    with pytest.raises(SystemExit, match="read-only mode"):
        cli._stage(sample_ifc)
    assert not store.source_path(sha).exists()
    assert not list(store.models_dir().glob("*.part"))

    store.source_path(sha).write_bytes(sample_ifc.read_bytes())
    assert cli._stage(sample_ifc)[0] == sha


def test_readonly_refuses_the_convert_flag(env, monkeypatch) -> None:
    # Track the CLI's direct environment mutation so pytest restores it.
    monkeypatch.setenv("IFCVIEWX_READONLY", "0")
    monkeypatch.setattr(sys, "argv", ["ifcviewx", "--readonly", "--convert"])
    with pytest.raises(SystemExit, match="unavailable in read-only mode"):
        cli.main()


def test_cli_open_url_reports_that_a_source_is_available(
    env, sample_ifc, monkeypatch, capsys
) -> None:
    monkeypatch.setattr(cli, "_health", lambda _port: {"service": "ifcviewx"})
    monkeypatch.setattr(sys, "argv", ["ifcviewx", str(sample_ifc), "--no-browser"])
    cli.main()
    assert "source=1" in capsys.readouterr().out


def test_cli_open_automatically_converts_ifczip(env, tmp_path, monkeypatch, capsys) -> None:
    packed = tmp_path / "model.ifczip"
    packed.write_bytes(store.ZIP_MAGIC + b"test archive payload")
    converted: list[tuple[object, str]] = []

    def convert_now(source, sha: str) -> None:
        converted.append((source, sha))
        store.converted_path(sha).write_bytes(_ifcx_bytes())

    monkeypatch.setattr(cli, "_health", lambda _port: {"service": "ifcviewx"})
    monkeypatch.setattr(cli, "_convert_now", convert_now)
    monkeypatch.setattr(sys, "argv", ["ifcviewx", str(packed), "--no-browser"])
    cli.main()

    assert converted and converted[0][0] == packed
    assert "source=1" in capsys.readouterr().out


def test_readonly_refuses_ifczip_without_staging(env, tmp_path, monkeypatch) -> None:
    packed = tmp_path / "model.ifczip"
    packed.write_bytes(store.ZIP_MAGIC + b"test archive payload")
    sha = hashlib.sha256(packed.read_bytes()).hexdigest()
    monkeypatch.setenv("IFCVIEWX_READONLY", "0")
    monkeypatch.setattr(cli, "_health", lambda _port: {"service": "ifcviewx"})
    monkeypatch.setattr(sys, "argv", ["ifcviewx", str(packed), "--readonly", "--no-browser"])

    with pytest.raises(SystemExit, match="IFCZIP conversion is unavailable"):
        cli.main()
    assert not store.source_path(sha).exists()
