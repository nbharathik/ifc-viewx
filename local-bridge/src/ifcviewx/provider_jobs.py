"""Persistent, bounded jobs for Local Studio native providers."""

from __future__ import annotations

import hashlib
import json
import math
import os
import queue
import signal
import subprocess
import sys
import threading
import time
import uuid
from collections import deque
from pathlib import Path
from typing import Any, Callable, Mapping

from . import audit, store
from .config import settings
from .providers import (
    ProviderLookupError,
    ProviderRecord,
    ProviderRegistry,
    model_sha,
    reject_path_inputs,
    validate_value,
)
from .sandbox import child_env

TERMINAL = frozenset({"succeeded", "failed", "cancelled"})
ACTIVE = frozenset({"queued", "running"})


class JobRequestError(ValueError):
    def __init__(self, code: str, message: str, status_code: int = 400) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def _now() -> float:
    return round(time.time(), 3)


def _json_bytes(value: Any) -> bytes:
    return json.dumps(
        value,
        ensure_ascii=False,
        allow_nan=False,
        separators=(",", ":"),
    ).encode("utf-8")


def _terminate(process: subprocess.Popen) -> None:
    if process.poll() is not None:
        return
    try:
        if os.name != "nt":
            os.killpg(process.pid, signal.SIGKILL)
        else:
            process.kill()
    except (OSError, ProcessLookupError):
        pass


def _provider_env() -> dict[str, str]:
    config = settings()
    env = child_env()
    private_home = config.state_dir / "provider-home"
    private_home.mkdir(parents=True, exist_ok=True)
    env.update(
        {
            "HOME": str(private_home),
            "USERPROFILE": str(private_home),
            "APPDATA": str(private_home),
            "LOCALAPPDATA": str(private_home),
            "IFCVIEWX_MODELS": str(config.store_dir),
            "IFCVIEWX_STATE": str(config.state_dir),
            "IFCVIEWX_ALLOW_PYTHON": "1" if config.allow_python else "0",
            "IFCVIEWX_READONLY": "1" if config.readonly else "0",
            "IFCVIEWX_PYTHON_TIMEOUT": str(config.python_timeout_s),
            "IFCVIEWX_CONVERT_TIMEOUT": str(config.convert_timeout_s),
            "IFCVIEWX_ANALYZE_TIMEOUT": str(config.analyze_timeout_s),
            "IFCVIEWX_MEMORY_GB": str(config.memory_bytes / 1024**3),
            "IFCVIEWX_RESULT_TTL_S": str(config.result_ttl_s),
            "IFCVIEWX_MAX_OUTPUT_CHARS": str(config.max_output_chars),
        }
    )
    return env


