import unittest
from typing import Any
from unittest.mock import patch

from services.account_service import AccountService
from services.cpa_service import CPAImportService
from services.openai_backend_api import OpenAIBackendAPI
from services.sub2api_service import Sub2APIImportService


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


class FakeSub2APIConfig:
    def __init__(self) -> None:
        self.job: dict[str, Any] = {
            "job_id": "job-1",
            "status": "running",
            "created_at": "2026-05-23T00:00:00+00:00",
            "updated_at": "2026-05-23T00:00:00+00:00",
            "total": 1,
            "completed": 0,
            "added": 0,
            "skipped": 0,
            "refreshed": 0,
            "failed": 0,
            "errors": [],
        }

    def get_import_job(self, server_id: str) -> dict[str, Any]:
        return dict(self.job)

    def set_import_job(self, server_id: str, import_job: dict[str, Any] | None) -> dict[str, Any]:
        self.job = dict(import_job or {})
        return {"import_job": dict(self.job)}


class FakeCPAConfig(FakeSub2APIConfig):
    pass


class FakeAccountService:
    def __init__(self) -> None:
        self.account_payloads: list[dict[str, Any]] = []
        self.refreshed_tokens: list[str] = []

    def add_account_items(self, items: list[dict[str, Any]]) -> dict[str, Any]:
        self.account_payloads = [dict(item) for item in items]
        return {"added": len(items), "skipped": 0}

    def refresh_accounts(self, tokens: list[str]) -> dict[str, Any]:
        self.refreshed_tokens = list(tokens)
        return {"refreshed": len(tokens), "errors": []}


class AccountPlanTypeTests(unittest.TestCase):
    def test_imported_plan_type_sets_type_and_is_not_downgraded_by_free_refresh(self) -> None:
        service = AccountService(MemoryStorage())

        service.add_account_items(
            [
                {
                    "access_token": "access_token_team",
                    "email": "ming_log@qq.com",
                    "type": "free",
                    "plan_type": "team",
                }
            ]
        )

        account = service.get_account("access_token_team")
        self.assertIsNotNone(account)
        self.assertEqual(account["type"], "team")

        refreshed = service.update_account(
            "access_token_team",
            {"type": "free", "quota": 20},
            preserve_plan_hint=True,
        )
        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed["type"], "team")

        manually_updated = service.update_account("access_token_team", {"type": "free"})
        self.assertIsNotNone(manually_updated)
        self.assertEqual(manually_updated["type"], "free")

    def test_backend_plan_type_prefers_paid_account_over_free_default(self) -> None:
        payload = {
            "accounts": {
                "default": {"account": {"id": "personal", "plan_type": "free"}},
                "team-account": {"account": {"id": "team", "plan_type": "team"}},
            }
        }

        default_account = OpenAIBackendAPI._extract_default_account(payload)
        plan_type = OpenAIBackendAPI._extract_best_plan_type(payload, default_account)

        self.assertEqual(plan_type, "team")

    def test_sub2api_import_keeps_remote_plan_type_metadata(self) -> None:
        fake_config = FakeSub2APIConfig()
        fake_account_service = FakeAccountService()
        service = Sub2APIImportService(fake_config)  # type: ignore[arg-type]

        with (
            patch(
                "services.sub2api_service._fetch_access_token_for_account",
                return_value=("access_token_team", {"email": "ming_log@qq.com", "plan_type": "team"}),
            ),
            patch("services.sub2api_service.account_service", fake_account_service),
        ):
            service._run_import("server-1", {"id": "server-1"}, ["remote-account-1"])

        self.assertEqual(
            fake_account_service.account_payloads,
            [{"access_token": "access_token_team", "email": "ming_log@qq.com", "plan_type": "team"}],
        )
        self.assertEqual(fake_account_service.refreshed_tokens, ["access_token_team"])
        self.assertEqual(fake_config.job["status"], "completed")
        self.assertEqual(fake_config.job["refreshed"], 1)

    def test_remote_cpa_import_keeps_file_plan_type_metadata(self) -> None:
        fake_config = FakeCPAConfig()
        fake_account_service = FakeAccountService()
        service = CPAImportService(fake_config)  # type: ignore[arg-type]

        with (
            patch(
                "services.cpa_service.fetch_remote_account_payload",
                return_value=(
                    {"access_token": "access_token_team", "email": "ming_log@qq.com", "plan_type": "team"},
                    None,
                ),
            ),
            patch("services.cpa_service.account_service", fake_account_service),
        ):
            service._run_import("pool-1", {"id": "pool-1"}, ["ming_log.json"])

        self.assertEqual(
            fake_account_service.account_payloads,
            [{"access_token": "access_token_team", "email": "ming_log@qq.com", "plan_type": "team"}],
        )
        self.assertEqual(fake_account_service.refreshed_tokens, ["access_token_team"])
        self.assertEqual(fake_config.job["status"], "completed")
        self.assertEqual(fake_config.job["refreshed"], 1)


if __name__ == "__main__":
    unittest.main()
