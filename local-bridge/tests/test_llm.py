from __future__ import annotations

import json

import pytest

from ifcviewx import llm


class StreamResponse:
    headers = {"content-type": "text/event-stream"}

    def __init__(self, events: list[dict]) -> None:
        self.lines = [f"data: {json.dumps(event)}\n\n".encode() for event in events]

    def __iter__(self):
        return iter(self.lines)

    def __enter__(self):
        return self

    def __exit__(self, *_args) -> None:
        return None


def settings(provider: str = "openai") -> dict:
    return {
        "provider": provider,
        "baseUrl": "https://provider.example/v1" if provider == "openai" else "https://provider.example",
        "model": "model-a",
        "key": "secret",
        "multimodal": False,
    }


def test_openai_payload_uses_native_tools_and_stream_usage() -> None:
    tool = {
        "name": "result__group",
        "description": "Group an existing result",
        "schema": {
            "type": "object",
            "properties": {"handle": {"type": "string"}, "field": {"type": "string"}},
            "required": ["handle", "field"],
            "additionalProperties": False,
        },
    }
    _url, _headers, body = llm._payload(
        settings(),
        [{"role": "user", "content": "Group those by storey"}],
        [tool],
        None,
        True,
    )

    assert body["stream"] is True
    assert body["stream_options"] == {"include_usage": True}
    assert body["tools"][0]["function"]["name"] == "result__group"
    assert body["tools"][0]["function"]["parameters"]["additionalProperties"] is False


def test_openai_stream_reassembles_tool_arguments() -> None:
    response = StreamResponse(
        [
            {"choices": [{"delta": {"content": "Checking"}}]},
            {
                "choices": [
                    {
                        "delta": {
                            "tool_calls": [
                                {
                                    "index": 0,
                                    "id": "c1",
                                    "function": {"name": "find", "arguments": '{"type":'},
                                }
                            ]
                        }
                    }
                ]
            },
            {
                "choices": [
                    {"delta": {"tool_calls": [{"index": 0, "function": {"arguments": '"IfcWall"}'}}]}}
                ]
            },
            {"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": 6}},
        ]
    )

    events = list(llm._stream_openai(response, True))

    call = next(event["call"] for event in events if event["type"] == "tool_call")
    assert call == {"id": "c1", "name": "find", "input": {"type": "IfcWall"}}
    assert events[-1]["toolsUsed"] is True
    assert events[-1]["text"] == "Checking"


def test_view_image_requires_an_explicit_multimodal_service_setting() -> None:
    messages = [
        {
            "role": "user",
            "content": "VIEWER_CONTEXT_V1",
            "image": {"mimeType": "image/jpeg", "dataUrl": "data:image/jpeg;base64,AA=="},
        }
    ]

    with pytest.raises(ValueError, match="does not declare image support"):
        llm._clean_messages(messages, False)

    clean = llm._clean_messages(messages, True)
    assert clean[0]["image"]["dataUrl"] == "data:image/jpeg;base64,AA=="

