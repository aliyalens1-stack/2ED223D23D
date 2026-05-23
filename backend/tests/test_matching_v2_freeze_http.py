"""Matching-v2 Sprint 2 — HTTP integration tests against the public preview.

Validates POST /api/matching/v2/freeze/{jobId} and
GET  /api/matching/v2/snapshot/{jobId} end-to-end against the same ingress
the mobile client uses.

Five invariants covered:
  1. Idempotency — repeated freeze returns byte-identical doc; createdAt
     and createdBy of FIRST caller win even when later caller is a
     different actor (admin vs customer).
  2. Pricing bridge — dispatch.effectiveDensity == pricing.densitySnapshot.effectiveDensity
     (read live from /api/customer/requests/{id}/quote/confirm).
  3. 409 PRICING_NOT_CONFIRMED when no pricing exists yet for the jobId
     and when only a pending (unconfirmed) projection exists.
  4. GET returns frozen doc; 404 when none.
  5. No recompute — a second freeze after the first returns the original
     snapshot byte-identical (createdAt unchanged).
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests


BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
)
assert BASE_URL, "Backend URL env var missing"
BASE_URL = BASE_URL.rstrip("/")

CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}
ADMIN = {"email": "admin@autoservice.com", "password": "Admin123!"}

LOCKED_POLICY = {
    "high":   {"dispatchRadiusKm": 50,   "batchSize": 3,  "ttlMinutes": 5,    "policy": "fast_local"},
    "medium": {"dispatchRadiusKm": 100,  "batchSize": 5,  "ttlMinutes": 10,   "policy": "standard"},
    "low":    {"dispatchRadiusKm": 150,  "batchSize": 10, "ttlMinutes": 20,   "policy": "expanded"},
    "scarce": {"dispatchRadiusKm": None, "batchSize": 0,  "ttlMinutes": None, "policy": "concierge"},
}


# ─── Auth fixtures ───────────────────────────────────────────────────


def _login(creds: dict) -> str | None:
    r = requests.post(f"{BASE_URL}/api/auth/login", json=creds, timeout=20)
    if r.status_code != 200:
        return None
    return r.json().get("accessToken")


@pytest.fixture(scope="module")
def customer_token() -> str:
    tok = _login(CUSTOMER)
    if not tok:
        pytest.skip("customer login failed")
    return tok


@pytest.fixture(scope="module")
def admin_token() -> str | None:
    return _login(ADMIN)


@pytest.fixture(scope="module")
def auth_headers(customer_token: str) -> dict:
    return {"Authorization": f"Bearer {customer_token}", "Content-Type": "application/json"}


# ─── Request creation helpers ────────────────────────────────────────


def _create_request(auth_headers: dict) -> str:
    payload = {
        "type": "inspection",
        "brand": "BMW",
        "model": "X5",
        "budget": 25000,
        "cities": ["Berlin"],
        "country": "DE",
        "links": [f"https://example.com/test-{uuid.uuid4().hex[:8]}"],
        "comment": "TEST_matching_v2_freeze probe",
    }
    r = requests.post(
        f"{BASE_URL}/api/customer/requests", json=payload, headers=auth_headers, timeout=30
    )
    if r.status_code not in (200, 201):
        pytest.skip(f"cannot create request: {r.status_code} {r.text[:300]}")
    data = r.json()
    rid = (
        data.get("id") or data.get("_id") or data.get("requestId")
        or (data.get("request") or {}).get("id")
    )
    if not rid:
        pytest.skip(f"no request id in response: {data}")
    return rid


def _get_quote_and_jobs(auth_headers: dict, request_id: str) -> dict:
    """Returns the quote body containing jobs[]."""
    r = requests.post(
        f"{BASE_URL}/api/customer/requests/{request_id}/quote",
        json={"basePrice": 199.0},
        headers=auth_headers,
        timeout=30,
    )
    assert r.status_code == 200, f"quote create failed: {r.status_code} {r.text[:300]}"
    return r.json()


def _confirm_quote(auth_headers: dict, request_id: str) -> dict:
    r = requests.post(
        f"{BASE_URL}/api/customer/requests/{request_id}/quote/confirm",
        headers=auth_headers,
        timeout=30,
    )
    assert r.status_code == 200, f"confirm failed: {r.status_code} {r.text[:300]}"
    return r.json()


def _first_job(quote_body: dict) -> dict:
    jobs = quote_body.get("jobs") or []
    assert jobs, f"no jobs in quote: {quote_body}"
    return jobs[0]


# ─── Tests ───────────────────────────────────────────────────────────


class TestAuth:
    def test_freeze_requires_auth(self):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/job-anon-{uuid.uuid4().hex[:6]}",
            timeout=15,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code} {r.text[:200]}"

    def test_get_snapshot_requires_auth(self):
        r = requests.get(
            f"{BASE_URL}/api/matching/v2/snapshot/job-anon-{uuid.uuid4().hex[:6]}",
            timeout=15,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code} {r.text[:200]}"


class TestFreezeWithoutPricing:
    """Invariant 4: 409 PRICING_NOT_CONFIRMED when pricing missing/pending."""

    def _assert_pricing_not_confirmed_409(self, r):
        """Accepts either FastAPI native shape (detail.code) OR the project's
        global error envelope ({error, code, message, details}). Either way
        the response MUST programmatically identify PRICING_NOT_CONFIRMED.
        """
        assert r.status_code == 409, f"expected 409, got {r.status_code} {r.text[:300]}"
        body = r.json()
        # FastAPI native
        detail = body.get("detail") if isinstance(body, dict) else None
        if isinstance(detail, dict) and detail.get("code") == "PRICING_NOT_CONFIRMED":
            return
        # Global envelope — code field at root OR nested in details
        code_root = body.get("code")
        code_details = (body.get("details") or {}).get("code")
        assert (
            code_root == "PRICING_NOT_CONFIRMED" or code_details == "PRICING_NOT_CONFIRMED"
        ), (
            "409 envelope does not expose 'PRICING_NOT_CONFIRMED' code to client. "
            f"Got body: {body}\n"
            "Contract drift: the global error handler is overwriting the custom "
            "code with the HTTP status reason ('CONFLICT'). Clients cannot "
            "programmatically distinguish 'no pricing yet' from any other 409."
        )

    def test_freeze_unknown_job_returns_409_pricing_not_confirmed(self, auth_headers):
        unknown_job = f"TEST_no_pricing_{uuid.uuid4().hex[:10]}"
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{unknown_job}",
            headers=auth_headers,
            timeout=15,
        )
        self._assert_pricing_not_confirmed_409(r)

    def test_freeze_pending_quote_returns_409(self, auth_headers):
        """Pricing exists but is in status='pending' (not confirmed) — must refuse."""
        rid = _create_request(auth_headers)
        quote = _get_quote_and_jobs(auth_headers, rid)
        job_id = _first_job(quote)["jobId"]
        # DO NOT confirm. Now try to freeze.
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers,
            timeout=15,
        )
        self._assert_pricing_not_confirmed_409(r)


class TestFreezeAfterConfirm:
    """Invariants 2 + 3: freeze succeeds with confirmed pricing, density bridge holds."""

    @pytest.fixture(scope="class")
    def frozen_setup(self, auth_headers):
        rid = _create_request(auth_headers)
        _get_quote_and_jobs(auth_headers, rid)
        confirmed = _confirm_quote(auth_headers, rid)
        job = _first_job(confirmed)
        proj = job["projection"]
        return {
            "request_id": rid,
            "job_id": job["jobId"],
            "frozen_density": proj["densitySnapshot"]["effectiveDensity"],
            "pricing_digest": proj.get("digest", ""),
            "pricing_confirmed_at": proj.get("confirmedAt"),
            "pricing_version": confirmed.get("pricingVersion", "v2"),
        }

    def test_freeze_after_confirm_returns_200_with_locked_policy(self, auth_headers, frozen_setup):
        job_id = frozen_setup["job_id"]
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers,
            timeout=20,
        )
        assert r.status_code == 200, f"freeze failed: {r.status_code} {r.text[:400]}"
        body = r.json()
        density = frozen_setup["frozen_density"]
        expected = LOCKED_POLICY[density]

        assert body["jobId"] == job_id
        assert body["matchingVersion"] == "v2"
        assert body["effectiveDensity"] == density, (
            f"density bridge broken: pricing={density!r} vs dispatch={body['effectiveDensity']!r}"
        )
        assert body["dispatchRadiusKm"] == expected["dispatchRadiusKm"]
        assert body["batchSize"] == expected["batchSize"]
        assert body["ttlMinutes"] == expected["ttlMinutes"]
        assert body["policy"] == expected["policy"]
        assert body["status"] == "projected"
        assert body["pricingDigest"] == frozen_setup["pricing_digest"]
        assert body["pricingConfirmedAt"] == frozen_setup["pricing_confirmed_at"]
        assert body["createdAt"], "createdAt must be set"
        assert body["createdBy"], "createdBy must be set to customer user_id"

    def test_get_snapshot_returns_frozen_doc(self, auth_headers, frozen_setup):
        job_id = frozen_setup["job_id"]
        # Ensure frozen first
        freeze = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers, timeout=20,
        )
        assert freeze.status_code == 200
        get_r = requests.get(
            f"{BASE_URL}/api/matching/v2/snapshot/{job_id}",
            headers=auth_headers, timeout=15,
        )
        assert get_r.status_code == 200, f"{get_r.status_code} {get_r.text[:300]}"
        assert get_r.json() == freeze.json(), "GET must return byte-identical frozen doc"

    def test_idempotent_freeze_byte_identical_with_different_actor(
        self, auth_headers, admin_token, frozen_setup,
    ):
        """Second caller is a DIFFERENT actor (admin). Snapshot must NOT mutate.
        createdAt and createdBy of the FIRST caller must win.
        """
        job_id = frozen_setup["job_id"]

        first = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers, timeout=20,
        )
        assert first.status_code == 200
        first_doc = first.json()

        if not admin_token:
            pytest.skip("admin token unavailable — partial idempotency check only")

        admin_headers = {"Authorization": f"Bearer {admin_token}", "Content-Type": "application/json"}
        second = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=admin_headers, timeout=20,
        )
        assert second.status_code == 200, f"{second.status_code} {second.text[:300]}"
        second_doc = second.json()

        # Byte-identical regardless of which actor called
        assert second_doc == first_doc, (
            f"snapshot mutated between calls!\nfirst:  {first_doc}\nsecond: {second_doc}"
        )
        assert second_doc["createdAt"] == first_doc["createdAt"], "createdAt drift!"
        assert second_doc["createdBy"] == first_doc["createdBy"], (
            f"createdBy overwritten by later caller (admin) — first writer should win. "
            f"first={first_doc['createdBy']} second={second_doc['createdBy']}"
        )

    def test_third_freeze_still_returns_original(self, auth_headers, frozen_setup):
        """Invariant 5: no recompute drift — third call returns same doc."""
        job_id = frozen_setup["job_id"]
        a = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers, timeout=20,
        ).json()
        b = requests.post(
            f"{BASE_URL}/api/matching/v2/freeze/{job_id}",
            headers=auth_headers, timeout=20,
        ).json()
        assert a == b


class TestGetSnapshotNotFound:
    def test_get_unknown_returns_404(self, auth_headers):
        unknown_job = f"TEST_unknown_{uuid.uuid4().hex[:10]}"
        r = requests.get(
            f"{BASE_URL}/api/matching/v2/snapshot/{unknown_job}",
            headers=auth_headers, timeout=15,
        )
        assert r.status_code == 404, f"expected 404, got {r.status_code} {r.text[:200]}"
        body = r.json()
        detail = body.get("detail")
        if isinstance(detail, dict):
            assert detail.get("code") == "DISPATCH_SNAPSHOT_NOT_FOUND"
