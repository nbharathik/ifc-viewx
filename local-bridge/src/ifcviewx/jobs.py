"""Child-side jobs. Everything here runs inside sandbox.py's subprocess and is
the only code in the service that imports ifcopenshell.

Three jobs: run guarded user code, validate a model, and extract an element
schedule. The last two exist so the common questions ("is this model sound?",
"list every door with its fire rating") never need generated code at all.
"""

from __future__ import annotations

import builtins
import io
import json
import zlib
from contextlib import redirect_stdout
from typing import Any, Callable

from .guard import ALLOWED_IMPORTS, check

MAX_SAMPLE = 20
MAX_ROWS = 20_000

#: Builtins the generated code may reach. Anything that opens a file, compiles
#: source or walks the object graph upward is absent by construction.
SAFE_BUILTINS = {
    name: getattr(builtins, name)
    for name in (
        "abs all any ascii bin bool bytearray bytes callable chr complex dict dir divmod "
        "enumerate filter float format frozenset getattr hasattr hash hex id int isinstance "
        "issubclass iter len list map max min next object oct ord pow print range repr "
        "reversed round set setattr slice sorted str sum tuple type zip "
        "True False None NotImplemented Ellipsis "
        "ArithmeticError AssertionError AttributeError BaseException Exception FloatingPointError "
        "IndexError KeyError KeyboardInterrupt LookupError MemoryError NameError NotImplementedError "
        "OverflowError RecursionError RuntimeError StopIteration TypeError ValueError "
        "ZeroDivisionError"
    ).split()
    if hasattr(builtins, name)
}


def _safe_import(name: str, globals_=None, locals_=None, fromlist=(), level: int = 0):
    """Runtime twin of the static import allowlist."""
    if level:
        raise ImportError("relative imports are not allowed")
    if name.split(".")[0] not in ALLOWED_IMPORTS:
        raise ImportError(f'import of "{name}" is not allowed')
    return builtins.__import__(name, globals_, locals_, fromlist, level)


def _reject_dunder(name: object, verb: str) -> None:
    # Closes getattr(x, "__cl" + "ass__") and every other computed spelling the
    # static guard cannot see: the check is on the resolved name, not the source.
    if isinstance(name, str) and name.startswith("__"):
        raise AttributeError(f'{verb} "{name}" is not allowed')


def _safe_getattr(obj, name, *default):
    _reject_dunder(name, "access to")
    return builtins.getattr(obj, name, *default)


def _safe_setattr(obj, name, value):
    _reject_dunder(name, "setting")
    builtins.setattr(obj, name, value)


SAFE_BUILTINS["__import__"] = _safe_import
SAFE_BUILTINS["getattr"] = _safe_getattr
SAFE_BUILTINS["setattr"] = _safe_setattr


def _open(path: str):
    import ifcopenshell

    return ifcopenshell.open(path)


# ---------------------------------------------------------------------------
# Diff: what actually changed, independent of what the code claims


def _signatures(model) -> dict[str, int]:
    """GlobalId -> checksum of the entity's STEP line, ignoring its id."""
    out: dict[str, int] = {}
    for entity in model.by_type("IfcRoot"):
        guid = getattr(entity, "GlobalId", None)
        if not guid:
            continue
        # str(entity) is "#12=IFCWALL(...)"; the id shifts on rewrite, the
        # payload does not, so only the payload is hashed.
        out[str(guid)] = zlib.crc32(str(entity).partition("=")[2].encode("utf-8", "replace"))
    return out


def _label(model, guid: str) -> dict:
    try:
        entity = model.by_guid(guid)
    except Exception:  # noqa: BLE001 - removed entities have no lookup
        return {"globalId": guid}
    return {
        "globalId": guid,
        "expressID": entity.id(),
        "type": entity.is_a(),
        "name": getattr(entity, "Name", None),
    }


def _diff(before: dict[str, int], after: dict[str, int], model) -> dict:
    added = sorted(set(after) - set(before))
    removed = sorted(set(before) - set(after))
    modified = sorted(g for g in set(before) & set(after) if before[g] != after[g])
    return {
        "added": len(added),
        "removed": len(removed),
        "modified": len(modified),
        "addedSample": [_label(model, g) for g in added[:MAX_SAMPLE]],
        "removedSample": [{"globalId": g} for g in removed[:MAX_SAMPLE]],
        "modifiedSample": [_label(model, g) for g in modified[:MAX_SAMPLE]],
        "affectedGuids": (added + modified + removed)[:200],
    }


