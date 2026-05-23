"""Sprint 22 — Stripe Payments integration tests.

Covers:
- /api/admin/billing/stripe-config  (GET/POST, admin-auth, masking, no-erase, validation)
- /api/billing/checkout             (schema, product lookup, price source, txn record)
- /api/billing/checkout/status/{id} (polling)
- /api/billing/webhook              (signature gating)
- Idempotency / disabled-state behavior

Uses EXTERNAL public URL (EXPO_PUBLIC_BACKEND_URL) so we exercise the same
ingress that real Stripe will hit, AND a direct Mongo client for assertions
on payment_transactions / platform_settings.
"""
from __future__ import annotations

import os
import time
import uuid
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

# ── Config ──────────────────────────────────────────────────────────────
# Frontend .env uses EXPO_PUBLIC_BACKEND_URL; system prompt references EXPO_BACKEND_URL.
# Support both, no hardcoded default URLs.
BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "http://localhost:8001"
).rstrip("/")

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"

# Load values from /app/backend/.env so tests use the same Mongo/DB as the API
def _load_backend_env():
    env_path = "/app/backend/.env"
    if not os.path.exists(env_path):
        return {}
    out = {}
    with open(env_path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


_BENV = _load_backend_env()
MONGO_URL = os.environ.get("MONGO_URL") or _BENV.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME") or _BENV.get("DB_NAME", "auto_platform")

STRIPE_SECRET = "sk_test_emergent"
STRIPE_WEBHOOK_SECRET = "whsec_test123"


# ── Fixtures ────────────────────────────────────────────────────────────


@pytest.fixture(scope="session")
def admin_token():
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD},
        timeout=15,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    return r.json()["accessToken"]


@pytest.fixture(scope="session")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="session")
def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    return client[DB_NAME]


def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)


@pytest.fixture(scope="session", autouse=True)
def ensure_stripe_configured(auth_headers):
    """Ensure Stripe is enabled with the test key before running tests."""
    r = requests.post(
        f"{BASE_URL}/api/admin/billing/stripe-config",
        json={
            "secret_key": STRIPE_SECRET,
            "webhook_secret": STRIPE_WEBHOOK_SECRET,
            "enabled": True,
        },
        headers=auth_headers,
        timeout=15,
    )
    assert r.status_code == 200, f"bootstrap config failed: {r.status_code} {r.text}"
    yield


# ── Admin: stripe-config ────────────────────────────────────────────────


class TestStripeAdminConfig:
    def test_get_without_token_unauthorized(self):
        r = requests.get(f"{BASE_URL}/api/admin/billing/stripe-config", timeout=10)
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"

    def test_get_with_admin_token_returns_masked(self, auth_headers):
        r = requests.get(
            f"{BASE_URL}/api/admin/billing/stripe-config",
            headers=auth_headers,
            timeout=10,
        )
        assert r.status_code == 200
        d = r.json()
        assert d.get("configured") is True
        assert d.get("enabled") is True
        # mask format: first7 + ... + last4 → sk_test...gent
        assert d.get("secret_key_masked", "").startswith("sk_test")
        assert d.get("secret_key_masked", "").endswith("gent")
        assert "..." in d.get("secret_key_masked", "")
        assert d.get("webhook_url_hint") == "/api/billing/webhook"

    def test_post_set_full_config(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/admin/billing/stripe-config",
            json={
                "secret_key": STRIPE_SECRET,
                "webhook_secret": STRIPE_WEBHOOK_SECRET,
                "enabled": True,
            },
            headers=auth_headers,
            timeout=10,
        )
        assert r.status_code == 200
        assert r.json().get("status") == "ok"

    def test_post_partial_does_not_erase_secret(self, auth_headers):
        # Send only enabled flag — secret must remain intact.
        r = requests.post(
            f"{BASE_URL}/api/admin/billing/stripe-config",
            json={"enabled": True},
            headers=auth_headers,
            timeout=10,
        )
        assert r.status_code == 200
        # Verify secret still present via GET
        g = requests.get(
            f"{BASE_URL}/api/admin/billing/stripe-config",
            headers=auth_headers,
            timeout=10,
        ).json()
        assert g.get("secret_key_masked", "").startswith("sk_test")
        assert g.get("secret_key_masked", "").endswith("gent")

    def test_enable_without_secret_rejected(self, auth_headers, mongo):
        # Backup current doc, delete it, try to enable → expect 400, then restore.
        existing = _run(mongo.platform_settings.find_one({"type": "stripe"}, {"_id": 0}))
        try:
            _run(mongo.platform_settings.delete_one({"type": "stripe"}))
            r = requests.post(
                f"{BASE_URL}/api/admin/billing/stripe-config",
                json={"enabled": True},
                headers=auth_headers,
                timeout=10,
            )
            assert r.status_code == 400, f"expected 400 got {r.status_code}: {r.text}"
            assert "secret_key" in r.text.lower()
        finally:
            # Restore via API
            requests.post(
                f"{BASE_URL}/api/admin/billing/stripe-config",
                json={
                    "secret_key": STRIPE_SECRET,
                    "webhook_secret": STRIPE_WEBHOOK_SECRET,
                    "enabled": True,
                },
                headers=auth_headers,
                timeout=10,
            )


