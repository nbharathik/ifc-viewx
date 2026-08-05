"""End-to-end sandbox behaviour against a real IFC file."""

from __future__ import annotations

import pytest

from ifcviewx.sandbox import run

pytest.importorskip("ifcopenshell")

TIMEOUT = 60
MEMORY = 2 * 1024**3


def _python(sample, code: str, mode: str = "query", out=None) -> dict:
    payload = {"model": str(sample), "code": code, "mode": mode, "out": str(out) if out else None}
    return run("python", payload, TIMEOUT, MEMORY)


def test_query_returns_the_result(env, sample_ifc) -> None:
    outcome = _python(sample_ifc, "result = len(model.by_type('IfcWall'))")
    assert outcome["resultJson"] == "2"


def test_query_captures_stdout(env, sample_ifc) -> None:
    outcome = _python(sample_ifc, "print('hello')\nresult = 1")
    assert "hello" in outcome["stdout"]


def test_guard_runs_inside_the_sandbox_too(env, sample_ifc) -> None:
    outcome = _python(sample_ifc, "import os\nresult = 1")
    assert outcome["error"] == "rejected_by_guard"


def test_builtins_are_curated(env, sample_ifc) -> None:
    """Even if the guard were bypassed, the name is simply not there."""
    outcome = _python(sample_ifc, "result = open")
    assert outcome["error"] == "rejected_by_guard"


def test_runtime_import_hook_blocks_disallowed_modules(env, sample_ifc, monkeypatch) -> None:
    from ifcviewx import jobs

    with pytest.raises(ImportError):
        jobs._safe_import("socket")
    assert jobs._safe_import("json").__name__ == "json"


def test_runtime_getattr_guard_blocks_computed_dunder(env, sample_ifc) -> None:
    """The static guard cannot see "__cl" + "ass__"; the runtime getattr can."""
    outcome = _python(sample_ifc, 'c = getattr((), "__cl" + "ass__")\nresult = str(c)')
    assert outcome["error"] == "exception"
    assert "not allowed" in outcome["message"]


def test_audit_hook_blocks_a_spawn_reached_by_attrgetter(env, sample_ifc) -> None:
    """operator.attrgetter reaches classes past the getattr guard, but the audit
    hook still denies the one thing that would do harm: spawning a process."""
    code = (
        "import operator\n"
        "ga = lambda o, n: operator.attrgetter(n)(o)\n"
        "base = ga(ga((), '__cl' + 'ass__'), '__ba' + 'se__')\n"
        "subs = ga(base, '__subcl' + 'asses__')()\n"
        "popen = next(c for c in subs if ga(c, '__na' + 'me__') == 'Popen')\n"
        "popen(['cmd', '/c', 'echo pwned'])\n"
        "result = 'PWNED'\n"
    )
    outcome = _python(sample_ifc, code)
    assert outcome.get("resultJson") != '"PWNED"'
    assert outcome["error"] == "exception"
    assert "blocked by sandbox" in outcome["message"]


def test_exceptions_come_back_as_reports(env, sample_ifc) -> None:
    outcome = _python(sample_ifc, "result = 1 / 0")
    assert outcome["error"] == "exception"
    assert "ZeroDivisionError" in outcome["message"]


def test_edit_writes_a_copy_and_measures_the_diff(env, sample_ifc, tmp_path) -> None:
    out = tmp_path / "edited.ifc"
    code = (
        "def edit(model):\n"
        "    for wall in model.by_type('IfcWall'):\n"
        "        wall.Name = 'Renamed'\n"
        "    return {'summary': 'renamed walls', 'affected_guids': []}\n"
    )
    outcome = _python(sample_ifc, code, "edit", out)
    assert "error" not in outcome, outcome
    assert out.is_file(), "the edit must produce a separate file"
    assert outcome["diff"]["modified"] == 2
    assert outcome["diff"]["added"] == 0 and outcome["diff"]["removed"] == 0
    # The source is never touched.
    assert b"Renamed" not in sample_ifc.read_bytes()


def test_diff_is_measured_not_taken_from_the_code(env, sample_ifc, tmp_path) -> None:
    out = tmp_path / "edited.ifc"
    code = (
        "def edit(model):\n"
        "    return {'summary': 'lying', 'affected_guids': ['A', 'B', 'C']}\n"
    )
    outcome = _python(sample_ifc, code, "edit", out)
    assert outcome["diff"]["modified"] == 0
    assert outcome["affectedGuids"] == []


def test_edit_that_adds_an_entity_is_counted(env, sample_ifc, tmp_path) -> None:
    out = tmp_path / "edited.ifc"
    code = (
        "import ifcopenshell\n"
        "def edit(model):\n"
        "    model.create_entity('IfcWall', GlobalId=ifcopenshell.guid.new(), Name='New')\n"
        "    return {'summary': 'added a wall'}\n"
    )
    outcome = _python(sample_ifc, code, "edit", out)
    assert outcome["diff"]["added"] == 1
    assert outcome["entityCountAfter"] > outcome["entityCountBefore"]


def test_timeout_kills_the_child(env, sample_ifc) -> None:
    outcome = run(
        "python",
        {"model": str(sample_ifc), "code": "while True:\n    pass", "mode": "query"},
        2,
        MEMORY,
    )
    assert outcome["error"] == "timeout"


def test_validate_reports_checks(env, sample_ifc) -> None:
    outcome = run("validate", {"model": str(sample_ifc)}, TIMEOUT, MEMORY)
    assert outcome["schema"] == "IFC4"
    assert outcome["ok"] is True
    ids = {c["id"] for c in outcome["checks"]}
    # The sample has no placements or geometry, which the checks must notice.
    assert "missing_placement" in ids
    assert all(c["severity"] in {"error", "warning", "info"} for c in outcome["checks"])


def test_validate_flags_duplicate_guids(env, sample_ifc, tmp_path) -> None:
    import ifcopenshell

    model = ifcopenshell.open(str(sample_ifc))
    walls = model.by_type("IfcWall")
    walls[1].GlobalId = walls[0].GlobalId
    path = tmp_path / "dupe.ifc"
    model.write(str(path))
    outcome = run("validate", {"model": str(path)}, TIMEOUT, MEMORY)
    assert outcome["ok"] is False
    assert any(c["id"] == "duplicate_guid" for c in outcome["checks"])


def test_schedule_lists_elements(env, sample_ifc) -> None:
    outcome = run("schedule", {"model": str(sample_ifc), "type": "IfcWall"}, TIMEOUT, MEMORY)
    assert outcome["total"] == 2
    assert {row["name"] for row in outcome["rows"]} == {"Wall 0", "Wall 1"}
    assert outcome["rows"][0]["container"] == "Level 0"


def test_schedule_rejects_unknown_types(env, sample_ifc) -> None:
    outcome = run("schedule", {"model": str(sample_ifc), "type": "IfcNotAThing"}, TIMEOUT, MEMORY)
    assert outcome["error"] == "unknown_type"


def test_unknown_job_kind_is_reported(env, sample_ifc) -> None:
    assert run("nope", {"model": str(sample_ifc)}, TIMEOUT, MEMORY)["error"] == "unknown_job"
