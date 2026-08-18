"""The store owns its own growth and never lets a name come from a client."""

from __future__ import annotations

import time
from concurrent.futures import ThreadPoolExecutor
from threading import Barrier

import pytest

from ifcviewx import store

SHA = "a" * 64


def test_paths_are_derived_from_hashes_only(env) -> None:
    assert store.source_path(SHA).name == f"{SHA}.ifc"
    for bad in ("../escape", "abc", "", SHA + "x", "A" * 64):
        with pytest.raises(store.StoreError):
            store.source_path(bad)


def test_result_ids_are_validated(env) -> None:
    assert store.result_path("deadbeef").name == "edit-deadbeef.ifc"
    with pytest.raises(store.StoreError):
        store.result_path("../../etc/passwd")


def test_sniff_accepts_step_and_zip_only(env) -> None:
    assert store.looks_like_ifc(b"ISO-10303-21;\nHEADER;")
    assert store.looks_like_ifc(b"PK\x03\x04rest")
    assert not store.looks_like_ifc(b"MZ\x90\x00")
    assert not store.looks_like_ifc(b"<html>")


def test_upload_limit_is_enforced_before_writing(env) -> None:
    settings = env(IFCVIEWX_MAX_UPLOAD_MB="1")
    with pytest.raises(store.StoreError) as excinfo:
        store.require_space(settings.max_upload_bytes + 1)
    assert excinfo.value.code == "too_large"


def test_sweep_expires_edit_results(env) -> None:
    env(IFCVIEWX_RESULT_TTL_S="0")
    stale = store.result_path("beefbeef")
    stale.write_bytes(b"x")
    assert store.sweep()["expiredResults"] == 1
    assert not stale.exists()


def test_sweep_evicts_the_oldest_over_quota(env) -> None:
    env(IFCVIEWX_STORE_GB="0.000002")  # ~2 KB
    old, new = "b" * 64, "c" * 64
    store.source_path(old).write_bytes(b"x" * 2048)
    store.source_path(new).write_bytes(b"x" * 2048)
    # Age both past the five-minute protection window, oldest first.
    now = time.time()
    import os

    os.utime(store.source_path(old), (now - 9000, now - 9000))
    os.utime(store.source_path(new), (now - 600, now - 600))

    result = store.sweep()
    assert result["evicted"], "nothing was evicted despite exceeding the quota"
    assert not store.source_path(old).exists()
    assert store.source_path(new).exists(), "the newest model must survive"


def test_sweep_never_evicts_a_model_in_use(env) -> None:
    env(IFCVIEWX_STORE_GB="0.000001")
    import os

    keep = "d" * 64
    store.source_path(keep).write_bytes(b"x" * 4096)
    now = time.time()
    os.utime(store.source_path(keep), (now - 9000, now - 9000))
    store.sweep(keep={keep})
    assert store.source_path(keep).exists()


def test_reserving_space_refuses_a_quota_overrun(env) -> None:
    env(IFCVIEWX_STORE_GB="0.000001")
    recent = "e" * 64
    store.source_path(recent).write_bytes(b"x" * 800)
    with pytest.raises(store.StoreError) as excinfo:
        store.sweep(reserve=800)
    assert excinfo.value.code == "quota_exceeded"


def test_failed_reservation_does_not_partially_evict_old_models(env) -> None:
    env(IFCVIEWX_STORE_GB="0.000001")  # ~1 KB
    import os

    old, recent = "1" * 64, "2" * 64
    store.source_path(old).write_bytes(b"x" * 400)
    store.source_path(recent).write_bytes(b"x" * 800)
    stale = time.time() - 9000
    os.utime(store.source_path(old), (stale, stale))

    with pytest.raises(store.StoreError, match="quota is full"):
        store.sweep(reserve=400)
    assert store.source_path(old).is_file(), "an impossible reservation must not evict caches"
    assert store.source_path(recent).is_file()


def test_lease_prevents_eviction_while_a_worker_reads(env) -> None:
    env(IFCVIEWX_STORE_GB="0.000001")
    import os

    source = store.source_path(SHA)
    source.write_bytes(b"x" * 4096)
    old = time.time() - 9000
    os.utime(source, (old, old))
    with store.lease(SHA):
        store.sweep()
        assert source.is_file()
    assert not list(store.models_dir().glob("*.lease"))


def test_stats_reports_quota_and_contents(env) -> None:
    store.source_path(SHA).write_bytes(b"x" * 10)
    stats = store.stats()
    assert stats["files"] == 1
    assert stats["bytes"] == 10
    assert stats["models"][0]["sha"] == SHA


def test_concurrent_commits_cannot_claim_the_same_quota(env) -> None:
    env(IFCVIEWX_STORE_GB=str(100 / 1024**3))
    barrier = Barrier(2)
    shas = ("3" * 64, "4" * 64)
    staging = []
    for sha in shas:
        path = store.models_dir() / f"{sha}.test.part"
        path.write_bytes(b"x" * 60)
        staging.append(path)

    def publish(index: int) -> str:
        barrier.wait()
        try:
            store.commit_staging(
                staging[index],
                store.source_path(shas[index]),
                keep={shas[index]},
            )
            return "published"
        except store.StoreError as exc:
            return exc.code

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(publish, range(2)))

    assert sorted(outcomes) == ["published", "quota_exceeded"]
    assert sum(path.stat().st_size for path in store.models_dir().glob("*.ifc")) == 60
