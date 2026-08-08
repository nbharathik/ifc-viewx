"""Subprocess isolation for anything that touches an IFC file.

Parent side: `run()` spawns a throwaway interpreter, hands it one JSON job on
stdin and reads one JSON result from stdout. Runaway, crashing or hostile work
kills the child, never the service.

The child gets a scrubbed environment, a temporary working directory, memory
and CPU caps (rlimits on POSIX, a job object on Windows), and, for user code, a
curated `__builtins__` with an import hook that enforces the same allowlist the
static guard checks, plus an audit hook that denies process, socket, native
library and file-write operations however the code reaches them.

Child entry point: python -m ifcviewx.sandbox
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from typing import Any

#: Environment the child is allowed to see. Everything else is dropped so a
#: variable set by the caller cannot steer the interpreter.
ENV_KEEP = (
    "PATH",
    "PYTHONPATH",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "LANG",
    "LC_ALL",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
)


#: Audit events an escape would need to actually do harm. Blocking the effect,
#: not the path to it, is what makes the guard robust: even code that reaches a
#: loaded class through some spelling the AST guard missed cannot spawn a
#: process, open a socket, load a native library or delete a file. Reads and
#: pure computation stay allowed so IfcOpenShell keeps working; with the network
#: closed, nothing read this way can leave the machine.
_BLOCKED_AUDIT_EXACT = frozenset(
    {
        "os.system", "os.fork", "os.forkpty", "os.startfile",
        "os.remove", "os.rename", "os.replace", "os.unlink", "os.rmdir",
        "os.link", "os.symlink", "os.truncate",
        "ctypes.dlopen", "ctypes.LoadLibrary", "ctypes.dlsym",
    }
)
_BLOCKED_AUDIT_PREFIX = ("subprocess.", "os.exec", "os.spawn", "socket.", "winreg.", "webbrowser.")


def _arm_sandbox() -> None:
    """Warm the trusted library, then deny dangerous effects for user code.

    The hook cannot be removed once installed, and it fires at the C level, so
    it holds regardless of how the code reaches the operation.
    """
    try:
        import ifcopenshell  # noqa: F401
        import ifcopenshell.util.element  # noqa: F401
    except Exception:  # noqa: BLE001 - absent library just means nothing to warm
        pass

    write_flags = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC

    def _hook(event: str, args: tuple) -> None:
        if event in _BLOCKED_AUDIT_EXACT or event.startswith(_BLOCKED_AUDIT_PREFIX):
            raise RuntimeError(f"blocked by sandbox: {event}")
        # IfcOpenShell reads and writes models through C++, so no legitimate job
        # opens a file for writing from Python; deny that, keep reads for imports.
        if event == "open":
            mode = args[1] if len(args) > 1 else None
            flags = args[2] if len(args) > 2 else None
            if (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                mode is None and isinstance(flags, int) and flags & write_flags
            ):
                raise RuntimeError("blocked by sandbox: file write")

    sys.addaudithook(_hook)


def child_env() -> dict[str, str]:
    """Minimal environment; the package stays importable from a checkout."""
    env = {k: v for k in ENV_KEEP if (v := os.environ.get(k)) is not None}
    parent = str(Path(__file__).resolve().parents[1])
    existing = env.get("PYTHONPATH", "")
    env["PYTHONPATH"] = os.pathsep.join(p for p in (parent, existing) if p)
    env["PYTHONNOUSERSITE"] = "1"
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    env["PYTHONUNBUFFERED"] = "1"
    return env


def run(kind: str, payload: dict[str, Any], timeout: float, memory_bytes: int) -> dict:
    """Execute one job in a child process. Never raises for job-level failures."""
    job = json.dumps(
        {"kind": kind, "timeout": timeout, "memoryBytes": memory_bytes, **payload}
    )
    with tempfile.TemporaryDirectory(prefix="ifc-job-") as workdir:
        try:
            completed = subprocess.run(
                [sys.executable, "-B", "-m", "ifcviewx.sandbox"],
                input=job,
                capture_output=True,
                text=True,
                timeout=timeout,
                env=child_env(),
                cwd=workdir,
                # Its own session/group, so a timeout kill takes any strays.
                start_new_session=(os.name != "nt"),
            )
        except subprocess.TimeoutExpired:
            return {
                "error": "timeout",
                "message": f"{kind} ran longer than {timeout:.0f}s and was stopped",
            }
        except OSError as exc:
            return {"error": "spawn_failed", "message": str(exc)}

    if not completed.stdout.strip():
        detail = (completed.stderr or "").strip().splitlines()
        return {
            "error": "crashed",
            "message": detail[-1] if detail else f"the {kind} process exited ({completed.returncode})",
        }
    try:
        return json.loads(completed.stdout)
    except ValueError:
        return {"error": "bad_response", "message": completed.stdout[:400]}


# ---------------------------------------------------------------------------
# Child side


#: Held for the life of the process: closing the last handle to a job created
#: with KILL_ON_JOB_CLOSE would kill the very process the job protects.
_job_handle: int | None = None


def _apply_windows_limits(memory_bytes: int) -> None:
    """Cap memory with a job object the child assigns to itself.

    Self-assignment needs no suspended start and no handle passed down from the
    parent, and KILL_ON_JOB_CLOSE means anything the job spawns dies with it.
    """
    global _job_handle
    try:
        import ctypes
        from ctypes import wintypes

        class _Basic(ctypes.Structure):
            _fields_ = [
                ("PerProcessUserTimeLimit", ctypes.c_int64),
                ("PerJobUserTimeLimit", ctypes.c_int64),
                ("LimitFlags", wintypes.DWORD),
                ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t),
                ("ActiveProcessLimit", wintypes.DWORD),
                ("Affinity", ctypes.POINTER(wintypes.ULONG)),
                ("PriorityClass", wintypes.DWORD),
                ("SchedulingClass", wintypes.DWORD),
            ]

        class _Io(ctypes.Structure):
            _fields_ = [
                (name, ctypes.c_uint64)
                for name in (
                    "ReadOperationCount",
                    "WriteOperationCount",
                    "OtherOperationCount",
                    "ReadTransferCount",
                    "WriteTransferCount",
                    "OtherTransferCount",
                )
            ]

        class _Extended(ctypes.Structure):
            _fields_ = [
                ("BasicLimitInformation", _Basic),
                ("IoInfo", _Io),
                ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t),
                ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t),
            ]

        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # Handles are pointer sized; the default int restype truncates them.
        k32.CreateJobObjectW.restype = wintypes.HANDLE
        k32.CreateJobObjectW.argtypes = [wintypes.LPVOID, wintypes.LPCWSTR]
        k32.GetCurrentProcess.restype = wintypes.HANDLE
        k32.SetInformationJobObject.argtypes = [
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD
        ]
        k32.AssignProcessToJobObject.argtypes = [wintypes.HANDLE, wintypes.HANDLE]

        job = k32.CreateJobObjectW(None, None)
        if not job:
            return
        info = _Extended()
        # JOB_OBJECT_LIMIT_PROCESS_MEMORY | JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
        info.BasicLimitInformation.LimitFlags = 0x00000100 | 0x00002000
        info.ProcessMemoryLimit = memory_bytes
        # 9 = JobObjectExtendedLimitInformation
        if k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
            k32.AssignProcessToJobObject(job, k32.GetCurrentProcess())
            _job_handle = job
    except Exception:  # noqa: BLE001 - a missing cap must never fail the job
        return


def _apply_limits(memory_bytes: int, timeout: float) -> None:
    """Best-effort resource caps; the timeout is the backstop everywhere."""
    if os.name == "nt":
        _apply_windows_limits(memory_bytes)
        return
    try:
        import resource
    except ImportError:
        return
    caps = [
        (resource.RLIMIT_AS, memory_bytes),
        (resource.RLIMIT_CPU, int(timeout) + 5),
        (resource.RLIMIT_CORE, 0),
        (resource.RLIMIT_NOFILE, 256),
    ]
    for which, value in caps:
        try:
            soft, hard = resource.getrlimit(which)
            limit = value if hard == resource.RLIM_INFINITY else min(value, hard)
            resource.setrlimit(which, (limit, hard))
        except (ValueError, OSError):
            continue


def _main() -> None:
    job = json.loads(sys.stdin.read())
    _apply_limits(int(job.get("memoryBytes", 4 * 1024**3)), float(job.get("timeout", 120)))
    _arm_sandbox()
    try:
        from . import jobs

        handler = jobs.HANDLERS.get(str(job.get("kind")))
        result = (
            handler(job)
            if handler
            else {"error": "unknown_job", "message": str(job.get("kind"))}
        )
    except ImportError as exc:
        result = {"error": "no_ifcopenshell", "message": str(exc)}
    except MemoryError:
        result = {"error": "out_of_memory", "message": "the job exhausted its memory limit"}
    except Exception as exc:  # noqa: BLE001 - the report is the product
        result = {"error": "crashed", "message": f"{type(exc).__name__}: {exc}"}
    json.dump(result, sys.stdout, default=str)


if __name__ == "__main__":
    _main()
