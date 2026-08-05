"""Shared fixtures: every test gets its own store, token and posture."""

from __future__ import annotations

import sys
from pathlib import Path

import pytest

SRC = Path(__file__).resolve().parents[1] / "src"
if str(SRC) not in sys.path:
    sys.path.insert(0, str(SRC))

from ifcviewx import config  # noqa: E402

TOKEN = "0" * 32


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Isolated settings; returns a helper to re-load with overrides."""

    def apply(**overrides: str):
        monkeypatch.setenv("IFCVIEWX_TOKEN", TOKEN)
        monkeypatch.setenv("IFCVIEWX_MODELS", str(tmp_path / "models"))
        monkeypatch.setenv("IFCVIEWX_STATE", str(tmp_path / "state"))
        for key, value in overrides.items():
            monkeypatch.setenv(key, value)
        config.reset()
        return config.settings()

    apply()
    yield apply
    config.reset()


@pytest.fixture
def client(env):
    """TestClient over the real app, with a hub that has no browser attached."""
    from fastapi.testclient import TestClient

    from ifcviewx.app import create_app, reset_state
    from ifcviewx.ws import BrowserHub

    reset_state()
    return TestClient(create_app(BrowserHub(TOKEN)), headers={"host": "127.0.0.1"})


@pytest.fixture
def auth() -> dict:
    return {"X-IFC-Token": TOKEN}


@pytest.fixture
def sample_ifc(tmp_path) -> Path:
    """A tiny but valid IFC4 file: project, storey, two walls, one door."""
    ifcopenshell = pytest.importorskip("ifcopenshell")
    model = ifcopenshell.file(schema="IFC4")
    new = ifcopenshell.guid.new
    project = model.create_entity("IfcProject", GlobalId=new(), Name="Test project")
    storey = model.create_entity("IfcBuildingStorey", GlobalId=new(), Name="Level 0")
    model.create_entity(
        "IfcRelAggregates", GlobalId=new(), RelatingObject=project, RelatedObjects=[storey]
    )
    walls = [
        model.create_entity("IfcWall", GlobalId=new(), Name=f"Wall {i}") for i in range(2)
    ]
    door = model.create_entity("IfcDoor", GlobalId=new(), Name="Door 1")
    model.create_entity(
        "IfcRelContainedInSpatialStructure",
        GlobalId=new(),
        RelatingStructure=storey,
        RelatedElements=[*walls, door],
    )
    path = tmp_path / "sample.ifc"
    model.write(str(path))
    return path
