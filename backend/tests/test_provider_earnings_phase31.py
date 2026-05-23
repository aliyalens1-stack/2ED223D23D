"""Provider Earnings Phase 3.1 — backend tests.

Doctrine: read-only projection. lead_fee→deducted (never paid_out).
Currencies never sum. Phase 3.1 emits only: pending, payable, disputed_hold, deducted.
"""
import os
from datetime import datetime, timezone, timedelta
import pytest
import httpx
from pymongo import MongoClient

BACKEND_URL = os.environ.get("BACKEND_URL", "http://localhost:8001")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

PROVIDER_EMAIL = "provider@test.com"
PROVIDER_PASSWORD = "Provider123!"
SLUG = "avtomaster-pro"

FORBIDDEN = ("paymentStatus", "paymentIntentId", "stripeChargeId",
             "auctionChargeId", "charge", "intent", "settlementType")


@pytest.fixture(scope="module")
def db():
    c = MongoClient(MONGO_URL)
    return c[DB_NAME]


@pytest.fixture(scope="module")
def provider_token():
    with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
        r = c.post("/api/auth/login",
                   json={"email": PROVIDER_EMAIL, "password": PROVIDER_PASSWORD})
    assert r.status_code == 200, r.text
    return r.json()["accessToken"]


@pytest.fixture(scope="module", autouse=True)
def seed(db):
    """Seed deterministic Phase 3.1 fixtures + cleanup."""
    now = datetime.now(timezone.utc).isoformat()
    # Clean prior
    db.bookings.delete_many({"id": {"$in": ["er-test-paid", "er-test-unpaid", "er-test-disputed"]}})
    db.payments.delete_many({"bookingId": {"$in": ["er-test-paid", "er-test-disputed"]}})
    db.auction_charges.delete_many({"id": "er-charge-1"})

    db.bookings.insert_many([
        {"id": "er-test-paid", "providerSlug": SLUG, "status": "completed",
         "finalPrice": 2500, "currency": "EUR", "completedAt": now,
         "serviceName": "TEST_PaidService", "customerName": "Alice"},
        {"id": "er-test-unpaid", "providerSlug": SLUG, "status": "completed",
         "finalPrice": 4200, "currency": "EUR", "completedAt": now,
         "serviceName": "TEST_UnpaidService", "customerName": "Bob"},
        {"id": "er-test-disputed", "providerSlug": SLUG, "status": "completed",
         "finalPrice": 3800, "currency": "UAH", "completedAt": now,
         "serviceName": "TEST_DisputedService", "customerName": "Carol"},
    ])
    db.payments.insert_many([
        {"bookingId": "er-test-paid", "status": "paid", "currency": "EUR", "createdAt": now},
        {"bookingId": "er-test-disputed", "status": "disputed", "currency": "UAH", "createdAt": now},
    ])
    db.auction_charges.insert_one(
        {"id": "er-charge-1", "providerSlug": SLUG, "amountCharged": 45,
         "currency": "EUR", "bookingId": "er-test-paid", "createdAt": now,
         "zone": "kyiv-center"}
    )
    yield
    db.bookings.delete_many({"id": {"$in": ["er-test-paid", "er-test-unpaid", "er-test-disputed"]}})
    db.payments.delete_many({"bookingId": {"$in": ["er-test-paid", "er-test-disputed"]}})
    db.auction_charges.delete_many({"id": "er-charge-1"})


# ── Auth ──
class TestAuth:
    def test_items_no_token_401(self):
        with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
            r = c.get("/api/provider/earnings/items")
        assert r.status_code == 401

    def test_items_bad_token_401(self):
        with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
            r = c.get("/api/provider/earnings/items",
                      headers={"Authorization": "Bearer junk.token.here"})
        assert r.status_code == 401


