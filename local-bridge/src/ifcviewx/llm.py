"""Optional assistant proxy with native tools and normalized streaming.

The provider URL and key come from the environment. Redirects are refused and
the key is never returned to the browser. View images are accepted only when
IFCVIEWX_LLM_MULTIMODAL is explicitly enabled.
"""

from __future__ import annotations

import json
import re
import time
import urllib.error
import urllib.request
from collections.abc import Iterator
from typing import Any

from .config import env

TIMEOUT_S = 180
MAX_MESSAGES = 80
MAX_CHARS = 4_000_000
MAX_TOOLS = 96
MAX_TOKENS = 16_384
MAX_SYSTEM_MESSAGES = 8
MAX_PROVIDER_BYTES = 16 * 1024 * 1024
MAX_EVENT_LINE_BYTES = 1024 * 1024
MAX_RESPONSE_CHARS = 4_000_000
MAX_TOOL_ARGUMENT_CHARS = 1_000_000
ANTHROPIC_VERSION = "2023-06-01"


def _truthy(value: str | None) -> bool:
    return (value or "").strip().lower() in {"1", "true", "yes", "on"}


def config() -> dict[str, Any]:
    provider = (env("LLM_PROVIDER") or "").strip().lower()
    base = (env("LLM_BASE_URL") or "").strip().rstrip("/")
    if provider == "anthropic" and not base:
        base = "https://api.anthropic.com"
    return {
        "provider": provider,
        "baseUrl": base,
        "model": (env("LLM_MODEL") or "").strip(),
        "key": (env("LLM_API_KEY") or "").strip(),
        "multimodal": _truthy(env("LLM_MULTIMODAL")),
    }


def configured() -> bool:
    settings = config()
    return bool(settings["provider"] and settings["baseUrl"] and settings["model"])


def describe() -> dict[str, Any]:
    settings = config()
    return {
        "configured": configured(),
        "provider": settings["provider"],
        "model": settings["model"],
        "baseUrl": settings["baseUrl"],
        "multimodal": settings["multimodal"],
    }


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


_opener = urllib.request.build_opener(_NoRedirect())


def _request(url: str, headers: dict[str, str], body: dict[str, Any]):
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", **headers},
        method="POST",
    )
    return _opener.open(request, timeout=TIMEOUT_S)  # noqa: S310


def _post(url: str, headers: dict[str, str], body: dict[str, Any]) -> dict[str, Any]:
    with _request(url, headers, body) as response:
        raw = response.read(MAX_PROVIDER_BYTES + 1)
        if len(raw) > MAX_PROVIDER_BYTES:
            raise ValueError("the assistant provider response exceeds the proxy size limit")
        data = json.loads(raw.decode("utf-8", "replace"))
        if not isinstance(data, dict):
            raise ValueError("the assistant provider returned a non-object response")
        return data


def _clean_messages(messages: list[dict[str, Any]], multimodal: bool) -> list[dict[str, Any]]:
    system = [raw for raw in messages if isinstance(raw, dict) and raw.get("role") == "system"]
    if len(system) > MAX_SYSTEM_MESSAGES:
        half = MAX_SYSTEM_MESSAGES // 2
        system = [*system[:half], *system[-half:]]
    turns = [raw for raw in messages if not (isinstance(raw, dict) and raw.get("role") == "system")]
    selected = [*system, *turns[-(MAX_MESSAGES - len(system)):]]
    clean: list[dict[str, Any]] = []
    for raw in selected:
        if not isinstance(raw, dict):
            continue
        message: dict[str, Any] = {
            "role": str(raw.get("role", "user")),
            "content": str(raw.get("content", "")),
        }
        calls = raw.get("calls")
        if isinstance(calls, list):
            message["calls"] = calls
        if raw.get("callId") is not None:
            message["callId"] = str(raw["callId"])
        if raw.get("name") is not None:
            message["name"] = str(raw["name"])
        image = raw.get("image")
        if isinstance(image, dict):
            if not multimodal:
                raise ValueError("the local assistant provider does not declare image support")
            data_url = str(image.get("dataUrl", ""))
            mime = str(image.get("mimeType", ""))
            if not data_url.startswith("data:image/") or mime not in {"image/jpeg", "image/png"}:
                raise ValueError("the attached view image is invalid")
            message["image"] = {"dataUrl": data_url, "mimeType": mime}
        clean.append(message)
    if len(json.dumps(clean)) > MAX_CHARS:
        raise ValueError("the conversation exceeds the proxy size limit")
    return clean


