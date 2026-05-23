"""Integration tests for Pricing v2C customer-facing quote contract.

The frontend (PricingBreakdown.tsx) renders frozen `explanation[]` +
`densitySnapshot` returned by the backend. This test validates the
backend contract still holds:

  POST /api/customer/requests/{id}/quote      → projection with
      explanation[], densitySnapshot, customerTotal, manualReview, status, digest
  POST /api/customer/requests/{id}/quote/confirm  → status=confirmed, confirmedAt
  GET  /api/customer/requests/{id}/quote       → immutable confirmed projection
"""
from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL") or os.environ.get("EXPO_BACKEND_URL")
assert BASE_URL, "Backend URL env var missing"
BASE_URL = BASE_URL.rstrip("/")

CUSTOMER = {"email": "customer@test.com", "password": "Customer123!"}


# ── helpers ─────────────────────────────────────────────────────────
@pytest.fixture(scope="module")
def customer_token() -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json=CUSTOMER,
        timeout=20,
    )
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("accessToken")
    assert tok, "missing accessToken"
    return tok


@pytest.fixture(scope="module")
def auth_headers(customer_token: str) -> dict:
    return {"Authorization": f"Bearer {customer_token}", "Content-Type": "application/json"}


@pytest.fixture(scope="module")
def request_id(auth_headers: dict) -> str:
    """Create a fresh car_request with a Berlin job so we have something to quote.

    Uses the public customer endpoint that creates a request and a job in one shot.
    """
    payload = {
        "type": "inspection",
        "brand": "BMW",
        "model": "X5",
        "budget": 25000,
        "cities": ["Berlin"],
        "country": "DE",
        "links": [f"https://example.com/test-{uuid.uuid4().hex[:8]}"],
        "comment": "TEST_pricing_v2c contract check",
    }
    r = requests.post(
        f"{BASE_URL}/api/customer/requests", json=payload, headers=auth_headers, timeout=30
    )
    last_err = None
    if r.status_code in (200, 201):
        data = r.json()
        rid = (
            data.get("id")
            or data.get("_id")
            or data.get("requestId")
            or (data.get("request") or {}).get("id")
            or (data.get("request") or {}).get("_id")
        )
        if rid:
            return rid
        last_err = ("response missing id", data)
    else:
        last_err = (r.status_code, r.text[:300])
    # Fall back to listing existing requests
    r = requests.get(f"{BASE_URL}/api/customer/requests", headers=auth_headers, timeout=20)
    if r.status_code == 200:
        items = r.json() if isinstance(r.json(), list) else (r.json().get("items") or r.json().get("requests") or [])
        for it in items:
            rid = it.get("id") or it.get("_id") or it.get("requestId")
            if rid:
                return rid
    pytest.skip(f"Could not obtain a request_id (last attempt: {last_err})")


# ── Contract: projection shape ─────────────────────────────────────
def _validate_projection_shape(projection: dict) -> None:
    """Frontend depends on every projection having these fields."""
    assert "explanation" in projection, f"missing explanation: {list(projection.keys())}"
    assert isinstance(projection["explanation"], list), "explanation must be a list"
    assert len(projection["explanation"]) > 0, "explanation must be non-empty"
    for item in projection["explanation"]:
        assert isinstance(item, dict), "each explanation entry must be a dict"
        assert "label" in item or "reason" in item or "code" in item, (
            f"explanation entry needs a textual key: {item}"
        )

    assert "customerTotal" in projection
    assert isinstance(projection["customerTotal"], (int, float))
    assert projection["customerTotal"] >= 0

    assert "manualReview" in projection
    assert isinstance(projection["manualReview"], bool)

    assert "status" in projection
    assert projection["status"] in ("pending", "confirmed")

    assert "digest" in projection
    assert isinstance(projection["digest"], str)


def _validate_density_snapshot(projection: dict) -> None:
    """v2 invariant: every projection has a densitySnapshot with a valid bucket."""
    ds = projection.get("densitySnapshot")
    assert ds is not None, f"missing densitySnapshot in projection (keys={list(projection.keys())})"
    eff = ds.get("effectiveDensity") or ds.get("bucket")
    assert eff in ("high", "medium", "low", "scarce"), f"invalid bucket: {eff} (snapshot={ds})"


