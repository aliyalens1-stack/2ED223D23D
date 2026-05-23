"""Phase C.1 + C.3 — Link Intelligence Core + Provider Workspace candidates.

Covers:
- GET  /api/parse/supported-sources                       (12 sources, new EU mkts)
- POST /api/parse/car-link                                (unified shape, soft/hard fail)
- POST /api/customer/requests        (type=selection)     creates request
- POST /api/provider/requests/{id}/candidates             attach candidate
- GET  /api/provider/requests/{id}/candidates             list
- PATCH /api/provider/candidates/{id}                     update
- DELETE /api/provider/candidates/{id}                    soft archive
- GET  /api/customer/requests/{id}/candidates             customer comparison
- 400 when type != selection
- No _id leak in JSON
"""
import os
import json
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/") or \
           os.environ.get("EXPO_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL or EXPO_BACKEND_URL must be set"

ADMIN_EMAIL = "admin@autoservice.com"
ADMIN_PASSWORD = "Admin123!"


@pytest.fixture(scope="module")
def s():
    return requests.Session()


@pytest.fixture(scope="module")
def admin_token(s):
    r = s.post(f"{BASE_URL}/api/auth/login",
               json={"email": ADMIN_EMAIL, "password": ADMIN_PASSWORD}, timeout=20)
    if r.status_code != 200:
        pytest.skip(f"Admin login failed: {r.status_code} {r.text[:200]}")
    j = r.json()
    return j.get("accessToken") or j.get("token") or j.get("access_token")


@pytest.fixture(scope="module")
def auth_headers(admin_token):
    return {"Authorization": f"Bearer {admin_token}"}