def _clean_tools(tools: list[dict[str, Any]]) -> list[dict[str, Any]]:
    if len(tools) > MAX_TOOLS:
        raise ValueError(f"at most {MAX_TOOLS} assistant tools are allowed")
    clean: list[dict[str, Any]] = []
    for raw in tools:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name", ""))
        schema = raw.get("schema")
        if not name or not isinstance(schema, dict) or schema.get("type") != "object":
            raise ValueError("every assistant tool needs a name and object schema")
        clean.append(
            {
                "name": name,
                "description": str(raw.get("description", ""))[:1024],
                "schema": schema,
            }
        )
    if len(json.dumps(clean)) > 256_000:
        raise ValueError("assistant tool schemas exceed the proxy size limit")
    return clean


def _image_block(message: dict[str, Any]) -> dict[str, Any] | None:
    image = message.get("image")
    if not isinstance(image, dict):
        return None
    data_url = str(image["dataUrl"])
    _, _, data = data_url.partition(",")
    return {
        "type": "image",
        "source": {
            "type": "base64",
            "media_type": image["mimeType"],
            "data": data,
        },
    }


def _anthropic_messages(clean: list[dict[str, Any]]) -> tuple[str, list[dict[str, Any]]]:
    system = "\n\n".join(m["content"] for m in clean if m["role"] == "system")
    turns: list[dict[str, Any]] = []
    for message in clean:
        if message["role"] == "system":
            continue
        if message["role"] == "tool":
            content: Any = [
                {
                    "type": "tool_result",
                    "tool_use_id": message.get("callId", ""),
                    "content": message["content"],
                }
            ]
            turns.append({"role": "user", "content": content})
            continue
        blocks: list[dict[str, Any]] = []
        image = _image_block(message)
        if image:
            blocks.append(image)
        if message["content"]:
            blocks.append({"type": "text", "text": message["content"]})
        for call in message.get("calls", []):
            if isinstance(call, dict):
                blocks.append(
                    {
                        "type": "tool_use",
                        "id": str(call.get("id", "")),
                        "name": str(call.get("name", "")),
                        "input": call.get("input") if isinstance(call.get("input"), dict) else {},
                    }
                )
        turns.append({"role": message["role"], "content": blocks or message["content"]})
    return system, turns


def _openai_messages(clean: list[dict[str, Any]]) -> list[dict[str, Any]]:
    turns: list[dict[str, Any]] = []
    for message in clean:
        if message["role"] == "tool":
            turns.append(
                {
                    "role": "tool",
                    "tool_call_id": message.get("callId", ""),
                    "content": message["content"],
                }
            )
            continue
        entry: dict[str, Any] = {"role": message["role"], "content": message["content"]}
        image = message.get("image")
        if isinstance(image, dict):
            entry["content"] = [
                {"type": "text", "text": message["content"]},
                {"type": "image_url", "image_url": {"url": image["dataUrl"], "detail": "low"}},
            ]
        calls = message.get("calls")
        if isinstance(calls, list) and calls:
            entry["content"] = message["content"] or None
            entry["tool_calls"] = [
                {
                    "id": str(call.get("id", "")),
                    "type": "function",
                    "function": {
                        "name": str(call.get("name", "")),
                        "arguments": json.dumps(call.get("input") or {}),
                    },
                }
                for call in calls
                if isinstance(call, dict)
            ]
        turns.append(entry)
    return turns