# ── Shape & Doctrine ──
class TestEarningsItems:
    def _get(self, token, params=None):
        with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
            return c.get("/api/provider/earnings/items",
                         params=params or {},
                         headers={"Authorization": f"Bearer {token}"})

    def test_items_200_shape(self, provider_token):
        r = self._get(provider_token)
        assert r.status_code == 200
        data = r.json()
        assert "items" in data and "summary" in data
        assert "byCurrency" in data["summary"]
        assert isinstance(data["summary"]["byCurrency"], list)

    def test_items_doctrine_no_raw_fields(self, provider_token):
        r = self._get(provider_token)
        for it in r.json()["items"]:
            for f in FORBIDDEN:
                assert f not in it, f"raw field '{f}' leaked in item {it.get('id')}"

    def test_items_no_processing_or_paidout(self, provider_token):
        r = self._get(provider_token)
        states = {it["state"] for it in r.json()["items"]}
        assert "processing" not in states
        assert "paid_out" not in states

    def test_paid_booking_payable(self, provider_token):
        r = self._get(provider_token)
        item = next((it for it in r.json()["items"] if it["id"] == "er_er-test-paid"), None)
        assert item is not None
        assert item["state"] == "payable"
        assert item["kind"] == "job"
        assert item["amount"]["currency"] == "EUR"
        assert item["amount"]["gross"] == 2500
        assert item["workItemId"] == "bk_er-test-paid"

    def test_unpaid_booking_pending(self, provider_token):
        r = self._get(provider_token)
        item = next((it for it in r.json()["items"] if it["id"] == "er_er-test-unpaid"), None)
        assert item is not None
        assert item["state"] == "pending"

    def test_disputed_booking_disputed_hold(self, provider_token):
        r = self._get(provider_token)
        item = next((it for it in r.json()["items"] if it["id"] == "er_er-test-disputed"), None)
        assert item is not None
        assert item["state"] == "disputed_hold"
        assert item.get("blockedReason", {}).get("code") == "payment_disputed"
        assert item["amount"]["currency"] == "UAH"

    def test_lead_fee_doctrine(self, provider_token):
        r = self._get(provider_token)
        item = next((it for it in r.json()["items"] if it["id"] == "lf_er-charge-1"), None)
        assert item is not None
        assert item["kind"] == "lead_fee"
        assert item["state"] == "deducted"
        assert item["amount"]["net"] == -45
        assert item["amount"]["gross"] == 0

    def test_id_prefixes(self, provider_token):
        r = self._get(provider_token)
        for it in r.json()["items"]:
            assert it["id"].startswith(("er_", "lf_"))

    def test_summary_currency_segregation(self, provider_token):
        r = self._get(provider_token)
        currencies = {b["currency"] for b in r.json()["summary"]["byCurrency"]}
        assert "EUR" in currencies and "UAH" in currencies
        # No cross-currency total
        assert "total" not in r.json()["summary"]
        assert "grandTotal" not in r.json()["summary"]

    def test_summary_buckets_have_processing_paidout_zero(self, provider_token):
        r = self._get(provider_token)
        for bucket in r.json()["summary"]["byCurrency"]:
            assert "processing" in bucket
            assert "paid_out" in bucket
            # MAY appear with count=0 (reserved buckets)

    def test_filter_state_payable(self, provider_token):
        r = self._get(provider_token, {"state": "payable"})
        data = r.json()
        for it in data["items"]:
            assert it["state"] == "payable"
        # Summary still global — must include both currencies
        assert len(data["summary"]["byCurrency"]) >= 2

    def test_filter_invalid_state_ignored(self, provider_token):
        r = self._get(provider_token, {"state": "invalid_state"})
        assert r.status_code == 200
        # Returns all items (filter silently ignored)
        assert len(r.json()["items"]) >= 4

    def test_date_window_clip(self, provider_token):
        # Window in the far past — should clip everything out
        old = (datetime.now(timezone.utc) - timedelta(days=900)).isoformat()
        older = (datetime.now(timezone.utc) - timedelta(days=1000)).isoformat()
        r = self._get(provider_token, {"from": older, "to": old})
        assert r.status_code == 200
        # No seeded items should match
        ids = {it["id"] for it in r.json()["items"]}
        assert "er_er-test-paid" not in ids
        assert "lf_er-charge-1" not in ids


class TestSummary:
    def test_summary_endpoint(self, provider_token):
        with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
            r = c.get("/api/provider/earnings/summary",
                      headers={"Authorization": f"Bearer {provider_token}"})
        assert r.status_code == 200
        data = r.json()
        assert "summary" in data and "lastRefreshedAt" in data
        # Validate ISO format
        datetime.fromisoformat(data["lastRefreshedAt"].replace("Z", "+00:00"))


class TestLegacy:
    def test_legacy_earnings_still_200(self):
        # No auth required (legacy NestJS-fallback path)
        with httpx.Client(base_url=BACKEND_URL, timeout=15) as c:
            r = c.get("/api/provider/earnings")
        assert r.status_code == 200
        body = r.json()
        # Legacy random.randint shape (not the new clarity shape)
        assert "today" in body or "items" not in body