def run_provider_process(
    request: Mapping[str, Any],
    cancel: threading.Event,
    progress: Callable[[Mapping[str, Any]], None],
) -> dict[str, Any]:
    """Run one provider and return a result or structured error."""
    timeout = float(request["timeoutSeconds"])
    started = time.monotonic()
    lines: queue.Queue[str | None] = queue.Queue(maxsize=64)
    overflow = threading.Event()
    stderr_tail: deque[str] = deque(maxlen=8)
    max_line = max(1024 * 1024, settings().max_output_chars * 8)
    max_stream = max_line * 4
    package_root = str(Path(__file__).resolve().parents[1])
    bootstrap = (
        "import sys;"
        f"sys.path.insert(0,{package_root!r});"
        "from ifcviewx.provider_runner import main;main()"
    )
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", bootstrap],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            env=_provider_env(),
            start_new_session=(os.name != "nt"),
        )
    except OSError as exc:
        return {"error": "spawn_failed", "message": str(exc)}
    assert process.stdin is not None and process.stdout is not None and process.stderr is not None
    try:
        process.stdin.write(json.dumps(dict(request)))
        process.stdin.close()
    except OSError as exc:
        _terminate(process)
        return {"error": "spawn_failed", "message": str(exc)}

    def read_stdout() -> None:
        total = 0
        try:
            while line := process.stdout.readline(max_line + 1):
                total += len(line)
                if len(line) > max_line or total > max_stream:
                    overflow.set()
                    return
                lines.put(line)
        finally:
            lines.put(None)

    def read_stderr() -> None:
        while chunk := process.stderr.read(4096):
            stderr_tail.append(chunk)

    stdout_thread = threading.Thread(target=read_stdout, daemon=True, name="provider-output")
    stderr_thread = threading.Thread(target=read_stderr, daemon=True, name="provider-errors")
    stdout_thread.start()
    stderr_thread.start()
    response: dict[str, Any] | None = None
    stream_done = False
    while True:
        if cancel.is_set():
            _terminate(process)
            process.wait(timeout=5)
            return {"error": "cancelled", "message": "the provider job was cancelled"}
        if overflow.is_set():
            _terminate(process)
            process.wait(timeout=5)
            return {"error": "result_too_large", "message": "the provider output exceeded its limit"}
        if time.monotonic() - started > timeout:
            _terminate(process)
            process.wait(timeout=5)
            return {
                "error": "timeout",
                "message": f"the provider ran longer than {timeout:.0f}s and was stopped",
            }
        try:
            line = lines.get(timeout=0.1)
        except queue.Empty:
            if stream_done and process.poll() is not None:
                break
            continue
        if line is None:
            stream_done = True
            if process.poll() is not None:
                break
            continue
        try:
            message = json.loads(line)
        except ValueError:
            continue
        if message.get("type") == "progress" and isinstance(message.get("progress"), dict):
            progress(message["progress"])
        elif message.get("type") == "result":
            response = {"value": message.get("value")}
        elif message.get("type") == "error":
            response = {
                "error": str(message.get("code") or "provider_failed"),
                "message": str(message.get("message") or "provider failed"),
            }
            if isinstance(message.get("details"), dict):
                response.update(message["details"])
    process.wait()
    stderr_thread.join(timeout=1)
    if response is not None:
        return response
    detail = "".join(stderr_tail).strip().splitlines()
    return {
        "error": "provider_crashed",
        "message": detail[-1] if detail else f"provider process exited ({process.returncode})",
    }


