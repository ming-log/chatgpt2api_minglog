from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest import mock

from fastapi import FastAPI
from fastapi.testclient import TestClient

import api.ppt as ppt_module


AUTH_HEADERS = {"Authorization": "Bearer test-key"}


def make_plan(count: int = 5) -> dict:
    return {
        "slide_count": count,
        "design_concept": "整体设计",
        "global_style_prompt": "全局风格",
        "slides": [
            {"slide_id": str(index), "title": f"第 {index} 页", "layout_type": "title_content", "slide_prompt": f"提示词 {index}"}
            for index in range(1, count + 1)
        ],
    }


def make_task(task_id: str, *, status: str = "success", pptx_ready: bool = False) -> dict:
    return {
        "id": task_id,
        "name": task_id,
        "status": status,
        "slide_count": 5,
        "design_concept": "整体设计",
        "global_style_prompt": "全局风格",
        "markdown": "# demo",
        "markdown_file_name": "demo.md",
        "model": "gpt-image-2",
        "account_type": "free",
        "size": "",
        "quality": "auto",
        "concurrency": 10,
        "created_at": "2026-01-01 00:00:00",
        "updated_at": "2026-01-01 00:00:00",
        "pptx_ready": pptx_ready,
        "download_url": f"/api/ppt/tasks/{task_id}/download" if pptx_ready else None,
        "slides": [
            {
                "slide_id": str(index),
                "title": f"第 {index} 页",
                "layout_type": "title_content",
                "original_prompt": f"提示词 {index}",
                "current_prompt": f"提示词 {index}",
                "final_prompt": f"全局风格\n提示词 {index}",
                "image_url": "data:image/png;base64,AA==",
                "version": 1,
                "status": "success",
                "error": "",
                "reference_images": [],
            }
            for index in range(1, 6)
        ],
    }


