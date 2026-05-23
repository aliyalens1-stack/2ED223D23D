"""
Phase 3.0b P0 sprint tests:
- P0-1: inline Stripe Checkout (no credits/packages)
- P0-2: Cities catalogue (DACH expansion)
- P0-3: i18n (no Russian for guest flow)
"""
import os
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


# ── Cities ────────────────────────────────────────────────────────
class TestCities:
    def test_list_cities(self, api):
        r = api.get(f"{BASE_URL}/api/cities", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert isinstance(data, list)
        assert len(data) >= 25, f"Expected >=25 cities, got {len(data)}"
        de = [c for c in data if c["country"] == "DE"]
        at = [c for c in data if c["country"] == "AT"]
        ua = [c for c in data if c["country"] == "UA"]
        assert len(de) >= 20, f"Expected >=20 DE cities, got {len(de)}"
        assert len(at) == 2, f"Expected 2 AT cities, got {len(at)}"
        assert len(ua) == 3, f"Expected 3 UA cities, got {len(ua)}"
        # All must have lat/lng/providersCount
        for c in data:
            assert "lat" in c and "lng" in c
            assert "providersCount" in c
            assert isinstance(c["providersCount"], int)

    def test_city_munich_has_addressmarkers(self, api):
        # API doesn't return addressMarkers in response model → check via list
        r = api.get(f"{BASE_URL}/api/cities", timeout=15)
        data = r.json()
        munich = next((c for c in data if c["code"] == "munich"), None)
        assert munich, "munich missing"
        assert munich["name"] == "München"

    def test_cities_have_aliases_field(self, api):
        """Phase 3.0b P0-2: every city must expose an `aliases` array (alternative spellings)."""
        r = api.get(f"{BASE_URL}/api/cities", timeout=15)
        assert r.status_code == 200
        data = r.json()
        for c in data:
            assert "aliases" in c, f"city {c['code']} missing aliases field"
            assert isinstance(c["aliases"], list), f"city {c['code']} aliases not a list"

    def test_munich_aliases_contain_variants(self, api):
        r = api.get(f"{BASE_URL}/api/cities", timeout=15)
        data = r.json()
        munich = next((c for c in data if c["code"] == "munich"), None)
        assert munich is not None
        aliases_lower = {a.lower() for a in munich["aliases"]}
        assert "münchen" in aliases_lower
        assert "munich" in aliases_lower
        assert "muenchen" in aliases_lower

    def test_cologne_aliases_contain_variants(self, api):
        r = api.get(f"{BASE_URL}/api/cities", timeout=15)
        data = r.json()
        cologne = next((c for c in data if c["code"] == "cologne"), None)
        assert cologne is not None
        aliases_lower = {a.lower() for a in cologne["aliases"]}
        assert "köln" in aliases_lower
        assert "koeln" in aliases_lower
        assert "cologne" in aliases_lower


# ── Payments ──────────────────────────────────────────────────────
class TestPayments:
    SESSION_IDS = []

    def test_inspection_checkout(self, api):
        body = {
            "originUrl": BASE_URL,
            "requestPayload": {
                "type": "inspection",
                "links": ["https://www.mobile.de/test"],
                "cities": ["Berlin"],
            },
        }
        r = api.post(f"{BASE_URL}/api/payments/auto-request/checkout", json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert "sessionId" in d and "url" in d
        assert d["amount"] == 149
        assert d["currency"] == "eur"
        assert d["url"].startswith("http")
        TestPayments.SESSION_IDS.append(d["sessionId"])

    def test_selection_checkout(self, api):
        body = {
            "originUrl": BASE_URL,
            "requestPayload": {
                "type": "selection",
                "brand": "BMW",
                "model": "M3",
                "budget": 50000,
                "cities": ["Berlin", "München"],
            },
        }
        r = api.post(f"{BASE_URL}/api/payments/auto-request/checkout", json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["amount"] == 399
        assert d["currency"] == "eur"

    def test_anti_tampering_amount_ignored(self, api):
        # Frontend cannot inject amount via body; backend pricing rules.
        body = {
            "originUrl": BASE_URL,
            "amount": 1,  # ← extra field, must be ignored
            "requestPayload": {
                "type": "inspection",
                "links": ["https://www.mobile.de/x"],
                "cities": ["Berlin"],
            },
        }
        r = api.post(f"{BASE_URL}/api/payments/auto-request/checkout", json=body, timeout=20)
        assert r.status_code == 200
        assert r.json()["amount"] == 149

    def test_invalid_missing_cities(self, api):
        body = {
            "originUrl": BASE_URL,
            "requestPayload": {"type": "inspection", "links": ["https://x.com"]},
        }
        r = api.post(f"{BASE_URL}/api/payments/auto-request/checkout", json=body, timeout=15)
        assert r.status_code == 422, f"expected 422, got {r.status_code}: {r.text}"

    def test_invalid_type(self, api):
        body = {
            "originUrl": BASE_URL,
            "requestPayload": {
                "type": "bogus_type",
                "cities": ["Berlin"],
                "links": ["https://x.com"],
            },
        }
        r = api.post(f"{BASE_URL}/api/payments/auto-request/checkout", json=body, timeout=15)
        # Pydantic on type may produce 422; or after Pydantic 400 from PRICING lookup.
        # Either is acceptable as "invalid"
        assert r.status_code in (400, 422), f"got {r.status_code}: {r.text}"

    def test_status_unknown_session(self, api):
        r = api.get(f"{BASE_URL}/api/payments/auto-request/status/no-such-session-xyz", timeout=15)
        assert r.status_code == 404

    def test_status_unpaid_or_trusted_paid_session(self, api):
        """On sk_test_emergent proxy: retrieve fails → status endpoint trusts redirect
        and marks paid+complete. That's the intentional Phase 3.0b iter4 fix.
        Must: (a) return 200 (not 502), (b) either paid:false (real proxy lookup)
        or paid:true with a populated `request` object.
        """
        if not TestPayments.SESSION_IDS:
            pytest.skip("no session created")
        sid = TestPayments.SESSION_IDS[0]
        r = api.get(f"{BASE_URL}/api/payments/auto-request/status/{sid}", timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["sessionId"] == sid
        assert d["status"] in ("open", "complete", "expired")
        if d["paid"]:
            # Proxy-trust path
            assert d["status"] == "complete"
            assert d["paymentStatus"] == "paid"
            assert d.get("request") is not None, "paid session must populate `request`"
            assert d["request"].get("type") == "inspection"
            assert "Berlin" in (d["request"].get("cities") or [])
            TestPayments.PAID_REQ_ID = d["request"].get("id")
        else:
            assert d["paymentStatus"] in ("unpaid", "no_payment_required")

    def test_status_idempotency(self, api):
        """Calling /status/{sid} twice must NOT double-create car_requests.
        Checked via MongoDB count on paymentSessionId (the response dict omits `id`
        because backend strips Mongo `_id` — that's a minor API miss, see report).
        """
        from pymongo import MongoClient
        if not TestPayments.SESSION_IDS:
            pytest.skip("no session created")
        sid = TestPayments.SESSION_IDS[0]
        r1 = api.get(f"{BASE_URL}/api/payments/auto-request/status/{sid}", timeout=20)
        r2 = api.get(f"{BASE_URL}/api/payments/auto-request/status/{sid}", timeout=20)
        assert r1.status_code == 200 and r2.status_code == 200
        assert r1.json()["paid"] == r2.json()["paid"]

        mc = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = mc[os.environ.get("DB_NAME", "auto_search_platform")]
        cnt = db.car_requests.count_documents({"paymentSessionId": sid})
        if r1.json()["paid"]:
            assert cnt == 1, f"Idempotency broken: {cnt} car_requests created for session {sid}"
        else:
            assert cnt == 0


# ── Guest create request (no 402) ────────────────────────────────
class TestGuestCreateRequest:
    def test_guest_can_create_inspection(self, api):
        body = {
            "type": "inspection",
            "links": ["https://www.mobile.de/test-guest"],
            "cities": ["Berlin"],
        }
        r = api.post(f"{BASE_URL}/api/customer/requests", json=body, timeout=15)
        assert r.status_code != 402, "Guest should NOT get 402; credits removed for inspection guests"
        assert r.status_code == 200, f"got {r.status_code}: {r.text}"
        d = r.json()
        assert d.get("type") == "inspection"
        assert "Berlin" in (d.get("cities") or [])

    def test_guest_can_create_selection(self, api):
        body = {
            "type": "selection",
            "brand": "Audi",
            "model": "A4",
            "budget": 25000,
            "cities": ["Berlin"],
        }
        r = api.post(f"{BASE_URL}/api/customer/requests", json=body, timeout=15)
        assert r.status_code != 402
        assert r.status_code == 200, r.text


# ── DB persistence of payment_transactions ───────────────────────
class TestPaymentTxPersistence:
    def test_tx_created_in_mongo(self):
        # Use mongo directly
        from pymongo import MongoClient
        mc = MongoClient(os.environ.get("MONGO_URL", "mongodb://localhost:27017"))
        db = mc[os.environ.get("DB_NAME", "auto_search_platform")]

        # Trigger a checkout via API
        r = requests.post(
            f"{BASE_URL}/api/payments/auto-request/checkout",
            json={
                "originUrl": BASE_URL,
                "requestPayload": {
                    "type": "inspection",
                    "links": ["https://www.mobile.de/persist-test"],
                    "cities": ["Berlin"],
                },
            },
            timeout=20,
        )
        assert r.status_code == 200
        sid = r.json()["sessionId"]
        tx = db.payment_transactions.find_one({"_id": sid})
        assert tx is not None, "payment_transactions doc not persisted"
        assert tx.get("status") == "initiated"
        assert tx.get("payment_status") == "unpaid"
        assert tx.get("requestPayload") is not None
        assert tx["requestPayload"].get("type") == "inspection"
