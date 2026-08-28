"""HTTP surface: who may call what, and what the service refuses to store."""

from __future__ import annotations

import hashlib
import json
import struct
import time

import pytest

from ifcviewx import store
from ifcviewx.convert import FORMAT_VERSION, MAGIC, MAGIC_END, mark_cache


def _ifcx_bytes() -> bytes:
    manifest = json.dumps({"stats": {}, "bounds": {}, "tree": []}).encode()
    return (
        struct.pack("<2I", MAGIC, FORMAT_VERSION)
        + manifest
        + struct.pack("<2I", len(manifest), MAGIC_END)
    )

GUARDED = [
    ("post", "/model"),
    ("post", "/convert"),
    ("post", "/python"),
    ("post", "/guard"),
    ("post", "/validate"),
    ("post", "/schedule"),
    ("post", "/llm/chat"),
    ("post", "/llm/stream"),
    ("get", "/store"),
    ("get", "/audit"),
    ("get", "/jobs/abc"),
    ("get", "/api/v1/providers"),
    ("post", "/api/v1/jobs"),
]


@pytest.mark.parametrize(("method", "path"), GUARDED)
def test_guarded_routes_reject_missing_token(client, method: str, path: str) -> None:
    call = getattr(client, method)
    response = call(path, json={}) if method == "post" else call(path)
    assert response.status_code == 401


def test_health_is_public_but_thin_without_a_token(client, auth) -> None:
    public = client.get("/health").json()
    assert public["service"] == "ifcviewx"
    assert "store" not in public

    private = client.get("/health", headers=auth).json()
    assert "store" in private and "llm" in private


def test_invalid_numeric_configuration_falls_back_to_safe_values(env) -> None:
    settings = env(
        IFCVIEWX_PORT="nan",
        IFCVIEWX_MEMORY_GB="-1",
        IFCVIEWX_MAX_UPLOAD_MB="inf",
        IFCVIEWX_PYTHON_TIMEOUT="-5",
        IFCVIEWX_STORE_GB="1e300",
    )
    assert settings.port == 8765
    assert settings.memory_bytes == 4 * 1024**3
    assert settings.max_upload_bytes == 2048 * 1024**2
    assert settings.python_timeout_s == 120
    assert settings.store_quota_bytes == 20 * 1024**3


def test_configured_directories_are_absolute(env, tmp_path, monkeypatch) -> None:
    monkeypatch.chdir(tmp_path)
    settings = env(IFCVIEWX_MODELS="relative-models", IFCVIEWX_STATE="relative-state")
    assert settings.store_dir.is_absolute()
    assert settings.state_dir.is_absolute()


def test_pre_rename_env_names_still_work(env) -> None:
    """IFC_BRIDGE_* is read when the IFCVIEWX_* name is absent."""
    settings = env(IFC_BRIDGE_READONLY="1")
    assert settings.readonly is True


def test_non_local_host_header_is_refused(client) -> None:
    assert client.get("/health", headers={"host": "evil.example"}).status_code == 403


def test_no_web_page_is_trusted_by_default(client) -> None:
    """Local Studio and Web Studio are separate apps. Nothing on the internet
    may talk to this service, including the hosted copy of this same viewer."""
    for origin in ("https://nbharathik.github.io", "https://someone.github.io", "https://evil.example"):
        assert client.get("/health", headers={"origin": origin}).status_code == 403


def test_the_page_this_service_served_is_allowed(client, auth) -> None:
    origin = {"origin": "http://127.0.0.1:8765"}
    assert client.get("/health", headers=origin).status_code == 200
    assert client.get("/store", headers=origin).status_code == 401
    assert client.get("/store", headers={**origin, **auth}).status_code == 200