def _payload(
    settings: dict[str, Any],
    clean: list[dict[str, Any]],
    tools: list[dict[str, Any]],
    model: str | None,
    stream: bool,
) -> tuple[str, dict[str, str], dict[str, Any]]:
    raw_target = model if model is not None else settings["model"]
    if not isinstance(raw_target, str) or not raw_target.strip():
        raise ValueError("the assistant model must be a non-empty string")
    target = raw_target.strip()
    if settings["provider"] == "anthropic":
        system, turns = _anthropic_messages(clean)
        body: dict[str, Any] = {
            "model": target,
            "max_tokens": MAX_TOKENS,
            "messages": turns,
            "stream": stream,
        }
        if system:
            body["system"] = system
        if tools:
            body["tools"] = [
                {
                    "name": tool["name"],
                    "description": tool["description"],
                    "input_schema": tool["schema"],
                }
                for tool in tools
            ]
        return (
            f"{settings['baseUrl']}/v1/messages",
            {"x-api-key": settings["key"], "anthropic-version": ANTHROPIC_VERSION},
            body,
        )
    token_field = (
        "max_completion_tokens"
        if re.match(r"^(?:gpt-5(?:[.-]|$)|o[134](?:[.-]|$))", target, re.IGNORECASE)
        else "max_tokens"
    )
    body = {
        "model": target,
        token_field: MAX_TOKENS,
        "messages": _openai_messages(clean),
        "stream": stream,
    }
    if stream:
        body["stream_options"] = {"include_usage": True}
    if tools:
        body["tools"] = [
            {
                "type": "function",
                "function": {
                    "name": tool["name"],
                    "description": tool["description"],
                    "parameters": tool["schema"],
                },
            }
            for tool in tools
        ]
    headers = {"Authorization": f"Bearer {settings['key']}"} if settings["key"] else {}
    return f"{settings['baseUrl']}/chat/completions", headers, body


def _turn_from_data(provider: str, data: dict[str, Any], offered: bool) -> dict[str, Any]:
    if provider == "anthropic":
        blocks = data.get("content") or []
        for block in blocks:
            if isinstance(block, dict) and block.get("type") == "tool_use":
                if len(json.dumps(block.get("input") or {})) > MAX_TOOL_ARGUMENT_CHARS:
                    raise ValueError("assistant tool arguments exceed the proxy size limit")
        calls = [
            {
                "id": str(block.get("id", "")),
                "name": str(block.get("name", "")),
                "input": block.get("input") if isinstance(block.get("input"), dict) else {},
            }
            for block in blocks
            if isinstance(block, dict) and block.get("type") == "tool_use"
        ]
        usage = data.get("usage") or {}
        content = "".join(
                str(block.get("text", ""))
                for block in blocks
                if isinstance(block, dict) and block.get("type") == "text"
            )
        if len(content) > MAX_RESPONSE_CHARS:
            raise ValueError("the assistant provider text exceeds the proxy size limit")
        return {
            "content": content,
            "calls": calls,
            "toolsUsed": offered,
            "usage": {
                "input": int(usage.get("input_tokens") or 0),
                "output": int(usage.get("output_tokens") or 0),
            },
            "model": data.get("model"),
        }
    choice = (data.get("choices") or [{}])[0]
    message = choice.get("message") or {}
    calls = []
    for call in message.get("tool_calls") or []:
        function = call.get("function") or {}
        arguments = str(function.get("arguments") or "{}")
        if len(arguments) > MAX_TOOL_ARGUMENT_CHARS:
            raise ValueError("assistant tool arguments exceed the proxy size limit")
        try:
            inputs = json.loads(arguments)
        except ValueError:
            inputs = {}
        calls.append(
            {
                "id": str(call.get("id", "")),
                "name": str(function.get("name", "")),
                "input": inputs if isinstance(inputs, dict) else {},
            }
        )
    usage = data.get("usage") or {}
    content = str(message.get("content") or "")
    if len(content) > MAX_RESPONSE_CHARS:
        raise ValueError("the assistant provider text exceeds the proxy size limit")
    return {
        "content": content,
        "calls": calls,
        "toolsUsed": offered,
        "usage": {
            "input": int(usage.get("prompt_tokens") or 0),
            "output": int(usage.get("completion_tokens") or 0),
        },
        "model": data.get("model"),
    }


def chat_turn(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    model: str | None = None,
) -> dict[str, Any]:
    settings = config()
    if not configured():
        return {"error": "not_configured", "message": "the service has no assistant provider configured"}
    if not settings["baseUrl"].startswith(("http://", "https://")):
        return {"error": "bad_base_url", "message": "IFCVIEWX_LLM_BASE_URL must be http(s)"}
    try:
        clean = _clean_messages(messages, bool(settings["multimodal"]))
        offered = _clean_tools(tools or [])
        url, headers, body = _payload(settings, clean, offered, model, False)
        data = _post(url, headers, body)
        return _turn_from_data(settings["provider"], data, bool(offered))
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", "replace")[:300]
        if tools and exc.code in {400, 404} and any(word in detail.lower() for word in ("tool", "function")):
            return {"content": "", "calls": [], "toolsUsed": False}
        return {"error": "provider_error", "message": f"HTTP {exc.code}: {detail}"}
    except (urllib.error.URLError, TimeoutError) as exc:
        return {"error": "unreachable", "message": str(exc)}
    except ValueError as exc:
        return {"error": "bad_request", "message": str(exc)}


