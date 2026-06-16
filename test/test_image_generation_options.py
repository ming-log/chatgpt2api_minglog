from __future__ import annotations

import os
import unittest
from unittest import mock

os.environ.setdefault("CHATGPT2API_AUTH_KEY", "chatgpt2api")

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ai as ai_module


AUTH_HEADERS = {"Authorization": "Bearer chatgpt2api"}


class ImageGenerationOptionsTests(unittest.TestCase):
    def setUp(self):
        self.generation_calls = []
        self.edit_calls = []

        def fake_generation_handle(payload):
            self.generation_calls.append(payload)
            return {"created": 1, "data": [{"b64_json": "ZmFrZQ=="}]}

        def fake_edit_handle(payload):
            self.edit_calls.append(payload)
            return {"created": 1, "data": [{"b64_json": "ZmFrZQ=="}]}

        self.generation_patcher = mock.patch.object(
            ai_module.openai_v1_image_generations,
            "handle",
            fake_generation_handle,
        )
        self.edit_patcher = mock.patch.object(ai_module.openai_v1_image_edit, "handle", fake_edit_handle)
        self.filter_patcher = mock.patch.object(ai_module, "filter_or_log", mock.AsyncMock())
        self.generation_patcher.start()
        self.edit_patcher.start()
        self.filter_patcher.start()
        self.addCleanup(self.generation_patcher.stop)
        self.addCleanup(self.edit_patcher.stop)
        self.addCleanup(self.filter_patcher.stop)

        app = FastAPI()
        app.include_router(ai_module.create_router())
        self.client = TestClient(app)

    def test_image_generation_accepts_size_and_quality(self):
        response = self.client.post(
            "/v1/images/generations",
            headers=AUTH_HEADERS,
            json={
                "model": "gpt-image-2",
                "account_type": "paid",
                "prompt": "生成一张海报",
                "n": 1,
                "size": "3840x2160",
                "quality": "high",
                "response_format": "b64_json",
            },
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.generation_calls[0]["account_type"], "paid")
        self.assertEqual(self.generation_calls[0]["size"], "3840x2160")
        self.assertEqual(self.generation_calls[0]["quality"], "high")

    def test_image_edit_multipart_accepts_size_and_quality(self):
        response = self.client.post(
            "/v1/images/edits",
            headers=AUTH_HEADERS,
            data={
                "model": "gpt-image-2",
                "account_type": "paid",
                "prompt": "把图片改成夜景风格",
                "n": "1",
                "size": "2048x2048",
                "quality": "medium",
                "response_format": "b64_json",
            },
            files=[("image", ("one.png", b"one", "image/png"))],
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.edit_calls[0]["account_type"], "paid")
        self.assertEqual(self.edit_calls[0]["size"], "2048x2048")
        self.assertEqual(self.edit_calls[0]["quality"], "medium")


if __name__ == "__main__":
    unittest.main()
