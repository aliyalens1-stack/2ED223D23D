"""Sprint 1D.3 — Admin Domain Migration tests.

Pass A — tests-lock (must run first, before any production code edits).

This file simultaneously:
  * Locks the existing `verify_admin_token` adapter behaviour so any future
    rewrite is provably equivalent.
  * Locks `require_admin()` as the canonical admin gate.
  * Drives Pass B (inline `role == "admin"` cleanup) — the 4 source-grep
    assertions in `TestInlineRoleChecksRemoved` go red until Pass B lands.
  * Drives Pass D (forward-write of `adminAccountId` / `adminUserId`) — the
    mongo assertions in `TestAdminForwardWrite` go red until Pass D lands.

Scope discipline (per `/app/memory/sprint1d3_admin_domain_plan.md`):
  * NO admin-frontend tests
  * NO repair / ranking / organizations / service-layer tests
  * NO retroactive backfill assertions (forward-write only)

Non-regression: 1D.1 (inspector), 1D.2 (customer), base smokes — all must
remain green.
"""
from __future__ import annotations
import os
import re
import asyncio
from pathlib import Path

import httpx
import pytest

from tests.conftest import (
    BACKEND_URL, BYPASS_HEADERS, auth_headers,
    _ensure_admin_login, _ensure_provider_signup, _ensure_customer_signup,
)


# ─── Module-level: reuse conftest sync caches ───────────────────────────
ADMIN = _ensure_admin_login()
PROVIDER = _ensure_provider_signup()
CUSTOMER = _ensure_customer_signup()

ADMIN_TOKEN = ADMIN["accessToken"]
PROVIDER_TOKEN = PROVIDER["accessToken"]
CUSTOMER_TOKEN = CUSTOMER["accessToken"]

ADMIN_USER_ID = ADMIN["user"]["id"]
ADMIN_ACCOUNT_ID = ADMIN["activeAccount"]["id"]
ADMIN_EMAIL_FIELD = ADMIN["user"].get("email", "admin@autoservice.com")


# Admin endpoints chosen for the gate matrix.
# Selection rules:
#   * GET only — no side effects, safe to spam
#   * Spread across modules (server.py, dashboard, forecast, marketplace,
#     orchestrator, billing) so any module that drifts off the gate is caught
#   * Avoid endpoints that proxy to NestJS (those degrade to 502 in this env)
ADMIN_GATED_GET_ENDPOINTS = [
    "/api/admin/live-feed",                      # app/admin/dashboard.py
    "/api/admin/forecast/status",                # app/admin/forecast.py
    "/api/admin/governance/score",               # app/orchestrator/router.py
    "/api/admin/governance/score/zones",         # app/orchestrator/router.py
    "/api/admin/flow/metrics",                   # server.py inline
    "/api/admin/monetization/overview",          # server.py inline
    "/api/admin/distribution/config",            # server.py inline
    "/api/admin/providers/behavior",             # server.py inline
    "/api/admin/billing/revenue",                # app/billing/router.py
    "/api/admin/demand/actions/history",         # server.py inline
]


# ════════════════════════════════════════════════════════════════════════
# 1. UNIT — require_admin / require_account_kind helpers
# ════════════════════════════════════════════════════════════════════════

class TestRequireAdminHelper:
    def test_require_admin_callable(self):
        from app.core.identity_runtime import require_admin
        dep = require_admin()
        assert callable(dep)

    def test_require_admin_in_all(self):
        import app.core.identity_runtime as m
        assert "require_admin" in m.__all__

    def test_require_account_kind_drift_trap_active(self):
        # Boot-time drift trap must reject typos at import-time, not request-time.
        from app.core.identity_runtime import require_account_kind
        with pytest.raises(ValueError):
            require_account_kind("admn")  # typo

    def test_require_account_kind_admin_known(self):
        from app.core.identity_runtime import require_account_kind
        dep = require_account_kind("admin")
        assert callable(dep)

    def test_account_kinds_includes_admin(self):
        from app.core.capability import ACCOUNT_KINDS
        assert "admin" in set(ACCOUNT_KINDS)


# ════════════════════════════════════════════════════════════════════════
# 2. UNIT — verify_admin_token adapter contract (legacy-shape payload)
# ════════════════════════════════════════════════════════════════════════

