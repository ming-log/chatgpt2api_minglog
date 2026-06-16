import base64
import json
import os
import random
import re
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from io import BytesIO
from pathlib import Path
from typing import Any, Dict, Iterator, Optional

from curl_cffi import requests
from PIL import Image

from services.account_service import account_service
from services.config import config
from services.proxy_service import proxy_settings
from utils.helper import (
    UpstreamHTTPError,
    ensure_ok,
    is_transient_upstream_connection_error,
    iter_sse_payloads,
    new_uuid,
)
from utils.log import logger
from utils.pow import build_legacy_requirements_token, build_proof_token, parse_pow_resources
from utils.turnstile import solve_turnstile_token


class InvalidAccessTokenError(RuntimeError):
    pass


class ImagePollTimeoutError(RuntimeError):
    pass


@dataclass
class ChatRequirements:
    """保存一次对话请求所需的 sentinel token。"""
    token: str
    proof_token: str = ""
    turnstile_token: str = ""
    so_token: str = ""
    raw_finalize: Optional[Dict[str, Any]] = None


DEFAULT_CLIENT_VERSION = "prod-be885abbfcfe7b1f511e88b3003d9ee44757fbad"
DEFAULT_CLIENT_BUILD_NUMBER = "5955942"
DEFAULT_POW_SCRIPT = "https://chatgpt.com/backend-api/sentinel/sdk.js"
CODEX_IMAGE_MODEL = "codex-gpt-image-2"
CODEX_IMAGE_TOOL_MODEL = "gpt-image-2"
CODEX_RESPONSES_PATH = "/backend-api/codex/responses"
DEFAULT_CODEX_IMAGE_RESPONSES_MODEL = "gpt-5.4-mini"
DEFAULT_CODEX_USER_AGENT = "codex_cli_rs/0.118.0 (Windows 10.0.0; x86_64) chatgpt2api/0.1.0"
DEFAULT_CODEX_ORIGINATOR = "codex_cli_rs"
CODEX_OFFICIAL_EMPTY_HEADERS = (
    "version",
    "x-codex-turn-state",
    "x-codex-turn-metadata",
    "x-client-request-id",
    "x-responsesapi-include-timing-metrics",
)
PLAN_TYPE_SCORES = {
    "free": 0,
    "plus": 10,
    "team": 20,
    "business": 20,
    "enterprise": 20,
    "edu": 20,
    "pro": 30,
    "prolite": 30,
}
IMAGE_TRANSPORT_RETRY_ATTEMPTS = 3
IMAGE_TRANSPORT_RETRY_STATUSES = {429, 500, 502, 503, 504}


def _decode_jwt_payload(token: str) -> Dict[str, Any]:
    parts = str(token or "").split(".")
    if len(parts) < 2:
        return {}
    try:
        payload = parts[1] + "=" * (-len(parts[1]) % 4)
        decoded = base64.urlsafe_b64decode(payload.encode("utf-8"))
        data = json.loads(decoded.decode("utf-8"))
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def _normalize_plan_type(value: Any) -> str:
    plan_type = str(value or "").strip().lower()
    if plan_type == "codex":
        return ""
    compact = plan_type.replace("-", "_").replace(" ", "_")
    for candidate in ("prolite", "enterprise", "business", "team", "plus", "pro", "edu", "free"):
        if compact == candidate or compact.endswith(f"_{candidate}") or candidate in compact.split("_"):
            return candidate
    return plan_type


def _plan_type_score(value: Any) -> int:
    plan_type = _normalize_plan_type(value)
    if not plan_type:
        return -1
    return PLAN_TYPE_SCORES.get(plan_type, 1)


def _image_transport_retry_sleep(attempt: int) -> None:
    backoff = min(2 ** max(0, attempt - 1), 4)
    time.sleep(backoff + random.uniform(0, 0.5))


