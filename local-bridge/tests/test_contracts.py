from __future__ import annotations

import inspect
import sys
import tomllib
from pathlib import Path

import pytest
from fastapi.routing import APIRoute
from starlette.routing import WebSocketRoute

from ifcviewx import cli, server
from ifcviewx.convert import CACHE_REVISION, FORMAT_VERSION, MAGIC, MAGIC_END
from ifcviewx.providers import CoreProvider, PROTOCOL_CURRENT, PROTOCOL_MAX, PROTOCOL_MIN


HTTP_ROUTES = [
    ("GET", "/health"),
    ("GET", "/api/v1/providers"),
    ("POST", "/api/v1/jobs"),
    ("GET", "/api/v1/jobs/{job_id}"),
    ("POST", "/api/v1/jobs/{job_id}/cancel"),
    ("GET", "/api/v1/jobs/{job_id}/result"),
    ("POST", "/model"),
    ("GET", "/store"),
    ("POST", "/store/prune"),
    ("POST", "/store/reveal"),
    ("GET", "/models/{name}"),
    ("POST", "/convert"),
    ("GET", "/jobs/{job_id}"),
    ("POST", "/jobs/{job_id}/cancel"),
    ("POST", "/python"),
    ("GET", "/python/result/{result_id}"),
    ("POST", "/guard"),
    ("POST", "/validate"),
    ("POST", "/schedule"),
    ("POST", "/llm/chat"),
    ("POST", "/llm/stream"),
    ("GET", "/audit"),
    ("WS", "/ws"),
    ("GET", "/{path:path}"),
]

MCP_SIGNATURES = {
    "get_status": "() -> dict",
    "get_model_info": "() -> dict",
    "get_spatial_tree": "(max_depth: int = 4) -> dict",
    "get_selection": "() -> dict",
    "select_element": "(express_id: int) -> dict",
    "get_properties": "(express_id: int) -> dict",
    "set_visibility": "(express_id: int, visible: bool) -> dict",
    "show_all": "() -> dict",
    "fit_view": "(express_id: int = 0) -> dict",
    "search_model": "(query: str, limit: int = 20) -> dict",
    "find_elements": "(type: str = '', name: str = '', storey: str = '') -> dict",
    "count_elements": "() -> dict",
    "list_storeys": "() -> dict",
    "get_visibility": "() -> dict",
    "isolate_elements": "(ids: list[int]) -> dict",
    "hide_elements": "(ids: list[int]) -> dict",
    "unhide_elements": "(ids: list[int]) -> dict",
    "select_elements": "(ids: list[int]) -> dict",
    "load_categories": "(spaces: bool = False, openings: bool = False) -> dict",
    "color_elements": "(groups: list[dict]) -> dict",
    "set_section": "(axis: str = '', offset: float | None = None, flip: bool = False, clear: bool = False) -> dict",
    "section_box": "(ids: list[int] | None = None, clear: bool = False) -> dict",
    "set_camera": "(view: str = '') -> dict",
    "capture_view": "(max_width: int = 1024) -> dict",
    "list_viewpoints": "() -> dict",
    "save_viewpoint": "(name: str = '') -> dict",
    "detect_clashes": "(a: list[str] | None = None, b: list[str] | None = None, tolerance: float = 10) -> dict",
    "validate_model": "() -> dict",
    "element_schedule": "(ifc_type: str = 'IfcElement', properties: str = '', limit: int = 500) -> dict",
    "convert_model": "(path: str) -> dict",
    "list_converted_models": "() -> dict",
    "service_status": "() -> dict",
}


def test_http_route_surface_is_frozen(env) -> None:
    from ifcviewx.app import create_app
    from ifcviewx.ws import BrowserHub

    app = create_app(BrowserHub(env().token))
    routes: list[tuple[str, str]] = []
    for route in app.routes:
        if isinstance(route, WebSocketRoute):
            routes.append(("WS", route.path))
        elif isinstance(route, APIRoute):
            routes.extend((method, route.path) for method in sorted(route.methods))
    assert routes == HTTP_ROUTES


def test_mcp_tool_names_signatures_and_descriptions_are_frozen() -> None:
    tools = server.mcp._tool_manager._tools
    assert list(tools) == list(MCP_SIGNATURES)
    assert {
        name: str(inspect.signature(tool.fn)) for name, tool in tools.items()
    } == MCP_SIGNATURES
    assert all(tool.description and tool.description.strip() for tool in tools.values())


def test_cli_entry_points_and_help_are_frozen(monkeypatch, capsys) -> None:
    pyproject = tomllib.loads(
        (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    )
    assert pyproject["project"]["scripts"] == {
        "ifcviewx": "ifcviewx.cli:main",
        "ifcx-convert": "ifcviewx.convert:main",
    }

    monkeypatch.setattr(sys, "argv", ["ifcviewx", "--help"])
    with pytest.raises(SystemExit) as exit_info:
        cli.main()
    assert exit_info.value.code == 0
    help_text = capsys.readouterr().out
    for option in ("--port", "--token", "--convert", "--readonly", "--no-python", "--no-browser"):
        assert option in help_text


def test_provider_and_ifcx_protocol_versions_are_frozen(env) -> None:
    assert (PROTOCOL_MIN, PROTOCOL_MAX, PROTOCOL_CURRENT) == (1, 1, 1)
    assert [
        capability["id"] for capability in CoreProvider().manifest["capabilities"]
    ] == [
        "ifc.convert",
        "ifc.validate",
        "ifc.schedule",
        "geometry.precise-distance",
        "ifc.python.query",
        "ifc.python.edit",
    ]
    assert (MAGIC, MAGIC_END, FORMAT_VERSION, CACHE_REVISION) == (
        0x58434649,
        0x444E4558,
        1,
        1,
    )