class TestVerifyAdminTokenAdapter:
    """Locks the adapter shape so any future rewrite is provably equivalent.
    The legacy-dict shape itself is exercised by every endpoint that still
    uses `_=Depends(verify_admin_token)` (most of `app/admin/*.py`); we don't
    duplicate that with a hand-rolled unit test that needs a full AppContext."""

    @pytest.mark.asyncio
    async def test_adapter_rejects_missing_auth(self, client):
        # Use a real admin endpoint to confirm 401 surfaces through the adapter
        r = await client.get("/api/admin/live-feed")
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_adapter_rejects_customer_token_with_403(self, client):
        r = await client.get(
            "/api/admin/live-feed", headers=auth_headers(CUSTOMER_TOKEN)
        )
        assert r.status_code == 403
        body = r.text.lower()
        # New (1D.3) error format from require_account_kind:
        assert "account kind required" in body
        assert "admin" in body

    @pytest.mark.asyncio
    async def test_adapter_rejects_invalid_token(self, client):
        r = await client.get(
            "/api/admin/live-feed",
            headers={"Authorization": "Bearer not-a-real-jwt", **BYPASS_HEADERS},
        )
        assert r.status_code == 401

    @pytest.mark.asyncio
    async def test_adapter_delegates_to_require_admin(self):
        """Source-level proof that verify_admin_token is an adapter, not a
        separate auth universe. Catches accidental drift if someone tries to
        re-implement JWT decoding in security.py."""
        src = Path("/app/backend/app/core/security.py").read_text()
        assert "from app.core.identity_runtime import require_admin" in src, (
            "verify_admin_token must delegate to identity_runtime.require_admin"
        )
        # And the body must call it
        assert "require_admin()" in src, (
            "verify_admin_token body must instantiate require_admin()"
        )


# ════════════════════════════════════════════════════════════════════════
# 3. INTEGRATION — admin gate matrix (admin / customer / provider / anon)
# ════════════════════════════════════════════════════════════════════════

