"""Provider manifests, matching and persistent job behavior."""

from __future__ import annotations

import io
import threading
import time

import pytest

from ifcviewx import store
from ifcviewx import provider_jobs
from ifcviewx.provider_jobs import JobRequestError, ProviderJobManager
from ifcviewx.providers import (
    CoreProvider,
    ProviderRecord,
    ProviderRegistry,
    ProviderValidationError,
    validate_manifest,
    version_satisfies,
)


def _schema(properties=None) -> dict:
    return {
        "type": "object",
        "properties": properties or {},
        "required": [],
        "additionalProperties": False,
    }


class FakeProvider:
    manifest = {
        "schemaVersion": 1,
        "id": "org.example.fake",
        "version": "1.2.3",
        "name": "Fake provider",
        "description": "A deterministic provider used by the job manager tests.",
        "limits": {
            "maxConcurrency": 1,
            "timeoutSeconds": 10,
            "memoryBytes": 256 * 1024**2,
            "resultTtlSeconds": 60,
        },
        "capabilities": [
            {
                "id": "example.echo",
                "title": "Echo",
                "description": "Return the typed input.",
                "effect": "compute",
                "modelRequirement": "none",
                "available": True,
                "inputSchema": _schema({"value": {"type": "string", "maxLength": 100}}),
                "resultSchema": {"type": "object", "additionalProperties": True},
            }
        ],
    }

    def run(self, capability_id, context, inputs, progress):
        return {"value": inputs.get("value")}


def _registry() -> ProviderRegistry:
    provider = FakeProvider()
    return ProviderRegistry([ProviderRecord(provider, validate_manifest(provider.manifest), "test")])


def test_entry_point_discovery_keeps_valid_providers_and_reports_invalid_ones(env, monkeypatch) -> None:
    class EntryPoint:
        def __init__(self, name, loaded):
            self.name = name
            self.value = f"tests:{name}"
            self.loaded = loaded

        def load(self):
            return self.loaded

    monkeypatch.setattr(
        "ifcviewx.providers.metadata.entry_points",
        lambda **kwargs: [EntryPoint("valid", FakeProvider()), EntryPoint("invalid", object())],
    )
    registry = ProviderRegistry.discover()
    assert registry.get("org.example.fake") is not None
    assert registry.errors == [
        {
            "entryPoint": "invalid",
            "error": "entry point must expose manifest and run",
        }
    ]


@pytest.mark.parametrize(
    ("requirement", "expected"),
    [("*", True), (">=1.0 <2", True), ("^1.2", True), ("~1.2", True), ("2.x", False)],
)
def test_provider_version_ranges(requirement: str, expected: bool) -> None:
    assert version_satisfies("1.2.3", requirement) is expected


def test_provider_manifest_rejects_path_inputs() -> None:
    provider = FakeProvider()
    provider.manifest = {
        **provider.manifest,
        "capabilities": [
            {
                **provider.manifest["capabilities"][0],
                "inputSchema": _schema({"source_path": {"type": "string"}}),
            }
        ],
    }
    with pytest.raises(ProviderValidationError, match="filesystem path"):
        validate_manifest(provider.manifest)


def test_provider_manifest_rejects_camel_case_path_inputs() -> None:
    provider = FakeProvider()
    provider.manifest = {
        **provider.manifest,
        "capabilities": [
            {
                **provider.manifest["capabilities"][0],
                "inputSchema": _schema({"sourcePath": {"type": "string"}}),
            }
        ],
    }
    with pytest.raises(ProviderValidationError, match="filesystem path"):
        validate_manifest(provider.manifest)


def test_provider_manifest_requires_usable_finite_limits() -> None:
    provider = FakeProvider()
    provider.manifest = {
        **provider.manifest,
        "limits": {**provider.manifest["limits"], "maxConcurrency": 0.5},
    }
    with pytest.raises(ProviderValidationError, match="positive integer"):
        validate_manifest(provider.manifest)

    provider.manifest["limits"]["maxConcurrency"] = 1
    provider.manifest["limits"]["timeoutSeconds"] = float("inf")
    with pytest.raises(ProviderValidationError, match="finite"):
        validate_manifest(provider.manifest)


