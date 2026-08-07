"""The `ifcviewx check` exit-code contract and JSON shape.

The exit code is the whole product for CI, so every code has a test: 0 clean,
1 findings, 2 a run that never got far enough to judge the model.
"""

from __future__ import annotations

import json

import pytest

from ifcviewx import check

pytest.importorskip("ifcopenshell")


def _run(*argv: str) -> int:
    return check.run(list(argv))


@pytest.fixture
def clean_ifc(tmp_path):
    """A model with no structural findings at all: units, placement, geometry."""
    import ifcopenshell
    import ifcopenshell.api.root
    import ifcopenshell.api.unit

    model = ifcopenshell.file(schema="IFC4")
    new = ifcopenshell.guid.new
    project = ifcopenshell.api.root.create_entity(model, ifc_class="IfcProject", name="Clean")
    unit = model.create_entity("IfcSIUnit", UnitType="LENGTHUNIT", Name="METRE")
    model.create_entity("IfcUnitAssignment", Units=[unit])
    project.UnitsInContext = model.by_type("IfcUnitAssignment")[0]
    storey = ifcopenshell.api.root.create_entity(model, ifc_class="IfcBuildingStorey", name="Level 0")
    model.create_entity(
        "IfcRelAggregates", GlobalId=new(), RelatingObject=project, RelatedObjects=[storey]
    )
    placement = model.create_entity("IfcLocalPlacement")
    context = model.create_entity("IfcGeometricRepresentationContext", ContextType="Model")
    wall = model.create_entity(
        "IfcWall",
        GlobalId=new(),
        Name="Wall 1",
        ObjectPlacement=placement,
        Representation=model.create_entity(
            "IfcProductDefinitionShape",
            Representations=[
                model.create_entity(
                    "IfcShapeRepresentation",
                    ContextOfItems=context,
                    RepresentationIdentifier="Body",
                    Items=[],
                )
            ],
        ),
    )
    model.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=new(),
        RelatingStructure=storey,
        RelatedElements=[wall],
    )
    path = tmp_path / "clean.ifc"
    model.write(str(path))
    return path


def _ids(tmp_path, name: str, body: str):
    path = tmp_path / name
    path.write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<ids xmlns="http://standards.buildingsmart.org/IDS" '
        'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
        'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" '
        'xsi:schemaLocation="http://standards.buildingsmart.org/IDS '
        'http://standards.buildingsmart.org/IDS/1.0/ids.xsd">'
        "<info><title>Test</title></info>"
        f"<specifications>{body}</specifications></ids>",
        encoding="utf-8",
    )
    return path


WALL_HAS_NAME = """
<specification name="Walls are named" ifcVersion="IFC4">
  <applicability minOccurs="1" maxOccurs="unbounded">
    <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
  </applicability>
  <requirements>
    <attribute cardinality="required"><name><simpleValue>Name</simpleValue></name></attribute>
  </requirements>
</specification>
"""

WALL_HAS_FIRE_RATING = """
<specification name="Walls carry a fire rating" ifcVersion="IFC4">
  <applicability minOccurs="1" maxOccurs="unbounded">
    <entity><name><simpleValue>IFCWALL</simpleValue></name></entity>
  </applicability>
  <requirements>
    <property cardinality="required" dataType="IFCLABEL">
      <propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>
      <baseName><simpleValue>FireRating</simpleValue></baseName>
    </property>
  </requirements>
</specification>
"""


# -- exit codes --------------------------------------------------------------
def test_missing_file_exits_2(tmp_path, capsys) -> None:
    assert _run(str(tmp_path / "nope.ifc")) == 2
    assert "no such file" in capsys.readouterr().err


def test_a_file_that_is_not_ifc_exits_2(tmp_path, capsys) -> None:
    junk = tmp_path / "junk.ifc"
    junk.write_text("not an ifc file at all", encoding="utf-8")
    assert _run(str(junk)) == 2
    assert "cannot read" in capsys.readouterr().err