def _validate_aggregate_shape(body: dict) -> None:
    for key in ("requestId", "pricingVersion", "currency", "customerTotal", "manualReview", "status", "digest", "jobs"):
        assert key in body, f"missing aggregate key: {key} (got {list(body.keys())})"
    assert isinstance(body["jobs"], list) and body["jobs"], "jobs must be non-empty list"
    for line in body["jobs"]:
        assert "jobId" in line and "city" in line and "projection" in line


# ── Tests ──────────────────────────────────────────────────────────
class TestQuoteCreation:
    """POST /api/customer/requests/{id}/quote — creates frozen projection."""

    def test_create_quote_returns_explanation_and_density(self, auth_headers, request_id):
        r = requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            json={"basePrice": 199.0},
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text[:400]}"
        body = r.json()
        _validate_aggregate_shape(body)
        for line in body["jobs"]:
            proj = line["projection"]
            _validate_projection_shape(proj)
            _validate_density_snapshot(proj)
            assert proj["status"] == "pending"
            # Customer-safe view: inspector payout fields must be stripped
            assert "inspectorDistancePayout" not in proj
            assert "platformDistanceFee" not in proj

    def test_create_quote_no_inspector_fields_at_root(self, auth_headers, request_id):
        r = requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            json={"basePrice": 199.0},
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 200
        body = r.json()
        # Aggregate body must not leak per-job payout split
        assert "inspectorDistancePayout" not in body
        assert "platformDistanceFee" not in body


class TestQuoteGet:
    """GET /api/customer/requests/{id}/quote — read-only view."""

    def test_get_quote_returns_same_shape(self, auth_headers, request_id):
        # Ensure projection exists first
        requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            json={"basePrice": 199.0},
            headers=auth_headers,
            timeout=30,
        )
        r = requests.get(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            headers=auth_headers,
            timeout=20,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text[:400]}"
        body = r.json()
        _validate_aggregate_shape(body)
        for line in body["jobs"]:
            _validate_projection_shape(line["projection"])
            _validate_density_snapshot(line["projection"])


class TestQuoteConfirm:
    """POST /api/customer/requests/{id}/quote/confirm — locks projection."""

    def test_confirm_sets_status_confirmed_and_confirmed_at(self, auth_headers, request_id):
        # Make sure a pending projection exists
        post = requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            json={"basePrice": 199.0},
            headers=auth_headers,
            timeout=30,
        )
        assert post.status_code == 200

        r = requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote/confirm",
            headers=auth_headers,
            timeout=30,
        )
        assert r.status_code == 200, f"{r.status_code} {r.text[:400]}"
        body = r.json()
        _validate_aggregate_shape(body)
        assert body["status"] == "confirmed"
        for line in body["jobs"]:
            proj = line["projection"]
            _validate_projection_shape(proj)
            _validate_density_snapshot(proj)
            assert proj["status"] == "confirmed"
            assert proj.get("confirmedAt"), "confirmedAt must be set on confirmed projection"

    def test_confirmed_quote_is_immutable_via_get(self, auth_headers, request_id):
        r = requests.get(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            headers=auth_headers,
            timeout=20,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "confirmed"
        for line in body["jobs"]:
            proj = line["projection"]
            assert proj["status"] == "confirmed"
            # densitySnapshot + explanation MUST survive confirmation (frontend depends on it)
            _validate_density_snapshot(proj)
            assert isinstance(proj.get("explanation"), list) and proj["explanation"], (
                "explanation must persist on confirmed projection"
            )

    def test_confirmed_quote_post_is_noop_or_idempotent(self, auth_headers, request_id):
        """Re-running POST /quote on a confirmed request must NOT mutate frozen values."""
        before = requests.get(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            headers=auth_headers,
            timeout=20,
        ).json()
        # Refresh attempt
        requests.post(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            json={"basePrice": 999.0},  # different base — must be ignored on confirmed
            headers=auth_headers,
            timeout=30,
        )
        after = requests.get(
            f"{BASE_URL}/api/customer/requests/{request_id}/quote",
            headers=auth_headers,
            timeout=20,
        ).json()
        assert before["customerTotal"] == after["customerTotal"], (
            f"confirmed total changed: {before['customerTotal']} → {after['customerTotal']}"
        )
        assert before["digest"] == after["digest"], "confirmed digest must be immutable"
