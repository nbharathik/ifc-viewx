"""Static guard for generated IfcOpenShell code.

This is an AST walk, not a regex scan: a regex sees `getattr(x, '__cla' + 'ss__')`
as harmless text, the parser does not. It is still only the first of three
layers: the code also runs in a throwaway subprocess with curated builtins,
and edits land on a copy that the user must explicitly apply.

Rejections are phrased for the model that wrote the code: each one says what
was wrong so the assistant can repair it without a human in the loop.
"""

from __future__ import annotations

import ast
import re

#: Import roots the generated code may use.
ALLOWED_IMPORTS = frozenset(
    {
        "ifcopenshell",
        "collections",
        "datetime",
        "decimal",
        "functools",
        "itertools",
        "json",
        "math",
        "operator",
        "re",
        "statistics",
        "string",
        "typing",
        "uuid",
    }
)

#: Builtins that hand back the interpreter. `getattr`/`setattr` stay available
#: because IFC code needs them; the dunder rules below close the escape.
DENIED_NAMES = frozenset(
    {
        "breakpoint",
        "compile",
        "eval",
        "exec",
        "exit",
        "globals",
        "help",
        "input",
        "locals",
        "memoryview",
        "open",
        "quit",
        "vars",
    }
)

DUNDER_TEXT = re.compile(r"^__\w+__$")
#: A format template that reaches a dunder attribute, e.g. "{0.__class__}".
#: str.format resolves attributes at the C level, past the runtime getattr
#: guard, so the only place to stop it is the source.
FORMAT_DUNDER = re.compile(r"\{[^{}]*\.__")
#: Callables that resolve an attribute name in C, past `_safe_getattr`. Without
#: these, `attrgetter("__cla" + "ss__")` walks straight out of the sandbox.
DENIED_ATTRS = frozenset(
    {
        "Formatter",
        "_getframe",
        "ag_frame",
        "attrgetter",
        "builtins",
        "cr_frame",
        "f_builtins",
        "f_globals",
        "f_locals",
        "format_map",
        "gi_frame",
        "ifcopenshell_wrapper",
        "methodcaller",
        "modules",
        "os",
        "serializers",
        "sys",
        "tb_frame",
        "write",
    }
)
MAX_CODE_CHARS = 100_000


def _is_dunder(name: str | None) -> bool:
    return bool(name) and name.startswith("__")  # type: ignore[union-attr]


def denied_import(name: str) -> bool:
    parts = name.split(".")
    return (
        not parts
        or parts[0] not in ALLOWED_IMPORTS
        or any(part.startswith("_") or part in DENIED_ATTRS for part in parts[1:])
    )


class _Walker(ast.NodeVisitor):
    def __init__(self) -> None:
        self.violations: list[str] = []

    def fail(self, reason: str) -> None:
        self.violations.append(reason)

    # -- imports ------------------------------------------------------------
    def visit_Import(self, node: ast.Import) -> None:
        for alias in node.names:
            if denied_import(alias.name):
                self.fail(f'import of "{alias.name}" is not allowed')
        self.generic_visit(node)

    def visit_ImportFrom(self, node: ast.ImportFrom) -> None:
        if node.level:
            self.fail("relative imports are not allowed")
        elif denied_import(node.module or ""):
            self.fail(f'import of "{node.module}" is not allowed')
        for alias in node.names:
            if alias.name == "*" or alias.name.startswith("_") or alias.name in DENIED_ATTRS:
                self.fail(f'import of "{alias.name}" is not allowed')
        self.generic_visit(node)

    # -- names and attributes ----------------------------------------------
    def visit_Name(self, node: ast.Name) -> None:
        if node.id in DENIED_NAMES:
            self.fail(f"{node.id}() is not allowed")
        elif node.id in DENIED_ATTRS:
            self.fail(f'"{node.id}" is not allowed')
        elif _is_dunder(node.id):
            self.fail(f'"{node.id}" is not allowed')
        self.generic_visit(node)

    def visit_Attribute(self, node: ast.Attribute) -> None:
        # Any leading underscore is private surface: statistics.random._os and
        # typing.sys._getframe both walk out of the sandbox through one, so the
        # attribute check is stricter than the name check above.
        if node.attr.startswith("_"):
            self.fail(f'access to "{node.attr}" is not allowed')
        elif node.attr in DENIED_ATTRS:
            # write() and the geometry serializers reach the filesystem through
            # C++, under the audit hook rather than through it. The service
            # saves the edit for you.
            self.fail(f'access to "{node.attr}" is not allowed')
        self.generic_visit(node)

    def visit_Constant(self, node: ast.Constant) -> None:
        # Blocks getattr(obj, "__class__") and dict-key escapes alike. The test
        # is "contains", not "is": `"__cla" + "ss__"` is two harmless-looking
        # literals that the compiler joins into a dunder the guard never sees.
        if isinstance(node.value, str):
            if DUNDER_TEXT.match(node.value):
                self.fail(f'the name "{node.value}" is not allowed')
            elif "__" in node.value:
                self.fail('a string holding "__" is not allowed')
            elif FORMAT_DUNDER.search(node.value):
                self.fail('reaching a "__" attribute through a format string is not allowed')
        self.generic_visit(node)

    # -- declarations -------------------------------------------------------
    def visit_FunctionDef(self, node: ast.FunctionDef) -> None:
        if _is_dunder(node.name):
            self.fail(f'defining "{node.name}" is not allowed')
        self.generic_visit(node)

    def visit_ClassDef(self, node: ast.ClassDef) -> None:
        if _is_dunder(node.name):
            self.fail(f'defining "{node.name}" is not allowed')
        self.generic_visit(node)

    def visit_AsyncFunctionDef(self, node: ast.AsyncFunctionDef) -> None:
        self.fail("async code is not allowed")

    def visit_Await(self, node: ast.Await) -> None:
        self.fail("async code is not allowed")

    def visit_Global(self, node: ast.Global) -> None:
        self.fail("global declarations are not allowed")

    def visit_Nonlocal(self, node: ast.Nonlocal) -> None:
        self.fail("nonlocal declarations are not allowed")


def has_edit_function(tree: ast.Module) -> bool:
    """True when the module defines the `def edit(model):` entry point."""
    return any(
        isinstance(node, ast.FunctionDef)
        and node.name == "edit"
        and len(node.args.posonlyargs) + len(node.args.args) == 1
        for node in tree.body
    )


def check(code: str, mode: str = "query") -> list[str]:
    """Reasons the code is rejected; an empty list means it may run."""
    if not code.strip():
        return ["the code is empty"]
    if len(code) > MAX_CODE_CHARS:
        return [f"the code is longer than {MAX_CODE_CHARS} characters"]
    try:
        tree = ast.parse(code)
    except SyntaxError as exc:
        return [f"syntax error on line {exc.lineno}: {exc.msg}"]

    walker = _Walker()
    walker.visit(tree)
    violations = walker.violations
    if mode == "edit" and not has_edit_function(tree):
        violations.append(
            "edit code must define `def edit(model):` that mutates the model and "
            'returns {"summary": str, "affected_guids": [...]}'
        )
    # Stable, de-duplicated: the same message twice teaches the model nothing.
    return sorted(dict.fromkeys(violations))


def guard_code(code: str, require_edit_shape: bool = False) -> list[str]:
    """Back-compatible wrapper used by the HTTP /guard route."""
    return check(code, "edit" if require_edit_shape else "query")