class OpenAIBackendAPI:
    """ChatGPT Web 后端封装。

    说明：
    - 传入 `access_token` 时，聊天和模型列表都会走已登录链路
      例如 `/backend-api/sentinel/chat-requirements`、`/backend-api/conversation`
    - 不传 `access_token` 时，会走未登录链路
      例如 `/backend-anon/sentinel/chat-requirements`、`/backend-anon/conversation`
    - `stream_conversation()` 是底层统一流式入口
    - 协议兼容转换放在 `services.protocol`
    """

    def __init__(self, access_token: str = "") -> None:
        """初始化后端客户端。

        参数：
        - `access_token`：可选。传入后表示使用已登录链路；不传则使用未登录链路。
        """
        self.base_url = "https://chatgpt.com"
        self.client_version = DEFAULT_CLIENT_VERSION
        self.client_build_number = DEFAULT_CLIENT_BUILD_NUMBER
        self.access_token = access_token
        self.fp = self._build_fp()
        self.user_agent = self.fp["user-agent"]
        self.device_id = self.fp["oai-device-id"]
        self.session_id = self.fp["oai-session-id"]
        self.pow_script_sources: list[str] = []
        self.pow_data_build = ""
        self.session = requests.Session(**proxy_settings.build_session_kwargs(
            impersonate=self.fp["impersonate"],
            verify=True,
        ))
        self.session.headers.update({
            "User-Agent": self.user_agent,
            "Origin": self.base_url,
            "Referer": self.base_url + "/",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8,en-US;q=0.7",
            "Cache-Control": "no-cache",
            "Pragma": "no-cache",
            "Priority": "u=1, i",
            "Sec-Ch-Ua": self.fp["sec-ch-ua"],
            "Sec-Ch-Ua-Arch": '"x86"',
            "Sec-Ch-Ua-Bitness": '"64"',
            "Sec-Ch-Ua-Full-Version": '"143.0.3650.96"',
            "Sec-Ch-Ua-Full-Version-List": '"Microsoft Edge";v="143.0.3650.96", "Chromium";v="143.0.7499.147", "Not A(Brand";v="24.0.0.0"',
            "Sec-Ch-Ua-Mobile": self.fp["sec-ch-ua-mobile"],
            "Sec-Ch-Ua-Model": '""',
            "Sec-Ch-Ua-Platform": self.fp["sec-ch-ua-platform"],
            "Sec-Ch-Ua-Platform-Version": '"19.0.0"',
            "Sec-Fetch-Dest": "empty",
            "Sec-Fetch-Mode": "cors",
            "Sec-Fetch-Site": "same-origin",
            "OAI-Device-Id": self.device_id,
            "OAI-Session-Id": self.session_id,
            "OAI-Language": "zh-CN",
            "OAI-Client-Version": self.client_version,
            "OAI-Client-Build-Number": self.client_build_number,
        })
        if self.access_token:
            self.session.headers["Authorization"] = f"Bearer {self.access_token}"

    def _build_fp(self) -> Dict[str, str]:
        account = account_service.get_account(self.access_token) if self.access_token else {}
        account = account if isinstance(account, dict) else {}
        raw_fp = account.get("fp")
        fp = {str(k).lower(): str(v) for k, v in raw_fp.items()} if isinstance(raw_fp, dict) else {}
        for key in (
                "user-agent",
                "impersonate",
                "oai-device-id",
                "oai-session-id",
                "sec-ch-ua",
                "sec-ch-ua-mobile",
                "sec-ch-ua-platform",
        ):
            value = str(account.get(key) or "").strip()
            if value:
                fp[key] = value
        fp.setdefault(
            "user-agent",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0",
        )
        fp.setdefault("impersonate", "edge101")
        fp.setdefault("oai-device-id", new_uuid())
        fp.setdefault("oai-session-id", new_uuid())
        fp.setdefault("sec-ch-ua", '"Microsoft Edge";v="143", "Chromium";v="143", "Not A(Brand";v="24"')
        fp.setdefault("sec-ch-ua-mobile", "?0")
        fp.setdefault("sec-ch-ua-platform", '"Windows"')
        return fp

    def _headers(self, path: str, extra: Optional[Dict[str, str]] = None) -> Dict[str, str]:
        """构造请求头，并补上 web 端要求的 target path/route。"""
        headers = dict(self.session.headers)
        headers["X-OpenAI-Target-Path"] = path
        headers["X-OpenAI-Target-Route"] = path
        if extra:
            headers.update(extra)
        return headers

    def _chatgpt_account_id(self) -> str:
        account = account_service.get_account(self.access_token) if self.access_token else {}
        account = account if isinstance(account, dict) else {}
        for key in ("account_id", "chatgpt_account_id", "organization_id"):
            value = str(account.get(key) or "").strip()
            if value:
                return value
        auth = _decode_jwt_payload(self.access_token).get("https://api.openai.com/auth")
        if isinstance(auth, dict):
            for key in ("chatgpt_account_id", "account_id", "organization_id"):
                value = str(auth.get(key) or "").strip()
                if value:
                    return value
        return ""

    @staticmethod
    def _extract_quota_and_restore_at(limits_progress: list[Any]) -> tuple[int, str | None, bool]:
        for item in limits_progress:
            if isinstance(item, dict) and item.get("feature_name") == "image_gen":
                return int(item.get("remaining") or 0), str(item.get("reset_after") or "") or None, False
        return 0, None, True

    def _get_me(self) -> Dict[str, Any]:
        path = "/backend-api/me"
        response = self.session.get(self.base_url + path, headers=self._headers(path), timeout=20)
        if response.status_code != 200:
            if response.status_code == 401:
                raise InvalidAccessTokenError(f"{path} failed: HTTP {response.status_code}")
            raise RuntimeError(f"{path} failed: HTTP {response.status_code}")
        return response.json()

    def _get_conversation_init(self) -> Dict[str, Any]:
        path = "/backend-api/conversation/init"
        response = self.session.post(
            self.base_url + path,
            headers=self._headers(path, {"Content-Type": "application/json"}),
            json={
                "gizmo_id": None,
                "requested_default_model": None,
                "conversation_id": None,
                "timezone_offset_min": -480,
            },
            timeout=20,
        )
        if response.status_code != 200:
            if response.status_code == 401:
                raise InvalidAccessTokenError(f"{path} failed: HTTP {response.status_code}")
            raise RuntimeError(f"{path} failed: HTTP {response.status_code}")
        return response.json()

    @staticmethod
    def _unwrap_account_entry(value: Any) -> Dict[str, Any]:
        if not isinstance(value, dict):
            return {}
        account = value.get("account")
        if isinstance(account, dict):
            return account
        return value

    @classmethod
    def _extract_default_account(cls, payload: Dict[str, Any]) -> Dict[str, Any]:
        accounts = payload.get("accounts") if isinstance(payload.get("accounts"), dict) else {}
        return cls._unwrap_account_entry(accounts.get("default"))

    @classmethod
    def _account_plan_type(cls, account: Dict[str, Any]) -> str:
        if not isinstance(account, dict):
            return ""
        for key in (
                "plan_type",
                "account_plan",
                "chatgpt_plan_type",
                "subscription_type",
                "subscription_plan_type",
                "workspace_plan_type",
                "sku",
        ):
            plan_type = _normalize_plan_type(account.get(key))
            if plan_type:
                return plan_type
        for key in ("subscription", "plan", "billing"):
            nested = account.get(key)
            if not isinstance(nested, dict):
                continue
            for nested_key in ("plan_type", "type", "name", "sku"):
                plan_type = _normalize_plan_type(nested.get(nested_key))
                if plan_type:
                    return plan_type
        return ""

    @classmethod
    def _extract_best_plan_type(cls, payload: Dict[str, Any], default_account: Dict[str, Any]) -> str:
        candidates: list[Dict[str, Any]] = []
        if default_account:
            candidates.append(default_account)

        raw_accounts = payload.get("accounts")
        if isinstance(raw_accounts, dict):
            account_entries = raw_accounts.values()
        elif isinstance(raw_accounts, list):
            account_entries = raw_accounts
        else:
            account_entries = []
        for value in account_entries:
            account = cls._unwrap_account_entry(value)
            if account:
                candidates.append(account)

        root_account = cls._unwrap_account_entry(payload.get("account"))
        if root_account:
            candidates.append(root_account)

        best_plan_type = "free"
        best_score = _plan_type_score(best_plan_type)
        for account in candidates:
            if account.get("is_deactivated") is True or account.get("deleted") is True:
                continue
            plan_type = cls._account_plan_type(account)
            score = _plan_type_score(plan_type)
            if score > best_score:
                best_plan_type = plan_type
                best_score = score
        return best_plan_type or "free"

    def _get_account_payload(self) -> Dict[str, Any]:
        route = "/backend-api/accounts/check/v4-2023-04-27"
        response = self.session.get(self.base_url + route + "?timezone_offset_min=-480", headers=self._headers(route),
                                    timeout=20)
        if response.status_code != 200:
            if response.status_code == 401:
                raise InvalidAccessTokenError(f"{route} failed: HTTP {response.status_code}")
            raise RuntimeError(f"/backend-api/accounts/check failed: HTTP {response.status_code}")
        payload = response.json()
        logger.debug({"event": "backend_user_info_account_payload", "account_payload": payload})
        return payload if isinstance(payload, dict) else {}

    def _get_default_account(self) -> Dict[str, Any]:
        return self._extract_default_account(self._get_account_payload())

    def get_user_info(self) -> Dict[str, Any]:
        """获取当前 token 的账号信息。"""
        if not self.access_token:
            raise RuntimeError("access_token is required")
        logger.debug({"event": "backend_user_info_start"})
        with ThreadPoolExecutor(max_workers=3) as executor:
            me_future = executor.submit(self._get_me)
            init_future = executor.submit(self._get_conversation_init)
            account_future = executor.submit(self._get_account_payload)
            me_payload, init_payload, account_payload = me_future.result(), init_future.result(), account_future.result()

        default_account = self._extract_default_account(account_payload)
        plan_type = self._extract_best_plan_type(account_payload, default_account)

        limits_progress = init_payload.get("limits_progress")
        limits_progress = limits_progress if isinstance(limits_progress, list) else []
        quota, restore_at, image_quota_unknown = self._extract_quota_and_restore_at(limits_progress)
        result = {
            "email": me_payload.get("email"),
            "user_id": me_payload.get("id"),
            "type": plan_type,
            "quota": quota,
            "image_quota_unknown": image_quota_unknown,
            "limits_progress": limits_progress,
            "default_model_slug": init_payload.get("default_model_slug"),
            "restore_at": restore_at,
            "status": "正常" if image_quota_unknown and plan_type.lower() != "free" else ("限流" if quota == 0 else "正常"),
        }
        logger.debug({
            "event": "backend_user_info_result",
            "email": result.get("email"),
            "user_id": result.get("user_id"),
            "type": result.get("type"),
            "quota": result.get("quota"),
            "image_quota_unknown": result.get("image_quota_unknown"),
            "default_model_slug": result.get("default_model_slug"),
            "restore_at": result.get("restore_at"),
            "status": result.get("status"),
        })
        return result

    def _bootstrap_headers(self) -> Dict[str, str]:
        """构造首页预热请求头。"""
        return {
            "User-Agent": self.user_agent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
            "Sec-Ch-Ua": self.session.headers["Sec-Ch-Ua"],
            "Sec-Ch-Ua-Mobile": self.session.headers["Sec-Ch-Ua-Mobile"],
            "Sec-Ch-Ua-Platform": self.session.headers["Sec-Ch-Ua-Platform"],
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Upgrade-Insecure-Requests": "1",
        }

    def _build_requirements(self, data: Dict[str, Any], source_p: str = "") -> ChatRequirements:
        """把 sentinel 响应整理成后续对话需要的 token 集合。"""
        if (data.get("arkose") or {}).get("required"):
            raise RuntimeError("chat requirements requires arkose token, which is not implemented")

        proof_token = ""
        proof_info = data.get("proofofwork") or {}
        if proof_info.get("required"):
            proof_token = build_proof_token(
                proof_info.get("seed", ""),
                proof_info.get("difficulty", ""),
                self.user_agent,
                script_sources=self.pow_script_sources,
                data_build=self.pow_data_build,
            )

        turnstile_token = ""
        turnstile_info = data.get("turnstile") or {}
        if turnstile_info.get("required") and turnstile_info.get("dx"):
            turnstile_token = solve_turnstile_token(turnstile_info["dx"], source_p) or ""

        return ChatRequirements(
            token=data.get("token", ""),
            proof_token=proof_token,
            turnstile_token=turnstile_token,
            so_token=data.get("so_token", ""),
            raw_finalize=data,
        )

    def _conversation_headers(self, path: str, requirements: ChatRequirements) -> Dict[str, str]:
        """根据当前 requirements 构造对话 SSE 请求头。"""
        headers = {
            "Accept": "text/event-stream",
            "Content-Type": "application/json",
            "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token,
        }
        if requirements.proof_token:
            headers["OpenAI-Sentinel-Proof-Token"] = requirements.proof_token
        if requirements.turnstile_token:
            headers["OpenAI-Sentinel-Turnstile-Token"] = requirements.turnstile_token
        if requirements.so_token:
            headers["OpenAI-Sentinel-SO-Token"] = requirements.so_token
        return self._headers(path, headers)

    def _api_messages_to_conversation_messages(self, messages: list[Dict[str, Any]]) -> list[Dict[str, Any]]:
        """把标准 chat messages 转成 web conversation 所需的 messages。"""
        conversation_messages = []
        for item in messages:
            role = item.get("role", "user")
            content = item.get("content", "")
            if isinstance(content, str):
                conversation_messages.append({
                    "id": new_uuid(),
                    "author": {"role": role},
                    "content": {"content_type": "text", "parts": [content]},
                })
                continue
            if not isinstance(content, list):
                raise RuntimeError("only string or list message content is supported")
            text_parts: list[str] = []
            image_inputs: list[tuple[bytes, str]] = []
            for part in content:
                if not isinstance(part, dict):
                    continue
                part_type = str(part.get("type") or "")
                if part_type == "text":
                    text_parts.append(str(part.get("text") or ""))
                elif part_type == "image":
                    data = part.get("data")
                    mime = str(part.get("mime") or "image/png")
                    if isinstance(data, (bytes, bytearray)):
                        image_inputs.append((bytes(data), mime))
            if not image_inputs:
                conversation_messages.append({
                    "id": new_uuid(),
                    "author": {"role": role},
                    "content": {"content_type": "text", "parts": ["".join(text_parts)]},
                })
                continue
            if not self.access_token:
                raise RuntimeError("authenticated upstream account required for image input")
            uploaded: list[Dict[str, Any]] = []
            for idx, (data, mime) in enumerate(image_inputs, start=1):
                ext_part = mime.split("/", 1)[1].split("+")[0] if "/" in mime else "png"
                extension = "jpg" if ext_part == "jpeg" else (ext_part or "png")
                b64 = base64.b64encode(data).decode("ascii")
                uploaded.append(self._upload_image(f"data:{mime};base64,{b64}", f"image_{idx}.{extension}"))
            parts: list[Any] = []
            for ref in uploaded:
                parts.append({
                    "content_type": "image_asset_pointer",
                    "asset_pointer": f"file-service://{ref['file_id']}",
                    "width": ref["width"],
                    "height": ref["height"],
                    "size_bytes": ref["file_size"],
                })
            text = "".join(text_parts)
            if text:
                parts.append(text)
            conversation_messages.append({
                "id": new_uuid(),
                "author": {"role": role},
                "content": {"content_type": "multimodal_text", "parts": parts},
                "metadata": {
                    "attachments": [{
                        "id": ref["file_id"],
                        "mimeType": ref["mime_type"],
                        "name": ref["file_name"],
                        "size": ref["file_size"],
                        "width": ref["width"],
                        "height": ref["height"],
                    } for ref in uploaded],
                },
            })
        return conversation_messages

    def _conversation_payload(self, messages: list[Dict[str, Any]], model: str, timezone: str) -> Dict[str, Any]:
        """把标准 messages 构造成 web 对话请求体。"""
        return {
            "action": "next",
            "messages": self._api_messages_to_conversation_messages(messages),
            "model": model,
            "parent_message_id": new_uuid(),
            "conversation_mode": {"kind": "primary_assistant"},
            "conversation_origin": None,
            "force_paragen": False,
            "force_paragen_model_slug": "",
            "force_rate_limit": False,
            "force_use_sse": True,
            "history_and_training_disabled": True,
            "reset_rate_limits": False,
            "suggestions": [],
            "supported_encodings": [],
            "system_hints": [],
            "timezone": timezone,
            "timezone_offset_min": -480,
            "variant_purpose": "comparison_implicit",
            "websocket_request_id": new_uuid(),
            "client_contextual_info": {
                "is_dark_mode": False,
                "time_since_loaded": 120,
                "page_height": 900,
                "page_width": 1400,
                "pixel_ratio": 2,
                "screen_height": 1440,
                "screen_width": 2560,
            },
        }

    def _image_model_slug(self, model: str) -> str:
        """把标准图片模型名映射到底层 model slug。"""
        model = str(model or "").strip()
        if not model:
            return "auto"
        if model == "gpt-image-2":
            return "gpt-5-3"
        if model == CODEX_IMAGE_MODEL:
            return model
        return "auto"

    def _image_headers(self, path: str, requirements: ChatRequirements, conduit_token: str = "", accept: str = "*/*") -> \
            Dict[str, str]:
        """构造图片链路请求头。"""
        headers = {
            "Content-Type": "application/json",
            "Accept": accept,
            "OpenAI-Sentinel-Chat-Requirements-Token": requirements.token,
        }
        if requirements.proof_token:
            headers["OpenAI-Sentinel-Proof-Token"] = requirements.proof_token
        if conduit_token:
            headers["X-Conduit-Token"] = conduit_token
        if accept == "text/event-stream":
            headers["X-Oai-Turn-Trace-Id"] = new_uuid()
        return self._headers(path, headers)

    def _codex_responses_headers(self, accept: str = "text/event-stream") -> Dict[str, str]:
        """构造 Codex Responses 上游请求头。

        这条链路使用 Codex Responses 的 image_generation tool，可以结构化传递 size/quality。
        """
        headers = {
            "Authorization": f"Bearer {self.access_token}",
            "Accept": accept,
            "Content-Type": "application/json",
            "User-Agent": DEFAULT_CODEX_USER_AGENT,
            "Originator": DEFAULT_CODEX_ORIGINATOR,
            "Connection": "Keep-Alive",
            "session_id": new_uuid(),
            "conversation_id": new_uuid(),
        }
        for key in CODEX_OFFICIAL_EMPTY_HEADERS:
            headers[key] = ""
        account_id = self._chatgpt_account_id()
        if account_id:
            headers["ChatGPT-Account-Id"] = account_id
        return headers

    def _prepare_image_conversation(self, prompt: str, requirements: ChatRequirements, model: str) -> str:
        """为图片生成准备 conduit token。"""
        path = "/backend-api/f/conversation/prepare"
        payload = {
            "action": "next",
            "fork_from_shared_post": False,
            "parent_message_id": new_uuid(),
            "model": self._image_model_slug(model),
            "client_prepare_state": "success",
            "timezone_offset_min": -480,
            "timezone": "Asia/Shanghai",
            "conversation_mode": {"kind": "primary_assistant"},
            "system_hints": ["picture_v2"],
            "partial_query": {
                "id": new_uuid(),
                "author": {"role": "user"},
                "content": {"content_type": "text", "parts": [prompt]},
            },
            "supports_buffering": True,
            "supported_encodings": ["v1"],
            "client_contextual_info": {"app_name": "chatgpt.com"},
        }
        response = self.session.post(
            self.base_url + path,
            headers=self._image_headers(path, requirements),
            json=payload,
            timeout=60,
        )
        ensure_ok(response, path)
        return response.json().get("conduit_token", "")

    def _decode_image_base64(self, image: str) -> bytes:
        """把 base64 图片字符串或本地路径解码成二进制。"""
        if (
                image
                and len(image) < 512
                and not image.startswith("data:")
                and "\n" not in image
                and "\r" not in image
        ):
            file_path = Path(os.path.expanduser(image))
            if file_path.exists() and file_path.is_file():
                return file_path.read_bytes()
        payload = image.split(",", 1)[1] if image.startswith("data:") and "," in image else image
        return base64.b64decode(payload)

    @staticmethod
    def _mime_type_from_image_bytes(data: bytes) -> str:
        if data.startswith(b"\x89PNG\r\n\x1a\n"):
            return "image/png"
        if data.startswith(b"\xff\xd8\xff"):
            return "image/jpeg"
        if data.startswith(b"RIFF") and data[8:12] == b"WEBP":
            return "image/webp"
        if data.startswith((b"GIF87a", b"GIF89a")):
            return "image/gif"
        return "image/png"

    def _image_data_url(self, image: str) -> str:
        text = str(image or "").strip()
        if text.startswith("data:"):
            return text
        data = self._decode_image_base64(text)
        mime_type = self._mime_type_from_image_bytes(data)
        return f"data:{mime_type};base64,{base64.b64encode(data).decode('ascii')}"

    def _canonical_image_tool_model(self, model: str) -> str:
        model = str(model or "").strip()
        if model in {"", "gpt-image-2", CODEX_IMAGE_MODEL}:
            return CODEX_IMAGE_TOOL_MODEL
        return CODEX_IMAGE_TOOL_MODEL

    def _build_codex_image_response_body(
            self,
            prompt: str,
            model: str,
            images: Optional[list[str]] = None,
            size: object = None,
            quality: object = None,
    ) -> Dict[str, Any]:
        images = images or []
        content: list[Dict[str, Any]] = [{"type": "input_text", "text": prompt}]
        for image in images:
            image_url = self._image_data_url(image)
            if image_url:
                content.append({"type": "input_image", "image_url": image_url})

        tool: Dict[str, Any] = {
            "type": "image_generation",
            "action": "edit" if images else "generate",
            "model": self._canonical_image_tool_model(model),
        }
        size_text = str(size or "").strip()
        if size_text:
            tool["size"] = size_text
        quality_text = str(quality or "").strip()
        if quality_text:
            tool["quality"] = quality_text

        return {
            "instructions": "",
            "stream": True,
            "reasoning": {
                "effort": "medium",
                "summary": "auto",
            },
            "parallel_tool_calls": True,
            "include": ["reasoning.encrypted_content"],
            "model": DEFAULT_CODEX_IMAGE_RESPONSES_MODEL,
            "store": False,
            "tool_choice": {
                "type": "image_generation",
            },
            "input": [{
                "type": "message",
                "role": "user",
                "content": content,
            }],
            "tools": [tool],
        }

    def _start_codex_image_response(
            self,
            prompt: str,
            model: str,
            images: Optional[list[str]] = None,
            size: object = None,
            quality: object = None,
    ) -> requests.Response:
        if not self.access_token:
            raise RuntimeError("access_token is required for Codex image responses")
        payload = self._build_codex_image_response_body(prompt, model, images, size, quality)
        response = self.session.post(
            self.base_url + CODEX_RESPONSES_PATH,
            headers=self._codex_responses_headers("text/event-stream"),
            json=payload,
            timeout=300,
            stream=True,
        )
        ensure_ok(response, CODEX_RESPONSES_PATH)
        return response

    def stream_codex_image_response_events(
            self,
            prompt: str,
            model: str,
            images: Optional[list[str]] = None,
            size: object = None,
            quality: object = None,
    ) -> Iterator[Dict[str, Any]]:
        for attempt in range(1, IMAGE_TRANSPORT_RETRY_ATTEMPTS + 1):
            response: requests.Response | None = None
            try:
                response = self._start_codex_image_response(prompt, model, images, size, quality)
                saw_sse_payload = False
                raw_lines: list[str] = []
                for raw_line in response.iter_lines():
                    if not raw_line:
                        continue
                    line = raw_line.decode("utf-8", errors="ignore") if isinstance(raw_line, bytes) else str(raw_line)
                    if line.startswith("data:"):
                        saw_sse_payload = True
                        payload = line[5:].strip()
                        if not payload or payload == "[DONE]":
                            continue
                        try:
                            event = json.loads(payload)
                        except json.JSONDecodeError:
                            logger.debug({"event": "codex_image_response_non_json_sse", "payload": payload[:500]})
                            continue
                        if isinstance(event, dict):
                            yield event
                    else:
                        raw_lines.append(line)
                if not saw_sse_payload and raw_lines:
                    payload = "\n".join(raw_lines).strip()
                    if payload:
                        event = json.loads(payload)
                        if isinstance(event, dict):
                            yield event
                return
            except UpstreamHTTPError as exc:
                if exc.status_code not in IMAGE_TRANSPORT_RETRY_STATUSES or attempt >= IMAGE_TRANSPORT_RETRY_ATTEMPTS:
                    raise
                logger.warning({
                    "event": "codex_image_response_retry",
                    "attempt": attempt,
                    "status_code": exc.status_code,
                    "error": str(exc),
                })
                _image_transport_retry_sleep(attempt)
            except requests.exceptions.RequestException as exc:
                if not is_transient_upstream_connection_error(exc) or attempt >= IMAGE_TRANSPORT_RETRY_ATTEMPTS:
                    raise
                logger.warning({
                    "event": "codex_image_response_retry",
                    "attempt": attempt,
                    "error": str(exc),
                })
                _image_transport_retry_sleep(attempt)
            finally:
                if response is not None:
                    response.close()

    def _upload_image(self, image: str, file_name: str = "image.png") -> Dict[str, Any]:
        """上传一张 base64 图片，返回底层文件元数据。"""
        data = self._decode_image_base64(image)
        if (
                image
                and len(image) < 512
                and not image.startswith("data:")
                and "\n" not in image
                and "\r" not in image
        ):
            candidate_path = Path(os.path.expanduser(image))
            if candidate_path.exists() and candidate_path.is_file():
                file_name = candidate_path.name
        image = Image.open(BytesIO(data))
        width, height = image.size
        mime_type = Image.MIME.get(image.format, "image/png")
        path = "/backend-api/files"
        response = self.session.post(
            self.base_url + path,
            headers=self._headers(path, {"Content-Type": "application/json", "Accept": "application/json"}),
            json={"file_name": file_name, "file_size": len(data), "use_case": "multimodal", "width": width,
                  "height": height},
            timeout=60,
        )
        ensure_ok(response, path)
        upload_meta = response.json()
        time.sleep(0.5)
        response = self.session.put(
            upload_meta["upload_url"],
            headers={
                "Content-Type": mime_type,
                "x-ms-blob-type": "BlockBlob",
                "x-ms-version": "2020-04-08",
                "Origin": self.base_url,
                "Referer": self.base_url + "/",
                "User-Agent": self.user_agent,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "en-US,en;q=0.8",
            },
            data=data,
            timeout=120,
        )
        ensure_ok(response, "image_upload")
        path = f"/backend-api/files/{upload_meta['file_id']}/uploaded"
        response = self.session.post(
            self.base_url + path,
            headers=self._headers(path, {"Content-Type": "application/json", "Accept": "application/json"}),
            data="{}",
            timeout=60,
        )
        ensure_ok(response, path)
        return {
            "file_id": upload_meta["file_id"],
            "file_name": file_name,
            "file_size": len(data),
            "mime_type": mime_type,
            "width": width,
            "height": height,
        }

    def _start_image_generation(self, prompt: str, requirements: ChatRequirements, conduit_token: str, model: str,
                                references: Optional[list[Dict[str, Any]]] = None) -> requests.Response:
        """启动图片生成或编辑的 SSE 请求。"""
        references = references or []
        parts = [{
            "content_type": "image_asset_pointer",
            "asset_pointer": f"file-service://{item['file_id']}",
            "width": item["width"],
            "height": item["height"],
            "size_bytes": item["file_size"],
        } for item in references]
        parts.append(prompt)
        content = {"content_type": "multimodal_text", "parts": parts} if references else {"content_type": "text",
                                                                                          "parts": [prompt]}
        metadata = {
            "developer_mode_connector_ids": [],
            "selected_github_repos": [],
            "selected_all_github_repos": False,
            "system_hints": ["picture_v2"],
            "serialization_metadata": {"custom_symbol_offsets": []},
        }
        if references:
            metadata["attachments"] = [{
                "id": item["file_id"],
                "mimeType": item["mime_type"],
                "name": item["file_name"],
                "size": item["file_size"],
                "width": item["width"],
                "height": item["height"],
            } for item in references]
        payload = {
            "action": "next",
            "messages": [{
                "id": new_uuid(),
                "author": {"role": "user"},
                "create_time": time.time(),
                "content": content,
                "metadata": metadata,
            }],
            "parent_message_id": new_uuid(),
            "model": self._image_model_slug(model),
            "client_prepare_state": "sent",
            "timezone_offset_min": -480,
            "timezone": "Asia/Shanghai",
            "conversation_mode": {"kind": "primary_assistant"},
            "enable_message_followups": True,
            "system_hints": ["picture_v2"],
            "supports_buffering": True,
            "supported_encodings": ["v1"],
            "client_contextual_info": {
                "is_dark_mode": False,
                "time_since_loaded": 1200,
                "page_height": 1072,
                "page_width": 1724,
                "pixel_ratio": 1.2,
                "screen_height": 1440,
                "screen_width": 2560,
                "app_name": "chatgpt.com",
            },
            "paragen_cot_summary_display_override": "allow",
            "force_parallel_switch": "auto",
        }
        path = "/backend-api/f/conversation"
        response = self.session.post(
            self.base_url + path,
            headers=self._image_headers(path, requirements, conduit_token, "text/event-stream"),
            json=payload,
            timeout=300,
            stream=True,
        )
        ensure_ok(response, path)
        return response

    def _get_conversation(self, conversation_id: str) -> Dict[str, Any]:
        """获取完整 conversation 详情。"""
        path = f"/backend-api/conversation/{conversation_id}"
        response = self.session.get(self.base_url + path, headers=self._headers(path, {"Accept": "application/json"}),
                                    timeout=60)
        ensure_ok(response, path)
        return response.json()

    def _extract_image_tool_records(self, data: Dict[str, Any]) -> list[Dict[str, Any]]:
        """从 conversation 明细里提取图片工具输出记录。"""
        mapping = data.get("mapping") or {}
        file_pat = re.compile(r"file-service://([A-Za-z0-9_-]+)")
        sed_pat = re.compile(r"sediment://([A-Za-z0-9_-]+)")
        records = []
        for message_id, node in mapping.items():
            message = (node or {}).get("message") or {}
            author = message.get("author") or {}
            metadata = message.get("metadata") or {}
            content = message.get("content") or {}
            if author.get("role") != "tool":
                continue
            if content.get("content_type") != "multimodal_text":
                continue
            file_ids, sediment_ids = [], []
            for part in content.get("parts") or []:
                text = (part.get("asset_pointer") or "") if isinstance(part, dict) else (
                    part if isinstance(part, str) else "")
                for hit in file_pat.findall(text):
                    if hit not in file_ids:
                        file_ids.append(hit)
                for hit in sed_pat.findall(text):
                    if hit not in sediment_ids:
                        sediment_ids.append(hit)
            if metadata.get("async_task_type") != "image_gen" and not file_ids and not sediment_ids:
                continue
            records.append(
                {"message_id": message_id, "create_time": message.get("create_time") or 0, "file_ids": file_ids,
                 "sediment_ids": sediment_ids})
        return sorted(records, key=lambda item: item["create_time"])

    def _poll_image_results(self, conversation_id: str, timeout_secs: float = 120.0) -> tuple[list[str], list[str]]:
        """Poll the conversation document until image file ids appear or budget runs out.

        - Sleeps image_poll_initial_wait_secs first (default 10s, +jitter). ChatGPT
          image generation takes ~30s; polling immediately wastes requests and trips
          a transient 429 the upstream returns within ~200ms of the SSE stream
          closing (the conversation document is not yet committed).
        - Subsequent polls are image_poll_interval_secs apart (default 10s).
        - On upstream 429 / 5xx or network errors, backs off exponentially
          (capped at 16s, +jitter) honoring Retry-After when present.
        - All sleeps stay within timeout_secs; on exhaustion raises ImagePollTimeoutError.
        """
        start = time.time()
        attempt = 0
        interval = float(config.image_poll_interval_secs)
        initial_wait = float(config.image_poll_initial_wait_secs)
        logger.info({
            "event": "image_poll_start",
            "conversation_id": conversation_id,
            "timeout_secs": timeout_secs,
            "initial_wait_secs": initial_wait,
            "interval_secs": interval,
        })

        def _remaining() -> float:
            return timeout_secs - (time.time() - start)

        if initial_wait > 0:
            jitter = random.uniform(0, min(2.0, initial_wait * 0.2))
            sleep_for = min(initial_wait + jitter, max(0.0, _remaining()))
            if sleep_for > 0:
                time.sleep(sleep_for)

        def _retry_sleep(reason: str, status_code: int | None, error: str | None, retry_after: int | None) -> bool:
            # retry_after=0 means "retry immediately" — must not be coerced via falsy check.
            base = retry_after if retry_after is not None else min(2 ** min(attempt, 4), 16)
            backoff = base + random.uniform(0, 0.5)
            remaining = _remaining()
            if remaining <= 0:
                return False
            sleep_for = min(backoff, remaining)
            log_payload: Dict[str, Any] = {
                "event": "image_poll_retry",
                "conversation_id": conversation_id,
                "attempt": attempt,
                "reason": reason,
                "sleep_secs": round(sleep_for, 2),
            }
            if status_code is not None:
                log_payload["status_code"] = status_code
            if error is not None:
                log_payload["error"] = error
            logger.warning(log_payload)
            time.sleep(sleep_for)
            return True

        while _remaining() > 0:
            attempt += 1
            try:
                conversation = self._get_conversation(conversation_id)
            except UpstreamHTTPError as exc:
                if exc.status_code in (429, 500, 502, 503, 504):
                    if _retry_sleep("upstream_status", exc.status_code, None, exc.retry_after):
                        continue
                    break
                raise
            except requests.exceptions.RequestException as exc:
                if _retry_sleep("network", None, str(exc), None):
                    continue
                break

            file_ids, sediment_ids = [], []
            for record in self._extract_image_tool_records(conversation):
                for file_id in record["file_ids"]:
                    if file_id not in file_ids:
                        file_ids.append(file_id)
                for sediment_id in record["sediment_ids"]:
                    if sediment_id not in sediment_ids:
                        sediment_ids.append(sediment_id)
            logger.debug({"event": "image_poll_check", "conversation_id": conversation_id, "attempt": attempt,
                          "file_ids": file_ids, "sediment_ids": sediment_ids})
            if file_ids:
                logger.info({"event": "image_poll_hit", "conversation_id": conversation_id, "file_ids": file_ids,
                             "sediment_ids": sediment_ids})
                return file_ids, sediment_ids
            if sediment_ids:
                logger.info({"event": "image_poll_hit", "conversation_id": conversation_id, "file_ids": [],
                             "sediment_ids": sediment_ids})
                return [], sediment_ids
            logger.debug({"event": "image_poll_wait", "conversation_id": conversation_id,
                          "elapsed_secs": round(time.time() - start, 1)})
            wait = min(interval, max(0.0, _remaining()))
            if wait > 0:
                time.sleep(wait)
        logger.info({
            "event": "image_poll_timeout",
            "conversation_id": conversation_id,
            "timeout_secs": timeout_secs,
            "attempts_made": attempt,
            # attempts_made == 0 means the initial_wait consumed the entire budget — no HTTP attempted.
            "initial_wait_exhausted_budget": attempt == 0,
        })
        raise ImagePollTimeoutError(
            f"ChatGPT 生图超时（已等待 {timeout_secs} 秒）。"
            f"当前超时阈值可在 config.json 中调大 image_poll_timeout_secs，"
            f"也可能是账号被限流或生图队列拥堵导致。"
        )

    def _get_file_download_url(self, file_id: str) -> str:
        """获取文件下载地址。"""
        path = f"/backend-api/files/{file_id}/download"
        response = self.session.get(self.base_url + path, headers=self._headers(path, {"Accept": "application/json"}),
                                    timeout=60)
        ensure_ok(response, path)
        data = response.json()
        return data.get("download_url") or data.get("url") or ""

    def _get_attachment_download_url(self, conversation_id: str, attachment_id: str) -> str:
        """通过 conversation 附件接口获取下载地址。"""
        path = f"/backend-api/conversation/{conversation_id}/attachment/{attachment_id}/download"
        response = self.session.get(self.base_url + path, headers=self._headers(path, {"Accept": "application/json"}),
                                    timeout=60)
        ensure_ok(response, path)
        data = response.json()
        return data.get("download_url") or data.get("url") or ""

    def _resolve_image_urls(self, conversation_id: str, file_ids: list[str], sediment_ids: list[str]) -> list[str]:
        """把图片结果 id 解析成可下载 URL。"""
        urls = []
        skip_patterns = {"file_upload"}
        for file_id in file_ids:
            if file_id in skip_patterns:
                logger.debug({
                    "event": "image_file_id_skipped",
                    "source": "file",
                    "conversation_id": conversation_id,
                    "id": file_id,
                })
                continue
            try:
                url = self._get_file_download_url(file_id)
            except Exception as exc:
                logger.debug({
                    "event": "image_download_url_failed",
                    "source": "file",
                    "conversation_id": conversation_id,
                    "id": file_id,
                    "error": repr(exc),
                })
                continue
            if url:
                urls.append(url)
            else:
                logger.debug({
                    "event": "image_download_url_empty",
                    "source": "file",
                    "conversation_id": conversation_id,
                    "id": file_id,
                })
        if urls or not conversation_id:
            logger.debug({
                "event": "image_urls_resolved",
                "conversation_id": conversation_id,
                "file_ids": file_ids,
                "sediment_ids": sediment_ids,
                "urls": urls,
            })
            return urls
        for sediment_id in sediment_ids:
            try:
                url = self._get_attachment_download_url(conversation_id, sediment_id)
            except Exception as exc:
                logger.debug({
                    "event": "image_download_url_failed",
                    "source": "sediment",
                    "conversation_id": conversation_id,
                    "id": sediment_id,
                    "error": repr(exc),
                })
                continue
            if url:
                urls.append(url)
            else:
                logger.debug({
                    "event": "image_download_url_empty",
                    "source": "sediment",
                    "conversation_id": conversation_id,
                    "id": sediment_id,
                })
        logger.debug({
            "event": "image_urls_resolved",
            "conversation_id": conversation_id,
            "file_ids": file_ids,
            "sediment_ids": sediment_ids,
            "urls": urls,
        })
        return urls

    def resolve_conversation_image_urls(
            self,
            conversation_id: str,
            file_ids: list[str],
            sediment_ids: list[str],
            poll: bool = True,
    ) -> list[str]:
        file_ids = [item for item in file_ids if item != "file_upload"]
        sediment_ids = list(sediment_ids)
        if poll and conversation_id and not file_ids and not sediment_ids:
            logger.info({"event": "image_resolve_poll_needed", "conversation_id": conversation_id})
            polled_file_ids, polled_sediment_ids = self._poll_image_results(conversation_id,
                                                                            config.image_poll_timeout_secs)
            file_ids.extend(item for item in polled_file_ids if item and item not in file_ids)
            sediment_ids.extend(item for item in polled_sediment_ids if item and item not in sediment_ids)
        return self._resolve_image_urls(conversation_id, file_ids, sediment_ids)

    def _download_image_with_retry(self, url: str) -> bytes:
        for attempt in range(1, IMAGE_TRANSPORT_RETRY_ATTEMPTS + 1):
            try:
                response = self.session.get(url, timeout=120)
                ensure_ok(response, "image_download")
                return response.content
            except UpstreamHTTPError as exc:
                if exc.status_code not in IMAGE_TRANSPORT_RETRY_STATUSES or attempt >= IMAGE_TRANSPORT_RETRY_ATTEMPTS:
                    raise
                logger.warning({
                    "event": "image_download_retry",
                    "attempt": attempt,
                    "status_code": exc.status_code,
                    "error": str(exc),
                })
                _image_transport_retry_sleep(attempt)
            except requests.exceptions.RequestException as exc:
                if not is_transient_upstream_connection_error(exc) or attempt >= IMAGE_TRANSPORT_RETRY_ATTEMPTS:
                    raise
                logger.warning({
                    "event": "image_download_retry",
                    "attempt": attempt,
                    "error": str(exc),
                })
                _image_transport_retry_sleep(attempt)
        raise RuntimeError("image_download failed")

    def download_image_bytes(self, urls: list[str]) -> list[bytes]:
        images = []
        for url in urls:
            images.append(self._download_image_with_retry(url))
        return images

    def stream_conversation(
            self,
            messages: Optional[list[Dict[str, Any]]] = None,
            model: str = "auto",
            prompt: str = "",
            images: Optional[list[str]] = None,
            system_hints: Optional[list[str]] = None,
    ) -> Iterator[str]:
        system_hints = system_hints or []
        if "picture_v2" in system_hints:
            yield from self._stream_picture_conversation(prompt, model, images or [])
            return

        normalized = messages or [{"role": "user", "content": prompt}]
        self._bootstrap()
        requirements = self._get_chat_requirements()
        path, timezone = self._chat_target()
        payload = self._conversation_payload(normalized, model, timezone)
        response = self.session.post(
            self.base_url + path,
            headers=self._conversation_headers(path, requirements),
            json=payload,
            timeout=300,
            stream=True,
        )
        ensure_ok(response, path)
        try:
            yield from iter_sse_payloads(response)
        finally:
            response.close()

    def _stream_picture_conversation(
            self,
            prompt: str,
            model: str,
            images: list[str],
    ) -> Iterator[str]:
        if not self.access_token:
            raise RuntimeError("access_token is required for image endpoints")
        references = [self._upload_image(image, f"image_{idx}.png") for idx, image in enumerate(images, start=1)]
        self._bootstrap()
        requirements = self._get_chat_requirements()
        conduit_token = self._prepare_image_conversation(prompt, requirements, model)
        response = self._start_image_generation(prompt, requirements, conduit_token, model, references)
        try:
            yield from iter_sse_payloads(response)
        finally:
            response.close()

    def _bootstrap(self) -> None:
        """预热首页，并提取 PoW 相关脚本引用。"""
        response = self.session.get(
            self.base_url + "/",
            headers=self._bootstrap_headers(),
            timeout=30,
        )
        ensure_ok(response, "bootstrap")
        self.pow_script_sources, self.pow_data_build = parse_pow_resources(response.text)
        if not self.pow_script_sources:
            self.pow_script_sources = [DEFAULT_POW_SCRIPT]

    def _get_chat_requirements(self) -> ChatRequirements:
        """获取当前模式对话所需的 sentinel token。"""
        path = "/backend-api/sentinel/chat-requirements" if self.access_token else "/backend-anon/sentinel/chat-requirements"
        context = "auth_chat_requirements" if self.access_token else "noauth_chat_requirements"
        body = {"p": build_legacy_requirements_token(self.user_agent, self.pow_script_sources, self.pow_data_build)}
        response = self.session.post(
            self.base_url + path,
            headers=self._headers(path, {"Content-Type": "application/json"}),
            json=body,
            timeout=30,
        )
        ensure_ok(response, context)
        requirements = self._build_requirements(response.json(), "" if self.access_token else body["p"])
        if not requirements.token:
            message = "missing auth chat requirements token" if self.access_token else "missing chat requirements token"
            raise RuntimeError(f"{message}: {requirements.raw_finalize}")
        return requirements

    def _chat_target(self) -> tuple[str, str]:
        if self.access_token:
            return "/backend-api/conversation", "Asia/Shanghai"
        return "/backend-anon/conversation", "America/Los_Angeles"

    def list_models(self) -> Dict[str, Any]:
        """返回当前模式下可用模型，格式对齐 OpenAI `/v1/models`。"""
        self._bootstrap()
        path = "/backend-api/models?history_and_training_disabled=false" if self.access_token else (
            "/backend-anon/models?iim=false&is_gizmo=false"
        )
        route = "/backend-api/models" if self.access_token else "/backend-anon/models"
        context = "auth_models" if self.access_token else "anon_models"
        response = self.session.get(
            self.base_url + path,
            headers=self._headers(route),
            timeout=30,
        )
        ensure_ok(response, context)
        data = []
        seen = set()
        for item in response.json().get("models", []):
            if not isinstance(item, dict):
                continue
            slug = str(item.get("slug", "")).strip()
            if not slug or slug in seen:
                continue
            seen.add(slug)
            data.append({
                "id": slug,
                "object": "model",
                "created": int(item.get("created") or 0),
                "owned_by": str(item.get("owned_by") or "chatgpt"),
                "permission": [],
                "root": slug,
                "parent": None,
            })
        data.sort(key=lambda item: item["id"])
        return {"object": "list", "data": data}