def test_zero_result_ttl_is_a_valid_immediate_expiry_policy(env) -> None:
    env(IFCVIEWX_RESULT_TTL_S="0")
    registry = ProviderRegistry.discover()
    assert registry.get("org.ifcviewx.core") is not None


def test_core_provider_declares_precise_ifc_distance() -> None:
    capability = next(
        item for item in CoreProvider().manifest["capabilities"]
        if item["id"] == "geometry.precise-distance"
    )
    assert capability["modelRequirement"] == "ifc-source"
    assert capability["effect"] == "read"
    assert capability["inputSchema"]["required"] == ["a", "b"]


def test_core_python_edit_is_committed_as_a_quota_tracked_result(
    env, sample_ifc
) -> None:
    import hashlib

    sha = hashlib.sha256(sample_ifc.read_bytes()).hexdigest()
    store.source_path(sha).write_bytes(sample_ifc.read_bytes())
    outcome = CoreProvider().run(
        "ifc.python.edit",
        {"modelPath": str(store.source_path(sha)), "modelSha": sha},
        {
            "code": (
                "def edit(model):\n"
                "    model.by_type('IfcWall')[0].Name = 'Changed'\n"
                "    return {'summary': 'changed'}\n"
            )
        },
        lambda _event: None,
    )
    assert "error" not in outcome, outcome
    result = store.result_path(outcome["resultId"])
    assert result.is_file()
    assert store.stats()["resultBytes"] == result.stat().st_size
    assert not list(store.models_dir().glob("*.part"))


def test_core_provider_runs_precise_distance(env, monkeypatch, tmp_path) -> None:
    import ifcopenshell
    import ifcopenshell.geom

    class Model:
        def by_id(self, express_id):
            return {10: "a", 20: "b"}.get(express_id)

    class Clash:
        distance = 0.125
        p1 = (1.0, 2.0, 3.0)
        p2 = (1.125, 2.0, 3.0)

    class Tree:
        def add_element(self, element):
            assert element == "shape"

        def clash_intersection_many(self, a, b, tolerance, check_all):
            return ()

        def clash_clearance_many(self, a, b, clearance, check_all):
            assert a == ["a"] and b == ["b"]
            assert clearance == 2.0 and check_all is True
            return (Clash(),)

    class Iterator:
        def __init__(self):
            self.done = False

        def initialize(self):
            return True

        def get(self):
            return "shape"

        def next(self):
            if self.done:
                return False
            self.done = True
            return False

    monkeypatch.setattr(ifcopenshell, "open", lambda path: Model())

    class Settings:
        def set(self, name, value):
            pass

    monkeypatch.setattr(ifcopenshell.geom, "settings", Settings)
    monkeypatch.setattr(ifcopenshell.geom, "tree", Tree)
    monkeypatch.setattr(ifcopenshell.geom, "iterator", lambda settings, model, threads, include: Iterator())
    progress = []
    result = CoreProvider().run(
        "geometry.precise-distance",
        {"modelPath": str(tmp_path / "model.ifc"), "modelSha": "a" * 64},
        {"a": 10, "b": 20, "maxDistance": 2.0},
        progress.append,
    )
    assert result == {
        "a": 10,
        "b": 20,
        "distance": 0.125,
        "distanceMm": 125.0,
        "intersecting": False,
        "pointA": [1.0, 2.0, 3.0],
        "pointB": [1.125, 2.0, 3.0],
        "fidelity": "native-mesh",
        "engine": "ifcopenshell-bvh",
    }
    assert progress[-1]["done"] == 1