def _response_lines(response) -> Iterator[bytes]:
    readline = getattr(response, "readline", None)
    if callable(readline):
        while raw := readline(MAX_EVENT_LINE_BYTES + 1):
            if len(raw) > MAX_EVENT_LINE_BYTES:
                raise ValueError("an assistant provider stream event exceeds the size limit")
            yield raw
        return
    for raw in response:
        if len(raw) > MAX_EVENT_LINE_BYTES:
            raise ValueError("an assistant provider stream event exceeds the size limit")
        yield raw


def _data_events(response) -> Iterator[dict[str, Any]]:
    started = time.monotonic()
    total = 0
    for raw in _response_lines(response):
        total += len(raw)
        if total > MAX_PROVIDER_BYTES:
            raise ValueError("the assistant provider stream exceeds the proxy size limit")
        if time.monotonic() - started > TIMEOUT_S:
            raise TimeoutError("the assistant provider stream exceeded its wall-time limit")
        line = raw.decode("utf-8", "replace").strip()
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload:
            continue
        if payload == "[DONE]":
            yield {"_ifcviewx_done": True}
            continue
        try:
            event = json.loads(payload)
        except ValueError:
            continue
        if isinstance(event, dict):
            yield event


def _stream_openai(response, offered: bool) -> Iterator[dict[str, Any]]:
    text_parts: list[str] = []
    text_chars = 0
    calls: dict[int, dict[str, str]] = {}
    usage = {"input": 0, "output": 0}
    terminal = False
    for event in _data_events(response):
        if event.get("_ifcviewx_done"):
            terminal = True
            continue
        raw_usage = event.get("usage") or {}
        if raw_usage:
            usage = {
                "input": int(raw_usage.get("prompt_tokens") or 0),
                "output": int(raw_usage.get("completion_tokens") or 0),
            }
        for choice in event.get("choices") or []:
            if choice.get("finish_reason") is not None:
                terminal = True
            delta = choice.get("delta") or {}
            chunk = delta.get("content")
            if chunk:
                value = str(chunk)
                text_chars += len(value)
                if text_chars > MAX_RESPONSE_CHARS:
                    raise ValueError("the assistant provider text exceeds the proxy size limit")
                text_parts.append(value)
                yield {"type": "text_delta", "delta": value}
            for part in delta.get("tool_calls") or []:
                index = int(part.get("index") or 0)
                target = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                if part.get("id"):
                    target["id"] = str(part["id"])
                function = part.get("function") or {}
                if function.get("name"):
                    target["name"] += str(function["name"])
                if function.get("arguments"):
                    argument_chunk = str(function["arguments"])
                    if len(target["arguments"]) + len(argument_chunk) > MAX_TOOL_ARGUMENT_CHARS:
                        raise ValueError("assistant tool arguments exceed the proxy size limit")
                    target["arguments"] += argument_chunk
    if not terminal:
        raise ValueError("the assistant provider stream ended before its terminal event")
    normalized = []
    for call in calls.values():
        try:
            inputs = json.loads(call["arguments"] or "{}")
        except ValueError:
            inputs = {}
        normalized.append(
            {"id": call["id"], "name": call["name"], "input": inputs if isinstance(inputs, dict) else {}}
        )
    for call in normalized:
        yield {"type": "tool_call", "call": call}
    if usage["input"] or usage["output"]:
        yield {"type": "usage", "usage": usage}
    yield {"type": "done", "text": "".join(text_parts), "calls": normalized, "toolsUsed": offered}