class ProviderJobManager:
    def __init__(
        self,
        registry: ProviderRegistry,
        executor: Callable[
            [Mapping[str, Any], threading.Event, Callable[[Mapping[str, Any]], None]],
            dict[str, Any],
        ] = run_provider_process,
    ) -> None:
        self.registry = registry
        self.executor = executor
        self._jobs: dict[str, dict[str, Any]] = {}
        self._cancel: dict[str, threading.Event] = {}
        self._provider_gates: dict[str, threading.Semaphore] = {}
        self._lock = threading.RLock()
        self._global_gate = threading.Semaphore(settings().job_concurrency)
        self._jobs_dir = settings().state_dir / "jobs-v1"
        self._results_dir = settings().state_dir / "job-results-v1"
        self._jobs_dir.mkdir(parents=True, exist_ok=True)
        self._results_dir.mkdir(parents=True, exist_ok=True)
        self._load()
        self.prune()

    def _job_path(self, job_id: str) -> Path:
        return self._jobs_dir / f"{job_id}.json"

    def _result_path(self, job_id: str) -> Path:
        return self._results_dir / f"{job_id}.json"

    def _write(self, path: Path, value: Any) -> None:
        data = _json_bytes(value)
        staging = path.with_suffix(f"{path.suffix}.{uuid.uuid4().hex}.part")
        try:
            staging.write_bytes(data)
            staging.replace(path)
        finally:
            staging.unlink(missing_ok=True)

    def _persist(self, job: Mapping[str, Any]) -> None:
        self._write(self._job_path(str(job["id"])), job)

    def _load(self) -> None:
        for path in self._jobs_dir.glob("*.json"):
            try:
                job = json.loads(path.read_text(encoding="utf-8"))
                job_id = str(job.get("id", ""))
                if path.stem != job_id or not re_job_id(job_id):
                    continue
                if job.get("status") in ACTIVE:
                    job["status"] = "failed"
                    job["finishedAt"] = _now()
                    job["error"] = {
                        "code": "service_restarted",
                        "message": "Local Studio restarted before this job completed",
                    }
                    job["resultAvailable"] = False
                    self._persist(job)
                if job.get("status") in TERMINAL:
                    self._jobs[job_id] = job
            except (OSError, ValueError, TypeError):
                continue

    def prune(self) -> dict[str, int]:
        now = time.time()
        removed_jobs = 0
        removed_results = 0
        with self._lock:
            for job_id, job in list(self._jobs.items()):
                expires = float(job.get("resultExpiresAt") or 0)
                if expires and expires <= now and not job.get("resultExpired"):
                    result_path = self._result_path(job_id)
                    if result_path.is_file():
                        self._expire_staged_file(result_path)
                        result_path.unlink(missing_ok=True)
                        removed_results += 1
                    job["resultAvailable"] = False
                    job["resultExpired"] = True
                    self._persist(job)
                finished = float(job.get("finishedAt") or 0)
                if finished and now - finished > settings().job_ttl_s:
                    self._job_path(job_id).unlink(missing_ok=True)
                    self._result_path(job_id).unlink(missing_ok=True)
                    self._jobs.pop(job_id, None)
                    removed_jobs += 1
        return {"jobs": removed_jobs, "results": removed_results}

    def _expire_staged_file(self, result_path: Path) -> None:
        try:
            result = json.loads(result_path.read_text(encoding="utf-8"))
            value = result.get("value") if isinstance(result, dict) else None
            result_id = value.get("resultId") if isinstance(value, dict) else None
            if isinstance(result_id, str):
                store.result_path(result_id).unlink(missing_ok=True)
        except (OSError, ValueError, store.StoreError):
            return

    def submit(
        self,
        provider_id: str,
        provider_version: str,
        capability_id: str,
        inputs: Any,
        requested_model_sha: Any = None,
    ) -> dict[str, Any]:
        self.prune()
        if not isinstance(inputs, dict):
            raise JobRequestError("bad_input", "input must be an object")
        try:
            input_bytes = _json_bytes(inputs)
        except (TypeError, ValueError) as exc:
            raise JobRequestError("bad_input", "input must contain valid JSON") from exc
        if len(input_bytes) > settings().max_output_chars:
            raise JobRequestError("input_too_large", "provider input exceeds the service limit", 413)
        path_issues = reject_path_inputs(inputs)
        if path_issues:
            raise JobRequestError("path_input_forbidden", path_issues[0])
        try:
            record, capability = self.registry.resolve(provider_id, provider_version, capability_id)
        except ProviderLookupError as exc:
            status = 404 if exc.code in {"unknown_provider", "unknown_capability"} else 409
            if exc.code == "invalid_version_range":
                status = 400
            raise JobRequestError(exc.code, exc.message, status) from exc
        if settings().readonly and capability["effect"] == "staged-write":
            raise JobRequestError("readonly", "this service is running read-only", 403)
        input_issues = validate_value(inputs, capability["inputSchema"])
        if input_issues:
            raise JobRequestError("input_schema", input_issues[0])
        sha = model_sha(requested_model_sha)
        if requested_model_sha is not None and sha is None:
            raise JobRequestError("bad_model_sha", "modelSha must be a SHA-256 content hash")
        if capability["modelRequirement"] == "ifc-source":
            if sha is None:
                raise JobRequestError("model_required", "this capability requires modelSha")
            if not store.source_path(sha).is_file():
                raise JobRequestError("unknown_model", "the service does not hold that model", 404)
        else:
            sha = None
        with self._lock:
            active = sum(job.get("status") in ACTIVE for job in self._jobs.values())
            if active >= settings().max_queued_jobs:
                raise JobRequestError("job_queue_full", "the Local Studio job queue is full", 429)
            dedupe = self._dedupe(record, capability, sha)
            if dedupe:
                return dict(dedupe)
            job_id = uuid.uuid4().hex
            job = {
                "schemaVersion": 1,
                "id": job_id,
                "status": "queued",
                "providerId": record.manifest["id"],
                "providerVersion": record.manifest["version"],
                "capabilityId": capability_id,
                "modelSha": sha,
                "submittedAt": _now(),
                "progress": {"phase": "queued", "done": 0, "total": 1, "message": "Queued"},
                "resultAvailable": False,
            }
            self._jobs[job_id] = job
            self._cancel[job_id] = threading.Event()
            self._persist(job)
        audit.record(
            "provider.job.queued",
            jobId=job_id,
            provider=record.manifest["id"],
            capability=capability_id,
            model=sha[:12] if sha else None,
        )
        threading.Thread(
            target=self._run,
            args=(job_id, record, capability, dict(inputs)),
            daemon=True,
            name=f"provider-{provider_id.rpartition('.')[2]}-{job_id[:8]}",
        ).start()
        return dict(job)

    def _dedupe(
        self,
        record: ProviderRecord,
        capability: Mapping[str, Any],
        sha: str | None,
    ) -> dict[str, Any] | None:
        if capability["id"] != "ifc.convert" or not sha:
            return None
        for job in self._jobs.values():
            if (
                job.get("providerId") == record.manifest["id"]
                and job.get("capabilityId") == capability["id"]
                and job.get("modelSha") == sha
                and job.get("status") in ACTIVE
            ):
                return job
        return None

    def _provider_gate(self, record: ProviderRecord) -> threading.Semaphore:
        provider_id = str(record.manifest["id"])
        with self._lock:
            gate = self._provider_gates.get(provider_id)
            if gate is None:
                declared = int(record.manifest["limits"]["maxConcurrency"])
                gate = threading.Semaphore(min(declared, settings().job_concurrency))
                self._provider_gates[provider_id] = gate
            return gate

    def _run(
        self,
        job_id: str,
        record: ProviderRecord,
        capability: Mapping[str, Any],
        inputs: dict[str, Any],
    ) -> None:
        cancel = self._cancel[job_id]
        provider_gate = self._provider_gate(record)
        while not cancel.is_set():
            if self._global_gate.acquire(timeout=0.1):
                break
        else:
            return self._finish_cancel(job_id)
        try:
            while not cancel.is_set():
                if provider_gate.acquire(timeout=0.1):
                    break
            else:
                return self._finish_cancel(job_id)
            try:
                self._execute(job_id, record, capability, inputs, cancel)
            finally:
                provider_gate.release()
        finally:
            self._global_gate.release()
            with self._lock:
                self._cancel.pop(job_id, None)

    def _execute(
        self,
        job_id: str,
        record: ProviderRecord,
        capability: Mapping[str, Any],
        inputs: dict[str, Any],
        cancel: threading.Event,
    ) -> None:
        started = time.time()
        self._update(
            job_id,
            status="running",
            startedAt=round(started, 3),
            progress={"phase": "starting", "done": 0, "total": 1, "message": "Starting provider"},
        )
        audit.record(
            "provider.job.start",
            jobId=job_id,
            provider=record.manifest["id"],
            capability=capability["id"],
        )
        declared_timeout = float(capability.get("timeoutSeconds") or record.manifest["limits"]["timeoutSeconds"])
        request = {
            "providerId": record.manifest["id"],
            "providerVersion": record.manifest["version"],
            "capabilityId": capability["id"],
            "modelSha": self._jobs[job_id].get("modelSha"),
            "input": inputs,
            "timeoutSeconds": min(declared_timeout, settings().provider_timeout_s),
            "memoryBytes": min(
                int(record.manifest["limits"]["memoryBytes"]),
                settings().memory_bytes,
            ),
        }
        outcome = self.executor(request, cancel, lambda value: self._progress(job_id, value))
        if cancel.is_set() or outcome.get("error") == "cancelled":
            return self._finish_cancel(job_id)
        elapsed = round((time.time() - started) * 1000)
        if outcome.get("error"):
            error = {
                "code": str(outcome.get("error")),
                "message": str(outcome.get("message") or outcome.get("error")),
            }
            details = {key: value for key, value in outcome.items() if key not in {"error", "message"}}
            if details:
                error["details"] = details
            self._update(job_id, status="failed", finishedAt=_now(), elapsedMs=elapsed, error=error)
            audit.record(
                "provider.job.finish",
                jobId=job_id,
                provider=record.manifest["id"],
                capability=capability["id"],
                outcome=error["code"],
                elapsedMs=elapsed,
            )
            return
        value = outcome.get("value")
        result_issues = validate_value(value, capability["resultSchema"], "result")
        try:
            encoded = _json_bytes(value)
        except (TypeError, ValueError):
            result_issues.append("result must contain valid JSON")
        if result_issues:
            self._update(
                job_id,
                status="failed",
                finishedAt=_now(),
                elapsedMs=elapsed,
                error={"code": "result_schema", "message": result_issues[0]},
            )
            audit.record(
                "provider.job.finish",
                jobId=job_id,
                provider=record.manifest["id"],
                capability=capability["id"],
                outcome="result_schema",
                elapsedMs=elapsed,
            )
            return
        if len(encoded) > settings().max_output_chars:
            self._update(
                job_id,
                status="failed",
                finishedAt=_now(),
                elapsedMs=elapsed,
                error={"code": "result_too_large", "message": "the provider result exceeds the output limit"},
            )
            return
        ttl = min(
            float(record.manifest["limits"]["resultTtlSeconds"]),
            settings().result_ttl_s,
        )
        expires = round(time.time() + ttl, 3)
        result = {
            "schemaVersion": 1,
            "jobId": job_id,
            "providerId": record.manifest["id"],
            "providerVersion": record.manifest["version"],
            "capabilityId": capability["id"],
            "createdAt": _now(),
            "expiresAt": expires,
            "value": value,
        }
        self._write(self._result_path(job_id), result)
        output_hash = hashlib.sha256(encoded).hexdigest()
        self._update(
            job_id,
            status="succeeded",
            finishedAt=_now(),
            elapsedMs=elapsed,
            resultAvailable=True,
            resultExpiresAt=expires,
            resultSchemaVersion=1,
            outputSha256=output_hash,
            progress={"phase": "complete", "done": 1, "total": 1, "message": "Complete"},
        )
        audit.record(
            "provider.job.finish",
            jobId=job_id,
            provider=record.manifest["id"],
            capability=capability["id"],
            model=(self._jobs[job_id].get("modelSha") or "")[:12] or None,
            outcome="ok",
            elapsedMs=elapsed,
            outputSha256=output_hash,
        )

    def _progress(self, job_id: str, value: Mapping[str, Any]) -> None:
        phase = str(value.get("phase") or "working")[:80]
        message = str(value.get("message") or "Working")[:500]
        try:
            done = float(value.get("done", 0))
            total = max(float(value.get("total", 1)), 0.0)
        except (TypeError, ValueError):
            done, total = 0.0, 1.0
        if not math.isfinite(done) or not math.isfinite(total):
            done, total = 0.0, 1.0
        progress: dict[str, Any] = {
            "phase": phase,
            "done": max(0.0, done),
            "total": total,
            "message": message,
        }
        partial = value.get("partialResultHandle")
        if isinstance(partial, str) and re_job_id(partial):
            progress["partialResultHandle"] = partial
        self._update(job_id, progress=progress)

    def _finish_cancel(self, job_id: str) -> None:
        job = self.get(job_id)
        if job and job.get("status") not in TERMINAL:
            self._update(
                job_id,
                status="cancelled",
                finishedAt=_now(),
                error={"code": "cancelled", "message": "the provider job was cancelled"},
                progress={"phase": "cancelled", "done": 0, "total": 1, "message": "Cancelled"},
            )
            audit.record(
                "provider.job.cancelled",
                jobId=job_id,
                provider=job.get("providerId"),
                capability=job.get("capabilityId"),
            )

    def _update(self, job_id: str, **fields: Any) -> None:
        with self._lock:
            job = self._jobs[job_id]
            if job.get("status") in TERMINAL and fields.get("status") not in {None, job.get("status")}:
                return
            job.update(fields)
            self._persist(job)

    def get(self, job_id: str) -> dict[str, Any] | None:
        self.prune()
        with self._lock:
            job = self._jobs.get(job_id)
            return dict(job) if job else None

    def cancel(self, job_id: str) -> dict[str, Any] | None:
        with self._lock:
            job = self._jobs.get(job_id)
            if job is None:
                return None
            if job.get("status") in TERMINAL:
                return dict(job)
            cancel = self._cancel.get(job_id)
            if cancel:
                cancel.set()
            if job.get("status") == "queued":
                self._finish_cancel(job_id)
            return dict(self._jobs[job_id])

    def wait(self, job_id: str, timeout: float | None = None) -> dict[str, Any] | None:
        deadline = None if timeout is None else time.monotonic() + timeout
        while True:
            job = self.get(job_id)
            if job is None or job.get("status") in TERMINAL:
                return job
            if deadline is not None and time.monotonic() >= deadline:
                return job
            time.sleep(0.05)

    def result(self, job_id: str) -> tuple[str, dict[str, Any] | None]:
        job = self.get(job_id)
        if job is None:
            return "unknown", None
        if job.get("resultExpired"):
            return "expired", None
        if job.get("status") != "succeeded":
            return "not_ready", job
        path = self._result_path(job_id)
        if not path.is_file():
            return "expired", None
        try:
            return "ok", json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return "expired", None


def re_job_id(value: str) -> bool:
    return len(value) == 32 and all(character in "0123456789abcdef" for character in value)
