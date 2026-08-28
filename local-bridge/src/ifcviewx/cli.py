"""The ifcviewx command.

ifcviewx [model.ifc]        start Local Studio and open the viewer
ifcviewx check model.ifc    structural and IDS checks with CI exit codes
ifcviewx convert model.ifc  IFC -> .ifcx from the terminal (also: ifcx-convert)
ifcviewx mcp                MCP over stdio for AI clients (Claude Desktop, ...)

Local Studio is the built viewer served at http://127.0.0.1:<port> plus the
service behind it: IfcOpenShell conversion, native guarded Python, model
checks, schedules and the MCP bridge. Everything stays on this machine.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import time
import urllib.request
import uuid
import webbrowser
from importlib.util import find_spec
from pathlib import Path
from urllib.parse import quote


def _health(port: int) -> dict | None:
    """The ifcviewx already on this port, {} for a stranger, None for nothing."""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as res:
            body = json.load(res)
        return body if isinstance(body, dict) and body.get("service") == "ifcviewx" else {}
    except (OSError, ValueError):
        return None


def _stage(path: Path) -> tuple[str, str]:
    """Copy a model into the content-addressed store. Returns (sha, name)."""
    from . import store
    from .config import settings

    digest = hashlib.sha256()
    staging = store.models_dir() / f"stage-{uuid.uuid4().hex}.part"
    size = 0
    kind = ""
    try:
        with path.open("rb") as source, staging.open("wb") as output:
            while chunk := source.read(4 * 1024 * 1024):
                if size == 0:
                    head = chunk[: store.SNIFF_BYTES]
                    kind = (
                        "ifcx"
                        if head.startswith(b"IFCX")
                        else "ifc"
                        if store.looks_like_ifc(head)
                        else ""
                    )
                    if not kind:
                        raise ValueError(f"{path.name} is not an IFC (STEP) or .ifcx file")
                projected = size + len(chunk)
                store.require_space(projected, written=size)
                digest.update(chunk)
                output.write(chunk)
                size = projected
        if not size:
            raise ValueError(f"{path.name} is not an IFC (STEP) or .ifcx file")

        sha = digest.hexdigest()
        if kind == "ifcx":
            from .convert import is_valid_ifcx

            if not is_valid_ifcx(staging):
                raise ValueError(f"{path.name} is a corrupt or unsupported .ifcx file")
            target = store.converted_path(sha)
        else:
            target = store.source_path(sha)
        if settings().readonly and not target.is_file():
            raise ValueError("read-only mode cannot add this model to the store")
        if not target.is_file():
            store.commit_staging(staging, target, keep={sha})
        return sha, path.name
    except store.StoreError as exc:
        sys.exit(f"ifcviewx: {exc.message}")
    except ValueError as exc:
        sys.exit(f"ifcviewx: {exc}")
    except OSError as exc:
        sys.exit(f"ifcviewx: cannot stage {path}: {exc}")
    finally:
        staging.unlink(missing_ok=True)


def _convert_now(source: Path, sha: str) -> None:
    from . import store
    from .convert import cache_valid, publish_cache

    target = store.converted_path(sha)
    if cache_valid(target):
        return
    if find_spec("ifcopenshell") is None:
        sys.exit("ifcviewx: --convert needs IfcOpenShell, which this Python does not have: pip install ifcopenshell")
    from .convert import convert

    def report(percent: int, meshes: int) -> None:
        print(f"\r  converting  {percent:3d}%  {meshes} meshes", end="", flush=True)

    staging = target.with_name(f"{target.name}.{uuid.uuid4().hex}.part")
    try:
        stats = convert(source, staging, report)
        publish_cache(staging, target, sha)
    except Exception as exc:  # noqa: BLE001 - the message is the product
        sys.exit(f"\nifcviewx: conversion failed: {exc}")
    finally:
        staging.unlink(missing_ok=True)
    print(f"\r  converted  {stats['meshCount']} meshes  {stats['triangleCount']:,} triangles")


def main() -> None:
    argv = sys.argv[1:]
    if argv[:1] == ["mcp"]:
        from .server import main as run_mcp

        sys.argv = [sys.argv[0], *argv[1:]]
        return run_mcp()
    if argv[:1] == ["convert"]:
        from .convert import main as run_convert

        sys.argv = [sys.argv[0], *argv[1:]]
        return run_convert()
    if argv[:1] == ["check"]:
        from .check import run as run_check

        sys.exit(run_check(argv[1:]))

    parser = argparse.ArgumentParser(
        prog="ifcviewx",
        description="IFCViewX Local Studio: fast, private IFC viewing with IfcOpenShell power.",
        epilog="Subcommands: ifcviewx check <model.ifc>    ifcviewx convert <model.ifc>    ifcviewx mcp",
    )
    parser.add_argument("model", nargs="?", type=Path, help="IFC or .ifcx file to open")
    parser.add_argument("--port", type=int, help="serve on this port (default 8765)")
    parser.add_argument("--token", help="fix the session token instead of a random one")
    parser.add_argument("--convert", action="store_true", help="convert to .ifcx before opening")
    parser.add_argument("--readonly", action="store_true", help="refuse uploads, conversions and edits")
    parser.add_argument("--no-python", action="store_true", help="disable code execution entirely")
    parser.add_argument("--no-browser", action="store_true", help="do not open a browser")
    args = parser.parse_args(argv)

    if args.port:
        os.environ["IFCVIEWX_PORT"] = str(args.port)
    if args.token:
        os.environ["IFCVIEWX_TOKEN"] = args.token
    if args.readonly:
        os.environ["IFCVIEWX_READONLY"] = "1"
    if args.no_python:
        os.environ["IFCVIEWX_ALLOW_PYTHON"] = "0"

    from .config import reset, settings

    # ``main`` is also used as an embeddable entry point.  Re-read settings
    # after applying command-line overrides in case the host imported config
    # before invoking us.
    reset()
    config = settings()
    if args.convert and config.readonly:
        sys.exit("ifcviewx: --convert is unavailable in read-only mode")
    running = _health(config.port)
    if running == {}:
        sys.exit(f"ifcviewx: port {config.port} is used by another program (try --port)")

    url = f"http://127.0.0.1:{config.port}/"
    if args.model is not None:
        from . import store

        source = args.model.expanduser()
        try:
            with source.open("rb") as model_file:
                is_ifczip = model_file.read(len(store.ZIP_MAGIC)) == store.ZIP_MAGIC
        except OSError:
            # _stage produces the single, user-facing read error below.
            is_ifczip = False
        if is_ifczip and config.readonly:
            sys.exit("ifcviewx: IFCZIP conversion is unavailable in read-only mode")
        sha, name = _stage(source)
        # IFCZIP is a conversion input, not a browser format. Convert it
        # automatically so the long-supported CLI workflow opens successfully.
        if (args.convert or is_ifczip) and store.source_path(sha).is_file():
            _convert_now(source, sha)
        has_source = "1" if store.source_path(sha).is_file() else "0"
        url += f"?open={sha}&name={quote(name)}&source={has_source}"

    if running:
        print(f"Local Studio is already running  {url}")
        if not args.no_browser:
            webbrowser.open(url)
        return

    from .app import _capabilities, serve
    from .ws import BrowserHub

    hub = BrowserHub(config.token)
    try:
        serve(hub, config.port)
    except RuntimeError as exc:
        sys.exit(f"ifcviewx: {exc}")

    posture = "  ".join(
        label for label, on in (("read-only", config.readonly), ("python off", not config.allow_python)) if on
    )
    # The origin rule decides which web pages may talk to this process at all,
    # so it is worth one line rather than being buried in the environment.
    origins = "localhost only"
    if config.extra_origins:
        origins += f"  (plus {', '.join(sorted(config.extra_origins))} from IFCVIEWX_ORIGINS)"
    print(
        "IFCViewX Local Studio\n"
        f"  viewer   {url}\n"
        # The page this service serves receives the token itself. It is printed
        # for an MCP client or a curl, never to be pasted into a web page.
        f"  token    {config.token}  (for MCP clients; the viewer gets it automatically)\n"
        f"  service  {', '.join(_capabilities())}" + (f"  ({posture})" if posture else "") + "\n"
        f"  origins  {origins}\n"
        f"  store    {config.store_dir}\n"
        "  ai       ifcviewx mcp  (MCP server for Claude Desktop / Claude Code)"
        + ("" if find_spec("ifcopenshell") else "\n  note     no IfcOpenShell here, so conversion and native Python are off: pip install ifcopenshell"),
        flush=True,
    )
    print("Models never leave this machine. Ctrl+C stops it.", flush=True)
    if not args.no_browser:
        webbrowser.open(url)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        print("\nstopped")


if __name__ == "__main__":
    main()
