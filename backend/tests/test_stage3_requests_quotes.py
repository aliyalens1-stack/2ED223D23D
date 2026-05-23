"""Stage 3 backend tests — Requests + Quotes + Booking flow.

Covers:
  - GET  /api/services (catalog)
  - POST /api/requests (create + 3 fake quotes)
  - GET  /api/requests/my (auth required)
  - GET  /api/requests/{id}/quotes (sorted asc)
  - POST /api/quotes/{id}/accept (booking + 409/400/404 edges)
  - GET  /api/marketplace/providers?q=... (Stage 2 search)
"""
from __future__ import annotations

import os

import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "http://localhost:8001").rstrip("/")

CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}
BERLIN = "berlin"  # Known seeded city with providers
MAPPED_KEYS = ["oil_change", "brakes", "engine", "battery", "tires", "towing", "pre_purchase", "diagnostics"]


@pytest.fixture(scope="module")
def api():
    s = requests.Session()
    s.headers.update({"Content-Type": "application/json"})
    return s


@pytest.fixture(scope="module")
def customer_token(api):
    r = api.post(f"{BASE_URL}/api/auth/login", json=CUSTOMER, timeout=20)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("token") or r.json().get("accessToken") or r.json().get("access_token")
    assert tok, f"no token in {r.json()}"
    return tok


# ── GET /api/services ──────────────────────────────────────────────────────
class TestServicesCatalog:
    def test_services_structure(self, api):
        r = api.get(f"{BASE_URL}/api/services", timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "clusters" in data
        clusters = data["clusters"]
        assert set(clusters.keys()) >= {"repair", "inspection"}
        # All 8 services present
        all_keys = [it["key"] for c in clusters.values() for it in c["items"]]
        for k in MAPPED_KEYS:
            assert k in all_keys, f"missing key {k}"
        # Multilingual + priceFrom
        sample = clusters["repair"]["items"][0]
        for f in ("key", "de", "en", "ru", "priceFrom"):
            assert f in sample, f"service missing {f}"
        assert isinstance(sample["priceFrom"], (int, float))


# ── POST /api/requests ─────────────────────────────────────────────────────
class TestCreateRequest:
    def test_create_request_generates_3_quotes(self, api):
        r = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "oil_change", "city": BERLIN, "description": "TEST_stage3 oil change"},
            timeout=20,
        )
        assert r.status_code == 200, r.text
        data = r.json()
        assert "requestId" in data
        assert data["status"] == "offers"
        quotes = data["quotes"]
        assert len(quotes) == 3, f"expected 3 quotes got {len(quotes)}"

        # Price normalized: [basePrice .. basePrice*2]; base for oil_change = 60
        for q in quotes:
            assert q["currency"] == "EUR"
            assert 60 <= q["priceFrom"] <= 120, f"price out of range {q['priceFrom']}"
            assert q["status"] == "pending"
            assert "expiresAt" in q and q["expiresAt"]
            assert q["responseTime"].endswith("min"), f"responseTime={q['responseTime']}"
            # Provider snapshot
            p = q["provider"]
            assert p["name"]
            assert "rating" in p and "reviews" in p
            assert "tuvVerified" in p
            assert "yearsExperience" in p
            assert isinstance(p["yearsExperience"], int)

    def test_create_request_invalid_service(self, api):
        r = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "bogus_xyz", "city": BERLIN},
            timeout=15,
        )
        assert r.status_code == 400

    def test_create_request_city_without_providers(self, api):
        r = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "oil_change", "city": "TEST_nowhere_zzz"},
            timeout=15,
        )
        assert r.status_code == 404


# ── GET /api/requests/my ───────────────────────────────────────────────────
class TestMyRequests:
    def test_my_requires_auth(self, api):
        r = api.get(f"{BASE_URL}/api/requests/my", timeout=15)
        assert r.status_code == 401

    def test_my_with_token_returns_list(self, api, customer_token):
        # Create a request as this user
        h = {"Authorization": f"Bearer {customer_token}"}
        c = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "brakes", "city": BERLIN, "description": "TEST_stage3 my"},
            headers=h,
            timeout=20,
        )
        assert c.status_code == 200
        req_id = c.json()["requestId"]

        r = api.get(f"{BASE_URL}/api/requests/my", headers=h, timeout=15)
        assert r.status_code == 200
        data = r.json()
        assert "requests" in data
        ids = [x["id"] for x in data["requests"]]
        assert req_id in ids


