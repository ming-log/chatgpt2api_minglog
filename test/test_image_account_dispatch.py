from __future__ import annotations

import unittest
from typing import Any

from services.account_service import AccountService, normalize_image_account_category


class MemoryStorage:
    def __init__(self, accounts: list[dict[str, Any]] | None = None) -> None:
        self.accounts = list(accounts or [])

    def load_accounts(self) -> list[dict[str, Any]]:
        return list(self.accounts)

    def save_accounts(self, accounts: list[dict[str, Any]]) -> None:
        self.accounts = list(accounts)

    def load_auth_keys(self) -> list[dict[str, Any]]:
        return []

    def save_auth_keys(self, auth_keys: list[dict[str, Any]]) -> None:
        pass

    def health_check(self) -> dict[str, Any]:
        return {"ok": True}

    def get_backend_info(self) -> dict[str, Any]:
        return {"type": "memory"}


class ImageAccountDispatchTests(unittest.TestCase):
    def test_image_account_category_collapses_paid_plan_types(self) -> None:
        for value in ("paid", "team", "plus", "pro", "prolite", "business", "enterprise", "edu", "Team/Plus/Pro"):
            self.assertEqual(normalize_image_account_category(value), "paid")
        self.assertEqual(normalize_image_account_category("free"), "free")

    def test_image_dispatch_uses_all_accounts_regardless_of_type(self) -> None:
        # 图片生成不再区分套餐：所有账号统一进入同一个反代号池。
        service = AccountService(MemoryStorage())
        service.add_account_items(
            [
                {"access_token": "free-token", "type": "free", "quota": 2},
                {"access_token": "team-token", "type": "team", "quota": 2},
            ]
        )

        def fake_fetch_remote_info(access_token: str, event: str = "fetch_remote_info") -> dict[str, Any] | None:
            return service.get_account(access_token)

        service.fetch_remote_info = fake_fetch_remote_info  # type: ignore[method-assign]

        seen: set[str] = set()
        for _ in range(4):
            token = service.get_available_access_token("free")
            seen.add(token)
            service.release_image_slot(token)

        self.assertEqual(seen, {"free-token", "team-token"})

    def test_paid_request_falls_back_to_any_available_account(self) -> None:
        # 请求 paid 也能拿到 free 账号，因为不再有套餐限制。
        service = AccountService(MemoryStorage([{"access_token": "free-token", "type": "free", "quota": 2}]))

        def fake_fetch_remote_info(access_token: str, event: str = "fetch_remote_info") -> dict[str, Any] | None:
            return service.get_account(access_token)

        service.fetch_remote_info = fake_fetch_remote_info  # type: ignore[method-assign]

        token = service.get_available_access_token("paid")
        service.release_image_slot(token)

        self.assertEqual(token, "free-token")

    def test_get_available_access_token_reports_when_pool_empty(self) -> None:
        service = AccountService(MemoryStorage([{"access_token": "free-token", "type": "free", "quota": 0}]))

        with self.assertRaisesRegex(RuntimeError, "no available image quota"):
            service.get_available_access_token("paid")


if __name__ == "__main__":
    unittest.main()