def test_missing_ids_exits_2(sample_ifc, tmp_path, capsys) -> None:
    assert _run(str(sample_ifc), "--ids", str(tmp_path / "nope.ids")) == 2
    assert "no such file" in capsys.readouterr().err


def test_a_clean_model_exits_0(clean_ifc) -> None:
    assert _run(str(clean_ifc), "--quiet") == 0


def test_findings_at_the_threshold_exit_1(sample_ifc) -> None:
    # The shared fixture has no units and no placements: warnings, no errors.
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "warning") == 1


def test_fail_on_error_passes_what_fail_on_warning_fails(sample_ifc) -> None:
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "error") == 0
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "warning") == 1


def test_fail_on_none_never_exits_1(sample_ifc) -> None:
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "none") == 0


def test_fail_on_info_catches_the_lowest_severity(sample_ifc) -> None:
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "info") == 1


# -- json --------------------------------------------------------------------
def test_json_parses_and_carries_a_schema_version(sample_ifc, tmp_path) -> None:
    out = tmp_path / "result.json"
    _run(str(sample_ifc), "--quiet", "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["schemaVersion"] == check.SCHEMA_VERSION
    assert result["tool"] == "ifcviewx"
    assert result["model"]["schema"] == "IFC4"
    assert result["model"]["sha256"] == __import__("hashlib").sha256(sample_ifc.read_bytes()).hexdigest()
    assert set(result["counts"]) == {"error", "warning", "info"}
    assert result["exitCode"] == result["counts"]["error"] and result["ok"] is True


def test_json_to_stdout_is_the_only_output(sample_ifc, capsys) -> None:
    _run(str(sample_ifc), "--json", "-")
    out = capsys.readouterr().out
    # Parsing the whole stream proves the human summary did not join it.
    assert json.loads(out)["tool"] == "ifcviewx"


def test_json_records_the_threshold_it_was_judged_against(sample_ifc, tmp_path) -> None:
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--fail-on", "warning", "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["failOn"] == "warning"
    assert result["ok"] is False
    assert result["exitCode"] == 1


def test_ids_absent_is_stated_rather_than_implied(sample_ifc, tmp_path) -> None:
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["ids"]["available"] is False
    assert result["ids"]["reason"]


def test_structural_checks_match_the_viewer_pass(sample_ifc, tmp_path) -> None:
    from ifcviewx import jobs

    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["checks"]["counts"] == jobs.validate({"model": str(sample_ifc)})["counts"]


# -- ids ---------------------------------------------------------------------
def test_a_passing_ids_leaves_the_exit_code_alone(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    spec = _ids(tmp_path, "names.ids", WALL_HAS_NAME)
    assert _run(str(sample_ifc), "--quiet", "--ids", str(spec)) == 0


def test_a_failing_ids_exits_1_even_with_no_structural_errors(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    spec = _ids(tmp_path, "fire.ids", WALL_HAS_FIRE_RATING)
    # The model has no structural errors, so only the IDS can push this to 1.
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "error") == 0
    assert _run(str(sample_ifc), "--quiet", "--fail-on", "error", "--ids", str(spec)) == 1


def test_ids_results_name_the_specification_and_its_counts(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    spec = _ids(tmp_path, "fire.ids", WALL_HAS_FIRE_RATING)
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--ids", str(spec), "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["ids"]["available"] is True
    document = result["ids"]["documents"][0]
    assert document["file"] == "fire.ids"
    reported = document["specifications"][0]
    assert reported["name"] == "Walls carry a fire rating"
    assert reported["status"] == "fail"
    assert reported["applicable"] == 2
    assert reported["failed"] == 2


def test_ids_names_the_elements_that_failed(sample_ifc, tmp_path) -> None:
    """A count without the elements is not actionable, so the JSON carries both."""
    pytest.importorskip("ifctester")
    spec = _ids(tmp_path, "fire.ids", WALL_HAS_FIRE_RATING)
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--ids", str(spec), "--json", str(out))
    reported = json.loads(out.read_text(encoding="utf-8"))["ids"]["documents"][0]["specifications"][0]
    assert reported["failureCount"] == 2
    assert len(reported["failures"]) == 2
    first = reported["failures"][0]
    assert first["class"] == "IfcWall"
    assert first["globalId"]
    assert first["name"].startswith("Wall")
    assert first["reasons"], "a failure with no reason cannot be acted on"


def test_one_element_missing_two_requirements_is_listed_once(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    two = WALL_HAS_FIRE_RATING.replace(
        "</requirements>",
        '<property cardinality="required" dataType="IFCLABEL">'
        "<propertySet><simpleValue>Pset_WallCommon</simpleValue></propertySet>"
        "<baseName><simpleValue>AcousticRating</simpleValue></baseName>"
        "</property></requirements>",
    )
    spec = _ids(tmp_path, "two.ids", two)
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--ids", str(spec), "--json", str(out))
    reported = json.loads(out.read_text(encoding="utf-8"))["ids"]["documents"][0]["specifications"][0]
    assert len(reported["requirements"]) == 2
    # Two walls, two unmet requirements each: still two elements to go and fix.
    assert reported["failureCount"] == 2


def test_several_ids_documents_all_appear(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    first = _ids(tmp_path, "names.ids", WALL_HAS_NAME)
    second = _ids(tmp_path, "fire.ids", WALL_HAS_FIRE_RATING)
    out = tmp_path / "r.json"
    _run(str(sample_ifc), "--quiet", "--ids", str(first), "--ids", str(second), "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert [doc["file"] for doc in result["ids"]["documents"]] == ["names.ids", "fire.ids"]


def test_a_required_specification_that_matches_nothing_fails(sample_ifc, tmp_path) -> None:
    """minOccurs=1 on applicability means the model must contain such an element."""
    pytest.importorskip("ifctester")
    spec = _ids(
        tmp_path,
        "pumps.ids",
        WALL_HAS_NAME.replace("IFCWALL", "IFCPUMP").replace("Walls are named", "Pumps are named"),
    )
    out = tmp_path / "r.json"
    code = _run(str(sample_ifc), "--quiet", "--ids", str(spec), "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    assert result["ids"]["documents"][0]["specifications"][0]["status"] == "fail"
    assert code == 1


def test_an_optional_specification_matching_nothing_is_not_a_pass(sample_ifc, tmp_path) -> None:
    pytest.importorskip("ifctester")
    spec = _ids(
        tmp_path,
        "pumps.ids",
        WALL_HAS_NAME.replace("IFCWALL", "IFCPUMP")
        .replace("Walls are named", "Pumps are named")
        .replace('minOccurs="1"', 'minOccurs="0"'),
    )
    out = tmp_path / "r.json"
    code = _run(str(sample_ifc), "--quiet", "--ids", str(spec), "--json", str(out))
    result = json.loads(out.read_text(encoding="utf-8"))
    reported = result["ids"]["documents"][0]["specifications"][0]
    assert reported["status"] == "skipped"
    assert reported["applicable"] == 0
    # Reported, but not an error: nothing was checked, so nothing failed.
    assert result["counts"]["info"] >= 1
    assert code == 0


# -- output ------------------------------------------------------------------
def test_the_summary_names_the_threshold_and_the_verdict(sample_ifc, capsys) -> None:
    _run(str(sample_ifc), "--fail-on", "warning")
    out = capsys.readouterr().out
    assert "failing on warning" in out
    assert out.strip().endswith("FAILED")


def test_quiet_prints_nothing_on_stdout(sample_ifc, capsys) -> None:
    _run(str(sample_ifc), "--quiet")
    assert capsys.readouterr().out == ""