def test_the_app_shell_never_hands_its_token_to_another_origin(client) -> None:
    """Every unguarded path falls back to the app shell, and the shell carries
    the token that gates everything else, so no other site may read one out."""
    served = client.get("/")
    if served.status_code != 200 or "text/html" not in served.headers.get("content-type", ""):
        pytest.skip("no built app to serve")
    assert "__IFC_SERVICE__" in served.text, "the served app carries its own token"

    for path in ("/", "/does/not/exist"):
        cross = client.get(path, headers={"origin": "https://someone.github.io"})
        assert "__IFC_SERVICE__" not in cross.text
        assert "access-control-allow-origin" not in cross.headers

    # A service worker or subresource fetch caches the shell into the browser
    # profile, so it must receive a token-free copy however same-origin it is.
    worker = client.get("/", headers={"sec-fetch-dest": "empty"})
    assert "__IFC_SERVICE__" not in worker.text


def test_an_extra_origin_is_opt_in_and_exact(env) -> None:
    """Someone hosting the viewer themselves can name their origin, and gets
    that one only."""
    from fastapi.testclient import TestClient

    from ifcviewx.app import create_app
    from ifcviewx.ws import BrowserHub

    settings = env(IFCVIEWX_ORIGINS="https://mine.example")
    opened = TestClient(create_app(BrowserHub(settings.token)), headers={"host": "127.0.0.1"})
    assert opened.get("/health", headers={"origin": "https://mine.example"}).status_code == 200
    assert opened.get("/health", headers={"origin": "https://other.example"}).status_code == 403


def test_the_bridge_socket_repeats_the_host_and_origin_checks(client) -> None:
    """No HTTP middleware runs for websockets, so /ws has to check for itself."""
    from starlette.websockets import WebSocketDisconnect

    token = "0" * 32
    for headers in ({"host": "evil.example"}, {"origin": "https://evil.example"}):
        with pytest.raises(WebSocketDisconnect) as refused:
            with client.websocket_connect(f"/ws?token={token}", headers=headers):
                pass
        assert refused.value.code == 4403


def test_repeated_bad_tokens_are_throttled(client) -> None:
    bad = {"X-IFC-Token": "wrong"}
    codes = [client.get("/store", headers=bad).status_code for _ in range(7)]
    assert codes[0] == 401
    assert 429 in codes, "the service kept answering unauthenticated attempts"


