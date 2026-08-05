"""MCP server bridging AI clients to the IFCViewX browser viewer.

Pure adapter (pattern from ifc-schema-mcp): every tool body is one hub call or
one service call plus uniform error mapping. Tools never raise: errors come
back as structured dicts the model can act on. Docstrings are the tool
descriptions and are written for LLM consumption.

Two tiers: viewer tools talk to the connected browser, analysis talks to the
local service. Anything that changes a model is staged for the user to apply in
the viewer: no tool here writes to a file the user did not ask for.

There is deliberately no code-execution tool. A client of this server can read
the model, drive the viewport and stage typed edits; it cannot run Python.
Running IfcOpenShell belongs to the user, in the viewer's Python Console.

Run:  ifcviewx mcp   (configure exactly that as an MCP server in your client)
"""

# No `from __future__ import annotations` here: FastMCP reads the raw
# annotations to build tool schemas and stringified ones break it.

import hashlib
import sys
from pathlib import Path
from typing import Any

from mcp.server.fastmcp import FastMCP

from . import audit, store
from .config import settings
from .ws import BrowserHub

mcp = FastMCP("ifcviewx")

_hub: BrowserHub | None = None
MAX_READ_BYTES = 4 * 1024**3


def _call(method: str, **params: Any) -> Any:
    assert _hub is not None
    try:
        return _hub.call(method, params)
    except ConnectionError as exc:
        return {"error": "no_browser", "message": str(exc)}
    except TimeoutError:
        return {"error": "timeout", "message": f"{method} timed out waiting for the browser"}
    except Exception as exc:  # noqa: BLE001: tools never raise to the client
        return {"error": "bridge_error", "message": str(exc)}


def _active_sha() -> str | None:
    """The model the viewer handed to this service, if any."""
    status = _call("get_status")
    sha = status.get("sha") if isinstance(status, dict) else None
    return sha if isinstance(sha, str) and store.is_sha(sha) else None


def _prune(node: Any, depth: int) -> Any:
    """Limit spatial-tree depth so huge models stay readable for the LLM."""
    if not isinstance(node, dict):
        return node
    out = {k: v for k, v in node.items() if k != "children"}
    children = node.get("children") or []
    if depth <= 1:
        out["children_omitted"] = len(children)
    else:
        out["children"] = [_prune(c, depth - 1) for c in children]
    return out


# ---------------------------------------------------------------------------
# Viewer state


@mcp.tool()
def get_status() -> dict:
    """Check the bridge and viewer state. Call this first.

    Returns whether a browser is connected, whether a model is loaded, its file
    name, whether the local service holds a copy (needed for native Python and
    analysis), and any pending edit awaiting the user's approval.
    """
    if _hub is not None and not _hub.connected():
        return {
            "error": "no_browser",
            "message": "no browser connected: the user must open IFCViewX and "
            "connect it to this service with the printed session token",
        }
    status = _call("get_status")
    if isinstance(status, dict) and "error" not in status:
        config = settings()
        status["service"] = {
            "pythonEnabled": config.allow_python,
            "readonly": config.readonly,
            "nativeReady": bool(status.get("sha")),
        }
    return status


@mcp.tool()
def get_model_info() -> dict:
    """Summarize the loaded IFC model: schema, entity/mesh/triangle totals, and
    per-type entity counts. Use this to ground answers about the model.
    """
    return _call("get_model_info")


@mcp.tool()
def get_spatial_tree(max_depth: int = 4) -> dict:
    """Get the spatial structure (Project > Site > Building > Storey > elements).

    Nodes have expressID, type, name and children; children below max_depth are
    replaced by a children_omitted count. Increase max_depth for detail.
    """
    result = _call("get_spatial_tree")
    if isinstance(result, dict) and "error" not in result:
        return _prune(result, max(1, max_depth))
    return result


@mcp.tool()
def get_selection() -> dict:
    """Get the expressID of the element currently selected in the viewer, or
    null when nothing is selected. Useful for 'what is this?' questions.
    """
    return _call("get_selection")


@mcp.tool()
def select_element(express_id: int) -> dict:
    """Select an element in the 3D viewer by expressID, highlight it, and zoom
    to it. Example: select_element(express_id=137)
    """
    return _call("select_element", express_id=express_id)


@mcp.tool()
def get_properties(express_id: int) -> dict:
    """Get an element's attributes, property sets, and quantities by expressID."""
    return _call("get_properties", express_id=express_id)


@mcp.tool()
def set_visibility(express_id: int, visible: bool) -> dict:
    """Show or hide an element (and its spatial subtree) in the viewer."""
    return _call("set_visibility", express_id=express_id, visible=visible)


@mcp.tool()
def show_all() -> dict:
    """Make every element visible again (reverts hides/isolates)."""
    return _call("show_all")


@mcp.tool()
def fit_view(express_id: int = 0) -> dict:
    """Frame the camera on an element (pass its expressID) or on the whole
    model (omit express_id / pass 0)."""
    return _call("fit_view", express_id=express_id)


# ---------------------------------------------------------------------------
# Analysis that needs no generated code


@mcp.tool()
def validate_model() -> dict:
    """Run structural QA on the loaded model without executing any code.

    Checks identity (duplicate/missing GlobalId), spatial containment, object
    placement, geometry, units and naming. Returns
    {ok, schema, totals, counts, checks:[{id, severity, title, count, sample, hint}]}
    ordered errors first. This is the answer to "is this model sound?".
    """
    from .app import analyze

    sha = _active_sha()
    if sha is None:
        return {
            "error": "no_native_model",
            "message": "the service does not hold this model; open it in the "
            "Local Studio viewer and it is handed over automatically",
        }
    return analyze("validate", sha)


