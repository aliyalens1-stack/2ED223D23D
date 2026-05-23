"""Sprint 28 — Revenue Dashboard backend tests."""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")
ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASS = "Admin123!"
CUSTOMER_EMAIL = "customer@test.com"
CUSTOMER_PASS = "Customer123!"


def _login(email, pwd):
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"email": email, "password": pwd}, timeout=15)
    assert r.status_code == 200, f"login {email} -> {r.status_code} {r.text}"
    body = r.json()
    return body.get("accessToken") or body.get("access_token") or body["token"]


@pytest.fixture(scope="module")
def admin_token():
    return _login(ADMIN_EMAIL, ADMIN_PASS)


@pytest.fixture(scope="module")
def customer_token():
    try:
        return _login(CUSTOMER_EMAIL, CUSTOMER_PASS)
    except AssertionError:
        pytest.skip("customer creds missing")


# ── Auth guards ─────────────────────────────────────────────
def test_summary_no_auth_401():
    r = requests.get(f"{BASE_URL}/api/admin/revenue/summary", timeout=15)
    assert r.status_code == 401, r.text


def test_summary_customer_token_403_or_401(customer_token):
    r = requests.get(
        f"{BASE_URL}/api/admin/revenue/summary",
        headers={"Authorization": f"Bearer {customer_token}"}, timeout=15,
    )
    assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code}"


# ── Admin happy path ────────────────────────────────────────
def test_summary_admin_200_schema(admin_token):
    r = requests.get(
        f"{BASE_URL}/api/admin/revenue/summary",
        headers={"Authorization": f"Bearer {admin_token}"}, timeout=20,
    )
    assert r.status_code == 200, r.text
    d = r.json()
    expected = {"today", "yesterday", "week", "lastWeek", "month", "currency",
                "transactions", "paidTransactions", "failedTransactions",
                "boostRevenue", "avgOrderValue", "conversionRate",
                "growth", "revenueBreakdown", "alerts",
                "topProviders", "topZones", "recent"}
    missing = expected - set(d.keys())
    assert not missing, f"missing fields: {missing}"
    assert {"vsYesterday", "vsLastWeek"}.issubset(d["growth"].keys())
    assert {"boost", "subscription", "other"}.issubset(d["revenueBreakdown"].keys())
    assert isinstance(d["alerts"], list)
    assert isinstance(d["topProviders"], list)
    assert isinstance(d["topZones"], list)
    assert isinstance(d["recent"], list)
    assert d["currency"] == "UAH"


# ── Dev seed + DoD scenario ─────────────────────────────────
def test_dev_seed_and_breakdown(admin_token):
    headers = {"Authorization": f"Bearer {admin_token}"}

    # seed 5 fake payments
    r = requests.post(f"{BASE_URL}/api/admin/revenue/_dev_seed_fake?count=5",
                      headers=headers, timeout=20)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["ok"] is True
    assert body["count"] == 5
    types = [x["type"] for x in body["inserted"]]
    assert types.count("boost") == 3
    assert types.count("subscription") == 1
    assert types.count("payment") == 1

    # fetch summary
    r = requests.get(f"{BASE_URL}/api/admin/revenue/summary", headers=headers, timeout=20)
    assert r.status_code == 200
    d = r.json()

    # today should be > 0 (seed was inserted today)
    assert d["today"] > 0, f"today={d['today']}"
    # growth.vsYesterday should be > 0
    assert d["growth"]["vsYesterday"] > 0, f"growth={d['growth']}"

    bd = d["revenueBreakdown"]
    # boost = 699 + 299 + 1499 = 2497
    assert bd["boost"] >= 2497, f"boost={bd['boost']}"
    # subscription = 499
    assert bd["subscription"] >= 499, f"subscription={bd['subscription']}"
    # other (commission_order 200) — at least 200
    assert bd["other"] >= 200, f"other={bd['other']}"

    # recent contains seeded entries
    assert len(d["recent"]) > 0
    recent_providers = {r.get("providerId") for r in d["recent"]}
    assert "avtomaster-pro" in recent_providers or "mobile-service-24" in recent_providers

    # topProviders sorted desc by revenue, avtomaster-pro should be first
    tp = d["topProviders"]
    assert len(tp) >= 1
    revenues = [p["revenue"] for p in tp]
    assert revenues == sorted(revenues, reverse=True), "topProviders not sorted"
    assert tp[0]["providerId"] == "avtomaster-pro", f"top={tp[0]}"

    # concentration alert: avtomaster-pro should be >50%
    alerts_text = " | ".join(a.get("text", "") for a in d["alerts"])
    has_warning = any(a.get("type") == "warning" and "концентрация" in a.get("text", "").lower()
                      for a in d["alerts"])
    assert has_warning, f"no concentration warning. alerts={d['alerts']}, text='{alerts_text}'"
