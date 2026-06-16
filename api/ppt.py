from __future__ import annotations

import time
import uuid
from pathlib import Path
from typing import Any
from urllib.parse import quote, urlparse

from fastapi import APIRouter, Header, HTTPException, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import FileResponse, Response
from pydantic import BaseModel, ConfigDict, Field

from api.support import require_identity, resolve_image_base_url
from services.content_filter import check_request
from services.log_service import LOG_TYPE_CALL, log_service
from services.ppt_task_service import (
    AUTO_SLIDE_COUNT,
    DEFAULT_IMAGE_CONCURRENCY,
    DEFAULT_IMAGE_MODEL,
    MAX_IMAGE_CONCURRENCY,
    MAX_SLIDE_COUNT,
    MIN_IMAGE_CONCURRENCY,
    MIN_SLIDE_COUNT,
    PptPlanParseError,
    PptTaskNotFoundError,
    ppt_task_service,
)


class PptPlanRequest(BaseModel):
    markdown: str = Field(..., min_length=1)
    slide_count: int | str = AUTO_SLIDE_COUNT
    master_task_id: str = ""
    client_task_id: str = ""
    name: str = ""
    markdown_file_name: str = ""
    model: str = "auto"
    text_base_url: str = ""
    text_api_key: str = ""


class PptMasterCreateRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    name: str = ""
    model: str = DEFAULT_IMAGE_MODEL
    account_type: str = "free"
    size: str | None = None
    quality: str | None = None
    concurrency: int = Field(default=DEFAULT_IMAGE_CONCURRENCY, ge=MIN_IMAGE_CONCURRENCY, le=MAX_IMAGE_CONCURRENCY)
    style_prompt: str = ""
    image_base_url: str = ""
    image_api_key: str = ""


class PptTaskCreateRequest(BaseModel):
    client_task_id: str = Field(..., min_length=1)
    plan: dict[str, Any]
    master_task_id: str = ""
    name: str = ""
    markdown: str = ""
    markdown_file_name: str = ""
    model: str = DEFAULT_IMAGE_MODEL
    account_type: str = "free"
    size: str | None = None
    quality: str | None = None
    concurrency: int = Field(default=DEFAULT_IMAGE_CONCURRENCY, ge=MIN_IMAGE_CONCURRENCY, le=MAX_IMAGE_CONCURRENCY)
    image_base_url: str = ""
    image_api_key: str = ""


class PptPlanUpdateRequest(BaseModel):
    plan: dict[str, Any]


class PptProviderTestRequest(BaseModel):
    kind: str = Field(..., pattern="^(text|image)$")
    model: str = ""
    base_url: str = ""
    api_key: str = ""


class PptSlideRegenerateRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class PptSlideImageEditRequest(BaseModel):
    prompt: str = Field(..., min_length=1)


class PptSlideImageUploadRequest(BaseModel):
    image_url: str = Field(..., min_length=1)


class PptSlideReferenceUploadRequest(BaseModel):
    image_url: str = Field(..., min_length=1)
    title: str = ""
    reference_id: str = ""


class PptSlideInsertRequest(BaseModel):
    position: str = Field(..., pattern="^(before|after)$")


class EmptyBody(BaseModel):
    model_config = ConfigDict(extra="ignore")


class PptTaskResumeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    model: str = ""
    account_type: str | None = None
    size: str | None = None
    quality: str | None = None
    concurrency: int | None = Field(default=None, ge=MIN_IMAGE_CONCURRENCY, le=MAX_IMAGE_CONCURRENCY)
    image_base_url: str = ""
    image_api_key: str = ""


class PptTaskUpdateRequest(BaseModel):
    name: str = Field(..., min_length=1, max_length=120)


def _parse_task_ids(value: str) -> list[str]:
    return [item.strip() for item in value.split(",") if item.strip()]


def _request_id() -> str:
    return uuid.uuid4().hex[:12]


def _excerpt(value: object, limit: int = 1200) -> str:
    text = str(value or "").strip()
    normalized = " ".join(text.split())
    if len(normalized) <= limit:
        return normalized
    return normalized[: limit - 1].rstrip() + "..."


