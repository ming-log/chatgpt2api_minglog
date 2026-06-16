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

    def test_get_available_access_token_filters_by_account_category(self) -> None:
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

        free_token = service.get_available_access_token()
        service.release_image_slot(free_token)
        paid_token = service.get_available_access_token("paid")
        service.release_image_slot(paid_token)

        self.assertEqual(free_token, "free-token")
        self.assertEqual(paid_token, "team-token")

    def test_legacy_paid_account_type_request_matches_paid_category(self) -> None:
        service = AccountService(MemoryStorage([{"access_token": "plus-token", "type": "plus", "quota": 2}]))

        def fake_fetch_remote_info(access_token: str, event: str = "fetch_remote_info") -> dict[str, Any] | None:
            return service.get_account(access_token)

        service.fetch_remote_info = fake_fetch_remote_info  # type: ignore[method-assign]

        token = service.get_available_access_token("plus")
        service.release_image_slot(token)

        self.assertEqual(token, "plus-token")

    def test_get_available_access_token_reports_missing_requested_type(self) -> None:
        service = AccountService(MemoryStorage([{"access_token": "free-token", "type": "free", "quota": 2}]))

        with self.assertRaisesRegex(RuntimeError, "account type paid"):
            service.get_available_access_token("paid")


if __name__ == "__main__":
    unittest.main()
