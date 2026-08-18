"""The guard is the first of three layers, so it is tested like a lock:
every known way out of the interpreter has to stay shut.
"""

from __future__ import annotations

import pytest

from ifcviewx.guard import check

ESCAPES = [
    "import os",
    "from os import path",
    "import subprocess",
    "import importlib",
    "from . import app",
    "eval('1+1')",
    "exec('x=1')",
    "compile('x', '<s>', 'exec')",
    "open('/etc/passwd')",
    "__import__('os')",
    "x = __builtins__",
    "g = globals()",
    "v = vars(model)",
    "x = model.__class__",
    "x = ().__class__.__bases__[0].__subclasses__()",
    "getattr(model, '__class__')",
    "d = {'__globals__': 1}",
    "f = model.write.__globals__",
    "result = '{0.__class__}'.format(())",
    "s = '{0.__init__.__globals__[os]}'.format(f)",
    "async def go():\n    pass",
    "def f():\n    global model",
    "def __init__(self):\n    pass",
    "import uuid\nuuid.os.mkdir('outside')",
    "from uuid import os as helper\nhelper.mkdir('outside')",
    "import typing\nframe = typing.sys._getframe(1)\nresult = frame.f_builtins",
    "import typing\nresult = typing.sys.modules",
]

ALLOWED = [
    "result = len(model.by_type('IfcWall'))",
    "import ifcopenshell.util.element as util\nresult = 1",
    "from collections import Counter\nresult = Counter()",
    "result = [w.Name for w in model.by_type('IfcWall') if getattr(w, 'Name', None)]",
    "import json, math, re, itertools, functools, operator, statistics, decimal\nresult = 1",
    "def helper(x):\n    return x * 2\nresult = helper(2)",
    "result = '{0.Name}: {1}'.format(model, 3)",
]


@pytest.mark.parametrize("code", ESCAPES)
def test_escapes_are_rejected(code: str) -> None:
    assert check(code), f"guard let this through: {code!r}"


@pytest.mark.parametrize("code", ALLOWED)
def test_legitimate_code_is_allowed(code: str) -> None:
    assert check(code) == []


def test_edit_shape_is_required_only_for_edits() -> None:
    code = "result = 1"
    assert check(code, "query") == []
    assert any("def edit(model)" in v for v in check(code, "edit"))


def test_edit_shape_accepts_the_contract() -> None:
    assert check("def edit(model):\n    return {'summary': 'x'}", "edit") == []


def test_edit_shape_rejects_wrong_arity() -> None:
    assert check("def edit(model, extra):\n    return {}", "edit")


def test_syntax_errors_are_reported_not_raised() -> None:
    violations = check("def broken(:")
    assert violations and "syntax error" in violations[0]


def test_empty_and_oversized_code() -> None:
    assert check("   ") == ["the code is empty"]
    assert check("x = 1\n" * 40_000)


def test_violations_are_deduplicated_and_ordered() -> None:
    violations = check("import os\nimport os\nimport socket")
    assert violations == sorted(set(violations))