def test_core_provider_precise_distance_on_real_ifc(tmp_path) -> None:
    import ifcopenshell.api

    model = ifcopenshell.api.run("project.create_file", version="IFC4")
    ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcProject", name="Distance test")
    ifcopenshell.api.run("unit.assign_unit", model)
    model_context = ifcopenshell.api.run("context.add_context", model, context_type="Model")
    body = ifcopenshell.api.run(
        "context.add_context",
        model,
        context_type="Model",
        context_identifier="Body",
        target_view="MODEL_VIEW",
        parent=model_context,
    )
    walls = []
    for name, x in (("A", 0.0), ("B", 3.0)):
        wall = ifcopenshell.api.run("root.create_entity", model, ifc_class="IfcWall", name=name)
        representation = ifcopenshell.api.run(
            "geometry.add_wall_representation",
            model,
            context=body,
            length=1.0,
            height=1.0,
            thickness=1.0,
        )
        ifcopenshell.api.run("geometry.assign_representation", model, product=wall, representation=representation)
        ifcopenshell.api.run(
            "geometry.edit_object_placement",
            model,
            product=wall,
            matrix=(
                (1.0, 0.0, 0.0, x),
                (0.0, 1.0, 0.0, 0.0),
                (0.0, 0.0, 1.0, 0.0),
                (0.0, 0.0, 0.0, 1.0),
            ),
        )
        walls.append(wall)
    source = tmp_path / "distance.ifc"
    model.write(str(source))

    result = CoreProvider().run(
        "geometry.precise-distance",
        {"modelPath": str(source), "modelSha": "a" * 64},
        {"a": walls[0].id(), "b": walls[1].id(), "maxDistance": 2.1},
        lambda event: None,
    )

    assert result["distance"] == pytest.approx(2.0)
    assert result["distanceMm"] == pytest.approx(2000.0)
    assert result["intersecting"] is False
    # The facing surfaces are parallel, so the closest pair is any point on them.
    assert result["pointA"][0] == pytest.approx(1.0)
    assert result["pointB"][0] == pytest.approx(3.0)
    assert result["pointA"][1] == pytest.approx(result["pointB"][1])
    assert result["pointA"][2] == pytest.approx(result["pointB"][2])
    assert result["fidelity"] == "native-mesh"


def test_job_result_is_versioned_and_expires(env) -> None:
    env(IFCVIEWX_RESULT_TTL_S="0.5")
    manager = ProviderJobManager(
        _registry(),
        executor=lambda request, cancel, progress: {"value": {"echo": request["input"]["value"]}},
    )
    job = manager.submit("org.example.fake", "^1.0", "example.echo", {"value": "hello"})
    finished = manager.wait(job["id"], 2)
    assert finished and finished["status"] == "succeeded"
    state, result = manager.result(job["id"])
    assert state == "ok"
    assert result["schemaVersion"] == 1 and result["value"] == {"echo": "hello"}
    time.sleep(0.55)
    assert manager.result(job["id"])[0] == "expired"


def test_provider_result_must_match_its_declared_schema(env) -> None:
    manager = ProviderJobManager(
        _registry(),
        executor=lambda request, cancel, progress: {"value": "not an object"},
    )
    job = manager.submit("org.example.fake", "*", "example.echo", {"value": "hello"})
    finished = manager.wait(job["id"], 2)
    assert finished["status"] == "failed"
    assert finished["error"]["code"] == "result_schema"


def test_provider_input_and_output_must_be_standard_json(env) -> None:
    manager = ProviderJobManager(
        _registry(),
        executor=lambda request, cancel, progress: {"value": {"bad": float("nan")}},
    )
    with pytest.raises(JobRequestError, match="valid JSON"):
        manager.submit("org.example.fake", "*", "example.echo", {"value": float("nan")})

    job = manager.submit("org.example.fake", "*", "example.echo", {"value": "ok"})
    finished = manager.wait(job["id"], 2)
    assert finished["status"] == "failed"
    assert finished["error"]["code"] == "result_schema"


def test_nonfinite_provider_progress_is_sanitized(env) -> None:
    def executor(request, cancel, progress):
        progress({"done": float("nan"), "total": float("inf")})
        return {"value": {}}

    manager = ProviderJobManager(_registry(), executor=executor)
    job = manager.submit("org.example.fake", "*", "example.echo", {"value": "ok"})
    finished = manager.wait(job["id"], 2)
    assert finished["status"] == "succeeded"


def test_job_input_never_accepts_a_path_value(env) -> None:
    manager = ProviderJobManager(_registry(), executor=lambda request, cancel, progress: {"value": {}})
    with pytest.raises(JobRequestError, match="filesystem path"):
        manager.submit(
            "org.example.fake",
            "1.2.3",
            "example.echo",
            {"value": "C:/private/model.ifc"},
        )