@mcp.tool()
def element_schedule(ifc_type: str = "IfcElement", properties: str = "", limit: int = 500) -> dict:
    """Tabular export of elements and their properties, with no generated code.

    ifc_type is any IFC class ("IfcDoor", "IfcWall", "IfcSpace"). properties is a
    comma-separated list resolved from the element's property sets, either
    qualified ("Pset_DoorCommon.FireRating") or bare ("FireRating"). Call once
    with no properties to read availableProperties, then again to select columns.
    Returns {columns, rows, total, truncated, availableProperties}.
    """
    from .app import analyze

    sha = _active_sha()
    if sha is None:
        return {"error": "no_native_model", "message": "the service does not hold this model"}
    return analyze(
        "schedule",
        sha,
        type=ifc_type,
        properties=[p.strip() for p in properties.split(",") if p.strip()],
        limit=max(1, min(int(limit), 20_000)),
    )


# ---------------------------------------------------------------------------
# No execution tool, deliberately: an MCP client reads the model and stages
# typed edits; it never gets an interpreter. app.py's execute_python serves the
# viewer's Python Console over HTTP, gated by the user's session token.


# ---------------------------------------------------------------------------
# Files and housekeeping


@mcp.tool()
def convert_model(path: str) -> dict:
    """Convert an IFC file on this machine to the viewer's .ifcx format, so it
    opens instantly with no parsing. Returns the served URL and stats.

    Only .ifc/.ifczip files are read, and only under IFCVIEWX_ROOTS when that
    is configured.
    """
    from .convert import convert

    config = settings()
    source = Path(path).expanduser()
    try:
        source = source.resolve(strict=True)
    except OSError:
        return {"error": "not_found", "message": f"no file at {path}"}
    if not source.is_file():
        return {"error": "not_found", "message": f"no file at {source}"}
    if source.suffix.lower() not in {".ifc", ".ifczip"}:
        return {"error": "not_ifc", "message": "only .ifc/.ifczip files can be converted"}
    if config.read_roots and not any(source.is_relative_to(root) for root in config.read_roots):
        return {
            "error": "outside_roots",
            "message": "this service only reads files under IFCVIEWX_ROOTS",
        }
    size = source.stat().st_size
    if size > MAX_READ_BYTES:
        return {"error": "too_large", "message": f"{size / 1e9:.1f} GB is beyond the read limit"}
    digest = hashlib.sha256()
    with source.open("rb") as handle:
        head = handle.read(store.SNIFF_BYTES)
        if not store.looks_like_ifc(head):
            return {"error": "not_ifc", "message": "the file is not an IFC (STEP) document"}
        digest.update(head)
        # Streamed: a multi-GB model must not be pulled into memory just to hash.
        while chunk := handle.read(4 * 1024 * 1024):
            digest.update(chunk)

    sha = digest.hexdigest()
    target = store.converted_path(sha)
    audit.record("convert.mcp", path=str(source), sha=sha[:12])
    if target.is_file():
        return {"sha": sha, "url": f"/models/{sha}.ifcx", "stats": {"cached": True}}
    staging = target.with_suffix(".ifcx.part")
    try:
        stats = convert(source, staging)
    except Exception as exc:  # noqa: BLE001 - reported to the client
        staging.unlink(missing_ok=True)
        return {"error": "convert_failed", "message": str(exc)}
    staging.replace(target)
    return {"sha": sha, "url": f"/models/{sha}.ifcx", "stats": stats}


@mcp.tool()
def list_converted_models() -> dict:
    """List models already converted to .ifcx on this machine, newest first."""
    return {"models": [e.as_dict() for e in store.entries() if e.kind == "ifcx"][:50]}


@mcp.tool()
def service_status() -> dict:
    """Inspect the local service itself: posture, disk use, and recent activity.

    Use it to explain why a tool refused (read-only mode, code execution
    disabled) or how much of the model cache is in use.
    """
    config = settings()
    return {
        "posture": {
            "pythonEnabled": config.allow_python,
            "readonly": config.readonly,
            "pythonTimeoutS": config.python_timeout_s,
            "storeQuotaBytes": config.store_quota_bytes,
        },
        "store": store.stats(),
        "browserConnected": _hub.connected() if _hub else False,
        "recent": audit.tail(15),
    }


def main() -> None:
    """Console entry point: start the local service, then serve MCP over stdio."""
    global _hub
    from .app import _app_root, serve

    config = settings()
    _hub = BrowserHub(config.token)
    serve(_hub, config.port)
    posture = []
    if config.readonly:
        posture.append("read-only")
    if not config.allow_python:
        posture.append("python disabled")
    # stdout carries the MCP protocol; humans read stderr.
    print(
        f"ifcviewx on http://127.0.0.1:{config.port}"
        + (f"  ({', '.join(posture)})" if posture else "")
        + "\n"
        + (f"Viewer app: http://127.0.0.1:{config.port}/\n" if _app_root() else "")
        + f"Session token: {config.token}\n"
        "Open the viewer on this port and it is ready; the token above is for "
        "MCP clients, not for any web page.",
        file=sys.stderr,
        flush=True,
    )
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
