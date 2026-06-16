from __future__ import annotations

import base64
import io
import json
import os
import tempfile
import threading
import time
import unittest
import zipfile
from contextlib import redirect_stdout
from pathlib import Path
from xml.etree import ElementTree
from unittest import mock

from services.ppt_task_service import (
    AUTO_SLIDE_COUNT,
    PPTX_BUILD_VERSION,
    PptPlanParseError,
    PptTaskService,
    build_image_pptx,
    is_auto_slide_count,
    normalize_image_concurrency,
    normalize_slide_count,
)


OWNER = {"id": "owner-1", "name": "Owner", "role": "admin"}
OTHER_OWNER = {"id": "owner-2", "name": "Other", "role": "user"}
PNG_BYTES = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII="
)
DATA_IMAGE_URL = f"data:image/png;base64,{base64.b64encode(PNG_BYTES).decode('ascii')}"


def make_plan(count: int = 5) -> dict:
    return {
        "slide_count": count,
        "design_concept": "统一的评审汇报风格",
        "global_style_prompt": "ignored",
        "slides": [
            {
                "slide_id": str(index),
                "title": f"第 {index} 页",
                "layout_type": "title_content",
                "slide_prompt": f"第 {index} 页提示词",
            }
            for index in range(1, count + 1)
        ],
    }


def make_layout_plan() -> dict:
    return {
        "slide_count": 3,
        "design_concept": "统一母版风格",
        "global_style_prompt": "ignored",
        "slides": [
            {
                "slide_id": "1",
                "title": "章节页",
                "layout_type": "section_transition",
                "slide_prompt": "章节一：研究背景",
            },
            {
                "slide_id": "2",
                "title": "内容页",
                "layout_type": "title_content",
                "slide_prompt": "一级标题和三条内容要点",
            },
            {
                "slide_id": "3",
                "title": "副标题内容页",
                "layout_type": "title_subtitle_content",
                "slide_prompt": "一级标题、二级标题和图表内容",
            },
        ],
    }


def chat_result(plan: dict) -> dict:
    return {"choices": [{"message": {"content": json.dumps(plan, ensure_ascii=False)}}]}