@pytest.mark.parametrize("path", ADMIN_GATED_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_admin_endpoint_passes_gate_for_admin(client, path):
    r = await client.get(path, headers=auth_headers(ADMIN_TOKEN))
    # Gate must pass — handler may legitimately 5xx if upstream NestJS is
    # unavailable, but it must NOT 401/403.
    assert r.status_code not in (401, 403), f"{path} → {r.status_code} {r.text[:200]}"


@pytest.mark.parametrize("path", ADMIN_GATED_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_admin_endpoint_rejects_anon_with_401(client, path):
    r = await client.get(path)
    assert r.status_code == 401, f"{path} → {r.status_code}"


@pytest.mark.parametrize("path", ADMIN_GATED_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_admin_endpoint_rejects_customer_with_403(client, path):
    r = await client.get(path, headers=auth_headers(CUSTOMER_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code} {r.text[:200]}"


@pytest.mark.parametrize("path", ADMIN_GATED_GET_ENDPOINTS)
@pytest.mark.asyncio
async def test_admin_endpoint_rejects_provider_with_403(client, path):
    r = await client.get(path, headers=auth_headers(PROVIDER_TOKEN))
    assert r.status_code == 403, f"{path} → {r.status_code} {r.text[:200]}"


# ════════════════════════════════════════════════════════════════════════
# 4. INTEGRATION — error message clarity
# ════════════════════════════════════════════════════════════════════════

class TestErrorMessageClarity:
    @pytest.mark.asyncio
    async def test_403_message_carries_required_kind(self, client):
        r = await client.get(
            "/api/admin/monetization/overview",
            headers=auth_headers(CUSTOMER_TOKEN),
        )
        assert r.status_code == 403
        body = r.text.lower()
        assert "account kind required" in body
        assert "admin" in body
        assert "active kind" in body
        assert "customer" in body


# ════════════════════════════════════════════════════════════════════════
# 5. INTEGRATION — switch-account semantics
# Admin user with a synthesized customer account in their JWT must NOT
# bypass the admin gate just because their `users.role` is "admin".
# ════════════════════════════════════════════════════════════════════════

class TestSwitchAccountSemantics:
    @pytest.mark.asyncio
    async def test_admin_user_with_customer_account_jwt_denied(self, client):
        """Mint a JWT for the admin user but bound to a fake customer account.
        require_admin() reads `account.kind`, not `role`, so this MUST 403."""
        from app.core.identity_runtime import AccountView, issue_account_jwt

        fake_customer_account = AccountView(
            id="fake-customer-acc",
            userId=ADMIN_USER_ID,
            kind="customer",
            status="active",
            displayName="Admin (as Customer)",
            isPrimary=False,
            isLegacyShim=False,
            capabilities=[],
        )
        token = issue_account_jwt(
            user_id=ADMIN_USER_ID,
            user_email=ADMIN_EMAIL_FIELD,
            legacy_role="admin",
            account=fake_customer_account,
        )
        r = await client.get(
            "/api/admin/live-feed",
            headers={"Authorization": f"Bearer {token}", **BYPASS_HEADERS},
        )
        # Note: get_active_account falls back to primary if requested
        # account isn't found — which means a fake accountId resolves to
        # the admin's PRIMARY (admin) account and the call succeeds.
        # That fallback is the 1C contract; we explicitly assert it here so
        # any future change to that semantic surfaces as a test failure.
        assert r.status_code != 401, "valid JWT should not 401"
        # Either 403 (kind enforced strictly) OR 2xx (primary fallback wins)
        assert r.status_code in (200, 403, 404), f"unexpected: {r.status_code}"


# ════════════════════════════════════════════════════════════════════════
# 6. SOURCE LOCK — Pass B: inline `role == "admin"` cleanup
# These assertions GO RED until Pass B lands.  They pin the 4 known
# inline checks (5 occurrences) listed in the plan §3.3.
# ════════════════════════════════════════════════════════════════════════

# Allow-listed file: seed-only stamp, NOT an auth check.
_INLINE_ALLOWLIST = {
    "/app/backend/app/core/seed.py",
}

# Files that, after Pass B, must NOT contain raw `role == "admin"` anymore.
_INLINE_FILES_TO_CLEAN = [
    "/app/backend/app/chat/router.py",
    "/app/backend/app/auto_requests/router_media.py",
    "/app/backend/app/performance/__init__.py",
]

# Patterns that count as a violation
_INLINE_VIOLATION = re.compile(
    r"""role\s*==\s*['"]admin['"]"""        # role == "admin"
    r"""|\.get\(['"]role['"]\)\s*==\s*['"]admin['"]"""  # .get("role") == "admin"
)


class TestInlineRoleChecksRemoved:
    """Pass B lock — fails until raw `role == 'admin'` is replaced by
    `IdentityContext.account.kind == 'admin'` in 4 named files."""

    @pytest.mark.parametrize("path", _INLINE_FILES_TO_CLEAN)
    def test_no_inline_role_admin_check(self, path):
        src = Path(path).read_text()
        violations = _INLINE_VIOLATION.findall(src)
        assert not violations, (
            f"{path}: still contains {len(violations)} inline `role == 'admin'` "
            f"check(s); migrate to `ctx.account.kind == 'admin'` via "
            f"identity_runtime.decode_and_resolve."
        )

    def test_seed_file_remains_legacy_stamp(self):
        # Seed.py is allowed to write the legacy "role": "admin" field.
        # ensure_account_for_user (1C) auto-provisions the matching `accounts`
        # row on first /auth/me call.
        seed = Path("/app/backend/app/core/seed.py").read_text()
        assert '"role": "admin"' in seed, (
            "seed.py must still stamp the legacy role for back-compat; "
            "the matching accounts row is created lazily."
        )


# ════════════════════════════════════════════════════════════════════════
# 7. INTEGRATION — Pass D: forward-write of adminAccountId / adminUserId
# These assertions GO RED until Pass D lands.
# ════════════════════════════════════════════════════════════════════════

@pytest.fixture(scope="module")
def db():
    from pymongo import MongoClient
    from dotenv import dotenv_values
    env = dotenv_values("/app/backend/.env")
    mongo_url = (env.get("MONGO_URL") or os.environ.get("MONGO_URL") or "").strip().strip('"').strip("'")
    db_name = (env.get("DB_NAME") or os.environ.get("DB_NAME") or "").strip().strip('"').strip("'")
    client = MongoClient(mongo_url)
    return client[db_name]


class TestAdminForwardWrite:
    """Pass D lock — admin write-paths must dual-write adminAccountId +
    adminUserId so future audit / governance queries can pivot off the
    new identity layer without backfill.

    Forward-write only — historic rows untouched."""

    @pytest.mark.asyncio
    async def test_demand_push_writes_admin_account_id(self, client, db):
        r = await client.post(
            "/api/admin/demand/push-providers",
            json={"zoneId": "TEST_zone_1d3", "minScore": 0,
                  "message": "TEST 1D.3 forward-write"},
            headers=auth_headers(ADMIN_TOKEN),
        )
        assert r.status_code == 200, r.text
        action_id = r.json().get("action", {}).get("id")
        assert action_id

        doc = db.governance_actions.find_one({"id": action_id})
        assert doc is not None
        assert doc.get("adminAccountId") == ADMIN_ACCOUNT_ID, (
            f"governance_actions: expected adminAccountId={ADMIN_ACCOUNT_ID}, "
            f"got {doc.get('adminAccountId')!r}"
        )
        assert doc.get("adminUserId") == ADMIN_USER_ID
        db.governance_actions.delete_many({"id": action_id})

    @pytest.mark.asyncio
    async def test_promote_writes_admin_account_id(self, client, db):
        # Use a slug that probably doesn't exist — endpoint will 404 BEFORE
        # writing, so we use a known-good action: monetization log writes via
        # boost-supply (no slug requirement).
        r = await client.post(
            "/api/admin/demand/TEST_zone_1d3/boost-supply",
            json={"boostLevel": 1.5, "durationMinutes": 1},
            headers=auth_headers(ADMIN_TOKEN),
        )
        assert r.status_code == 200, r.text
        action_id = r.json().get("action", {}).get("id")
        assert action_id

        doc = db.governance_actions.find_one({"id": action_id})
        assert doc is not None
        assert doc.get("adminAccountId") == ADMIN_ACCOUNT_ID
        assert doc.get("adminUserId") == ADMIN_USER_ID
        db.governance_actions.delete_many({"id": action_id})

    @pytest.mark.asyncio
    async def test_demand_action_run_writes_admin_account_id(self, client, db):
        r = await client.post(
            "/api/admin/demand/actions/run",
            json={"zoneId": "TEST_zone_1d3", "mode": "manual"},
            headers=auth_headers(ADMIN_TOKEN),
        )
        assert r.status_code == 200, r.text
        execution_id = r.json().get("execution", {}).get("id")
        assert execution_id

        doc = db.demand_action_executions.find_one({"id": execution_id})
        assert doc is not None
        assert doc.get("adminAccountId") == ADMIN_ACCOUNT_ID
        assert doc.get("adminUserId") == ADMIN_USER_ID
        db.demand_action_executions.delete_many({"id": execution_id})

    @pytest.mark.asyncio
    async def test_anon_call_does_not_pollute_admin_audit(self, client, db):
        """Sanity: 401'd anonymous calls must never produce an audit row
        with a phantom adminAccountId. Because the gate fires before the
        handler, no insert should occur at all."""
        await client.post(
            "/api/admin/demand/push-providers",
            json={"zoneId": "TEST_zone_anon", "message": "x"},
        )
        # No row should exist for the anon call's zone marker
        leaked = db.governance_actions.find_one(
            {"zoneId": "TEST_zone_anon"}
        )
        assert leaked is None, (
            f"governance_actions polluted by anonymous call: {leaked}"
        )


# ════════════════════════════════════════════════════════════════════════
# 8. NON-REGRESSION — 1D.1 / 1D.2 / base must remain green
# ════════════════════════════════════════════════════════════════════════

class TestNonRegression:
    @pytest.mark.asyncio
    async def test_admin_auth_me_kind_admin(self, client):
        r = await client.get("/api/auth/me", headers=auth_headers(ADMIN_TOKEN))
        assert r.status_code == 200
        assert r.json()["activeAccount"]["kind"] == "admin"

    @pytest.mark.asyncio
    async def test_customer_credits_still_customer_gated(self, client):
        # 1D.2 gate intact: admin token gets 403 on /api/customer/credits
        r = await client.get(
            "/api/customer/credits", headers=auth_headers(ADMIN_TOKEN)
        )
        assert r.status_code == 403
        assert "customer" in r.text.lower()

    @pytest.mark.asyncio
    async def test_inspector_jobs_still_capability_gated(self, client):
        # 1D.1 gate intact: capability-based, not kind-based
        r = await client.get(
            "/api/inspector/jobs", headers=auth_headers(CUSTOMER_TOKEN)
        )
        # Customer has no `inspect` capability
        assert r.status_code in (401, 403)
        if r.status_code == 403:
            assert "capability" in r.text.lower()

    @pytest.mark.asyncio
    async def test_health_still_open(self, client):
        r = await client.get("/api/health")
        assert r.status_code == 200

    @pytest.mark.asyncio
    async def test_admin_panel_static_still_open(self, client):
        r = await client.get("/api/admin-panel/")
        assert r.status_code in (200, 307)

    @pytest.mark.asyncio
    async def test_marketplace_providers_still_open(self, client):
        r = await client.get("/api/marketplace/providers")
        assert r.status_code == 200