def _stream_anthropic(response, offered: bool) -> Iterator[dict[str, Any]]:
    text_parts: list[str] = []
    text_chars = 0
    calls: dict[int, dict[str, str]] = {}
    usage = {"input": 0, "output": 0}
    terminal = False
    for event in _data_events(response):
        kind = event.get("type")
        if kind == "message_stop":
            terminal = True
        if kind == "error":
            error = event.get("error") or {}
            yield {"type": "error", "message": str(error.get("message") or "provider stream failed")}
            return
        if kind == "message_start":
            raw = (event.get("message") or {}).get("usage") or {}
            usage["input"] = int(raw.get("input_tokens") or 0)
        if kind == "message_delta":
            raw = event.get("usage") or {}
            usage["output"] = int(raw.get("output_tokens") or usage["output"])
        if kind == "content_block_start":
            block = event.get("content_block") or {}
            if block.get("type") == "tool_use":
                calls[int(event.get("index") or 0)] = {
                    "id": str(block.get("id", "")),
                    "name": str(block.get("name", "")),
                    "arguments": json.dumps(block.get("input") or {}) if block.get("input") else "",
                }
        if kind == "content_block_delta":
            delta = event.get("delta") or {}
            if delta.get("type") == "text_delta" and delta.get("text"):
                chunk = str(delta["text"])
                text_chars += len(chunk)
                if text_chars > MAX_RESPONSE_CHARS:
                    raise ValueError("the assistant provider text exceeds the proxy size limit")
                text_parts.append(chunk)
                yield {"type": "text_delta", "delta": chunk}
            if delta.get("type") == "input_json_delta":
                index = int(event.get("index") or 0)
                target = calls.setdefault(index, {"id": "", "name": "", "arguments": ""})
                argument_chunk = str(delta.get("partial_json") or "")
                if len(target["arguments"]) + len(argument_chunk) > MAX_TOOL_ARGUMENT_CHARS:
                    raise ValueError("assistant tool arguments exceed the proxy size limit")
                target["arguments"] += argument_chunk
    if not terminal:
        raise ValueError("the assistant provider stream ended before its terminal event")
    normalized = []
    for call in calls.values():
        try:
            inputs = json.loads(call["arguments"] or "{}")
        except ValueError:
            inputs = {}
        normalized.append({"id": call["id"], "name": call["name"], "input": inputs})
    for call in normalized:
        yield {"type": "tool_call", "call": call}
    if usage["input"] or usage["output"]:
        yield {"type": "usage", "usage": usage}
    yield {"type": "done", "text": "".join(text_parts), "calls": normalized, "toolsUsed": offered}


def stream_chat(
    messages: list[dict[str, Any]],
    tools: list[dict[str, Any]] | None = None,
    model: str | None = None,
) -> Iterator[dict[str, Any]]:
    settings = config()
    if not configured():
        yield {"type": "error", "message": "the service has no assistant provider configured"}
        return
    try:
        clean = _clean_messages(messages, bool(settings["multimodal"]))
        offered = _clean_tools(tools or [])
        url, headers, body = _payload(settings, clean, offered, model, True)
        with _request(url, headers, body) as response:
            content_type = response.headers.get("content-type", "")
            if "text/event-stream" not in content_type:
                raw = response.read(MAX_PROVIDER_BYTES + 1)
                if len(raw) > MAX_PROVIDER_BYTES:
                    raise ValueError("the assistant provider response exceeds the proxy size limit")
                data = json.loads(raw.decode("utf-8", "replace"))
                if not isinstance(data, dict):
                    raise ValueError("the assistant provider returned a non-object response")
                turn = _turn_from_data(settings["provider"], data, bool(offered))
                if turn["content"]:
                    yield {"type": "text_delta", "delta": turn["content"]}
                for call in turn["calls"]:
                    yield {"type": "tool_call", "call": call}
                yield {"type": "usage", "usage": turn["usage"]}
                yield {"type": "done", "text": turn["content"], "calls": turn["calls"], "toolsUsed": bool(offered)}
                return
            if settings["provider"] == "anthropic":
                yield from _stream_anthropic(response, bool(offered))
            else:
                yield from _stream_openai(response, bool(offered))
    except urllib.error.HTTPError as exc:
        detail = exc.read(4096).decode("utf-8", "replace")[:300]
        if tools and exc.code in {400, 404} and any(word in detail.lower() for word in ("tool", "function")):
            yield {"type": "done", "text": "", "calls": [], "toolsUsed": False}
            return
        yield {"type": "error", "message": f"HTTP {exc.code}: {detail}"}
    except (urllib.error.URLError, TimeoutError, ValueError) as exc:
        yield {"type": "error", "message": str(exc)}


def chat(messages: list[dict[str, Any]], model: str | None = None) -> dict[str, Any]:
    """Compatibility response for the original non-tool endpoint."""
    outcome = chat_turn(messages, [], model)
    if outcome.get("error"):
        return outcome
    return {"content": outcome.get("content", ""), "model": outcome.get("model")}
