"""ifcviewx check: model QA from a terminal, for CI.

    ifcviewx check model.ifc --ids spec.ids --json out.json --fail-on error

No browser and no network. Structural checks are the same pass the viewer runs
(`jobs.validate`), so a green terminal and a green panel mean the same thing.
IDS goes through ifctester, the buildingSMART reference implementation, which
covers every facet including the classification and material ones the browser
validator reports as unsupported.

The exit code is the contract:

    0  nothing at or above --fail-on
    1  findings at or above --fail-on
    2  bad input, missing dependency, or a crash

CI needs that split. With one non-zero code a broken pipeline and a broken
model look identical, and the wrong person gets paged.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
SEVERITIES = ("error", "warning", "info")
#: Findings kept per check in the JSON. The counts are always complete.
MAX_SAMPLE = 20


class CheckError(Exception):
    """Anything that makes the run itself wrong, rather than the model."""


def _version() -> str:
    try:
        from importlib.metadata import version

        return version("ifcviewx")
    except Exception:  # noqa: BLE001 - a missing version must not fail a check
        return "unknown"


def _why(exc: Exception) -> str:
    """ifctester says "see details above" and prints nothing. Dig out the reason."""
    reason = getattr(exc, "reason", None)
    if not reason:
        for arg in getattr(exc, "args", ()):
            reason = getattr(arg, "reason", None)
            if reason:
                break
    text = str(reason) if reason else str(exc)
    return text.strip().splitlines()[0] if text.strip() else type(exc).__name__


def _read_model(path: Path):
    import ifcopenshell

    try:
        return ifcopenshell.open(str(path))
    except Exception as exc:  # noqa: BLE001 - the message is the product
        raise CheckError(f"cannot read {path.name}: {exc}") from exc


def _specification(spec: dict) -> dict[str, Any]:
    """One ifctester specification result, flattened.

    Failing elements hang off each requirement rather than the specification,
    so they are gathered here and deduplicated: one element that misses two
    requirements is one element to go and fix, not two.
    """
    failures: dict[str, dict[str, Any]] = {}
    for requirement in spec.get("requirements", []):
        for entity in requirement.get("failed_entities", []):
            key = entity.get("global_id") or str(entity.get("id"))
            found = failures.setdefault(
                key,
                {
                    "globalId": entity.get("global_id") or "",
                    "expressID": entity.get("id"),
                    "class": entity.get("class") or "",
                    "name": entity.get("name") or "",
                    "reasons": [],
                },
            )
            reason = entity.get("reason") or requirement.get("description") or ""
            if reason and reason not in found["reasons"]:
                found["reasons"].append(reason)
    return {
        "name": spec.get("name") or "",
        # A skipped specification matched no element, so it neither passed nor
        # failed and must not be counted as either.
        "status": "skipped" if spec.get("is_skipped") else "pass" if spec.get("status") else "fail",
        "applicable": spec.get("total_applicable", 0),
        "passed": spec.get("total_applicable_pass", 0),
        "failed": spec.get("total_applicable_fail", 0),
        "requirements": [
            requirement.get("description") or "" for requirement in spec.get("requirements", [])
        ],
        "failureCount": len(failures),
        "failures": list(failures.values())[:MAX_SAMPLE],
    }


def _ids_results(model, spec_paths: list[Path]) -> dict[str, Any]:
    """Run each .ids through ifctester and flatten it to our own shape."""
    try:
        from ifctester import ids as ids_module
        from ifctester import reporter
    except ImportError:
        raise CheckError(
            "--ids needs ifctester, which this Python does not have: pip install ifctester"
        ) from None

    documents = []
    for path in spec_paths:
        try:
            specs = ids_module.open(str(path))
        except Exception as exc:  # noqa: BLE001
            raise CheckError(f"cannot read {path.name}: {_why(exc)}") from exc
        specs.validate(model)
        engine = reporter.Json(specs)
        engine.report()
        results = engine.results
        documents.append(
            {
                "file": path.name,
                "title": results.get("title") or path.stem,
                "passed": bool(results.get("status")),
                "specifications": [_specification(spec) for spec in results.get("specifications", [])],
            }
        )
    return {"available": True, "documents": documents}


def _totals(structural: dict, ids: dict | None) -> dict[str, int]:
    """One severity tally over both passes, which is what --fail-on reads."""
    counts = {name: int(structural["counts"].get(name, 0)) for name in SEVERITIES}
    for document in (ids or {}).get("documents", []):
        for spec in document["specifications"]:
            if spec["status"] == "fail":
                counts["error"] += 1
            elif spec["status"] == "skipped":
                # Not a pass. It matched nothing, and a specification that
                # covers no element is usually a specification aimed at the
                # wrong class.
                counts["info"] += 1
    return counts


def evaluate(model_path: Path, spec_paths: list[Path]) -> dict[str, Any]:
    """The whole run as data. Raises CheckError for anything but a bad model."""
    from . import jobs

    if not model_path.is_file():
        raise CheckError(f"no such file: {model_path}")
    data = model_path.read_bytes()
    for spec in spec_paths:
        if not spec.is_file():
            raise CheckError(f"no such file: {spec}")

    try:
        structural = jobs.validate({"model": str(model_path)})
    except CheckError:
        raise
    except Exception as exc:  # noqa: BLE001
        raise CheckError(f"cannot read {model_path.name}: {exc}") from exc

    ids = None
    if spec_paths:
        ids = _ids_results(_read_model(model_path), spec_paths)

    counts = _totals(structural, ids)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "tool": "ifcviewx",
        "toolVersion": _version(),
        "model": {
            "name": model_path.name,
            "path": str(model_path),
            "bytes": len(data),
            "sha256": hashlib.sha256(data).hexdigest(),
            "schema": structural["schema"],
        },
        "totals": structural["totals"],
        "checks": {
            "counts": structural["counts"],
            "items": [
                {key: check[key] for key in ("id", "severity", "title", "count", "hint") if key in check}
                for check in structural["checks"]
            ],
        },
        "ids": ids or {"available": False, "reason": "no --ids given"},
        "counts": counts,
    }


def _fails(counts: dict[str, int], fail_on: str) -> bool:
    if fail_on == "none":
        return False
    ceiling = SEVERITIES.index(fail_on)
    return any(counts[name] for name in SEVERITIES[: ceiling + 1])


def _print(result: dict[str, Any], failed: bool, fail_on: str) -> None:
    model = result["model"]
    print(f"{model['name']}  {model['schema']}  {result['totals']['elements']:,} elements")
    for check in result["checks"]["items"]:
        print(f"  {check['severity']:<8}{check['count']:>7,}  {check['title']}")
    for document in result["ids"].get("documents", []):
        print(f"  ids       {document['file']}")
        for spec in document["specifications"]:
            mark = {"pass": "pass", "fail": "FAIL", "skipped": "skip"}[spec["status"]]
            print(f"    {mark:<6}{spec['passed']:>6}/{spec['applicable']:<6}  {spec['name']}")
    counts = result["counts"]
    line = ", ".join(f"{counts[name]} {name}" for name in SEVERITIES)
    print(f"{line}  (failing on {fail_on})")
    print("FAILED" if failed else "OK")


def run(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(
        prog="ifcviewx check",
        description="Structural and IDS checks over an IFC file. No browser, no network.",
    )
    parser.add_argument("model", type=Path, help="IFC file to check")
    parser.add_argument("--ids", type=Path, action="append", default=[], metavar="SPEC.ids",
                        help="an IDS to validate against; repeatable")
    parser.add_argument("--json", type=Path, metavar="OUT", help='write the result as JSON ("-" for stdout)')
    parser.add_argument("--fail-on", choices=[*SEVERITIES, "none"], default="error",
                        help="lowest severity that exits 1 (default: error)")
    parser.add_argument("--quiet", action="store_true", help="no human-readable output")
    args = parser.parse_args(argv)

    try:
        result = evaluate(args.model.expanduser(), [path.expanduser() for path in args.ids])
    except CheckError as exc:
        print(f"ifcviewx check: {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # noqa: BLE001 - a crash is a run failure, not a finding
        print(f"ifcviewx check: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2

    failed = _fails(result["counts"], args.fail_on)
    result["failOn"] = args.fail_on
    result["ok"] = not failed
    result["exitCode"] = 1 if failed else 0

    if args.json:
        text = json.dumps(result, indent=2)
        if str(args.json) == "-":
            print(text)
        else:
            try:
                args.json.expanduser().write_text(text, encoding="utf-8")
            except OSError as exc:
                print(f"ifcviewx check: cannot write {args.json}: {exc}", file=sys.stderr)
                return 2
    if not args.quiet and str(args.json) != "-":
        _print(result, failed, args.fail_on)
    return result["exitCode"]


def main() -> None:
    sys.exit(run(sys.argv[1:]))