# ---------------------------------------------------------------------------
# Jobs


def python(job: dict) -> dict:
    """Run guarded code against the model. `edit` writes a new file and a diff."""
    code = str(job.get("code", ""))
    mode = "edit" if job.get("mode") == "edit" else "query"
    violations = check(code, mode)
    if violations:
        return {"error": "rejected_by_guard", "violations": violations}

    model = _open(job["model"])
    limit = int(job.get("maxOutputChars", 200_000))
    before_count = len(list(model))
    before = _signatures(model) if mode == "edit" else {}

    namespace: dict[str, Any] = {
        "model": model,
        "__builtins__": SAFE_BUILTINS,
        "__name__": "ifc_job",
    }
    buffer = io.StringIO()
    try:
        with redirect_stdout(buffer):
            exec(code, namespace)  # noqa: S102 - guarded source, isolated process
            result = namespace.get("result")
            if mode == "edit" and result is None and callable(namespace.get("edit")):
                result = namespace["edit"](model)
    except Exception as exc:  # noqa: BLE001 - fed back for self-repair
        return {
            "error": "exception",
            "message": f"{type(exc).__name__}: {exc}",
            "stdout": buffer.getvalue()[:limit],
        }

    payload: dict[str, Any] = {"stdout": buffer.getvalue()[:limit]}
    if mode != "edit":
        try:
            payload["resultJson"] = json.dumps(result, default=str)[:limit]
        except Exception:  # noqa: BLE001 - unserialisable results still report
            payload["resultJson"] = json.dumps(str(result))[:limit]
        return payload

    claimed = result if isinstance(result, dict) else {}
    model.write(job["out"])
    payload.update(
        {
            "summary": str(claimed.get("summary", "")),
            "entityCountBefore": before_count,
            "entityCountAfter": len(list(model)),
            # The diff is measured, not reported by the code that made it.
            "diff": _diff(before, _signatures(model), model),
        }
    )
    payload["affectedGuids"] = payload["diff"]["affectedGuids"]
    return payload


def _checks(model) -> list[dict]:
    import ifcopenshell.util.element as util

    found: list[dict] = []

    def add(check_id: str, severity: str, title: str, items: list, hint: str = "") -> None:
        if not items:
            return
        found.append(
            {
                "id": check_id,
                "severity": severity,
                "title": title,
                "count": len(items),
                "sample": items[:MAX_SAMPLE],
                "hint": hint,
            }
        )

    seen: dict[str, int] = {}
    duplicates: list[dict] = []
    blank: list[dict] = []
    for entity in model.by_type("IfcRoot"):
        guid = getattr(entity, "GlobalId", None)
        if not guid:
            blank.append({"expressID": entity.id(), "type": entity.is_a()})
            continue
        if guid in seen:
            duplicates.append({"expressID": entity.id(), "type": entity.is_a(), "globalId": guid})
        else:
            seen[guid] = entity.id()
    add("duplicate_guid", "error", "Duplicate GlobalId", duplicates,
        "Two entities share an identifier; downstream tools will treat them as one.")
    add("missing_guid", "error", "Missing GlobalId", blank,
        "Every IfcRoot subtype must carry a GlobalId.")

    products = model.by_type("IfcElement")
    unplaced = [
        {"expressID": e.id(), "type": e.is_a(), "name": getattr(e, "Name", None)}
        for e in products
        if util.get_container(e) is None and not util.get_aggregate(e)
    ]
    add("orphan_elements", "warning", "Elements outside the spatial structure", unplaced,
        "These are not in any storey or space, so they will not appear in schedules.")

    unnamed = [
        {"expressID": e.id(), "type": e.is_a()}
        for e in products
        if not (getattr(e, "Name", None) or "").strip()
    ]
    add("unnamed_elements", "info", "Elements without a name", unnamed,
        "Names drive most schedules and the model tree.")

    no_placement = [
        {"expressID": e.id(), "type": e.is_a(), "name": getattr(e, "Name", None)}
        for e in products
        if getattr(e, "ObjectPlacement", None) is None
    ]
    add("missing_placement", "warning", "Elements without a placement", no_placement,
        "Without ObjectPlacement an element has no location in the model.")

    no_geometry = [
        {"expressID": e.id(), "type": e.is_a(), "name": getattr(e, "Name", None)}
        for e in products
        if getattr(e, "Representation", None) is None
    ]
    add("missing_representation", "info", "Elements without geometry", no_geometry,
        "Legitimate for logical elements; unexpected for walls, slabs and doors.")

    if not model.by_type("IfcBuildingStorey"):
        add("no_storeys", "warning", "No building storeys", [{"note": "IfcBuildingStorey not found"}],
            "Storeys are how the viewer and most tools group elements.")

    projects = model.by_type("IfcProject")
    if not projects:
        add("no_project", "error", "No IfcProject", [{"note": "the file has no project root"}], "")
    elif not getattr(projects[0], "UnitsInContext", None):
        add("no_units", "warning", "No unit assignment", [{"expressID": projects[0].id()}],
            "Lengths and areas cannot be interpreted without IfcUnitAssignment.")

    empty_sets = [
        {"expressID": p.id(), "name": getattr(p, "Name", None)}
        for p in model.by_type("IfcPropertySet")
        if not getattr(p, "HasProperties", None)
    ]
    add("empty_property_sets", "info", "Empty property sets", empty_sets, "")

    order = {"error": 0, "warning": 1, "info": 2}
    found.sort(key=lambda c: (order[c["severity"]], c["id"]))
    return found