class FakePptTaskService:
    def __init__(self, pptx_path: Path):
        self.pptx_path = pptx_path
        self.tasks: dict[str, dict] = {}
        self.created_tasks: list[tuple[dict, dict]] = []
        self.created_masters: list[tuple[dict, dict]] = []
        self.saved_plans: list[tuple[dict, dict]] = []
        self.updated_plans: list[tuple[dict, str, dict]] = []
        self.confirmed_masters: list[tuple[dict, str]] = []
        self.plan_calls: list[dict] = []
        self.provider_test_calls: list[dict] = []
        self.plan_error: Exception | None = None
        self.tasks["master-ready"] = self._make_master_task("master-ready", confirmed=True)

    def _make_master_task(self, task_id: str, *, confirmed: bool) -> dict:
        task = make_task(task_id, status="success")
        task["task_type"] = "master"
        task["master_confirmed"] = confirmed
        task["slide_count"] = 8
        task["slides"] = [
            {
                "slide_id": layout_type,
                "title": title,
                "layout_type": layout_type,
                "original_prompt": title,
                "current_prompt": title,
                "final_prompt": title,
                "image_url": "data:image/png;base64,AA==",
                "version": 1,
                "status": "success",
                "error": "",
                "reference_images": [],
            }
            for layout_type, title in [
                ("cover", "封面页（Cover）"),
                ("agenda", "目录页（Agenda）"),
                ("section_break", "章节过渡页（Section Break）"),
                ("single_column", "单栏内容页（Single Column）"),
                ("two_column", "双栏图文页（Two-column）"),
                ("bento_card", "卡片布局页（Bento / Card）"),
                ("dashboard", "数据图表页（Dashboard）"),
                ("thank_you", "结束页（Thank You / Q&A）"),
            ]
        ]
        return task

    def _make_plan_task(self, task_id: str, plan: dict) -> dict:
        task = make_task(task_id, status="success")
        task["task_type"] = "plan"
        task["slide_count"] = plan["slide_count"]
        task["design_concept"] = plan["design_concept"]
        task["global_style_prompt"] = plan["global_style_prompt"]
        task["slides"] = [
            {
                "slide_id": slide["slide_id"],
                "title": slide["title"],
                "layout_type": slide.get("layout_type", "title_content"),
                "original_prompt": slide["slide_prompt"],
                "current_prompt": slide["slide_prompt"],
                "final_prompt": "",
                "image_url": "",
                "version": 1,
                "status": "success",
                "error": "",
                "reference_images": [],
            }
            for slide in plan["slides"]
        ]
        return task

    def create_plan(self, markdown, slide_count, *, model="auto", text_base_url="", text_api_key=""):
        self.plan_calls.append({"slide_count": slide_count, "model": model, "text_base_url": text_base_url, "text_api_key": text_api_key})
        if self.plan_error is not None:
            raise self.plan_error
        count = 6 if str(slide_count).strip().lower() == "auto" else int(slide_count)
        return make_plan(count)

    def create_task(self, identity, **kwargs):
        self.created_tasks.append((identity, kwargs))
        task_id = kwargs["client_task_id"]
        task = self.tasks.setdefault(task_id, make_task(task_id, status="success"))
        task["master_task_id"] = kwargs.get("master_task_id", "")
        return task

    def save_plan_task(self, identity, **kwargs):
        self.saved_plans.append((identity, kwargs))
        task_id = kwargs["client_task_id"]
        task = self._make_plan_task(task_id, kwargs["plan"])
        task["master_task_id"] = kwargs.get("master_task_id", "")
        task["markdown"] = kwargs.get("markdown", "")
        task["markdown_file_name"] = kwargs.get("markdown_file_name", "")
        task["name"] = kwargs.get("name", "") or task_id
        self.tasks[task_id] = task
        return task

    def update_plan_task(self, identity, task_id, plan):
        self.updated_plans.append((identity, task_id, plan))
        task = self._make_plan_task(task_id, plan)
        task["name"] = self.tasks.get(task_id, {}).get("name", task_id)
        self.tasks[task_id] = task
        return task

    def create_master_task(self, identity, **kwargs):
        self.created_masters.append((identity, kwargs))
        task_id = kwargs["client_task_id"]
        task = self._make_master_task(task_id, confirmed=False)
        self.tasks[task_id] = task
        return task

    def confirm_master_task(self, identity, task_id):
        self.confirmed_masters.append((identity, task_id))
        task = self.tasks[task_id]
        task["master_confirmed"] = True
        return task

    def require_master_ready(self, _identity, master_task_id, *, require_confirmed=True):
        task = self.tasks[master_task_id]
        if require_confirmed and not task.get("master_confirmed"):
            raise ValueError("请先确认母版后再继续生成内容")
        return task

    def test_provider(self, **kwargs):
        self.provider_test_calls.append(kwargs)
        return {
            "ok": True,
            "kind": kwargs["kind"],
            "mode": "external" if kwargs.get("base_url") else "current_project",
            "status": 200,
            "latency_ms": 1,
            "model": kwargs.get("model") or "",
            "model_found": True,
            "model_count": 1,
            "message": "服务可访问",
        }

    def list_tasks(self, _identity, ids):
        return {
            "items": [self.tasks[task_id] for task_id in ids if task_id in self.tasks],
            "missing_ids": [task_id for task_id in ids if task_id not in self.tasks],
        }

    def regenerate_slide(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide["current_prompt"] = kwargs["prompt"]
                slide["version"] += 1
        return task

    def update_slide_prompt(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide["current_prompt"] = kwargs["prompt"]
                slide["version"] += 1
        return task

    def edit_slide_image(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide["current_prompt"] = kwargs["prompt"]
                slide["version"] += 1
                slide["status"] = "running"
        task["status"] = "running"
        return task

    def upload_slide_image(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide["image_url"] = kwargs["image_url"]
                slide["status"] = "success"
                slide["version"] += 1
        return task

    def delete_slide_reference(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide["reference_images"] = [
                    item for item in slide.get("reference_images", []) if item.get("id") != kwargs["reference_id"]
                ]
        return task

    def add_slide_reference(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        for slide in task["slides"]:
            if slide["slide_id"] == kwargs["slide_id"]:
                slide.setdefault("reference_images", []).append({
                    "id": kwargs.get("reference_id") or "ref-1",
                    "title": kwargs.get("title") or "用户参考图",
                    "layout_type": slide.get("layout_type", "title_content"),
                    "image_url": kwargs["image_url"],
                })
        return task

    def insert_blank_slide(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        slides = task["slides"]
        target_index = [index for index, slide in enumerate(slides) if slide["slide_id"] == kwargs["slide_id"]][0]
        insert_index = target_index if kwargs["position"] == "before" else target_index + 1
        slides.insert(
            insert_index,
            {
                "slide_id": "blank-1",
                "title": "空白页",
                "layout_type": "title_content",
                "original_prompt": "",
                "current_prompt": "",
                "final_prompt": "",
                "image_url": "",
                "version": 1,
                "status": "error",
                "error": "请输入图片描述后生成图片",
                "reference_images": [],
            },
        )
        task["slide_count"] = len(slides)
        task["status"] = "error"
        task["pptx_ready"] = False
        return task

    def delete_slide(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        task["slides"] = [slide for slide in task["slides"] if slide["slide_id"] != kwargs["slide_id"]]
        task["slide_count"] = len(task["slides"])
        task["status"] = "success"
        return task

    def resume_task(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        task["status"] = "running"
        return task

    def stop_task(self, _identity, task_id):
        task = self.tasks[task_id]
        task["status"] = "stopped"
        for slide in task["slides"]:
            if slide["status"] in {"queued", "running"}:
                slide["status"] = "stopped"
        return task

    def delete_task(self, _identity, task_id):
        if task_id not in self.tasks:
            raise ppt_module.PptTaskNotFoundError(task_id)
        del self.tasks[task_id]
        return {"ok": True}

    def rename_task(self, _identity, task_id, name):
        if task_id not in self.tasks:
            raise ppt_module.PptTaskNotFoundError(task_id)
        self.tasks[task_id]["name"] = name
        return self.tasks[task_id]

    def package_task(self, _identity, **kwargs):
        task = self.tasks[kwargs["task_id"]]
        task["status"] = "packaged"
        task["pptx_ready"] = True
        task["download_url"] = f"/api/ppt/tasks/{task['id']}/download"
        self.pptx_path.write_bytes(b"PK\x03\x04fake")
        return task

    def download_path(self, _identity, task_id):
        if task_id not in self.tasks:
            raise ppt_module.PptTaskNotFoundError(task_id)
        return self.pptx_path

    def download_slide_image(self, _identity, task_id, slide_id, base_url=""):
        if task_id not in self.tasks:
            raise ppt_module.PptTaskNotFoundError(task_id)
        if not any(slide["slide_id"] == slide_id for slide in self.tasks[task_id]["slides"]):
            raise ValueError("PPT 页面不存在")
        return b"fake-slide-image", "image/png", f"ppt-{slide_id}.png"


class PptApiTests(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp_dir.cleanup)
        self.fake_service = FakePptTaskService(Path(self.tmp_dir.name) / "task.pptx")
        self.service_patcher = mock.patch.object(ppt_module, "ppt_task_service", self.fake_service)
        self.service_patcher.start()
        self.addCleanup(self.service_patcher.stop)
        self.identity_patcher = mock.patch.object(
            ppt_module,
            "require_identity",
            lambda _authorization: {"id": "admin", "name": "管理员", "role": "admin"},
        )
        self.identity_patcher.start()
        self.addCleanup(self.identity_patcher.stop)
        self.log_patcher = mock.patch.object(ppt_module.log_service, "add")
        self.log_add = self.log_patcher.start()
        self.addCleanup(self.log_patcher.stop)
        app = FastAPI()
        app.include_router(ppt_module.create_router())
        self.client = TestClient(app)

    def test_create_plan_create_task_query_regenerate_package_and_download(self):
        plan_response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={
                "markdown": "# demo",
                "slide_count": 5,
                "master_task_id": "master-ready",
                "client_task_id": "plan-1",
                "name": "演示方案",
                "markdown_file_name": "demo.md",
                "model": "custom-text-model",
                "text_base_url": "https://text.example.test/v1",
                "text_api_key": "secret",
            },
        )
        self.assertEqual(plan_response.status_code, 200, plan_response.text)
        plan = plan_response.json()["plan"]
        self.assertEqual(plan["slide_count"], 5)
        self.assertEqual(self.fake_service.plan_calls[0]["slide_count"], 5)
        self.assertEqual(self.fake_service.plan_calls[0]["model"], "custom-text-model")
        self.assertEqual(self.fake_service.plan_calls[0]["text_base_url"], "https://text.example.test/v1")
        self.assertEqual(self.fake_service.plan_calls[0]["text_api_key"], "secret")
        self.assertEqual(plan_response.json()["task"]["id"], "plan-1")
        self.assertEqual(plan_response.json()["task"]["task_type"], "plan")
        self.assertEqual(self.fake_service.saved_plans[0][1]["master_task_id"], "master-ready")

        edited_plan = {**plan, "slides": [dict(slide) for slide in plan["slides"]]}
        edited_plan["slides"][0]["slide_prompt"] = "用户审核后修改的提示词"
        update_plan_response = self.client.patch(
            "/api/ppt/tasks/plan-1/plan",
            headers=AUTH_HEADERS,
            json={"plan": edited_plan},
        )
        self.assertEqual(update_plan_response.status_code, 200, update_plan_response.text)
        self.assertEqual(update_plan_response.json()["slides"][0]["current_prompt"], "用户审核后修改的提示词")
        self.assertEqual(self.fake_service.updated_plans[0][1], "plan-1")

        provider_response = self.client.post(
            "/api/ppt/provider/test",
            headers=AUTH_HEADERS,
            json={
                "kind": "text",
                "model": "gpt-5.5",
                "base_url": "",
                "api_key": "ignored-when-base-url-empty",
            },
        )
        self.assertEqual(provider_response.status_code, 200, provider_response.text)
        self.assertTrue(provider_response.json()["result"]["ok"])
        self.assertEqual(provider_response.json()["result"]["mode"], "current_project")
        self.assertEqual(self.fake_service.provider_test_calls[0]["base_url"], "")
        self.assertEqual(self.fake_service.provider_test_calls[0]["api_key"], "ignored-when-base-url-empty")

        current_project_provider_response = self.client.post(
            "/api/ppt/provider/test",
            headers=AUTH_HEADERS,
            json={
                "kind": "image",
                "model": "gpt-image-2",
                "base_url": "http://testserver/v1",
                "api_key": "",
            },
        )
        self.assertEqual(current_project_provider_response.status_code, 200, current_project_provider_response.text)
        self.assertTrue(current_project_provider_response.json()["result"]["ok"])
        self.assertEqual(current_project_provider_response.json()["result"]["mode"], "current_project")
        self.assertEqual(self.fake_service.provider_test_calls[1]["base_url"], "")

        create_response = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "ppt-1",
                "plan": plan,
                "master_task_id": "master-ready",
                "name": "演示任务",
                "markdown": "# demo",
                "markdown_file_name": "demo.md",
            },
        )
        self.assertEqual(create_response.status_code, 200, create_response.text)
        self.assertEqual(create_response.json()["id"], "ppt-1")
        self.assertEqual(self.fake_service.created_tasks[0][1]["name"], "演示任务")
        self.assertEqual(self.fake_service.created_tasks[0][1]["markdown"], "# demo")
        self.assertEqual(self.fake_service.created_tasks[0][1]["markdown_file_name"], "demo.md")

        query_response = self.client.get("/api/ppt/tasks?ids=ppt-1,missing", headers=AUTH_HEADERS)
        self.assertEqual(query_response.status_code, 200, query_response.text)
        self.assertEqual([item["id"] for item in query_response.json()["items"]], ["ppt-1"])
        self.assertEqual(query_response.json()["missing_ids"], ["missing"])

        regenerate_response = self.client.post(
            "/api/ppt/tasks/ppt-1/slides/3/regenerate",
            headers=AUTH_HEADERS,
            json={"prompt": "新的第 3 页提示词"},
        )
        self.assertEqual(regenerate_response.status_code, 200, regenerate_response.text)
        slide3 = [slide for slide in regenerate_response.json()["slides"] if slide["slide_id"] == "3"][0]
        self.assertEqual(slide3["current_prompt"], "新的第 3 页提示词")
        self.assertEqual(slide3["version"], 2)

        save_prompt_response = self.client.patch(
            "/api/ppt/tasks/ppt-1/slides/3/prompt",
            headers=AUTH_HEADERS,
            json={"prompt": "只保存但不生成的提示词"},
        )
        self.assertEqual(save_prompt_response.status_code, 200, save_prompt_response.text)
        self.assertEqual(
            [slide for slide in save_prompt_response.json()["slides"] if slide["slide_id"] == "3"][0]["current_prompt"],
            "只保存但不生成的提示词",
        )

        insert_response = self.client.post(
            "/api/ppt/tasks/ppt-1/slides/3/insert",
            headers=AUTH_HEADERS,
            json={"position": "after"},
        )
        self.assertEqual(insert_response.status_code, 200, insert_response.text)
        self.assertEqual(insert_response.json()["slide_count"], 6)
        self.assertEqual(insert_response.json()["slides"][3]["slide_id"], "blank-1")

        delete_slide_response = self.client.delete("/api/ppt/tasks/ppt-1/slides/blank-1", headers=AUTH_HEADERS)
        self.assertEqual(delete_slide_response.status_code, 200, delete_slide_response.text)
        self.assertEqual(delete_slide_response.json()["slide_count"], 5)

        upload_slide_image_response = self.client.post(
            "/api/ppt/tasks/ppt-1/slides/3/image",
            headers=AUTH_HEADERS,
            json={"image_url": "data:image/png;base64,AA=="},
        )
        self.assertEqual(upload_slide_image_response.status_code, 200, upload_slide_image_response.text)
        self.assertEqual(
            [slide for slide in upload_slide_image_response.json()["slides"] if slide["slide_id"] == "3"][0]["image_url"],
            "data:image/png;base64,AA==",
        )

        download_slide_image_response = self.client.get(
            "/api/ppt/tasks/ppt-1/slides/3/image/download",
            headers=AUTH_HEADERS,
        )
        self.assertEqual(download_slide_image_response.status_code, 200, download_slide_image_response.text)
        self.assertEqual(download_slide_image_response.content, b"fake-slide-image")
        self.assertEqual(download_slide_image_response.headers["content-type"], "image/png")
        self.assertIn("attachment", download_slide_image_response.headers["content-disposition"])

        add_reference_response = self.client.post(
            "/api/ppt/tasks/ppt-1/slides/3/references",
            headers=AUTH_HEADERS,
            json={"image_url": "data:image/png;base64,AA==", "title": "用户参考图"},
        )
        self.assertEqual(add_reference_response.status_code, 200, add_reference_response.text)
        self.assertEqual(
            [slide for slide in add_reference_response.json()["slides"] if slide["slide_id"] == "3"][0]["reference_images"][0]["title"],
            "用户参考图",
        )
        delete_reference_response = self.client.delete(
            "/api/ppt/tasks/ppt-1/slides/3/references/ref-1",
            headers=AUTH_HEADERS,
        )
        self.assertEqual(delete_reference_response.status_code, 200, delete_reference_response.text)
        self.assertEqual(
            [slide for slide in delete_reference_response.json()["slides"] if slide["slide_id"] == "3"][0]["reference_images"],
            [],
        )

        edit_slide_image_response = self.client.post(
            "/api/ppt/tasks/ppt-1/slides/3/edit",
            headers=AUTH_HEADERS,
            json={"prompt": "基于当前图片调整配色"},
        )
        self.assertEqual(edit_slide_image_response.status_code, 200, edit_slide_image_response.text)
        self.assertEqual(
            [slide for slide in edit_slide_image_response.json()["slides"] if slide["slide_id"] == "3"][0]["current_prompt"],
            "基于当前图片调整配色",
        )

        package_response = self.client.post("/api/ppt/tasks/ppt-1/package", headers=AUTH_HEADERS, json={})
        self.assertEqual(package_response.status_code, 200, package_response.text)
        self.assertTrue(package_response.json()["pptx_ready"])

        download_response = self.client.get("/api/ppt/tasks/ppt-1/download", headers=AUTH_HEADERS)
        self.assertEqual(download_response.status_code, 200, download_response.text)
        self.assertTrue(download_response.content.startswith(b"PK"))

        resume_response = self.client.post("/api/ppt/tasks/ppt-1/resume", headers=AUTH_HEADERS, json={})
        self.assertEqual(resume_response.status_code, 200, resume_response.text)
        self.assertEqual(resume_response.json()["status"], "running")

        stop_response = self.client.post("/api/ppt/tasks/ppt-1/stop", headers=AUTH_HEADERS, json={})
        self.assertEqual(stop_response.status_code, 200, stop_response.text)
        self.assertEqual(stop_response.json()["status"], "stopped")

        rename_response = self.client.patch("/api/ppt/tasks/ppt-1", headers=AUTH_HEADERS, json={"name": "更新后的任务名"})
        self.assertEqual(rename_response.status_code, 200, rename_response.text)
        self.assertEqual(rename_response.json()["name"], "更新后的任务名")

        delete_response = self.client.delete("/api/ppt/tasks/ppt-1", headers=AUTH_HEADERS)
        self.assertEqual(delete_response.status_code, 200, delete_response.text)
        self.assertTrue(delete_response.json()["ok"])

        deleted_query = self.client.get("/api/ppt/tasks?ids=ppt-1", headers=AUTH_HEADERS)
        self.assertEqual(deleted_query.status_code, 200, deleted_query.text)
        self.assertEqual(deleted_query.json()["items"], [])
        self.assertEqual(deleted_query.json()["missing_ids"], ["ppt-1"])

    def test_create_plan_defaults_to_auto_slide_count(self):
        response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo", "master_task_id": "master-ready"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(self.fake_service.plan_calls[0]["slide_count"], "auto")
        self.assertEqual(response.json()["plan"]["slide_count"], 6)

    def test_plan_and_task_require_confirmed_master_id(self):
        plan_response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo"},
        )
        self.assertEqual(plan_response.status_code, 400, plan_response.text)

        task_response = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={"client_task_id": "ppt-without-master", "plan": make_plan()},
        )
        self.assertEqual(task_response.status_code, 400, task_response.text)

    def test_master_create_confirm_then_plan_and_task_with_master_id(self):
        master_response = self.client.post(
            "/api/ppt/masters",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "master-1",
                "name": "演示母版",
                "model": "custom-image-model",
                "account_type": "paid",
                "size": "2048x1152",
                "quality": "high",
                "concurrency": 3,
                "style_prompt": "深色高级商务风",
                "image_base_url": "https://image.example.test/v1",
                "image_api_key": "secret",
            },
        )
        self.assertEqual(master_response.status_code, 200, master_response.text)
        self.assertEqual(master_response.json()["task_type"], "master")
        self.assertFalse(master_response.json()["master_confirmed"])
        self.assertEqual(self.fake_service.created_masters[0][1]["image_base_url"], "https://image.example.test/v1")
        self.assertEqual(self.fake_service.created_masters[0][1]["account_type"], "paid")
        self.assertEqual(self.fake_service.created_masters[0][1]["size"], "2048x1152")
        self.assertEqual(self.fake_service.created_masters[0][1]["quality"], "high")
        self.assertEqual(self.fake_service.created_masters[0][1]["style_prompt"], "深色高级商务风")

        blocked_plan_response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo", "slide_count": 5, "master_task_id": "master-1"},
        )
        self.assertEqual(blocked_plan_response.status_code, 400, blocked_plan_response.text)

        confirm_response = self.client.post("/api/ppt/masters/master-1/confirm", headers=AUTH_HEADERS, json={})
        self.assertEqual(confirm_response.status_code, 200, confirm_response.text)
        self.assertTrue(confirm_response.json()["master_confirmed"])

        plan_response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo", "slide_count": 5, "master_task_id": "master-1"},
        )
        self.assertEqual(plan_response.status_code, 200, plan_response.text)

        create_response = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={"client_task_id": "ppt-with-master", "plan": plan_response.json()["plan"], "master_task_id": "master-1"},
        )
        self.assertEqual(create_response.status_code, 200, create_response.text)
        self.assertEqual(self.fake_service.created_tasks[-1][1]["master_task_id"], "master-1")
        self.assertEqual(create_response.json()["master_task_id"], "master-1")

    def test_task_create_receives_authenticated_identity_for_user_isolation(self):
        plan = make_plan()
        response = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={
                "client_task_id": "ppt-private",
                "plan": plan,
                "master_task_id": "master-ready",
                "concurrency": 7,
                "model": "custom-image-model",
                "account_type": "paid",
                "size": "3840x2160",
                "quality": "medium",
                "image_base_url": "https://example.test/v1",
                "image_api_key": "secret",
            },
        )
        self.assertEqual(response.status_code, 200, response.text)
        identity, kwargs = self.fake_service.created_tasks[0]
        self.assertEqual(identity["id"], "admin")
        self.assertEqual(kwargs["client_task_id"], "ppt-private")
        self.assertEqual(kwargs["concurrency"], 7)
        self.assertEqual(kwargs["model"], "custom-image-model")
        self.assertEqual(kwargs["account_type"], "paid")
        self.assertEqual(kwargs["size"], "3840x2160")
        self.assertEqual(kwargs["quality"], "medium")
        self.assertEqual(kwargs["image_base_url"], "https://example.test/v1")
        self.assertEqual(kwargs["image_api_key"], "secret")

    def test_duplicate_client_task_id_is_idempotent_at_service_boundary(self):
        plan = make_plan()
        first = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={"client_task_id": "same-task", "plan": plan, "master_task_id": "master-ready"},
        )
        second = self.client.post(
            "/api/ppt/tasks",
            headers=AUTH_HEADERS,
            json={"client_task_id": "same-task", "plan": plan, "master_task_id": "master-ready"},
        )
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        self.assertEqual(first.json()["id"], second.json()["id"])

    def test_plan_parse_error_returns_debug_detail_and_logs_request(self):
        self.fake_service.plan_error = ppt_module.PptPlanParseError(
            "模型返回的设计方案不是合法 JSON：Expecting ',' delimiter",
            raw_output='{"slide_count": 5 "slides": []}',
            attempts=[
                {
                    "message": "Expecting ',' delimiter",
                    "line": 1,
                    "column": 19,
                    "char": 18,
                    "excerpt": '{"slide_count": 5 "slides": []}\n                  ^',
                }
            ],
        )

        response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo", "slide_count": 5, "master_task_id": "master-ready"},
        )

        self.assertEqual(response.status_code, 400, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["error_type"], "ppt_plan_parse_error")
        self.assertEqual(detail["parse_error"], "Expecting ',' delimiter")
        self.assertIn("request_id", detail)
        self.assertIn("model_output_preview", detail)
        self.log_add.assert_called()
        logged_detail = self.log_add.call_args.args[2]
        self.assertEqual(logged_detail["status"], "failed")
        self.assertEqual(logged_detail["request_id"], detail["request_id"])

    def test_plan_context_exhausted_error_returns_actionable_message(self):
        self.fake_service.plan_error = ppt_module.PptPlanParseError(
            "模型返回的设计方案不是合法 JSON：Expecting value",
            raw_output='{"slide_count": 5, "slides": [',
            attempts=[{"message": "Expecting value", "line": 1, "column": 31, "char": 30, "excerpt": ""}],
            context_exhausted=True,
        )

        response = self.client.post(
            "/api/ppt/plans",
            headers=AUTH_HEADERS,
            json={"markdown": "# demo", "slide_count": 5, "master_task_id": "master-ready"},
        )

        self.assertEqual(response.status_code, 400, response.text)
        detail = response.json()["detail"]
        self.assertEqual(detail["error_type"], "ppt_plan_context_exhausted")
        self.assertEqual(
            detail["error"],
            "当前任务过于复杂，内置模型上下文长度已耗尽，方案生成失败。请尝试配置外部文本服务后重试。",
        )


if __name__ == "__main__":
    unittest.main()