def test_model_free_provider_never_receives_the_current_model(env) -> None:
    seen = {}

    def capture(request, cancel, progress):
        seen.update(request)
        return {"value": {}}

    manager = ProviderJobManager(_registry(), executor=capture)
    job = manager.submit(
        "org.example.fake",
        "1.2.3",
        "example.echo",
        {"value": "safe"},
        "a" * 64,
    )
    assert manager.wait(job["id"], 2)["status"] == "succeeded"
    assert seen["modelSha"] is None


def test_result_expiry_removes_a_staged_ifc(env) -> None:
    env(IFCVIEWX_RESULT_TTL_S="0.05")
    result_id = "c" * 32
    staged = store.result_path(result_id)
    staged.write_bytes(b"ISO-10303-21; staged")
    manager = ProviderJobManager(
        _registry(),
        executor=lambda request, cancel, progress: {"value": {"resultId": result_id}},
    )
    job = manager.submit("org.example.fake", "*", "example.echo", {"value": "edit"})
    assert manager.wait(job["id"], 2)["status"] == "succeeded"
    time.sleep(0.08)
    assert manager.result(job["id"])[0] == "expired"
    assert not staged.exists()


def test_provider_concurrency_is_bounded(env) -> None:
    first_started = threading.Event()
    release = threading.Event()
    active = 0
    maximum = 0
    lock = threading.Lock()

    def blocked(request, cancel, progress):
        nonlocal active, maximum
        with lock:
            active += 1
            maximum = max(maximum, active)
        first_started.set()
        release.wait(5)
        with lock:
            active -= 1
        return {"value": {"ok": True}}

    manager = ProviderJobManager(_registry(), executor=blocked)
    first = manager.submit("org.example.fake", "*", "example.echo", {"value": "one"})
    assert first_started.wait(1)
    second = manager.submit("org.example.fake", "*", "example.echo", {"value": "two"})
    time.sleep(0.1)
    assert manager.get(second["id"])["status"] == "queued"
    release.set()
    assert manager.wait(first["id"], 2)["status"] == "succeeded"
    assert manager.wait(second["id"], 2)["status"] == "succeeded"
    assert maximum == 1


def test_running_job_can_be_cancelled(env) -> None:
    started = threading.Event()

    def wait_for_cancel(request, cancel, progress):
        started.set()
        cancel.wait(5)
        return {"error": "cancelled", "message": "cancelled"}

    manager = ProviderJobManager(_registry(), executor=wait_for_cancel)
    job = manager.submit("org.example.fake", "1.2.3", "example.echo", {"value": "wait"})
    assert started.wait(1)
    manager.cancel(job["id"])
    finished = manager.wait(job["id"], 2)
    assert finished and finished["status"] == "cancelled"


def test_provider_that_closes_stdout_still_obeys_its_timeout(env, monkeypatch) -> None:
    class Process:
        def __init__(self) -> None:
            self.stdin = io.StringIO()
            self.stdout = io.StringIO("")
            self.stderr = io.StringIO("")
            self.killed = False

        def poll(self):
            return 1 if self.killed else None

        def kill(self) -> None:
            self.killed = True

        def wait(self, timeout=None):
            if not self.killed:
                raise AssertionError("waited without enforcing the provider timeout")
            return 1

    process = Process()
    monkeypatch.setattr(provider_jobs.subprocess, "Popen", lambda *args, **kwargs: process)
    monkeypatch.setattr(provider_jobs, "_terminate", lambda child: child.kill())
    outcome = provider_jobs.run_provider_process(
        {"timeoutSeconds": 0.05},
        threading.Event(),
        lambda _progress: None,
    )
    assert outcome["error"] == "timeout"


def test_restart_marks_an_interrupted_job_failed(env) -> None:
    started = threading.Event()
    release = threading.Event()

    def paused(request, cancel, progress):
        started.set()
        release.wait(5)
        return {"value": {"ok": True}}

    first = ProviderJobManager(_registry(), executor=paused)
    job = first.submit("org.example.fake", "1.x", "example.echo", {"value": "wait"})
    assert started.wait(1)
    restarted = ProviderJobManager(_registry(), executor=paused)
    recovered = restarted.get(job["id"])
    assert recovered and recovered["status"] == "failed"
    assert recovered["error"]["code"] == "service_restarted"
    first.cancel(job["id"])
    release.set()