def validate(job: dict) -> dict:
    """Structural QA over the model: identity, placement, units, naming."""
    model = _open(job["model"])
    checks = _checks(model)
    counts = {"error": 0, "warning": 0, "info": 0}
    for check_ in checks:
        counts[check_["severity"]] += 1
    return {
        "schema": model.schema,
        "totals": {
            "entities": len(list(model)),
            "rooted": len(model.by_type("IfcRoot")),
            "elements": len(model.by_type("IfcElement")),
        },
        "counts": counts,
        "ok": counts["error"] == 0,
        "checks": checks,
    }


def schedule(job: dict) -> dict:
    """Tabular export: one row per element, with resolved pset properties."""
    import ifcopenshell.util.element as util

    model = _open(job["model"])
    ifc_type = str(job.get("type") or "IfcElement")
    wanted = [str(p) for p in (job.get("properties") or [])]
    limit = max(1, min(int(job.get("limit") or 2000), MAX_ROWS))

    try:
        elements = model.by_type(ifc_type)
    except Exception:  # noqa: BLE001 - unknown type is a user error, not a crash
        return {"error": "unknown_type", "message": f'"{ifc_type}" is not an IFC type in {model.schema}'}

    rows: list[dict] = []
    available: set[str] = set()
    for element in elements[:limit]:
        psets = util.get_psets(element)
        for pset_name, values in psets.items():
            for key in values:
                if key != "id":
                    available.add(f"{pset_name}.{key}")
        container = util.get_container(element)
        row = {
            "expressID": element.id(),
            "globalId": getattr(element, "GlobalId", None),
            "type": element.is_a(),
            "name": getattr(element, "Name", None),
            "container": getattr(container, "Name", None) if container else None,
        }
        for wanted_key in wanted:
            row[wanted_key] = _resolve(psets, wanted_key)
        rows.append(row)

    return {
        "type": ifc_type,
        "total": len(elements),
        "returned": len(rows),
        "truncated": len(elements) > len(rows),
        "columns": ["expressID", "globalId", "type", "name", "container", *wanted],
        "availableProperties": sorted(available)[:400],
        "rows": rows,
    }


def _resolve(psets: dict, key: str) -> Any:
    """Look up "Pset.Prop" exactly, or a bare property name in any set."""
    if "." in key:
        pset_name, _, prop = key.partition(".")
        value = psets.get(pset_name, {}).get(prop)
        return value if not hasattr(value, "is_a") else str(value)
    for values in psets.values():
        if key in values:
            value = values[key]
            return value if not hasattr(value, "is_a") else str(value)
    return None


HANDLERS: dict[str, Callable[[dict], dict]] = {
    "python": python,
    "validate": validate,
    "schedule": schedule,
}
