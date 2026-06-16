from __future__ import annotations

import base64
import json
import unittest
from unittest import mock

from curl_cffi import requests as curl_requests

import services.openai_backend_api as backend_module
from services.openai_backend_api import OpenAIBackendAPI
from services.protocol import conversation as conversation_module
from services.protocol.conversation import ConversationRequest, image_stream_error_message, stream_image_outputs


class FakeCurlResponse:
    def __init__(self, lines=None, exc: Exception | None = None, content: bytes = b"image-bytes") -> None:
        self.lines = list(lines or [])
        self.exc = exc
        self.content = content
        self.status_code = 200
        self.headers = {}
        self.text = ""
        self.closed = False

    def iter_lines(self):
        if self.exc:
            raise self.exc
        yield from self.lines

    def close(self) -> None:
        self.closed = True


class CodexImageResponsesTests(unittest.TestCase):
    def test_curl_56_image_error_is_user_friendly(self) -> None:
        message = image_stream_error_message(
            "Failed to perform, curl: (56) Connection closed abruptly. "
            "See https://curl.se/libcurl/c/libcurl-errors.html first for more details."
        )

        self.assertEqual(message, "upstream image connection failed, please retry later")

    def test_codex_image_response_body_carries_size_and_quality_in_tool(self) -> None:
        backend = OpenAIBackendAPI(access_token="test-token")

        body = backend._build_codex_image_response_body(
            "draw a poster",
            "codex-gpt-image-2",
            [],
            "1216x2160",
            "high",
        )

        self.assertEqual(body["model"], "gpt-5.4-mini")
        self.assertEqual(body["tool_choice"]["type"], "image_generation")
        tool = body["tools"][0]
        self.assertEqual(tool["type"], "image_generation")
        self.assertEqual(tool["action"], "generate")
        self.assertEqual(tool["model"], "gpt-image-2")
        self.assertEqual(tool["size"], "1216x2160")
        self.assertEqual(tool["quality"], "high")

    def test_codex_image_response_body_uses_input_images_for_edit(self) -> None:
        backend = OpenAIBackendAPI(access_token="test-token")
        png_b64 = base64.b64encode(b"\x89PNG\r\n\x1a\nfake").decode("ascii")

        body = backend._build_codex_image_response_body(
            "edit it",
            "gpt-image-2",
            [png_b64],
            "2048x2048",
            "medium",
        )

        tool = body["tools"][0]
        content = body["input"][0]["content"]
        self.assertEqual(tool["action"], "edit")
        self.assertEqual(tool["size"], "2048x2048")
        self.assertEqual(tool["quality"], "medium")
        self.assertEqual(content[0], {"type": "input_text", "text": "edit it"})
        self.assertTrue(content[1]["image_url"].startswith("data:image/png;base64,"))

    def test_paid_image_request_uses_codex_responses_path(self) -> None:
        result_b64 = base64.b64encode(b"image-bytes").decode("ascii")

        class FakeBackend:
            def __init__(self) -> None:
                self.kwargs = {}

            def stream_codex_image_response_events(self, **kwargs):
                self.kwargs = kwargs
                yield {
                    "type": "response.output_item.done",
                    "item": {
                        "type": "image_generation_call",
                        "result": result_b64,
                        "revised_prompt": "revised prompt",
                    },
                }

        backend = FakeBackend()
        request = ConversationRequest(
            prompt="draw",
            model="gpt-image-2",
            account_type="paid",
            size="1216x2160",
            quality="high",
            response_format="b64_json",
        )

        with mock.patch.object(conversation_module, "save_image_bytes", return_value="http://local/image.png"):
            outputs = list(stream_image_outputs(backend, request))

        self.assertEqual(backend.kwargs["size"], "1216x2160")
        self.assertEqual(backend.kwargs["quality"], "high")
        self.assertEqual(backend.kwargs["model"], "gpt-image-2")
        result = [item for item in outputs if item.kind == "result"][0]
        self.assertEqual(result.data[0]["b64_json"], result_b64)
        self.assertEqual(result.data[0]["url"], "http://local/image.png")
        self.assertEqual(result.data[0]["revised_prompt"], "revised prompt")

    def test_default_image_stream_recovers_after_transient_sse_close(self) -> None:
        class FakeBackend:
            def __init__(self) -> None:
                self.resolve_args = None
                self.download_args = None

            def resolve_conversation_image_urls(self, conversation_id, file_ids, sediment_ids):
                self.resolve_args = (conversation_id, file_ids, sediment_ids)
                return ["https://example.test/image.png"]

            def download_image_bytes(self, urls):
                self.download_args = urls
                return [b"image-bytes"]

        def fake_conversation_events(*_args, **_kwargs):
            yield {
                "type": "conversation.event",
                "conversation_id": "conversation-1",
                "file_ids": [],
                "sediment_ids": [],
                "raw": {"type": "progress"},
            }
            raise curl_requests.exceptions.ConnectionError(
                "Failed to perform, curl: (56) Connection closed abruptly."
            )

        backend = FakeBackend()
        request = ConversationRequest(prompt="draw", model="gpt-image-2", account_type="free")

        with (
            mock.patch.object(conversation_module, "conversation_events", fake_conversation_events),
            mock.patch.object(conversation_module, "save_image_bytes", return_value="http://local/image.png"),
        ):
            outputs = list(stream_image_outputs(backend, request))

        self.assertEqual(backend.resolve_args, ("conversation-1", [], []))
        self.assertEqual(backend.download_args, ["https://example.test/image.png"])
        result = [item for item in outputs if item.kind == "result"][0]
        self.assertEqual(result.data[0]["url"], "http://local/image.png")

    def test_codex_image_response_retries_transient_stream_close(self) -> None:
        backend = OpenAIBackendAPI(access_token="test-token")
        payload = {
            "type": "response.output_item.done",
            "item": {
                "type": "image_generation_call",
                "result": base64.b64encode(b"image-bytes").decode("ascii"),
            },
        }
        responses = [
            FakeCurlResponse(exc=curl_requests.exceptions.ConnectionError(
                "Failed to perform, curl: (56) Connection closed abruptly."
            )),
            FakeCurlResponse(lines=[f"data: {json.dumps(payload)}".encode("utf-8")]),
        ]

        with (
            mock.patch.object(backend, "_start_codex_image_response", side_effect=responses),
            mock.patch.object(backend_module, "_image_transport_retry_sleep", return_value=None),
        ):
            events = list(backend.stream_codex_image_response_events("draw", "gpt-image-2", [], "1536x2048", "high"))

        self.assertEqual(events, [payload])

    def test_image_download_retries_transient_connection_close(self) -> None:
        backend = OpenAIBackendAPI(access_token="test-token")

        class FakeSession:
            def __init__(self) -> None:
                self.calls = 0

            def get(self, _url, timeout):
                self.calls += 1
                if self.calls == 1:
                    raise curl_requests.exceptions.ConnectionError(
                        "Failed to perform, curl: (56) Connection closed abruptly."
                    )
                return FakeCurlResponse(content=b"downloaded-image")

        session = FakeSession()
        backend.session = session

        with mock.patch.object(backend_module, "_image_transport_retry_sleep", return_value=None):
            self.assertEqual(backend.download_image_bytes(["https://example.test/image.png"]), [b"downloaded-image"])

        self.assertEqual(session.calls, 2)


if __name__ == "__main__":
    unittest.main()
