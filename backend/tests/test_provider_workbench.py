"""Provider Workbench v1 — backend E2E tests.

Covers:
  - auth: 401 on no/bad token; 200 with provider token.
  - GET /api/provider/work-items shape & taxonomy hygiene.
  - POST /api/provider/work-items/{id}/action verb transitions.
  - submit_report → 400 (UI navigates).
  - inspection complete → 409 (legacy report path).
  - mismatched verb on item kind → 409.
"""
import os
import re
import asyncio
import pytest
import requests
from motor.motor_asyncio import AsyncIOMotorClient

BASE = os.environ.get("EXPO_BACKEND_URL", "http://localhost:8001").rstrip("/")
MONGO = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

PROVIDER_EMAIL = "provider@test.com"
PROVIDER_PASSWORD = "Provider123!"
PROVIDER_SLUG = "avtomaster-pro"


@pytest.fixture(scope="module")
def provider_token():
    r = requests.post(f"{BASE}/api/auth/login",
                      json={"email": PROVIDER_EMAIL, "password": PROVIDER_PASSWORD},
                      timeout=10)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    data = r.json()
    tok = data.get("accessToken")
    assert tok, f"accessToken missing in login response: {data}"
    return tok


@pytest.fixture(scope="module")
def auth_headers(provider_token):
    return {"Authorization": f"Bearer {provider_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def db():
    client = AsyncIOMotorClient(MONGO)
    return client[DB_NAME]


def _run(coro):
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


@pytest.fixture(scope="module")
def seeded_booking(db):
    """Seed a 'confirmed' booking owned by avtomaster-pro for E2E action transitions."""
    booking_id = "TEST_wb_bk_001"

    async def setup():
        await db.bookings.update_one(
            {"id": booking_id},
            {"$set": {
                "id": booking_id,
                "providerSlug": PROVIDER_SLUG,
                "status": "confirmed",
                "serviceName": "TEST Workbench Service",
                "customerName": "TEST Customer",
                "address": "TEST Strasse 1, Berlin",
                "finalPrice": 500,
                "currency": "EUR",
                "acceptedAt": "2026-01-01T00:00:00+00:00",
                "createdAt": "2026-01-01T00:00:00+00:00",
                "statusHistory": [],
            }},
            upsert=True,
        )

    async def teardown():
        await db.bookings.delete_one({"id": booking_id})

    _run(setup())
    yield booking_id
    _run(teardown())


# ── 1. Auth ──
class TestAuth:
    def test_login_returns_accessToken(self, provider_token):
        assert isinstance(provider_token, str) and len(provider_token) > 20

    def test_no_token_401(self):
        r = requests.get(f"{BASE}/api/provider/work-items", timeout=10)
        assert r.status_code == 401, f"expected 401 got {r.status_code}"

    def test_bad_token_401(self):
        r = requests.get(f"{BASE}/api/provider/work-items",
                         headers={"Authorization": "Bearer not-a-real-token"}, timeout=10)
        assert r.status_code == 401, f"expected 401 got {r.status_code}"


# ── 2. Work-items shape ──
class TestWorkItemsShape:
    def test_get_returns_items_array(self, auth_headers):
        r = requests.get(f"{BASE}/api/provider/work-items", headers=auth_headers, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "items" in data and isinstance(data["items"], list)

    def test_item_required_fields_and_no_raw_taxonomy(self, auth_headers, seeded_booking):
        r = requests.get(f"{BASE}/api/provider/work-items", headers=auth_headers, timeout=10)
        items = r.json().get("items", [])
        # Find our seeded item
        target = next((it for it in items if it.get("id") == f"bk_{seeded_booking}"), None)
        assert target, f"seeded booking not in projection: {[i.get('id') for i in items]}"
        # Required fields
        for key in ("id", "kind", "state", "priceShown", "customer", "serviceLabel", "enteredCurrentStateAt"):
            assert key in target, f"missing {key}"
        assert target["kind"] in ("booking", "inspection")
        valid_states = {"needs_response","scheduled","en_route","on_site","in_progress",
                        "report_required","awaiting_customer","awaiting_review",
                        "awaiting_payout","completed","blocked"}
        assert target["state"] in valid_states
        assert "amount" in target["priceShown"] and "currency" in target["priceShown"]
        assert "name" in target["customer"]
        # Forbidden raw fields
        for forbidden in ("bookingStatus","jobStatus","reportStatus","inspectorStatus","status"):
            assert forbidden not in target, f"raw taxonomy field leaked: {forbidden}"

    def test_id_prefixes(self, auth_headers):
        r = requests.get(f"{BASE}/api/provider/work-items", headers=auth_headers, timeout=10)
        for it in r.json().get("items", []):
            assert re.match(r"^(bk_|ij_|qr_)", it["id"]), f"bad id: {it['id']}"


# ── 3. Action verb dispatch (booking state machine via projector) ──
class TestActionDispatch:
    def test_depart_scheduled_to_en_route(self, auth_headers, seeded_booking):
        item_id = f"bk_{seeded_booking}"
        r = requests.post(f"{BASE}/api/provider/work-items/{item_id}/action",
                          headers=auth_headers, json={"verb": "depart"}, timeout=10)
        assert r.status_code == 200, r.text
        data = r.json()
        item = data.get("item")
        assert item, data
        assert item["state"] == "en_route"
        assert item.get("primaryAction", {}).get("verb") == "arrive"

    def test_arrive_to_on_site(self, auth_headers, seeded_booking):
        item_id = f"bk_{seeded_booking}"
        r = requests.post(f"{BASE}/api/provider/work-items/{item_id}/action",
                          headers=auth_headers, json={"verb": "arrive"}, timeout=10)
        assert r.status_code == 200, r.text
        item = r.json()["item"]
        assert item["state"] == "on_site"
        assert item["primaryAction"]["verb"] == "start"

    def test_start_to_in_progress(self, auth_headers, seeded_booking):
        item_id = f"bk_{seeded_booking}"
        r = requests.post(f"{BASE}/api/provider/work-items/{item_id}/action",
                          headers=auth_headers, json={"verb": "start"}, timeout=10)
        assert r.status_code == 200, r.text
        item = r.json()["item"]
        assert item["state"] == "in_progress"
        assert item["primaryAction"]["verb"] == "complete"
        assert item["primaryAction"]["confirmationRequired"] is True


# ── 4. Negative paths ──
class TestNegative:
    def test_submit_report_400(self, auth_headers):
        r = requests.post(f"{BASE}/api/provider/work-items/ij_fake/action",
                          headers=auth_headers, json={"verb": "submit_report"}, timeout=10)
        assert r.status_code == 400, r.text
        # Body should hint at /api/inspector/jobs/{id}/report
        body = r.text.lower()
        assert "/api/inspector/jobs" in body or "inspector/jobs" in body

    def test_complete_on_inspection_409(self, auth_headers):
        r = requests.post(f"{BASE}/api/provider/work-items/ij_fake/action",
                          headers=auth_headers, json={"verb": "complete"}, timeout=10)
        assert r.status_code == 409, r.text

    def test_mismatched_verb_on_qr_409(self, auth_headers):
        r = requests.post(f"{BASE}/api/provider/work-items/qr_fake/action",
                          headers=auth_headers, json={"verb": "depart"}, timeout=10)
        assert r.status_code == 409, r.text

    def test_unknown_prefix_400(self, auth_headers):
        r = requests.post(f"{BASE}/api/provider/work-items/zz_xx/action",
                          headers=auth_headers, json={"verb": "depart"}, timeout=10)
        assert r.status_code == 400, r.text


# ── 5. Legacy endpoints still work ──
class TestLegacyIntact:
    def test_inbox_loads(self, auth_headers):
        r = requests.get(f"{BASE}/api/provider/inbox?providerSlug={PROVIDER_SLUG}",
                         headers=auth_headers, timeout=10)
        assert r.status_code == 200, r.text
        assert "counts" in r.json()