def test_upload_rejects_files_that_are_not_ifc(client, auth) -> None:
    response = client.post(
        "/model", headers=auth, files={"file": ("evil.exe", b"MZ\x90\x00not an ifc", "application/octet-stream")}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "not_ifc"


def test_upload_rejects_an_empty_file(client, auth) -> None:
    response = client.post(
        "/model", headers=auth, files={"file": ("empty.ifc", b"", "application/octet-stream")}
    )
    assert response.status_code == 400
    assert response.json()["error"] == "not_ifc"


def test_upload_stores_by_content_hash(client, auth, sample_ifc) -> None:
    payload = sample_ifc.read_bytes()
    first = client.post("/model", headers=auth, files={"file": ("m.ifc", payload)}).json()
    second = client.post("/model", headers=auth, files={"file": ("other.ifc", payload)}).json()
    assert store.is_sha(first["sha"])
    assert first["sha"] == second["sha"], "the same bytes must not be stored twice"
    assert store.source_path(first["sha"]).is_file()


def test_source_backed_ifcx_requires_a_current_cache_marker(
    client, auth, sample_ifc
) -> None:
    payload = sample_ifc.read_bytes()
    sha = hashlib.sha256(payload).hexdigest()
    target = store.converted_path(sha)
    target.write_bytes(_ifcx_bytes())

    stale = client.post(
        "/model", headers=auth, files={"file": ("m.ifc", payload, "application/octet-stream")}
    )
    assert stale.status_code == 200
    assert stale.json()["converted"] is False
    assert client.get(f"/models/{sha}.ifcx").status_code == 404

    mark_cache(target)
    current = client.post(
        "/model", headers=auth, files={"file": ("m.ifc", payload, "application/octet-stream")}
    )
    assert current.json()["converted"] is True
    assert client.get(f"/models/{sha}.ifcx").status_code == 200


def test_bare_imported_ifcx_does_not_require_a_cache_marker(client) -> None:
    sha = "a" * 64
    store.converted_path(sha).write_bytes(_ifcx_bytes())
    assert not store.source_path(sha).exists()
    assert client.get(f"/models/{sha}.ifcx").status_code == 200


def test_upload_reservation_keeps_the_matching_converted_cache(
    client, auth, sample_ifc, monkeypatch
) -> None:
    payload = sample_ifc.read_bytes()
    sha = hashlib.sha256(payload).hexdigest()
    calls: list[tuple[object, object, set[str]]] = []
    original_commit = store.commit_staging

    def tracking_commit(staging, target, *, keep: set[str] | None = None):
        calls.append((staging, target, set(keep or ())))
        return original_commit(staging, target, keep=keep)

    monkeypatch.setattr(store, "commit_staging", tracking_commit)
    response = client.post(
        "/model", headers=auth, files={"file": ("m.ifc", payload, "application/octet-stream")}
    )
    assert response.status_code == 200
    assert any(target == store.source_path(sha) and sha in keep for _, target, keep in calls)


def test_model_route_refuses_names_that_are_not_hashes(client) -> None:
    for name in ("notasha.ifcx", "abc.ifcx", "a" * 63 + ".ifcx", "A" * 64 + ".ifcx", "x.exe"):
        assert client.get(f"/models/{name}").status_code == 404


def test_traversal_never_returns_a_file_off_the_app_root(client, tmp_path) -> None:
    """Anything that escapes falls back to the SPA shell, never to disk."""
    for name in ("/models/..%2f..%2fetc%2fpasswd", "/..%2f..%2fetc%2fpasswd"):
        response = client.get(name)
        assert b"root:" not in response.content
        assert response.status_code in {200, 404}
        if response.status_code == 200:
            assert "text/html" in response.headers.get("content-type", "")


def test_readonly_blocks_writes_but_allows_reads(env, auth, sample_ifc) -> None:
    from fastapi.testclient import TestClient

    from ifcviewx.app import create_app
    from ifcviewx.ws import BrowserHub

    settings = env(IFCVIEWX_READONLY="1")
    ro = TestClient(create_app(BrowserHub(settings.token)), headers={"host": "127.0.0.1"})
    upload = ro.post("/model", headers=auth, files={"file": ("m.ifc", sample_ifc.read_bytes())})
    assert upload.status_code == 403
    assert ro.get("/health").status_code == 200
    assert "convert" not in ro.get("/health").json()["capabilities"]


def test_custom_token_is_escaped_before_html_injection() -> None:
    from ifcviewx.app import _inject_token

    token = "</script><script>globalThis.pwned=1</script>"
    html = _inject_token("<html><head></head><body></body></html>", token, 8765)
    assert html.count("</script>") == 1
    assert token not in html
    assert "\\u003c/script\\u003e" in html


def test_python_can_be_disabled_entirely(env, auth) -> None:
    from fastapi.testclient import TestClient

    from ifcviewx.app import create_app
    from ifcviewx.ws import BrowserHub

    settings = env(IFCVIEWX_ALLOW_PYTHON="0")
    off = TestClient(create_app(BrowserHub(settings.token)), headers={"host": "127.0.0.1"})
    assert "python" not in off.get("/health").json()["capabilities"]
    response = off.post("/python", headers=auth, json={"sha": "0" * 64, "code": "result = 1"})
    assert response.status_code == 403


def test_guard_endpoint_reports_violations(client, auth) -> None:
    body = client.post("/guard", headers=auth, json={"code": "import os"}).json()
    assert body["ok"] is False and body["violations"]


def test_unknown_model_is_a_404_not_a_crash(client, auth) -> None:
    response = client.post("/validate", headers=auth, json={"sha": "0" * 64})
    assert response.status_code == 404


def test_security_headers_are_always_present(client) -> None:
    headers = client.get("/health").headers
    assert headers["x-content-type-options"] == "nosniff"
    assert headers["referrer-policy"] == "no-referrer"


def test_provider_listing_is_authenticated_and_versioned(client, auth) -> None:
    body = client.get("/api/v1/providers", headers=auth).json()
    assert body["protocol"] == {"min": 1, "max": 1, "current": 1}
    core = next(provider for provider in body["providers"] if provider["id"] == "org.ifcviewx.core")
    assert core["trust"] == "trusted-native"
    assert {capability["id"] for capability in core["capabilities"]} >= {
        "ifc.convert", "ifc.validate", "ifc.schedule", "ifc.python.query"
    }


def test_provider_mismatch_is_rejected_before_a_job_is_created(client, auth) -> None:
    response = client.post(
        "/api/v1/jobs",
        headers=auth,
        json={
            "providerId": "org.ifcviewx.core",
            "providerVersion": ">=99.0.0",
            "capabilityId": "ifc.validate",
            "modelSha": "0" * 64,
            "input": {},
        },
    )
    assert response.status_code == 409
    assert response.json()["error"] == "provider_version_mismatch"


def test_browser_provider_protocol_rejects_paths_at_every_level(client, auth) -> None:
    response = client.post(
        "/api/v1/jobs",
        headers=auth,
        json={
            "providerId": "org.ifcviewx.core",
            "providerVersion": "*",
            "capabilityId": "ifc.validate",
            "input": {"options": {"source_path": "C:/private/model.ifc"}},
        },
    )
    assert response.status_code == 400
    assert response.json()["error"] == "path_input_forbidden"


def test_generic_job_runs_the_same_validation_provider(client, auth, sample_ifc) -> None:
    pytest.importorskip("ifcopenshell")
    uploaded = client.post(
        "/model",
        headers=auth,
        files={"file": ("sample.ifc", sample_ifc.read_bytes())},
    ).json()
    started = client.post(
        "/api/v1/jobs",
        headers=auth,
        json={
            "providerId": "org.ifcviewx.core",
            "providerVersion": "*",
            "capabilityId": "ifc.validate",
            "modelSha": uploaded["sha"],
            "input": {},
        },
    )
    assert started.status_code == 202
    job = started.json()
    for _ in range(200):
        job = client.get(f"/api/v1/jobs/{job['id']}", headers=auth).json()
        if job["status"] not in {"queued", "running"}:
            break
        time.sleep(0.02)
    assert job["status"] == "succeeded", job
    result = client.get(f"/api/v1/jobs/{job['id']}/result", headers=auth).json()
    assert result["schemaVersion"] == 1
    assert result["value"]["schema"] == "IFC4"


def test_compatibility_schedule_and_python_use_provider_jobs(client, auth, sample_ifc) -> None:
    pytest.importorskip("ifcopenshell")
    uploaded = client.post(
        "/model",
        headers=auth,
        files={"file": ("sample.ifc", sample_ifc.read_bytes())},
    ).json()
    schedule = client.post(
        "/schedule",
        headers=auth,
        json={"sha": uploaded["sha"], "type": "IfcWall"},
    ).json()
    query = client.post(
        "/python",
        headers=auth,
        json={
            "sha": uploaded["sha"],
            "mode": "query",
            "code": "result = len(model.by_type('IfcWall'))",
        },
    ).json()
    assert schedule["total"] == 2
    assert query["resultJson"] == "2"
    events = client.get("/audit", headers=auth).json()["entries"]
    capabilities = {
        entry.get("capability")
        for entry in events
        if entry.get("event") == "provider.job.start"
    }
    assert {"ifc.schedule", "ifc.python.query"} <= capabilities


def test_compatibility_conversion_uses_the_generic_job(client, auth, sample_ifc) -> None:
    pytest.importorskip("ifcopenshell")
    uploaded = client.post(
        "/model",
        headers=auth,
        files={"file": ("sample.ifc", sample_ifc.read_bytes())},
    ).json()
    started = client.post("/convert", headers=auth, json={"sha": uploaded["sha"]}).json()
    assert started["jobId"]
    native = client.app.state.provider_jobs.get(started["jobId"])
    assert native["providerId"] == "org.ifcviewx.core"
    assert native["capabilityId"] == "ifc.convert"
    status = started
    for _ in range(300):
        status = client.get(f"/jobs/{started['jobId']}", headers=auth).json()
        if status["status"] not in {"queued", "running"}:
            break
        time.sleep(0.02)
    assert status["status"] == "done", status
    assert status["url"] == f"/models/{uploaded['sha']}.ifcx"
