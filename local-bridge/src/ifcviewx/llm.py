"""Optional assistant proxy.

When the service holds the provider key, the browser never has to. The target
URL comes from the environment only, redirects are never followed, and the
key is never echoed back in any response.

Env: IFCVIEWX_LLM_PROVIDER (openai-compatible | anthropic)
     IFCVIEWX_LLM_BASE_URL, IFCVIEWX_LLM_API_KEY, IFCVIEWX_LLM_MODEL
"""

from __future__ import annotations

import json
import urllib.error
import urllib.request

from .config import env

TIMEOUT_S = 180
MAX_MESSAGES = 80
MAX_CHARS = 400_000
ANTHROPIC_VERSION = "2023-06-01"


def config() -> dict:
    provider = (env("LLM_PROVIDER") or "").strip().lower()
    base = (env("LLM_BASE_URL") or "").strip().rstrip("/")
    if provider == "anthropic" and not base:
        base = "https://api.anthropic.com"
    return {
        "provider": provider,
        "baseUrl": base,
        "model": (env("LLM_MODEL") or "").strip(),
        "key": (env("LLM_API_KEY") or "").strip(),
    }


def configured() -> bool:
    settings = config()
    return bool(settings["provider"] and settings["baseUrl"] and settings["model"])


def describe() -> dict:
    """Safe-to-publish view: which provider and model, never the key."""
    settings = config()
    return {
        "configured": configured(),
        "provider": settings["provider"],
        "model": settings["model"],
        "baseUrl": settings["baseUrl"],
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def _post(url: str, headers: dict, body: dict) -> dict:
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    with _opener.open(request, timeout=TIMEOUT_S) as response:  # noqa: S310 - fixed scheme, env-controlled host
        return json.loads(response.read().decode("utf-8", "replace"))


def chat(messages: list[dict], model: str | None = None) -> dict:
    """One completion. Errors come back as {error, message}, never as raises."""
    settings = config()
    if not configured():
        return {"error": "not_configured", "message": "the service has no assistant provider configured"}
    if not settings["baseUrl"].startswith(("http://", "https://")):
        return {"error": "bad_base_url", "message": "IFCVIEWX_LLM_BASE_URL must be http(s)"}

    clean = [
        {"role": str(m.get("role", "user")), "content": str(m.get("content", ""))}
        for m in messages[-MAX_MESSAGES:]
        if isinstance(m, dict)
    ]
    if sum(len(m["content"]) for m in clean) > MAX_CHARS:
        return {"error": "too_large", "message": "the conversation exceeds the proxy size limit"}

    target = model or settings["model"]
    try:
        if settings["provider"] == "anthropic":
            system = "\n\n".join(m["content"] for m in clean if m["role"] == "system")
            payload = {
                "model": target,
                "max_tokens": 4096,
                "messages": [m for m in clean if m["role"] != "system"],
            }
            if system:
                payload["system"] = system
            data = _post(
                f"{settings['baseUrl']}/v1/messages",
                {"x-api-key": settings["key"], "anthropic-version": ANTHROPIC_VERSION},
                payload,
            )
            parts = [b.get("text", "") for b in data.get("content", []) if b.get("type") == "text"]
            return {"content": "".join(parts), "model": data.get("model", target)}

        data = _post(
            f"{settings['baseUrl']}/chat/completions",
            {"Authorization": f"Bearer {settings['key']}"} if settings["key"] else {},
            {"model": target, "messages": clean},
        )
        choice = (data.get("choices") or [{}])[0]
        return {
            "content": str((choice.get("message") or {}).get("content", "")),
            "model": data.get("model", target),
        }
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        return {"error": "provider_error", "message": f"HTTP {exc.code}: {detail}"}
    except (urllib.error.URLError, TimeoutError) as exc:
        return {"error": "unreachable", "message": str(exc)}
    except ValueError as exc:
        return {"error": "bad_response", "message": str(exc)}
