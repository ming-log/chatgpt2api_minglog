from __future__ import annotations

from contextlib import asynccontextmanager
from datetime import datetime
from threading import Event
import time
import uuid

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse

from api import accounts, ai, image_tasks, ppt, register, system
from api.support import resolve_web_asset, start_limited_account_watcher
from services.backup_service import backup_service
from services.config import config


def _should_console_log_request(path: str) -> bool:
    return path == "/version" or path.startswith(("/api/", "/auth/", "/v1/"))


def _should_suppress_console_request_log(method: str, path: str) -> bool:
    return method.upper() == "GET" and path in {
        "/api/accounts/image-types",
        "/api/ppt/tasks",
    }


def _format_log_time() -> str:
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def create_app() -> FastAPI:
    app_version = config.app_version

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        stop_event = Event()
        thread = start_limited_account_watcher(stop_event)
        backup_service.start()
        config.cleanup_old_images()
        try:
            yield
        finally:
            stop_event.set()
            thread.join(timeout=1)
            backup_service.stop()

    app = FastAPI(title="chatgpt2api", version=app_version, lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.middleware("http")
    async def console_request_logger(request: Request, call_next):
        if (
            not config.console_request_log_enabled
            or not _should_console_log_request(request.url.path)
            or _should_suppress_console_request_log(request.method, request.url.path)
        ):
            return await call_next(request)

        request_id = request.headers.get("x-request-id") or uuid.uuid4().hex[:12]
        started = time.time()
        query = f"?{request.url.query}" if request.url.query else ""
        client = request.client.host if request.client else "-"
        print(
            f"[api] time={_format_log_time()} -> {request.method} {request.url.path}{query} "
            f"rid={request_id} client={client}",
            flush=True,
        )
        try:
            response = await call_next(request)
        except Exception as exc:
            duration_ms = int((time.time() - started) * 1000)
            print(
                f"[api] time={_format_log_time()} <- ERROR {request.method} {request.url.path} rid={request_id} "
                f"duration_ms={duration_ms} error={exc}",
                flush=True,
            )
            raise

        duration_ms = int((time.time() - started) * 1000)
        response.headers["X-Request-Id"] = request_id
        print(
            f"[api] time={_format_log_time()} <- {response.status_code} {request.method} {request.url.path} rid={request_id} "
            f"duration_ms={duration_ms}",
            flush=True,
        )
        return response

    app.include_router(ai.create_router())
    app.include_router(accounts.create_router())
    app.include_router(image_tasks.create_router())
    app.include_router(ppt.create_router())
    app.include_router(register.create_router())
    app.include_router(system.create_router(app_version))

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_web(full_path: str):
        asset = resolve_web_asset(full_path)
        if asset is not None:
            return FileResponse(asset)
        if full_path.strip("/").startswith("_next/"):
            raise HTTPException(status_code=404, detail="Not Found")
        fallback = resolve_web_asset("")
        if fallback is None:
            raise HTTPException(status_code=404, detail="Not Found")
        return FileResponse(fallback)

    return app
