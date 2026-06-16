from __future__ import annotations

import io
import logging
import os
import re
import unittest
from unittest import mock

from fastapi.testclient import TestClient

from api.app import _format_log_time, _should_console_log_request, _should_suppress_console_request_log, create_app
from services.config import config
from utils.log import Logger


class ConsoleRequestLoggingTests(unittest.TestCase):
    def test_console_request_logger_prints_api_request_start_and_end(self):
        app = create_app()
        client = TestClient(app)

        with mock.patch.dict(os.environ, {"CHATGPT2API_CONSOLE_REQUEST_LOG": "1"}), mock.patch("builtins.print") as mocked_print:
            response = client.get("/version")

        self.assertEqual(response.status_code, 200, response.text)
        lines = [" ".join(str(arg) for arg in call.args) for call in mocked_print.call_args_list]
        api_lines = [line for line in lines if line.startswith("[api]")]
        self.assertTrue(any("-> GET /version" in line for line in api_lines), api_lines)
        self.assertTrue(any("<- 200 GET /version" in line for line in api_lines), api_lines)
        self.assertTrue(
            all(re.search(r"time=\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}", line) for line in api_lines),
            api_lines,
        )

    def test_console_request_logger_can_be_disabled(self):
        app = create_app()
        client = TestClient(app)

        with mock.patch.dict(os.environ, {"CHATGPT2API_CONSOLE_REQUEST_LOG": "0"}), mock.patch("builtins.print") as mocked_print:
            response = client.get("/version")

        self.assertEqual(response.status_code, 200, response.text)
        lines = [" ".join(str(arg) for arg in call.args) for call in mocked_print.call_args_list]
        self.assertFalse(any(line.startswith("[api]") for line in lines), lines)

    def test_console_request_logger_targets_api_paths_only(self):
        self.assertTrue(_should_console_log_request("/version"))
        self.assertTrue(_should_console_log_request("/api/ppt/plans"))
        self.assertTrue(_should_console_log_request("/v1/chat/completions"))
        self.assertTrue(_should_console_log_request("/auth/login"))
        self.assertFalse(_should_console_log_request("/_next/static/app.js"))
        self.assertFalse(_should_console_log_request("/ppt"))

    def test_console_request_logger_suppresses_noisy_polling_gets(self):
        app = create_app()
        client = TestClient(app)

        with mock.patch.dict(os.environ, {"CHATGPT2API_CONSOLE_REQUEST_LOG": "1"}), mock.patch("builtins.print") as mocked_print:
            client.get("/api/accounts/image-types")
            client.get("/api/ppt/tasks")

        lines = [" ".join(str(arg) for arg in call.args) for call in mocked_print.call_args_list]
        self.assertFalse(any(line.startswith("[api]") for line in lines), lines)
        self.assertTrue(_should_suppress_console_request_log("GET", "/api/accounts/image-types"))
        self.assertTrue(_should_suppress_console_request_log("GET", "/api/ppt/tasks"))
        self.assertFalse(_should_suppress_console_request_log("POST", "/api/ppt/tasks"))
        self.assertFalse(_should_suppress_console_request_log("GET", "/api/ppt/plans"))

    def test_console_request_logger_formats_log_time(self):
        self.assertRegex(_format_log_time(), r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$")

    def test_backend_logger_prints_timestamp(self):
        name = f"chatgpt2api-test-{id(self)}"
        backend_logger = Logger(name)
        stream = io.StringIO()
        for handler in backend_logger._logger.handlers:
            handler.stream = stream

        try:
            with mock.patch.dict(config.data, {"log_levels": ["info"]}):
                backend_logger.info("hello")
            self.assertRegex(
                stream.getvalue().strip(),
                r"^\[\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\] \[INFO\] hello$",
            )
        finally:
            logging.getLogger(name).handlers.clear()


if __name__ == "__main__":
    unittest.main()