# ── GET /api/requests/{id}/quotes ──────────────────────────────────────────
class TestQuotesSorted:
    def test_quotes_sorted_asc(self, api):
        c = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "tires", "city": BERLIN},
            timeout=20,
        )
        assert c.status_code == 200
        req_id = c.json()["requestId"]

        r = api.get(f"{BASE_URL}/api/requests/{req_id}/quotes", timeout=15)
        assert r.status_code == 200
        quotes = r.json()["quotes"]
        assert len(quotes) >= 1
        prices = [q["priceFrom"] for q in quotes]
        assert prices == sorted(prices), f"not sorted asc: {prices}"

    def test_quotes_request_not_found(self, api):
        r = api.get(f"{BASE_URL}/api/requests/bogus_id_xyz/quotes", timeout=15)
        assert r.status_code == 404


# ── POST /api/quotes/{id}/accept ───────────────────────────────────────────
class TestAcceptQuote:
    def test_accept_flow_and_double_accept(self, api):
        c = api.post(
            f"{BASE_URL}/api/requests",
            json={"serviceKey": "diagnostics", "city": BERLIN},
            timeout=20,
        )
        assert c.status_code == 200
        payload = c.json()
        quotes = payload["quotes"]
        q_accept = quotes[0]
        q_other = quotes[1]
        req_id = payload["requestId"]

        # Accept first
        r = api.post(f"{BASE_URL}/api/quotes/{q_accept['id']}/accept", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert data["status"] == "confirmed"
        booking = data["booking"]
        assert booking["finalPrice"] == q_accept["priceFrom"]
        assert booking["currency"] == "EUR"

        # Verify persistence via GET quotes: accepted status + siblings rejected
        g = api.get(f"{BASE_URL}/api/requests/{req_id}/quotes", timeout=15)
        assert g.status_code == 200
        gdata = g.json()
        assert gdata["request"]["status"] == "booked"
        by_id = {q["id"]: q for q in gdata["quotes"]}
        assert by_id[q_accept["id"]]["status"] == "accepted"
        assert by_id[q_other["id"]]["status"] == "rejected"

        # Double-accept same quote → 409 'already accepted'
        r2 = api.post(f"{BASE_URL}/api/quotes/{q_accept['id']}/accept", timeout=15)
        assert r2.status_code == 409

        # Accept sibling (already rejected) → 409 'already rejected'
        r3 = api.post(f"{BASE_URL}/api/quotes/{q_other['id']}/accept", timeout=15)
        assert r3.status_code == 409

    def test_accept_unknown_quote(self, api):
        r = api.post(f"{BASE_URL}/api/quotes/bogus_nonexistent/accept", timeout=15)
        assert r.status_code == 404


# ── GET /api/marketplace/providers?q=... (Stage 2 tail) ────────────────────
class TestProvidersSearch:
    def test_providers_regex_search(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/providers?city={BERLIN}&limit=20", timeout=15)
        assert r.status_code == 200
        providers = r.json()["providers"]
        assert providers, "no providers in berlin seed"
        # Take a substring of first provider's name for a positive search
        name = providers[0]["name"]
        token = name.split()[0][:4].lower()
        rq = api.get(f"{BASE_URL}/api/marketplace/providers?city={BERLIN}&q={token}", timeout=15)
        assert rq.status_code == 200
        found = rq.json()["providers"]
        assert any(token.lower() in p["name"].lower() or token.lower() in (p.get("description") or "").lower() for p in found)

    def test_providers_search_no_match(self, api):
        r = api.get(f"{BASE_URL}/api/marketplace/providers?city={BERLIN}&q=zzz_no_match_xyz", timeout=15)
        assert r.status_code == 200
        # Empty or zero results acceptable
        assert isinstance(r.json()["providers"], list)