def _provider_base_key(value: object) -> str:
    text = str(value or "").strip().rstrip("/")
    if not text:
        return ""
    parsed = urlparse(text)
    if parsed.scheme and parsed.netloc:
        host = (parsed.hostname or "").lower()
        if host in {"localhost", "127.0.0.1", "::1"}:
            host = "localhost"
        path = parsed.path.rstrip("/")
        if path.lower().endswith("/v1"):
            path = path[:-3].rstrip("/")
        return f"{parsed.scheme.lower()}://{host}{f':{parsed.port}' if parsed.port else ''}{path}".rstrip("/")
    if text.lower().endswith("/v1"):
        text = text[:-3].rstrip("/")
    return text.lower()


def _provider_base_url_for_request(value: object, request: Request) -> str:
    clean = str(value or "").strip()
    if not clean:
        return ""
    current_base_url = f"{request.url.scheme}://{request.headers.get('host', request.url.netloc)}"
    candidates = {
        _provider_base_key(resolve_image_base_url(request)),
        _provider_base_key(current_base_url),
    }
    return "" if _provider_base_key(clean) in candidates else clean


async def _check_text(text: str) -> None:
    await run_in_threadpool(check_request, text)


def _service_error_response(exc: Exception, request_id: str) -> tuple[int, dict[str, Any]]:
    if isinstance(exc, HTTPException):
        detail = exc.detail if isinstance(exc.detail, dict) else {"error": str(exc.detail)}
        return exc.status_code, {**detail, "request_id": request_id}
    if isinstance(exc, PptPlanParseError):
        return 400, {**exc.to_detail(), "request_id": request_id}
    if isinstance(exc, PptTaskNotFoundError):
        return 404, {"error": "PPT 任务不存在", "error_type": "ppt_task_not_found", "request_id": request_id}
    if isinstance(exc, ValueError):
        return 400, {"error": str(exc), "error_type": "ppt_validation_error", "request_id": request_id}
    return 502, {"error": str(exc), "error_type": "ppt_upstream_or_server_error", "request_id": request_id}


def _raise_service_error(exc: Exception, request_id: str) -> None:
    status_code, detail = _service_error_response(exc, request_id)
    raise HTTPException(status_code=status_code, detail=detail) from exc


def _log_ppt_request(
    identity: dict[str, object] | None,
    *,
    request_id: str,
    endpoint: str,
    summary: str,
    started: float,
    status: str,
    request_data: dict[str, Any] | None = None,
    response_data: dict[str, Any] | None = None,
    error: str = "",
) -> None:
    detail: dict[str, Any] = {
        "request_id": request_id,
        "key_id": (identity or {}).get("id"),
        "key_name": (identity or {}).get("name"),
        "role": (identity or {}).get("role"),
        "endpoint": endpoint,
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(started)),
        "ended_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "duration_ms": int((time.time() - started) * 1000),
        "status": status,
    }
    if request_data:
        detail["request"] = request_data
    if response_data:
        detail["response"] = response_data
    if error:
        detail["error"] = error
    try:
        log_service.add(LOG_TYPE_CALL, summary, detail)
    except Exception:
        pass