# ── parsers ──────────────────────────────────────────────────────────
class TestParsers:
    def test_supported_sources_count_and_new_ones(self, s):
        r = s.get(f"{BASE_URL}/api/parse/supported-sources", timeout=15)
        assert r.status_code == 200, r.text
        data = r.json()
        assert "sources" in data
        ids = {it["id"] for it in data["sources"]}
        assert len(data["sources"]) == 12, f"expected 12, got {len(data['sources'])}: {ids}"
        for must in ["mobile.de", "autoscout24", "kleinanzeigen.de", "otomoto.pl",
                     "leboncoin.fr", "willhaben.at", "marktplaats.nl",
                     "lacentrale.fr", "subito.it", "generic"]:
            assert must in ids, f"missing source {must}"

    def test_car_link_unified_shape_keys(self, s):
        r = s.post(f"{BASE_URL}/api/parse/car-link",
                   json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=12345"},
                   timeout=30)
        assert r.status_code == 200, r.text
        d = r.json()
        for k in ["recognized", "softFail", "hardFail", "source", "title", "image",
                  "price", "year", "mileage", "fuel", "parsed", "error"]:
            assert k in d, f"unified-shape missing key: {k}"

    def test_car_link_mobilede_soft_fail(self, s):
        r = s.post(f"{BASE_URL}/api/parse/car-link",
                   json={"url": "https://www.mobile.de/fahrzeuge/details.html?id=12345"},
                   timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["source"] == "mobile.de"
        assert d["recognized"] is False
        assert d["softFail"] is True
        assert d["hardFail"] is False
        # error code should be http_403 / http_4xx / fetch_failed family
        assert isinstance(d.get("error"), str) and d["error"], d

    def test_car_link_otomoto_source(self, s):
        r = s.post(f"{BASE_URL}/api/parse/car-link",
                   json={"url": "https://www.otomoto.pl/osobowe/oferta/bmw-x5-test-id12345.html"},
                   timeout=30)
        assert r.status_code == 200
        d = r.json()
        assert d["source"] == "otomoto.pl"
        # likely soft-fail (anti-bot or no parser implementation)
        assert d["softFail"] is True or d["recognized"] is True

    def test_car_link_bad_url_hard_fail(self, s):
        r = s.post(f"{BASE_URL}/api/parse/car-link",
                   json={"url": "not-a-url"}, timeout=15)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["hardFail"] is True
        assert d["error"] == "bad_url"
        assert d["recognized"] is False


# ── candidates lifecycle ─────────────────────────────────────────────
class TestCandidates:
    @pytest.fixture(scope="class")
    def selection_request(self, s, auth_headers):
        payload = {
            "type": "selection",
            "brand": "BMW",
            "model": "X5",
            "budget": 35000,
            "cities": ["Berlin"],
            "country": "DE",
            "comment": "TEST_phase_c selection",
        }
        r = s.post(f"{BASE_URL}/api/customer/requests",
                   headers=auth_headers, json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        body = r.json()
        assert "id" in body and body["type"] == "selection"
        return body

    @pytest.fixture(scope="class")
    def inspection_request(self, s, auth_headers):
        payload = {
            "type": "inspection",
            "links": ["https://www.mobile.de/fahrzeuge/details.html?id=987"],
            "cities": ["Berlin"],
            "country": "DE",
        }
        r = s.post(f"{BASE_URL}/api/customer/requests",
                   headers=auth_headers, json=payload, timeout=20)
        assert r.status_code in (200, 201), r.text
        return r.json()

    def test_create_request(self, selection_request):
        assert selection_request["id"]

    def test_attach_candidate(self, s, auth_headers, selection_request):
        rid = selection_request["id"]
        body = {
            "listingUrl": "https://www.mobile.de/fahrzeuge/details.html?id=A1",
            "source": "mobile.de",
            "preview": {"title": "TEST_BMW X5 xDrive30d", "image": "https://x/y.jpg",
                        "price": 28900, "year": 2019, "mileage": 120000,
                        "fuel": "diesel", "make": "BMW", "model": "X5"},
            "providerComment": "Solid spec, watch service history",
            "score": 7.5, "risk": "low", "recommended": True,
        }
        r = s.post(f"{BASE_URL}/api/provider/requests/{rid}/candidates",
                   headers=auth_headers, json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["id"]
        assert d["requestId"] == rid
        assert d["score"] == 7.5
        assert d["risk"] == "low"
        assert d["recommended"] is True
        assert d["preview"]["make"] == "BMW"
        assert "_id" not in d, "MongoDB _id should not leak"
        pytest.candidate_id = d["id"]

    def test_attach_candidate_rejects_inspection(self, s, auth_headers, inspection_request):
        rid = inspection_request["id"]
        body = {
            "listingUrl": "https://www.mobile.de/fahrzeuge/details.html?id=B1",
            "preview": {}, "score": 5,
        }
        r = s.post(f"{BASE_URL}/api/provider/requests/{rid}/candidates",
                   headers=auth_headers, json=body, timeout=20)
        assert r.status_code == 400, r.text

    def test_provider_list_candidates(self, s, auth_headers, selection_request):
        rid = selection_request["id"]
        r = s.get(f"{BASE_URL}/api/provider/requests/{rid}/candidates",
                  headers=auth_headers, timeout=20)
        assert r.status_code == 200, r.text
        items = r.json()
        assert isinstance(items, list) and len(items) >= 1
        assert all("_id" not in c for c in items)
        assert any(c["id"] == pytest.candidate_id for c in items)

    def test_attach_second_lower_score(self, s, auth_headers, selection_request):
        rid = selection_request["id"]
        body = {
            "listingUrl": "https://www.mobile.de/fahrzeuge/details.html?id=A2",
            "source": "mobile.de",
            "preview": {"title": "TEST_BMW X5 3.0d", "price": 24900,
                        "year": 2017, "mileage": 180000, "fuel": "diesel",
                        "make": "BMW", "model": "X5"},
            "providerComment": "Higher mileage",
            "score": 4.5, "risk": "medium", "recommended": False,
        }
        r = s.post(f"{BASE_URL}/api/provider/requests/{rid}/candidates",
                   headers=auth_headers, json=body, timeout=20)
        assert r.status_code == 200, r.text

    def test_patch_candidate(self, s, auth_headers, selection_request):
        cid = pytest.candidate_id
        body = {
            "listingUrl": "https://www.mobile.de/fahrzeuge/details.html?id=A1",
            "source": "mobile.de",
            "preview": {"title": "TEST_BMW X5 xDrive30d (updated)", "price": 27500,
                        "year": 2019, "mileage": 120000, "fuel": "diesel",
                        "make": "BMW", "model": "X5"},
            "providerComment": "Updated comment",
            "score": 8.0, "risk": "low", "recommended": True,
        }
        r = s.patch(f"{BASE_URL}/api/provider/candidates/{cid}",
                    headers=auth_headers, json=body, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["score"] == 8.0
        assert d["preview"]["price"] == 27500
        assert d["providerComment"] == "Updated comment"

    def test_customer_comparison_sort(self, s, auth_headers, selection_request):
        rid = selection_request["id"]
        r = s.get(f"{BASE_URL}/api/customer/requests/{rid}/candidates",
                  headers=auth_headers, timeout=20)
        assert r.status_code == 200, r.text
        d = r.json()
        assert d["requestId"] == rid
        assert d["count"] >= 2
        cands = d["candidates"]
        # Sorted: recommended desc, then score desc
        assert cands[0]["recommended"] is True, "recommended must come first"
        scores = [(c["recommended"], c["score"] or 0) for c in cands]
        assert scores == sorted(scores, key=lambda t: (1 if t[0] else 0, t[1]), reverse=True)
        # No _id leak
        assert all("_id" not in c for c in cands)

    def test_customer_comparison_requires_auth(self, s, selection_request):
        rid = selection_request["id"]
        r = s.get(f"{BASE_URL}/api/customer/requests/{rid}/candidates", timeout=15)
        assert r.status_code == 401

    def test_archive_candidate(self, s, auth_headers, selection_request):
        cid = pytest.candidate_id
        r = s.delete(f"{BASE_URL}/api/provider/candidates/{cid}",
                     headers=auth_headers, timeout=20)
        assert r.status_code == 200, r.text
        assert r.json().get("ok") is True

        # After archive — should not appear in customer comparison
        rid = selection_request["id"]
        r2 = s.get(f"{BASE_URL}/api/customer/requests/{rid}/candidates",
                   headers=auth_headers, timeout=20)
        assert r2.status_code == 200
        ids = [c["id"] for c in r2.json()["candidates"]]
        assert cid not in ids

    def test_archive_404(self, s, auth_headers):
        r = s.delete(f"{BASE_URL}/api/provider/candidates/does-not-exist-xxx",
                     headers=auth_headers, timeout=15)
        assert r.status_code == 404