# ── Provider: checkout ──────────────────────────────────────────────────


class TestBillingCheckout:
    def test_missing_fields_returns_422(self):
        r = requests.post(
            f"{BASE_URL}/api/billing/checkout", json={}, timeout=10,
        )
        assert r.status_code == 422

    def test_bad_product_code_400(self):
        r = requests.post(
            f"{BASE_URL}/api/billing/checkout",
            json={
                "productCode": "nonexistent_code",
                "providerSlug": "avtomaster-pro",
                "originUrl": BASE_URL,
            },
            timeout=15,
        )
        assert r.status_code == 400
        assert "product not found" in r.text.lower()

    def test_create_checkout_returns_stripe_url_and_amount(self, mongo):
        r = requests.post(
            f"{BASE_URL}/api/billing/checkout",
            json={
                "productCode": "promoted_7d",
                "providerSlug": "avtomaster-pro",
                "originUrl": BASE_URL,
            },
            timeout=30,
        )
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        d = r.json()
        assert d["checkoutUrl"].startswith("https://checkout.stripe.com")
        assert d["sessionId"].startswith("cs_test_")
        assert d["amount"] == 499.0
        assert d["currency"] == "UAH"

        # Verify payment_transactions record persisted
        time.sleep(0.5)
        txn = _run(
            mongo.payment_transactions.find_one(
                {"session_id": d["sessionId"]}, {"_id": 0}
            )
        )
        assert txn is not None, "payment_transactions row not created"
        assert txn["status"] == "initiated"
        assert txn["payment_status"] == "unpaid"
        assert txn["providerSlug"] == "avtomaster-pro"
        assert txn["productCode"] == "promoted_7d"
        assert txn["amount"] == 499.0
        assert txn["currency"] == "UAH"
        # stash for status test
        pytest._sprint22_session_id = d["sessionId"]

    def test_amount_is_server_side_only(self):
        """Even if client sends amount=1, server must use BILLING_PRODUCTS price (499)."""
        r = requests.post(
            f"{BASE_URL}/api/billing/checkout",
            json={
                "productCode": "promoted_7d",
                "providerSlug": "avtomaster-pro",
                "originUrl": BASE_URL,
                "amount": 1,  # ignored by server (no such field in schema)
                "price": 1,
                "currency": "USD",
            },
            timeout=30,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["amount"] == 499.0
        assert d["currency"] == "UAH"

    def test_status_endpoint_for_open_session(self):
        sid = getattr(pytest, "_sprint22_session_id", None)
        if not sid:
            pytest.skip("no session_id from previous test")
        r = requests.get(
            f"{BASE_URL}/api/billing/checkout/status/{sid}", timeout=30,
        )
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["session_id"] == sid
        assert "status" in d and "payment_status" in d
        # Brand new test session is unpaid/open
        assert d["payment_status"] in ("unpaid", "no_payment_required", "paid")
        assert d["status"] in ("initiated", "completed", "expired", "paid")


# ── Webhook ─────────────────────────────────────────────────────────────


class TestWebhook:
    def test_missing_signature_400(self):
        r = requests.post(
            f"{BASE_URL}/api/billing/webhook",
            data=b'{"type":"checkout.session.completed"}',
            headers={"Content-Type": "application/json"},
            timeout=10,
        )
        assert r.status_code == 400
        assert "stripe-signature" in r.text.lower()

    def test_invalid_signature_400(self):
        r = requests.post(
            f"{BASE_URL}/api/billing/webhook",
            data=b'{"type":"checkout.session.completed","data":{}}',
            headers={
                "Content-Type": "application/json",
                "Stripe-Signature": "t=1,v1=invalid_sig_xyz",
            },
            timeout=10,
        )
        assert r.status_code == 400
        assert "verif" in r.text.lower() or "signature" in r.text.lower()


# ── Disabled state / idempotency ────────────────────────────────────────


class TestStripeDisabledState:
    def test_disabled_then_reenabled(self, auth_headers, mongo):
        # Disable
        r = requests.post(
            f"{BASE_URL}/api/admin/billing/stripe-config",
            json={"enabled": False},
            headers=auth_headers,
            timeout=10,
        )
        assert r.status_code == 200

        try:
            r2 = requests.post(
                f"{BASE_URL}/api/billing/checkout",
                json={
                    "productCode": "promoted_7d",
                    "providerSlug": "avtomaster-pro",
                    "originUrl": BASE_URL,
                },
                timeout=15,
            )
            assert r2.status_code == 400
            assert "stripe not configured" in r2.text.lower()
        finally:
            # Re-enable
            r3 = requests.post(
                f"{BASE_URL}/api/admin/billing/stripe-config",
                json={"enabled": True},
                headers=auth_headers,
                timeout=10,
            )
            assert r3.status_code == 200

        # Should work again
        r4 = requests.post(
            f"{BASE_URL}/api/billing/checkout",
            json={
                "productCode": "promoted_7d",
                "providerSlug": "avtomaster-pro",
                "originUrl": BASE_URL,
            },
            timeout=30,
        )
        assert r4.status_code == 200
        assert r4.json()["amount"] == 499.0