def create_router() -> APIRouter:
    router = APIRouter()

    @router.post("/api/ppt/plans")
    async def create_ppt_plan(
        body: PptPlanRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        text_base_url = _provider_base_url_for_request(body.text_base_url, request)
        try:
            await _check_text(body.markdown)
            if not body.master_task_id:
                raise ValueError("请先确认母版后再生成内容方案")
            await run_in_threadpool(
                ppt_task_service.require_master_ready,
                identity,
                body.master_task_id,
                require_confirmed=True,
            )
            plan = await run_in_threadpool(
                ppt_task_service.create_plan,
                body.markdown,
                body.slide_count,
                model=body.model,
                text_base_url=text_base_url,
                text_api_key=body.text_api_key,
            )
            task = None
            if body.client_task_id:
                task = await run_in_threadpool(
                    ppt_task_service.save_plan_task,
                    identity,
                    client_task_id=body.client_task_id,
                    plan=plan,
                    master_task_id=body.master_task_id,
                    markdown=body.markdown,
                    markdown_file_name=body.markdown_file_name,
                    name=body.name,
                )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/plans",
                summary="PPT方案生成完成",
                started=started,
                status="success",
                request_data={
                    "slide_count": body.slide_count,
                    "master_task_id": body.master_task_id,
                    "model": body.model,
                    "text_base_url": text_base_url,
                    "markdown_preview": _excerpt(body.markdown),
                },
                response_data={
                    "task_id": task.get("id") if task else "",
                    "slide_count": plan.get("slide_count"),
                    "titles": [str(slide.get("title") or "") for slide in plan.get("slides", [])[:10]],
                    "slide_total": len(plan.get("slides", [])) if isinstance(plan.get("slides"), list) else 0,
                },
            )
            response = {"plan": plan, "request_id": rid}
            if task:
                response["task"] = task
            return response
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/plans",
                summary="PPT方案生成失败",
                started=started,
                status="failed",
                request_data={
                    "slide_count": body.slide_count,
                    "master_task_id": body.master_task_id,
                    "model": body.model,
                    "text_base_url": text_base_url,
                    "markdown_preview": _excerpt(body.markdown),
                },
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/masters")
    async def create_ppt_master(
        body: PptMasterCreateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        image_base_url = _provider_base_url_for_request(body.image_base_url, request)
        try:
            task = await run_in_threadpool(
                ppt_task_service.create_master_task,
                identity,
                client_task_id=body.client_task_id,
                name=body.name,
                model=body.model,
                account_type=body.account_type,
                size=body.size,
                quality=body.quality,
                concurrency=body.concurrency,
                style_prompt=body.style_prompt,
                image_base_url=image_base_url,
                image_api_key=body.image_api_key,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/masters",
                summary="PPT母版任务创建完成",
                started=started,
                status="success",
                request_data={
                    "client_task_id": body.client_task_id,
                    "name": body.name,
                    "model": body.model,
                    "account_type": body.account_type,
                    "size": body.size or "",
                    "quality": body.quality or "",
                    "concurrency": body.concurrency,
                    "style_prompt_preview": _excerpt(body.style_prompt, 300),
                    "image_base_url": image_base_url,
                },
                response_data={"task_id": task.get("id"), "status": task.get("status"), "slide_count": task.get("slide_count")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/masters",
                summary="PPT母版任务创建失败",
                started=started,
                status="failed",
                request_data={
                    "client_task_id": body.client_task_id,
                    "name": body.name,
                    "model": body.model,
                    "account_type": body.account_type,
                    "size": body.size or "",
                    "quality": body.quality or "",
                    "concurrency": body.concurrency,
                    "style_prompt_preview": _excerpt(body.style_prompt, 300),
                    "image_base_url": image_base_url,
                },
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/masters/{task_id}/confirm")
    async def confirm_ppt_master(
        task_id: str,
        _body: EmptyBody | None = None,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(ppt_task_service.confirm_master_task, identity, task_id)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/masters/{task_id}/confirm",
                summary="PPT母版确认完成",
                started=started,
                status="success",
                request_data={"task_id": task_id},
                response_data={"task_id": task.get("id"), "master_confirmed": task.get("master_confirmed")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/masters/{task_id}/confirm",
                summary="PPT母版确认失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/provider/test")
    async def test_ppt_provider(
        body: PptProviderTestRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        base_url = _provider_base_url_for_request(body.base_url, request)
        try:
            result = await run_in_threadpool(
                ppt_task_service.test_provider,
                kind=body.kind,
                model=body.model,
                base_url=base_url,
                api_key=body.api_key,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/provider/test",
                summary="PPT服务连通测试完成",
                started=started,
                status="success",
                request_data={
                    "kind": body.kind,
                    "model": body.model,
                    "base_url": base_url,
                    "mode": "external" if base_url else "current_project",
                },
                response_data=result,
            )
            return {"result": result, "request_id": rid}
        except Exception as exc:
            result = {
                "ok": False,
                "kind": body.kind,
                "mode": "external" if base_url else "current_project",
                "status": 0,
                "latency_ms": int((time.time() - started) * 1000),
                "model": body.model,
                "error": str(exc),
                "message": str(exc) or "服务不可用",
            }
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/provider/test",
                summary="PPT服务连通测试失败",
                started=started,
                status="failed",
                request_data={
                    "kind": body.kind,
                    "model": body.model,
                    "base_url": base_url,
                    "mode": result["mode"],
                },
                response_data=result,
                error=result["message"],
            )
            return {"result": result, "request_id": rid}

    @router.post("/api/ppt/tasks")
    async def create_ppt_task(
        body: PptTaskCreateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        image_base_url = _provider_base_url_for_request(body.image_base_url, request)
        try:
            if not body.master_task_id:
                raise ValueError("请先确认母版后再生成内容图片")
            await run_in_threadpool(
                ppt_task_service.require_master_ready,
                identity,
                body.master_task_id,
                require_confirmed=True,
            )
            task = await run_in_threadpool(
                ppt_task_service.create_task,
                identity,
                client_task_id=body.client_task_id,
                plan=body.plan,
                master_task_id=body.master_task_id,
                markdown=body.markdown,
                markdown_file_name=body.markdown_file_name,
                name=body.name,
                model=body.model,
                account_type=body.account_type,
                size=body.size,
                quality=body.quality,
                concurrency=body.concurrency,
                image_base_url=image_base_url,
                image_api_key=body.image_api_key,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks",
                summary="PPT图片任务创建完成",
                started=started,
                status="success",
                request_data={
                    "client_task_id": body.client_task_id,
                    "name": body.name,
                    "master_task_id": body.master_task_id,
                    "slide_count": body.plan.get("slide_count"),
                    "model": body.model,
                    "account_type": body.account_type,
                    "size": body.size or "",
                    "quality": body.quality or "",
                    "concurrency": body.concurrency,
                    "image_base_url": image_base_url,
                    "markdown_preview": _excerpt(body.markdown),
                },
                response_data={"task_id": task.get("id"), "status": task.get("status"), "slide_count": task.get("slide_count")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks",
                summary="PPT图片任务创建失败",
                started=started,
                status="failed",
                request_data={
                    "client_task_id": body.client_task_id,
                    "name": body.name,
                    "master_task_id": body.master_task_id,
                    "slide_count": body.plan.get("slide_count"),
                    "model": body.model,
                    "account_type": body.account_type,
                    "size": body.size or "",
                    "quality": body.quality or "",
                    "concurrency": body.concurrency,
                    "image_base_url": image_base_url,
                    "markdown_preview": _excerpt(body.markdown),
                },
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.get("/api/ppt/tasks")
    async def list_ppt_tasks(
        ids: str = Query(default=""),
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        parsed_ids = _parse_task_ids(ids)
        try:
            result = await run_in_threadpool(ppt_task_service.list_tasks, identity, parsed_ids)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks",
                summary="PPT任务查询完成",
                started=started,
                status="success",
                request_data={"ids": parsed_ids},
                response_data={
                    "item_count": len(result.get("items", [])),
                    "missing_ids": result.get("missing_ids", []),
                },
            )
            return {**result, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks",
                summary="PPT任务查询失败",
                started=started,
                status="failed",
                request_data={"ids": parsed_ids},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/slides/{slide_id}/regenerate")
    async def regenerate_ppt_slide(
        task_id: str,
        slide_id: str,
        body: PptSlideRegenerateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            await _check_text(body.prompt)
            task = await run_in_threadpool(
                ppt_task_service.regenerate_slide,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                prompt=body.prompt,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/regenerate",
                summary="PPT单页重生成提交完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt)},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/regenerate",
                summary="PPT单页重生成提交失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt)},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.patch("/api/ppt/tasks/{task_id}/plan")
    async def update_ppt_plan_task(
        task_id: str,
        body: PptPlanUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.update_plan_task,
                identity,
                task_id,
                body.plan,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/plan",
                summary="PPT方案任务更新完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_count": body.plan.get("slide_count")},
                response_data={"task_id": task.get("id"), "slide_count": task.get("slide_count")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/plan",
                summary="PPT方案任务更新失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_count": body.plan.get("slide_count")},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/slides/{slide_id}/edit")
    async def edit_ppt_slide_image(
        task_id: str,
        slide_id: str,
        body: PptSlideImageEditRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            await _check_text(body.prompt)
            task = await run_in_threadpool(
                ppt_task_service.edit_slide_image,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                prompt=body.prompt,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/edit",
                summary="PPT单页图生图提交完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt)},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/edit",
                summary="PPT单页图生图提交失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt)},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.patch("/api/ppt/tasks/{task_id}/slides/{slide_id}/prompt")
    async def update_ppt_slide_prompt(
        task_id: str,
        slide_id: str,
        body: PptSlideRegenerateRequest,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.update_slide_prompt,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                prompt=body.prompt,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/prompt",
                summary="PPT页面提示词保存完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt, 600)},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/prompt",
                summary="PPT页面提示词保存失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "prompt_preview": _excerpt(body.prompt, 600)},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/slides/{slide_id}/image")
    async def upload_ppt_slide_image(
        task_id: str,
        slide_id: str,
        body: PptSlideImageUploadRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.upload_slide_image,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                image_url=body.image_url,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/image",
                summary="PPT单页图片上传完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "image_url_preview": _excerpt(body.image_url, 120)},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/image",
                summary="PPT单页图片上传失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "image_url_preview": _excerpt(body.image_url, 120)},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/slides/{slide_id}/references")
    async def upload_ppt_slide_reference(
        task_id: str,
        slide_id: str,
        body: PptSlideReferenceUploadRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.add_slide_reference,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                image_url=body.image_url,
                title=body.title,
                reference_id=body.reference_id,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/references",
                summary="PPT页面参考图上传完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "title": body.title},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/references",
                summary="PPT页面参考图上传失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "title": body.title},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.delete("/api/ppt/tasks/{task_id}/slides/{slide_id}/references/{reference_id}")
    async def delete_ppt_slide_reference(
        task_id: str,
        slide_id: str,
        reference_id: str,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.delete_slide_reference,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                reference_id=reference_id,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/references/{reference_id}",
                summary="PPT页面参考图删除完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "reference_id": reference_id},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/references/{reference_id}",
                summary="PPT页面参考图删除失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "reference_id": reference_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/slides/{slide_id}/insert")
    async def insert_blank_ppt_slide(
        task_id: str,
        slide_id: str,
        body: PptSlideInsertRequest,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.insert_blank_slide,
                identity,
                task_id=task_id,
                slide_id=slide_id,
                position=body.position,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/insert",
                summary="PPT空白页插入完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id, "position": body.position},
                response_data={"task_id": task.get("id"), "status": task.get("status"), "slide_count": task.get("slide_count")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/insert",
                summary="PPT空白页插入失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id, "position": body.position},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.delete("/api/ppt/tasks/{task_id}/slides/{slide_id}")
    async def delete_ppt_slide(
        task_id: str,
        slide_id: str,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.delete_slide,
                identity,
                task_id=task_id,
                slide_id=slide_id,
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}",
                summary="PPT页面删除完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "slide_id": slide_id},
                response_data={"task_id": task.get("id"), "status": task.get("status"), "slide_count": task.get("slide_count")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}",
                summary="PPT页面删除失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/resume")
    async def resume_ppt_task(
        task_id: str,
        request: Request,
        body: PptTaskResumeRequest | None = None,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        image_base_url = _provider_base_url_for_request(body.image_base_url, request) if body else ""
        try:
            task = await run_in_threadpool(
                ppt_task_service.resume_task,
                identity,
                task_id=task_id,
                concurrency=body.concurrency if body else None,
                model=body.model if body else DEFAULT_IMAGE_MODEL,
                account_type=body.account_type if body else None,
                size=body.size if body else None,
                quality=body.quality if body else None,
                image_base_url=image_base_url,
                image_api_key=body.image_api_key if body else "",
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/resume",
                summary="PPT任务续跑提交完成",
                started=started,
                status="success",
                request_data={
                    "task_id": task_id,
                    "model": body.model if body else DEFAULT_IMAGE_MODEL,
                    "account_type": body.account_type if body else None,
                    "size": body.size if body else None,
                    "quality": body.quality if body else None,
                    "concurrency": body.concurrency if body else None,
                    "image_base_url": image_base_url,
                },
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/resume",
                summary="PPT任务续跑提交失败",
                started=started,
                status="failed",
                request_data={
                    "task_id": task_id,
                    "model": body.model if body else DEFAULT_IMAGE_MODEL,
                    "account_type": body.account_type if body else None,
                    "size": body.size if body else None,
                    "quality": body.quality if body else None,
                    "concurrency": body.concurrency if body else None,
                    "image_base_url": image_base_url,
                },
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/stop")
    async def stop_ppt_task(task_id: str, authorization: str | None = Header(default=None)):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(ppt_task_service.stop_task, identity, task_id)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/stop",
                summary="PPT任务停止完成",
                started=started,
                status="success",
                request_data={"task_id": task_id},
                response_data={"task_id": task.get("id"), "status": task.get("status")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/stop",
                summary="PPT任务停止失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.delete("/api/ppt/tasks/{task_id}")
    async def delete_ppt_task(task_id: str, authorization: str | None = Header(default=None)):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            result = await run_in_threadpool(ppt_task_service.delete_task, identity, task_id)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}",
                summary="PPT任务删除完成",
                started=started,
                status="success",
                request_data={"task_id": task_id},
                response_data=result,
            )
            return {**result, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}",
                summary="PPT任务删除失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.patch("/api/ppt/tasks/{task_id}")
    async def update_ppt_task(
        task_id: str,
        body: PptTaskUpdateRequest,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(ppt_task_service.rename_task, identity, task_id, body.name)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}",
                summary="PPT任务名称更新完成",
                started=started,
                status="success",
                request_data={"task_id": task_id, "name": body.name},
                response_data={"task_id": task.get("id"), "name": task.get("name")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}",
                summary="PPT任务名称更新失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "name": body.name},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.post("/api/ppt/tasks/{task_id}/package")
    async def package_ppt_task(
        task_id: str,
        request: Request,
        _body: EmptyBody | None = None,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            task = await run_in_threadpool(
                ppt_task_service.package_task,
                identity,
                task_id=task_id,
                base_url=resolve_image_base_url(request),
            )
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/package",
                summary="PPT打包完成",
                started=started,
                status="success",
                request_data={"task_id": task_id},
                response_data={"task_id": task.get("id"), "status": task.get("status"), "pptx_ready": task.get("pptx_ready")},
            )
            return {**task, "request_id": rid}
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/package",
                summary="PPT打包失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc

    @router.get("/api/ppt/tasks/{task_id}/slides/{slide_id}/image/download")
    async def download_ppt_slide_image(
        task_id: str,
        slide_id: str,
        request: Request,
        authorization: str | None = Header(default=None),
    ):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            data, media_type, filename = await run_in_threadpool(
                ppt_task_service.download_slide_image,
                identity,
                task_id,
                slide_id,
                resolve_image_base_url(request),
            )
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/image/download",
                summary="PPT页面图片下载失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id, "slide_id": slide_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc
        quoted = quote(filename)
        _log_ppt_request(
            identity,
            request_id=rid,
            endpoint="/api/ppt/tasks/{task_id}/slides/{slide_id}/image/download",
            summary="PPT页面图片下载完成",
            started=started,
            status="success",
            request_data={"task_id": task_id, "slide_id": slide_id},
            response_data={"filename": filename, "size": len(data), "media_type": media_type},
        )
        return Response(
            data,
            media_type=media_type,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}", "X-Request-Id": rid},
        )

    @router.get("/api/ppt/tasks/{task_id}/download")
    async def download_ppt_task(task_id: str, authorization: str | None = Header(default=None)):
        rid = _request_id()
        started = time.time()
        identity = require_identity(authorization)
        try:
            path = await run_in_threadpool(ppt_task_service.download_path, identity, task_id)
        except Exception as exc:
            status_code, detail = _service_error_response(exc, rid)
            _log_ppt_request(
                identity,
                request_id=rid,
                endpoint="/api/ppt/tasks/{task_id}/download",
                summary="PPT下载失败",
                started=started,
                status="failed",
                request_data={"task_id": task_id},
                response_data={"http_status": status_code, "detail": detail},
                error=str(detail.get("error") or exc),
            )
            raise HTTPException(status_code=status_code, detail=detail) from exc
        filename = Path(path).name
        quoted = quote(filename)
        _log_ppt_request(
            identity,
            request_id=rid,
            endpoint="/api/ppt/tasks/{task_id}/download",
            summary="PPT下载完成",
            started=started,
            status="success",
            request_data={"task_id": task_id},
            response_data={"filename": filename, "size": Path(path).stat().st_size},
        )
        return FileResponse(
            path,
            media_type="application/vnd.openxmlformats-officedocument.presentationml.presentation",
            filename=filename,
            headers={"Content-Disposition": f"attachment; filename*=UTF-8''{quoted}", "X-Request-Id": rid},
        )

    return router
