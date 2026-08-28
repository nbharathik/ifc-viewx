"""End-to-end sandbox behaviour against a real IFC file."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

import pytest

from ifcviewx.sandbox import child_env, run

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
    with pytest.raises(ImportError):
        jobs._safe_import("ifcopenshell.ifcopenshell_wrapper", fromlist=["*"])
    with pytest.raises(ImportError):
        jobs._safe_import("ifcopenshell.geom", fromlist=["serializers"])
    with pytest.raises(ImportError):
        jobs._safe_import("ifcopenshell", fromlist=["*"])
    with pytest.raises(ImportError):
        jobs._safe_import("statistics", fromlist=["_sqrt"])
    assert jobs._safe_import("json").__name__ == "json"


def test_child_ignores_inherited_pythonpath(env, sample_ifc, tmp_path, monkeypatch) -> None:
    shadow = tmp_path / "shadow"
    shadow.mkdir()
    (shadow / "uuid.py").write_text("PWNED = True\n", encoding="utf-8")
    monkeypatch.setenv("PYTHONPATH", str(shadow))
    outcome = _python(sample_ifc, "import uuid\nresult = hasattr(uuid, 'PWNED')")
    assert outcome["resultJson"] == "false"


def test_child_audit_hook_blocks_writes_while_the_guard_is_active(env, tmp_path) -> None:
    target = tmp_path / "audit-escape.txt"
    # Resolve the installed/checkout package path before isolated mode removes
    # the test runner's sys.path. This deliberately exercises the C-level audit
    # hook in a real child rather than relying on the static source guard.
    from ifcviewx import sandbox

    package_root = str(Path(sandbox.__file__).resolve().parents[1])
    script = (
        "import sys;"
        f"sys.path.insert(0,{package_root!r});"
        "from ifcviewx.sandbox import _arm_sandbox,guard_untrusted_effects;"
        "_arm_sandbox();"
        f"target={str(target)!r};"
        "\nwith guard_untrusted_effects():\n    open(target,'w').close()"
    )
    completed = subprocess.run(
        [sys.executable, "-I", "-B", "-c", script],
        capture_output=True,
        text=True,
        timeout=TIMEOUT,
        env=child_env(),
    )
    assert completed.returncode != 0
    assert "blocked by sandbox: file write" in completed.stderr
    assert not target.exists()


def test_computed_dunder_is_blocked(env, sample_ifc) -> None:
    """A split dunder is caught by the source rule, and by getattr behind it."""
    outcome = _python(sample_ifc, 'c = getattr((), "__cl" + "ass__")\nresult = str(c)')
    assert outcome["error"] == "rejected_by_guard"

    from ifcviewx import jobs

    with pytest.raises(AttributeError):
        jobs._safe_getattr((), "__cl" + "ass__")


def test_transitive_modules_cannot_reach_the_filesystem(env, sample_ifc, tmp_path) -> None:
    target = tmp_path / "outside"
    code = f"import uuid\nuuid.os.mkdir({str(target)!r})"
    outcome = _python(sample_ifc, code)
    assert outcome["error"] == "rejected_by_guard"
    assert not target.exists()


def test_transitive_sys_cannot_recover_real_builtins(env, sample_ifc) -> None:
    code = (
        "import typing\n"
        "frame = typing.sys._getframe(1)\n"
        "builtins = frame.f_builtins\n"
        "result = builtins\n"
    )
    outcome = _python(sample_ifc, code)
    assert outcome["error"] == "rejected_by_guard"


def test_attrgetter_route_to_a_spawn_is_blocked(env, sample_ifc) -> None:
    """operator.attrgetter resolves attribute names in C, past the runtime
    getattr guard, so the source rule refuses it outright."""
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
    assert outcome["error"] == "rejected_by_guard"


def test_private_module_alias_cannot_reach_the_filesystem(env, sample_ifc, tmp_path) -> None:
    """statistics imports random, whose _os alias is the real os module."""
    target = tmp_path
    direct = _python(sample_ifc, f"import statistics\nresult = statistics.random._os.listdir({str(target)!r})")
    assert direct["error"] == "rejected_by_guard"
    computed = _python(
        sample_ifc,
        f"import statistics\nresult = getattr(statistics.random, '_os').listdir({str(target)!r})",
    )
    assert computed["error"] == "exception"
    assert "_os" in computed["message"]


def test_geometry_serializer_cannot_write_arbitrary_paths(env, sample_ifc, tmp_path) -> None:
    """The C++ serializers create-or-truncate any path, past the audit hook."""
    target = tmp_path / "keepme.txt"
    target.write_text("original")
    code = (
        "import ifcopenshell\n"
        f"ser = ifcopenshell.geom.serializers.obj({str(target)!r}, 'x.mtl', None, None)\n"
        "result = 'wrote'\n"
    )
    outcome = _python(sample_ifc, code)
    assert outcome["error"] == "rejected_by_guard"
    assert target.read_text() == "original"


def test_geometry_serializer_cannot_be_imported_under_an_alias(env, sample_ifc) -> None:
    outcome = _python(
        sample_ifc,
        "import ifcopenshell.geom.serializers as serializer\nresult = serializer",
    )
    assert outcome["error"] == "rejected_by_guard"


def test_job_code_cannot_write_the_model_anywhere(env, sample_ifc, tmp_path) -> None:
    """model.write goes through C++, so the audit hook never sees it."""
    target = tmp_path / "escaped.ifc"
    code = f"def edit(model):\n    model.write({str(target)!r})\n    return {{'summary': 'x'}}\n"
    outcome = _python(sample_ifc, code, "edit", tmp_path / "out.ifc")
    assert not target.exists()
    assert outcome["error"] in {"rejected_by_guard", "exception"}


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


def test_edit_always_invokes_the_contract_even_when_result_is_assigned(
    env, sample_ifc, tmp_path
) -> None:
    out = tmp_path / "edited.ifc"
    code = (
        "result = {'summary': 'not the edit result'}\n"
        "def edit(model):\n"
        "    model.by_type('IfcWall')[0].Name = 'Changed'\n"
        "    return {'summary': 'changed'}\n"
    )
    outcome = _python(sample_ifc, code, "edit", out)
    assert "error" not in outcome, outcome
    assert outcome["summary"] == "changed"
    assert outcome["diff"]["modified"] >= 1


def test_edit_rejects_an_overwritten_entry_point(env, sample_ifc, tmp_path) -> None:
    code = "def edit(model):\n    return {}\nedit = None"
    outcome = _python(sample_ifc, code, "edit", tmp_path / "edited.ifc")
    assert outcome["error"] == "exception"
    assert "remain callable" in outcome["message"]


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


def test_diff_tracks_referenced_property_and_placement_data(env, sample_ifc, tmp_path) -> None:
    import ifcopenshell

    model = ifcopenshell.open(str(sample_ifc))
    wall = model.by_type("IfcWall")[0]
    point = model.create_entity("IfcCartesianPoint", Coordinates=(0.0, 0.0, 0.0))
    axis = model.create_entity("IfcAxis2Placement3D", Location=point)
    wall.ObjectPlacement = model.create_entity("IfcLocalPlacement", RelativePlacement=axis)
    prop = model.create_entity(
        "IfcPropertySingleValue",
        Name="Rating",
        NominalValue=model.create_entity("IfcLabel", "A"),
    )
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        Name="Pset_Test",
        HasProperties=[prop],
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[wall],
        RelatingPropertyDefinition=pset,
    )
    source = tmp_path / "referenced.ifc"
    model.write(str(source))
    code = (
        "def edit(model):\n"
        "    model.by_type('IfcCartesianPoint')[0].Coordinates = (1.0, 0.0, 0.0)\n"
        "    prop = model.by_type('IfcPropertySingleValue')[0]\n"
        "    prop.NominalValue = model.create_entity('IfcLabel', 'B')\n"
        "    return {'summary': 'changed referenced data'}\n"
    )
    outcome = _python(source, code, "edit", tmp_path / "referenced-edited.ifc")
    assert "error" not in outcome, outcome
    assert outcome["diff"]["modified"] >= 2
    assert wall.GlobalId in outcome["affectedGuids"]
    assert pset.GlobalId in outcome["affectedGuids"]


def test_diff_does_not_collapse_distinct_inline_property_values(env, sample_ifc, tmp_path) -> None:
    import ifcopenshell

    model = ifcopenshell.open(str(sample_ifc))
    wall = model.by_type("IfcWall")[0]
    properties = [
        model.create_entity(
            "IfcPropertySingleValue",
            Name=f"Value {index}",
            NominalValue=model.create_entity("IfcLabel", value),
        )
        for index, value in enumerate(("A", "B"))
    ]
    pset = model.create_entity(
        "IfcPropertySet",
        GlobalId=ifcopenshell.guid.new(),
        Name="Pset_Inline",
        HasProperties=properties,
    )
    model.create_entity(
        "IfcRelDefinesByProperties",
        GlobalId=ifcopenshell.guid.new(),
        RelatedObjects=[wall],
        RelatingPropertyDefinition=pset,
    )
    source = tmp_path / "inline.ifc"
    model.write(str(source))
    code = (
        "def edit(model):\n"
        "    prop = model.by_type('IfcPropertySingleValue')[1]\n"
        "    prop.NominalValue = model.create_entity('IfcLabel', 'Changed')\n"
        "    return {'summary': 'changed one inline value'}\n"
    )
    outcome = _python(source, code, "edit", tmp_path / "inline-edited.ifc")
    assert "error" not in outcome, outcome
    assert pset.GlobalId in outcome["affectedGuids"]


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


def test_conversion_runs_in_the_bounded_worker(env, sample_ifc, tmp_path) -> None:
    from ifcviewx.convert import is_valid_ifcx

    target = tmp_path / "model.ifcx"
    outcome = run(
        "convert",
        {"model": str(sample_ifc), "out": str(target)},
        TIMEOUT,
        MEMORY,
    )
    assert "error" not in outcome, outcome
    assert outcome["stats"]["totalEntities"] > 0
    assert is_valid_ifcx(target)


def test_unknown_job_kind_is_reported(env, sample_ifc) -> None:
    assert run("nope", {"model": str(sample_ifc)}, TIMEOUT, MEMORY)["error"] == "unknown_job"