def chat_stream(text: str):
    midpoint = max(1, len(text) // 2)
    for part in (text[:midpoint], text[midpoint:]):
        yield {"choices": [{"delta": {"content": part}, "finish_reason": None}]}
    yield {"choices": [{"delta": {}, "finish_reason": "stop"}]}


def wait_for_task(service: PptTaskService, identity: dict[str, object], task_id: str, status: str, timeout: float = 2.0) -> dict:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        result = service.list_tasks(identity, [task_id])
        last = (result.get("items") or [None])[0]
        if last and last.get("status") == status:
            return last
        time.sleep(0.02)
    raise AssertionError(f"task {task_id} did not reach {status}, last={last}")


class PptTaskServiceTests(unittest.TestCase):
    def make_service(self, path: Path, *, chat_handler=None, image_handler=None, image_edit_handler=None) -> PptTaskService:
        return PptTaskService(
            path,
            package_dir=path.parent / "packages",
            chat_handler=chat_handler or (lambda _payload: chat_result(make_plan(5))),
            image_handler=image_handler or (lambda _payload: {"data": [{"url": DATA_IMAGE_URL}]}),
            image_edit_handler=image_edit_handler or (lambda _payload: {"data": [{"url": DATA_IMAGE_URL}]}),
        )

    def test_slide_count_defaults_boundaries_and_invalid_values(self):
        self.assertEqual(normalize_slide_count(None), 20)
        self.assertEqual(normalize_slide_count(""), 20)
        self.assertEqual(normalize_slide_count(1), 1)
        self.assertEqual(normalize_slide_count(5), 5)
        self.assertEqual(normalize_slide_count(20), 20)
        self.assertEqual(normalize_slide_count(100), 100)
        self.assertTrue(is_auto_slide_count(AUTO_SLIDE_COUNT))
        for value in (0, 101, "abc", True):
            with self.assertRaises(ValueError):
                normalize_slide_count(value)

    def test_image_concurrency_defaults_boundaries_and_invalid_values(self):
        self.assertEqual(normalize_image_concurrency(None), 10)
        self.assertEqual(normalize_image_concurrency(""), 10)
        self.assertEqual(normalize_image_concurrency(1), 1)
        self.assertEqual(normalize_image_concurrency(10), 10)
        self.assertEqual(normalize_image_concurrency(100), 100)
        for value in (0, 101, "abc", True):
            with self.assertRaises(ValueError):
                normalize_image_concurrency(value)

    def test_plan_json_requires_exact_slide_count(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")

            plan = service.create_plan("# demo", 5)
            self.assertEqual(plan["slide_count"], 5)
            self.assertEqual(len(plan["slides"]), 5)
            self.assertTrue(plan["global_style_prompt"])

            with self.assertRaises(ValueError):
                service.create_plan("# demo", 6)

    def test_plan_generation_defaults_to_auto_slide_count(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return chat_result(make_plan(7))

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)

            plan = service.create_plan("# demo")

            self.assertEqual(plan["slide_count"], 7)
            self.assertEqual(len(plan["slides"]), 7)
            message = calls[0]["messages"][1]["content"]
            self.assertIn("自行决定 PPT 页数", message)
            self.assertNotIn("精确规划为 20 页", message)

    def test_plan_generation_requires_layout_type_and_fixed_fonts(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return chat_result(make_layout_plan())

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)

            plan = service.create_plan("# demo", 3)

            self.assertEqual([slide["layout_type"] for slide in plan["slides"]], ["cover", "agenda", "section_break"])
            self.assertEqual(plan["slides"][1]["title"], "目录")
            self.assertNotIn("封面页（Cover）", plan["slides"][0]["slide_prompt"])
            self.assertNotIn("目录页（Agenda）", plan["slides"][1]["slide_prompt"])
            self.assertNotIn("第一章章节过渡页", plan["slides"][2]["slide_prompt"])
            message = calls[0]["messages"][1]["content"]
            self.assertIn("layout_type", message)
            self.assertIn("封面页", message)
            self.assertIn("目录页", message)
            self.assertIn("禁止显示页码", message)
            self.assertIn("微软雅黑", message)
            self.assertIn("Times New Roman", message)
            self.assertIn("chapters", message)
            self.assertIn("标题规范", message)

    def test_plan_normalization_uses_one_chapter_outline_for_agenda_and_sections(self):
        raw_plan = {
            "slide_count": 6,
            "design_concept": "统一章节编号",
            "global_style_prompt": "ignored",
            "slides": [
                {"slide_id": "1", "title": "封面", "layout_type": "cover", "slide_prompt": "封面"},
                {"slide_id": "2", "title": "目录", "layout_type": "agenda", "slide_prompt": "目录"},
                {"slide_id": "3", "title": "第一章 市场洞察", "layout_type": "section_break", "slide_prompt": "第一章：市场洞察"},
                {"slide_id": "4", "title": "趋势分析", "layout_type": "single_column", "slide_prompt": "趋势分析内容"},
                {"slide_id": "5", "title": "第九章 增长路径", "layout_type": "section_break", "slide_prompt": "第九章：增长路径"},
                {"slide_id": "6", "title": "结束", "layout_type": "thank_you", "slide_prompt": "Q&A"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")

            plan = service.normalize_plan(raw_plan, 6)

        self.assertEqual(
            plan["chapters"],
            [
                {"chapter_no": "01", "chapter_title": "市场洞察", "section_slide_id": "3"},
                {"chapter_no": "02", "chapter_title": "增长路径", "section_slide_id": "5"},
            ],
        )
        agenda_prompt = plan["slides"][1]["slide_prompt"]
        second_section_prompt = plan["slides"][4]["slide_prompt"]
        self.assertNotIn("01 市场洞察", agenda_prompt)
        self.assertNotIn("目录章节清单", agenda_prompt)
        self.assertNotIn("章节编号必须使用「02」", second_section_prompt)
        self.assertNotIn("第九章：", second_section_prompt)
        self.assertEqual(plan["slides"][3]["chapter_no"], "01")
        self.assertEqual(plan["slides"][4]["chapter_title"], "增长路径")

    def test_content_final_prompt_injects_hidden_layout_controls(self):
        raw_plan = {
            "slide_count": 6,
            "design_concept": "统一章节编号",
            "global_style_prompt": "ignored",
            "slides": [
                {"slide_id": "1", "title": "年度增长复盘", "layout_type": "cover", "slide_prompt": "年度增长复盘封面"},
                {"slide_id": "2", "title": "目录", "layout_type": "agenda", "slide_prompt": "目录"},
                {"slide_id": "3", "title": "第一章 市场洞察", "layout_type": "section_break", "slide_prompt": "第一章：市场洞察"},
                {"slide_id": "4", "title": "趋势分析", "layout_type": "single_column", "slide_prompt": "趋势分析内容"},
                {"slide_id": "5", "title": "第九章 增长路径", "layout_type": "section_break", "slide_prompt": "第九章：增长路径"},
                {"slide_id": "6", "title": "结束", "layout_type": "thank_you", "slide_prompt": "Q&A"},
            ],
        }
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")

            service.create_task(OWNER, client_task_id="hidden-control-task", plan=raw_plan, base_url="http://testserver")
            task = wait_for_task(service, OWNER, "hidden-control-task", "success")

        cover = task["slides"][0]
        agenda = task["slides"][1]
        section = task["slides"][4]
        ending = task["slides"][5]
        self.assertNotIn("禁止显示页码", cover["current_prompt"])
        self.assertNotIn("目录章节清单", agenda["current_prompt"])
        self.assertNotIn("章节编号一致性", section["current_prompt"])
        self.assertIn("封面页硬性要求：必须清晰呈现整套 PPT 的主题", cover["final_prompt"])
        self.assertIn("目录页硬性要求：必须提供 2 个章节标题", agenda["final_prompt"])
        self.assertIn("01 市场洞察", agenda["final_prompt"])
        self.assertIn("这是第 2 章的章节过渡页", section["final_prompt"])
        self.assertIn("当前章节编号必须显示为「02」", section["final_prompt"])
        self.assertNotIn("第九章：", section["final_prompt"])
        self.assertIn("不允许包含联系电话、手机号、电子信箱", ending["final_prompt"])

    def test_plan_generation_streams_content_to_terminal_when_enabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            raw_plan = json.dumps(make_plan(5), ensure_ascii=False)

            def handler(payload):
                if payload.get("stream"):
                    return chat_stream(raw_plan)
                return chat_result(make_plan(5))

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)
            output = io.StringIO()
            with redirect_stdout(output):
                plan = service.create_plan("# demo", 5)

            self.assertEqual(plan["slide_count"], 5)
            printed = output.getvalue()
            self.assertIn("[ppt-plan-stream] begin plan slide_count=5", printed)
            self.assertIn('"slide_count": 5', printed)
            self.assertIn("[ppt-plan-stream] end plan slide_count=5", printed)

    def test_plan_stream_terminal_print_can_be_disabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return chat_result(make_plan(5))

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)
            output = io.StringIO()
            with mock.patch.dict(os.environ, {"CHATGPT2API_PPT_PLAN_STREAM_LOG": "0"}), redirect_stdout(output):
                plan = service.create_plan("# demo", 5)

            self.assertEqual(plan["slide_count"], 5)
            self.assertEqual(calls[0].get("stream"), False)
            self.assertNotIn("[ppt-plan-stream]", output.getvalue())

    def test_external_text_plan_streams_content_to_terminal_when_enabled(self):
        class StreamResponse:
            def __init__(self, lines: list[bytes]):
                self.lines = lines

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def __iter__(self):
                return iter(self.lines)

        with tempfile.TemporaryDirectory() as tmp_dir:
            raw_plan = json.dumps(make_plan(5), ensure_ascii=False)
            midpoint = max(1, len(raw_plan) // 2)
            lines = []
            for part in (raw_plan[:midpoint], raw_plan[midpoint:]):
                chunk = {"choices": [{"delta": {"content": part}, "finish_reason": None}]}
                lines.append(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
            lines.append(b"data: [DONE]\n\n")
            captured_payloads = []
            captured_accept_headers = []

            def fake_urlopen(request, timeout=120):
                captured_payloads.append(json.loads(request.data.decode("utf-8")))
                captured_accept_headers.append(request.get_header("Accept"))
                return StreamResponse(lines)

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            output = io.StringIO()
            with mock.patch.dict(os.environ, {"CHATGPT2API_PPT_PLAN_STREAM_LOG": "1"}), mock.patch(
                "services.ppt_task_service.urlopen",
                side_effect=fake_urlopen,
            ), redirect_stdout(output):
                plan = service.create_plan(
                    "# demo",
                    5,
                    text_base_url="https://text.example.test/v1",
                    text_api_key="secret",
                )

            self.assertEqual(plan["slide_count"], 5)
            self.assertEqual(captured_payloads[0]["stream"], True)
            self.assertEqual(captured_accept_headers[0], "text/event-stream")
            printed = output.getvalue()
            self.assertIn("[ppt-plan-stream] begin plan slide_count=5", printed)
            self.assertIn('"slide_count": 5', printed)
            self.assertIn("[ppt-plan-stream] end plan slide_count=5", printed)

    def test_external_text_plan_stream_terminal_print_can_be_disabled(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            with mock.patch.dict(os.environ, {"CHATGPT2API_PPT_PLAN_STREAM_LOG": "0"}), mock.patch(
                "services.ppt_task_service._post_openai_json",
                return_value=chat_result(make_plan(5)),
            ) as external_post, mock.patch("services.ppt_task_service._post_openai_stream_json") as external_stream:
                plan = service.create_plan(
                    "# demo",
                    5,
                    text_base_url="https://text.example.test/v1",
                    text_api_key="secret",
                )

            self.assertEqual(plan["slide_count"], 5)
            external_stream.assert_not_called()
            self.assertFalse(external_post.call_args.args[3]["stream"])

    def test_invalid_plan_json_is_repaired_once(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                if len(calls) == 1:
                    return {"choices": [{"message": {"content": '{"slide_count": 5 "slides": []}'}}]}
                return chat_result(make_plan(5))

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)
            plan = service.create_plan("# demo", 5)

            self.assertEqual(plan["slide_count"], 5)
            self.assertEqual(len(plan["slides"]), 5)
            self.assertEqual(len(calls), 2)

    def test_plan_parse_error_includes_debug_detail_when_repair_fails(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(
                Path(tmp_dir) / "ppt_tasks.json",
                chat_handler=lambda _payload: {"choices": [{"message": {"content": '{"slide_count": 5 "slides": []}'}}]},
            )

            with self.assertRaises(PptPlanParseError) as ctx:
                service.create_plan("# demo", 5)

            detail = ctx.exception.to_detail()
            self.assertEqual(detail["error_type"], "ppt_plan_parse_error")
            self.assertIn("parse_error", detail)
            self.assertIn("model_output_preview", detail)
            self.assertIn("repair_error", detail)

    def test_internal_truncated_plan_parse_error_reports_context_exhausted(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            truncated = '{"slide_count": 5, "design_concept": "复杂方案", "slides": ['
            service = self.make_service(
                Path(tmp_dir) / "ppt_tasks.json",
                chat_handler=lambda _payload: {"choices": [{"message": {"content": truncated}}]},
            )

            with self.assertRaises(PptPlanParseError) as ctx:
                service.create_plan("# demo", 5)

            detail = ctx.exception.to_detail()
            self.assertEqual(detail["error_type"], "ppt_plan_context_exhausted")
            self.assertEqual(
                detail["error"],
                "当前任务过于复杂，内置模型上下文长度已耗尽，方案生成失败。请尝试配置外部文本服务后重试。",
            )

    def test_blank_text_base_url_uses_current_project_even_with_api_key(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return chat_result(make_plan(5))

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", chat_handler=handler)
            with mock.patch("services.ppt_task_service._post_openai_json") as external_post:
                plan = service.create_plan("# demo", 5, text_base_url="", text_api_key="secret")

            self.assertEqual(plan["slide_count"], 5)
            self.assertEqual(len(calls), 1)
            external_post.assert_not_called()

    def test_blank_image_base_url_uses_current_project_even_with_api_key(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            with mock.patch("services.ppt_task_service._post_openai_json") as external_post:
                service.create_task(
                    OWNER,
                    client_task_id="fallback-image-task",
                    plan=make_plan(5),
                    image_base_url="",
                    image_api_key="secret",
                    base_url="http://testserver",
                )
                task = wait_for_task(service, OWNER, "fallback-image-task", "success")

            self.assertEqual(task["image_base_url"], "")
            self.assertEqual(len(calls), 5)
            external_post.assert_not_called()

    def test_internal_image_generation_uses_ppt_image_options(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = []

            def handler(payload):
                calls.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(
                OWNER,
                client_task_id="configured-image-task",
                plan=make_plan(1),
                account_type="paid",
                size="3840x2160",
                quality="high",
                base_url="http://testserver",
            )
            task = wait_for_task(service, OWNER, "configured-image-task", "success")

            self.assertEqual(task["account_type"], "paid")
            self.assertEqual(task["size"], "3840x2160")
            self.assertEqual(task["quality"], "high")
            self.assertEqual(task["slides"][0]["image_size"], len(PNG_BYTES))
            self.assertEqual(task["slides"][0]["image_width"], 1)
            self.assertEqual(task["slides"][0]["image_height"], 1)
            self.assertEqual(calls[0]["account_type"], "paid")
            self.assertEqual(calls[0]["size"], "3840x2160")
            self.assertEqual(calls[0]["quality"], "high")

    def test_download_slide_image_returns_image_bytes(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="download-image-task", plan=make_plan(1), base_url="http://testserver")
            wait_for_task(service, OWNER, "download-image-task", "success")

            data, mime_type, filename = service.download_slide_image(OWNER, "download-image-task", "1", base_url="http://testserver")

            self.assertEqual(data, PNG_BYTES)
            self.assertEqual(mime_type, "image/png")
            self.assertEqual(filename, "ppt-1-1.png")

    def test_external_image_generation_uses_size_and_quality_without_account_type(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            with mock.patch(
                "services.ppt_task_service._post_openai_json",
                return_value={"data": [{"url": DATA_IMAGE_URL}]},
            ) as external_post:
                service.create_task(
                    OWNER,
                    client_task_id="external-image-task",
                    plan=make_plan(1),
                    account_type="paid",
                    size="2048x1152",
                    quality="medium",
                    image_base_url="https://image.example.test/v1",
                    image_api_key="secret",
                    base_url="http://testserver",
                )
                task = wait_for_task(service, OWNER, "external-image-task", "success")

            self.assertEqual(task["account_type"], "paid")
            self.assertEqual(task["size"], "2048x1152")
            self.assertEqual(task["quality"], "medium")
            payload = external_post.call_args.args[3]
            self.assertEqual(payload["size"], "2048x1152")
            self.assertEqual(payload["quality"], "medium")
            self.assertNotIn("account_type", payload)

    def test_stop_task_marks_unfinished_slides_and_prevents_late_success(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            started = threading.Event()
            release = threading.Event()

            def handler(_payload):
                started.set()
                release.wait(1.0)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(
                OWNER,
                client_task_id="stop-task",
                plan=make_plan(3),
                concurrency=1,
                base_url="http://testserver",
            )
            self.assertTrue(started.wait(1.0))

            stopped = service.stop_task(OWNER, "stop-task")
            self.assertEqual(stopped["status"], "stopped")
            self.assertTrue(all(slide["status"] in {"stopped", "success"} for slide in stopped["slides"]))

            release.set()
            time.sleep(0.1)
            current = service.list_tasks(OWNER, ["stop-task"])["items"][0]
            self.assertEqual(current["status"], "stopped")
            self.assertTrue(any(slide["status"] == "stopped" for slide in current["slides"]))

    def test_master_task_is_persisted_before_generation_finishes_and_then_updates(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "ppt_tasks.json"
            started = threading.Event()
            release = threading.Event()

            def blocking_image_handler(_payload):
                started.set()
                self.assertTrue(release.wait(1.0))
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(path, image_handler=blocking_image_handler)
            try:
                service.create_master_task(OWNER, client_task_id="persisted-master", base_url="http://testserver")
                with service._lock:
                    saved = json.loads(path.read_text(encoding="utf-8"))
                saved_master = next(item for item in saved["tasks"] if item["id"] == "persisted-master")
                self.assertEqual(saved_master["task_type"], "master")
                self.assertEqual(saved_master["status"], "draft")
                self.assertEqual(saved_master["slides"][0]["status"], "draft")
                self.assertFalse(started.wait(0.05))

                service.resume_task(OWNER, task_id="persisted-master", base_url="http://testserver")
                self.assertTrue(started.wait(1.0))
                with service._lock:
                    running = json.loads(path.read_text(encoding="utf-8"))
                running_master = next(item for item in running["tasks"] if item["id"] == "persisted-master")
                self.assertEqual(running_master["status"], "running")
                self.assertEqual(running_master["slides"][0]["status"], "running")
            finally:
                release.set()

            final_task = wait_for_task(service, OWNER, "persisted-master", "success")
            self.assertEqual(final_task["status"], "success")
            self.assertTrue(all(slide["image_url"] for slide in final_task["slides"]))

    def test_provider_test_uses_current_project_when_base_url_is_blank(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            with mock.patch(
                "services.ppt_task_service.openai_v1_models.list_models",
                return_value={"object": "list", "data": [{"id": "gpt-5.5"}]},
            ):
                result = service.test_provider(kind="text", model="gpt-5.5", base_url="", api_key="secret")

            self.assertTrue(result["ok"])
            self.assertEqual(result["mode"], "current_project")
            self.assertTrue(result["model_found"])

    def test_provider_test_uses_ten_second_timeout_for_external_service(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            with mock.patch(
                "services.ppt_task_service._get_openai_json",
                return_value=(200, {"object": "list", "data": [{"id": "gpt-image-2"}]}),
            ) as get_json:
                result = service.test_provider(kind="image", model="gpt-image-2", base_url="https://image.example.test/v1", api_key="secret")

            self.assertTrue(result["ok"])
            get_json.assert_called_once_with("https://image.example.test/v1", "secret", "/v1/models", timeout=10.0)

    def test_plan_task_is_saved_updated_and_restored_from_history(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "ppt_tasks.json"
            service = self.make_service(path)
            plan_task = service.save_plan_task(
                OWNER,
                client_task_id="plan-1",
                plan=make_plan(2),
                markdown="# demo",
                markdown_file_name="demo.md",
                name="演示方案",
            )

            self.assertEqual(plan_task["task_type"], "plan")
            self.assertEqual(plan_task["markdown"], "# demo")
            self.assertIn("第 1 页提示词", plan_task["slides"][0]["current_prompt"])
            self.assertEqual(plan_task["slides"][0]["layout_type"], "cover")
            self.assertEqual(plan_task["slides"][1]["title"], "目录")
            self.assertNotIn("禁止显示页码", plan_task["slides"][0]["current_prompt"])

            edited_plan = make_plan(2)
            edited_plan["design_concept"] = "用户调整后的整体设计"
            edited_plan["slides"][0]["title"] = "用户改过的标题"
            edited_plan["slides"][0]["slide_prompt"] = "用户改过的第 1 页提示词"
            updated_task = service.update_plan_task(OWNER, "plan-1", edited_plan)

            self.assertEqual(updated_task["design_concept"], "用户调整后的整体设计")
            self.assertEqual(updated_task["slides"][0]["title"], "用户改过的标题")
            self.assertIn("第 1 页提示词", updated_task["slides"][0]["original_prompt"])
            self.assertIn("用户改过的第 1 页提示词", updated_task["slides"][0]["current_prompt"])
            self.assertNotIn("禁止显示页码", updated_task["slides"][0]["current_prompt"])
            self.assertGreater(updated_task["slides"][0]["version"], plan_task["slides"][0]["version"])

            restored_service = self.make_service(path)
            restored = restored_service.list_tasks(OWNER, [])["items"][0]
            self.assertEqual(restored["id"], "plan-1")
            self.assertEqual(restored["task_type"], "plan")
            self.assertIn("用户改过的第 1 页提示词", restored["slides"][0]["current_prompt"])

    def test_duplicate_client_task_id_returns_existing_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            first = service.create_task(OWNER, client_task_id="task-1", plan=make_plan(5), base_url="http://testserver")
            second = service.create_task(OWNER, client_task_id="task-1", plan=make_plan(5), base_url="http://testserver")

            self.assertEqual(first["id"], "task-1")
            self.assertEqual(second["id"], "task-1")
            wait_for_task(service, OWNER, "task-1", "success")
            self.assertEqual(calls, 5)

    def test_one_slide_task_is_allowed(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(OWNER, client_task_id="one-slide-task", plan=make_plan(1), base_url="http://testserver")
            task = wait_for_task(service, OWNER, "one-slide-task", "success")

            self.assertEqual(task["slide_count"], 1)
            self.assertEqual(len(task["slides"]), 1)
            self.assertEqual(calls, 1)

    def test_confirmed_master_task_is_required_and_used_as_content_reference(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_payloads = []
            edit_payloads = []

            def image_handler(payload):
                image_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            def edit_handler(payload):
                edit_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(
                Path(tmp_dir) / "ppt_tasks.json",
                image_handler=image_handler,
                image_edit_handler=edit_handler,
            )
            draft = service.create_master_task(
                OWNER,
                client_task_id="master-1",
                style_prompt="深色金融咨询风",
                base_url="http://testserver",
            )
            self.assertNotIn("生成一张 16:9 PPT 母版图片", draft["slides"][0]["current_prompt"])
            self.assertIn("生成一张 16:9 PPT 母版图片", draft["slides"][0]["final_prompt"])
            self.assertIn("深色金融咨询风", draft["slides"][0]["final_prompt"])
            service.resume_task(OWNER, task_id="master-1", base_url="http://testserver")
            master = wait_for_task(service, OWNER, "master-1", "success")

            self.assertEqual(master["task_type"], "master")
            self.assertFalse(master["master_confirmed"])
            self.assertEqual(
                [slide["layout_type"] for slide in master["slides"]],
                ["cover", "agenda", "section_break", "single_column", "two_column", "bento_card", "dashboard", "thank_you"],
            )
            self.assertEqual(master["slides"][0]["reference_images"], [])
            self.assertEqual([slide["reference_images"][0]["id"] for slide in master["slides"][1:]], ["cover"] * 7)
            self.assertEqual(len(image_payloads), 1)
            self.assertEqual(len(edit_payloads), 7)

            with self.assertRaises(ValueError):
                service.create_task(
                    OWNER,
                    client_task_id="blocked-content",
                    plan=make_layout_plan(),
                    master_task_id="master-1",
                    base_url="http://testserver",
                )

            confirmed = service.confirm_master_task(OWNER, "master-1")
            self.assertTrue(confirmed["master_confirmed"])
            service.create_task(
                OWNER,
                client_task_id="content-with-master",
                plan=make_layout_plan(),
                master_task_id="master-1",
                base_url="http://testserver",
            )
            content = wait_for_task(service, OWNER, "content-with-master", "success")

            self.assertEqual(content["master_task_id"], "master-1")
            self.assertEqual([slide["layout_type"] for slide in content["slides"]], ["cover", "agenda", "section_break"])
            self.assertEqual([slide["reference_images"][0]["id"] for slide in content["slides"]], ["cover", "agenda", "section_break"])
            self.assertEqual(len(image_payloads), 1)
            self.assertEqual(len(edit_payloads), 10)
            self.assertTrue(all(payload["images"][0][0] for payload in edit_payloads))
            self.assertIn("母版引用规范", edit_payloads[-1]["prompt"])
            self.assertIn("微软雅黑", edit_payloads[-1]["prompt"])
            self.assertIn("Times New Roman", edit_payloads[-1]["prompt"])
            self.assertIn("内容页一级标题统一", edit_payloads[-1]["prompt"])

            with service._lock:
                stored = service._tasks["owner-1:content-with-master"]
                stored["master_slides"][1].pop("reference_images", None)
                stored["master_slides"][2]["reference_images"] = []
            restored_view = service.list_tasks(OWNER, ["content-with-master"])["items"][0]
            self.assertEqual(restored_view["master_slides"][1]["reference_images"][0]["id"], "cover")
            self.assertEqual(restored_view["master_slides"][2]["reference_images"], [])

            without_reference = service.delete_slide_reference(
                OWNER,
                task_id="content-with-master",
                slide_id="2",
                reference_id="agenda",
            )
            self.assertEqual(without_reference["slides"][1]["reference_images"], [])
            service.regenerate_slide(
                OWNER,
                task_id="content-with-master",
                slide_id="2",
                prompt="不使用参考图重新生成第二页",
                base_url="http://testserver",
            )
            wait_for_task(service, OWNER, "content-with-master", "success")
            self.assertEqual(len(image_payloads), 2)
            self.assertEqual(len(edit_payloads), 10)

    def test_master_background_can_use_user_reference_before_generation_starts(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            image_payloads = []
            edit_payloads = []

            def image_handler(payload):
                image_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            def edit_handler(payload):
                edit_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(
                Path(tmp_dir) / "ppt_tasks.json",
                image_handler=image_handler,
                image_edit_handler=edit_handler,
            )
            draft = service.create_master_task(OWNER, client_task_id="master-with-reference", base_url="http://testserver")
            self.assertEqual(draft["status"], "draft")
            self.assertEqual(len(image_payloads), 0)
            self.assertEqual(len(edit_payloads), 0)

            with_reference = service.add_slide_reference(
                OWNER,
                task_id="master-with-reference",
                slide_id="cover",
                image_url=DATA_IMAGE_URL,
                title="用户上传的背景参考",
                base_url="http://testserver",
            )
            self.assertEqual(with_reference["slides"][0]["reference_images"][0]["title"], "用户上传的背景参考")
            updated_prompt = service.update_slide_prompt(
                OWNER,
                task_id="master-with-reference",
                slide_id="cover",
                prompt="用户改写后的封面母版提示词",
            )
            self.assertEqual(updated_prompt["slides"][0]["current_prompt"], "用户改写后的封面母版提示词")

            service.resume_task(OWNER, task_id="master-with-reference", base_url="http://testserver")
            master = wait_for_task(service, OWNER, "master-with-reference", "success")
            self.assertEqual(master["status"], "success")
            self.assertEqual(len(image_payloads), 0)
            self.assertEqual(len(edit_payloads), 8)
            self.assertTrue(edit_payloads[0]["images"][0][0])
            self.assertIn("用户改写后的封面母版提示词", edit_payloads[0]["prompt"])

    def test_delete_reference_is_blocked_while_images_are_generating(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            with service._lock:
                service._tasks["owner-1:active-reference-task"] = {
                    "id": "active-reference-task",
                    "name": "active-reference-task",
                    "owner_id": "owner-1",
                    "task_type": "content",
                    "status": "running",
                    "model": "gpt-image-2",
                    "size": "",
                    "concurrency": 1,
                    "image_base_url": "",
                    "image_api_key": "",
                    "slide_count": 1,
                    "design_concept": "",
                    "global_style_prompt": "全局风格",
                    "markdown": "",
                    "markdown_file_name": "",
                    "slides": [
                        {
                            "slide_id": "1",
                            "title": "第 1 页",
                            "layout_type": "title_content",
                            "original_prompt": "提示词",
                            "current_prompt": "提示词",
                            "final_prompt": "提示词",
                            "image_url": "",
                            "version": 1,
                            "status": "running",
                            "error": "",
                            "reference_images": [
                                {
                                    "id": "title_content",
                                    "title": "一级标题 + 内容",
                                    "layout_type": "title_content",
                                    "image_url": DATA_IMAGE_URL,
                                }
                            ],
                        }
                    ],
                    "created_at": "2026-01-01 00:00:00",
                    "updated_at": "2026-01-01 00:00:00",
                    "error": "",
                }

            with self.assertRaisesRegex(ValueError, "图片生成过程中不允许删除参考图"):
                service.delete_slide_reference(
                    OWNER,
                    task_id="active-reference-task",
                    slide_id="1",
                    reference_id="title_content",
                )

    def test_create_task_uses_configurable_image_concurrency(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            lock = threading.Lock()
            active = 0
            max_active = 0

            def handler(_payload):
                nonlocal active, max_active
                with lock:
                    active += 1
                    max_active = max(max_active, active)
                time.sleep(0.05)
                with lock:
                    active -= 1
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(OWNER, client_task_id="parallel-task", plan=make_plan(5), concurrency=3, base_url="http://testserver")
            task = wait_for_task(service, OWNER, "parallel-task", "success")

            self.assertEqual(task["concurrency"], 3)
            self.assertGreaterEqual(max_active, 2)
            self.assertLessEqual(max_active, 3)

    def test_tasks_are_persisted_and_listable_after_service_recreation(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            path = Path(tmp_dir) / "ppt_tasks.json"
            service = self.make_service(path)
            service.create_task(
                OWNER,
                client_task_id="restore-task",
                plan=make_plan(5),
                markdown="# 原始 Markdown",
                markdown_file_name="demo.md",
                name="可编辑任务名",
                concurrency=4,
                base_url="http://testserver",
            )
            wait_for_task(service, OWNER, "restore-task", "success")

            restored_service = self.make_service(path)
            result = restored_service.list_tasks(OWNER, [])

            self.assertEqual([item["id"] for item in result["items"]], ["restore-task"])
            self.assertEqual(result["items"][0]["name"], "可编辑任务名")
            self.assertEqual(result["items"][0]["markdown"], "# 原始 Markdown")
            self.assertEqual(result["items"][0]["markdown_file_name"], "demo.md")
            self.assertEqual(result["items"][0]["concurrency"], 4)
            self.assertEqual(result["items"][0]["slides"][0]["status"], "success")

    def test_rename_task_updates_public_history_name(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="rename-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "rename-task", "success")

            renamed = service.rename_task(OWNER, "rename-task", "新的任务名称")
            listed = service.list_tasks(OWNER, ["rename-task"])["items"][0]

            self.assertEqual(renamed["name"], "新的任务名称")
            self.assertEqual(listed["name"], "新的任务名称")

    def test_different_owner_cannot_query_task(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="private-task", plan=make_plan(5), base_url="http://testserver")

            wait_for_task(service, OWNER, "private-task", "success")
            result = service.list_tasks(OTHER_OWNER, ["private-task"])

            self.assertEqual(result["items"], [])
            self.assertEqual(result["missing_ids"], ["private-task"])

    def test_regenerate_only_updates_target_slide(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="regen-task", plan=make_plan(5), base_url="http://testserver")
            initial = wait_for_task(service, OWNER, "regen-task", "success")
            initial_prompts = {slide["slide_id"]: slide["current_prompt"] for slide in initial["slides"]}
            initial_versions = {slide["slide_id"]: slide["version"] for slide in initial["slides"]}

            service.regenerate_slide(
                OWNER,
                task_id="regen-task",
                slide_id="3",
                prompt="第 3 页修改后的提示词",
                base_url="http://testserver",
            )
            updated = wait_for_task(service, OWNER, "regen-task", "success")
            slides = {slide["slide_id"]: slide for slide in updated["slides"]}

            self.assertEqual(slides["3"]["current_prompt"], "第 3 页修改后的提示词")
            self.assertEqual(slides["3"]["version"], initial_versions["3"] + 1)
            for slide_id in ("1", "2", "4", "5"):
                self.assertEqual(slides[slide_id]["current_prompt"], initial_prompts[slide_id])
                self.assertEqual(slides[slide_id]["version"], initial_versions[slide_id])

    def test_insert_blank_slide_then_generate_and_delete_slide(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="insert-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "insert-task", "success")

            inserted = service.insert_blank_slide(OWNER, task_id="insert-task", slide_id="3", position="before")
            blank = inserted["slides"][2]

            self.assertEqual(inserted["slide_count"], 6)
            self.assertEqual(blank["title"], "空白页")
            self.assertEqual(blank["status"], "error")
            self.assertEqual(blank["current_prompt"], "")
            self.assertEqual(inserted["status"], "error")

            service.regenerate_slide(
                OWNER,
                task_id="insert-task",
                slide_id=blank["slide_id"],
                prompt="插入页的图片描述",
                base_url="http://testserver",
            )
            completed = wait_for_task(service, OWNER, "insert-task", "success")
            self.assertEqual(completed["slide_count"], 6)
            self.assertEqual(completed["slides"][2]["current_prompt"], "插入页的图片描述")
            self.assertEqual(completed["slides"][2]["status"], "success")

            deleted = service.delete_slide(OWNER, task_id="insert-task", slide_id=blank["slide_id"])
            self.assertEqual(deleted["slide_count"], 5)
            self.assertEqual([slide["slide_id"] for slide in deleted["slides"]], ["1", "2", "3", "4", "5"])
            self.assertEqual(deleted["status"], "success")

    def test_upload_and_edit_blank_slide_image(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            edit_payloads = []

            def edit_handler(payload):
                edit_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_edit_handler=edit_handler)
            service.create_task(OWNER, client_task_id="edit-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "edit-task", "success")
            inserted = service.insert_blank_slide(OWNER, task_id="edit-task", slide_id="3", position="after")
            blank_id = inserted["slides"][3]["slide_id"]

            uploaded = service.upload_slide_image(
                OWNER,
                task_id="edit-task",
                slide_id=blank_id,
                image_url=DATA_IMAGE_URL,
                base_url="http://testserver",
            )
            self.assertEqual(uploaded["slides"][3]["status"], "success")
            self.assertEqual(uploaded["slides"][3]["image_url"], DATA_IMAGE_URL)

            service.edit_slide_image(
                OWNER,
                task_id="edit-task",
                slide_id=blank_id,
                prompt="基于上传图片微调版式",
                base_url="http://testserver",
            )
            completed = wait_for_task(service, OWNER, "edit-task", "success")

            self.assertEqual(completed["slides"][3]["current_prompt"], "")
            self.assertEqual(completed["slides"][3]["final_prompt"], "")
            self.assertEqual(completed["slides"][3]["status"], "success")
            self.assertEqual(len(edit_payloads), 1)
            self.assertEqual(edit_payloads[0]["prompt"].count("基于上传图片微调版式"), 1)
            self.assertTrue(edit_payloads[0]["images"][0][0])

    def test_edit_slide_image_keeps_page_generation_prompt_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            edit_payloads = []

            def edit_handler(payload):
                edit_payloads.append(payload)
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_edit_handler=edit_handler)
            service.create_task(OWNER, client_task_id="edit-preserve-prompt", plan=make_plan(5), base_url="http://testserver")
            initial = wait_for_task(service, OWNER, "edit-preserve-prompt", "success")
            before = initial["slides"][1]

            service.edit_slide_image(
                OWNER,
                task_id="edit-preserve-prompt",
                slide_id=before["slide_id"],
                prompt="只调整这张图的背景层次",
                base_url="http://testserver",
            )
            completed = wait_for_task(service, OWNER, "edit-preserve-prompt", "success")
            after = completed["slides"][1]

            self.assertEqual(after["original_prompt"], before["original_prompt"])
            self.assertEqual(after["current_prompt"], before["current_prompt"])
            self.assertEqual(after["final_prompt"], before["final_prompt"])
            self.assertEqual(after["version"], before["version"] + 1)
            self.assertNotIn("只调整这张图的背景层次", after["current_prompt"])
            self.assertNotIn("只调整这张图的背景层次", after["final_prompt"])
            self.assertEqual(len(edit_payloads), 1)
            self.assertEqual(edit_payloads[0]["prompt"].count("只调整这张图的背景层次"), 1)

    def test_package_requires_all_slides_to_have_success_image(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                if calls == 3:
                    raise RuntimeError("boom")
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(OWNER, client_task_id="failed-package", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "failed-package", "error")

            with self.assertRaises(ValueError):
                service.package_task(OWNER, task_id="failed-package", base_url="http://testserver")

    def test_resume_task_continues_failed_slides(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            calls = 0

            def handler(_payload):
                nonlocal calls
                calls += 1
                if calls == 3:
                    raise RuntimeError("interrupted")
                return {"data": [{"url": DATA_IMAGE_URL}]}

            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json", image_handler=handler)
            service.create_task(
                OWNER,
                client_task_id="resume-task",
                plan=make_plan(5),
                concurrency=1,
                base_url="http://testserver",
            )
            failed = wait_for_task(service, OWNER, "resume-task", "error")
            failed_slides = [slide for slide in failed["slides"] if slide["status"] == "error"]
            self.assertEqual([slide["slide_id"] for slide in failed_slides], ["3"])

            resumed = service.resume_task(OWNER, task_id="resume-task", base_url="http://testserver")
            self.assertIn(resumed["status"], {"running", "success"})
            completed = wait_for_task(service, OWNER, "resume-task", "success")
            slides = {slide["slide_id"]: slide for slide in completed["slides"]}

            self.assertEqual(slides["3"]["status"], "success")
            self.assertEqual(slides["3"]["version"], 2)
            self.assertEqual(calls, 6)

    def test_package_creates_downloadable_pptx(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="package-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "package-task", "success")

            packaged = service.package_task(OWNER, task_id="package-task", base_url="http://testserver")
            path = service.download_path(OWNER, "package-task")

            self.assertEqual(packaged["status"], "packaged")
            self.assertTrue(packaged["pptx_ready"])
            self.assertEqual(packaged["pptx_build_version"], PPTX_BUILD_VERSION)
            self.assertTrue(path.is_file())
            with zipfile.ZipFile(path) as archive:
                self.assertIn("ppt/slides/slide5.xml", archive.namelist())
                self.assertTrue(any(name.startswith("ppt/media/image") for name in archive.namelist()))

    def test_build_image_pptx_escapes_slide_title_attributes(self):
        payload = build_image_pptx([('标题 "引用" & <风险>', PNG_BYTES)])

        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            for name in archive.namelist():
                if name.endswith((".xml", ".rels")):
                    ElementTree.fromstring(archive.read(name))

    def test_build_image_pptx_uses_standard_presentation_package(self):
        payload = build_image_pptx([("Theme", PNG_BYTES)])

        with zipfile.ZipFile(io.BytesIO(payload)) as archive:
            names = archive.namelist()
            self.assertIn("ppt/presentation.xml", names)
            self.assertIn("ppt/slides/slide1.xml", names)
            self.assertTrue(any(name.startswith("ppt/media/image") for name in names))
            self.assertIn("ppt/presProps.xml", names)
            self.assertIn("ppt/viewProps.xml", names)
            self.assertIn("ppt/tableStyles.xml", names)

    def test_old_packaged_pptx_requires_repackage_after_format_update(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="old-package-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "old-package-task", "success")
            service.package_task(OWNER, task_id="old-package-task", base_url="http://testserver")

            with service._lock:
                service._tasks["owner-1:old-package-task"].pop("pptx_build_version", None)

            listed = service.list_tasks(OWNER, ["old-package-task"])["items"][0]
            self.assertFalse(listed["pptx_ready"])
            self.assertNotIn("download_url", listed)
            with self.assertRaises(ValueError):
                service.download_path(OWNER, "old-package-task")

    def test_delete_task_removes_history_and_packaged_file(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="delete-task", plan=make_plan(5), base_url="http://testserver")
            wait_for_task(service, OWNER, "delete-task", "success")
            service.package_task(OWNER, task_id="delete-task", base_url="http://testserver")
            package_path = service.download_path(OWNER, "delete-task")
            self.assertTrue(package_path.is_file())

            result = service.delete_task(OWNER, "delete-task")
            query = service.list_tasks(OWNER, ["delete-task"])

            self.assertTrue(result["ok"])
            self.assertEqual(query["items"], [])
            self.assertEqual(query["missing_ids"], ["delete-task"])
            self.assertFalse(package_path.exists())

    def test_hundred_slide_task_can_queue_and_package_with_fake_handler(self):
        with tempfile.TemporaryDirectory() as tmp_dir:
            service = self.make_service(Path(tmp_dir) / "ppt_tasks.json")
            service.create_task(OWNER, client_task_id="hundred-task", plan=make_plan(100), base_url="http://testserver")
            wait_for_task(service, OWNER, "hundred-task", "success", timeout=5.0)

            packaged = service.package_task(OWNER, task_id="hundred-task", base_url="http://testserver")
            path = service.download_path(OWNER, "hundred-task")

            self.assertEqual(packaged["slide_count"], 100)
            with zipfile.ZipFile(path) as archive:
                self.assertIn("ppt/slides/slide100.xml", archive.namelist())
                self.assertIn("ppt/media/image100.png", archive.namelist())


if __name__ == "__main__":
    unittest.main()
