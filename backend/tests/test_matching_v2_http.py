"""Matching-v2 Sprint 1 — HTTP integration tests against the public preview.

Tests POST /api/matching/v2/project end-to-end:
  • Auth gating (401 without token)
  • Locked policy values returned byte-identical for each density tier
  • 422 on missing/unknown density (matching MUST refuse to guess)
  • End-to-end invariant: real /api/customer/requests/{id}/quote
    projection feeds in AS-IS and policy.effectiveDensity equals
    projection.densitySnapshot.effectiveDensity (no recomputation).

Hits the EXPO_PUBLIC_BACKEND_URL public preview so we exercise the same
ingress path the mobile client will.
"""
from __future__ import annotations

import os
import uuid

import pytest
import requests


BASE_URL = (
    os.environ.get("EXPO_PUBLIC_BACKEND_URL")
    or os.environ.get("EXPO_BACKEND_URL")
    or "https://app-mobile-build-26.preview.emergentagent.com"
).rstrip("/")

CUSTOMER_EMAIL = "customer@test.com"
CUSTOMER_PASSWORD = "Customer123!"

LOCKED_POLICY = {
    "high":   {"dispatchRadiusKm": 50,   "batchSize": 3,  "ttlMinutes": 5,    "policy": "fast_local"},
    "medium": {"dispatchRadiusKm": 100,  "batchSize": 5,  "ttlMinutes": 10,   "policy": "standard"},
    "low":    {"dispatchRadiusKm": 150,  "batchSize": 10, "ttlMinutes": 20,   "policy": "expanded"},
    "scarce": {"dispatchRadiusKm": None, "batchSize": 0,  "ttlMinutes": None, "policy": "concierge"},
}


# ─── Auth ────────────────────────────────────────────────────────────


@pytest.fixture(scope="module")
def customer_token() -> str:
    r = requests.post(
        f"{BASE_URL}/api/auth/login",
        json={"email": CUSTOMER_EMAIL, "password": CUSTOMER_PASSWORD},
        timeout=15,
    )
    if r.status_code != 200:
        pytest.skip(f"customer login failed: {r.status_code} {r.text}")
    return r.json()["accessToken"]


@pytest.fixture(scope="module")
def auth_headers(customer_token: str) -> dict:
    return {"Authorization": f"Bearer {customer_token}", "Content-Type": "application/json"}


def _snapshot(density: str) -> dict:
    """Pricing-v2-shaped pricing snapshot for projection."""
    return {
        "pricingVersion": "v2",
        "densitySnapshot": {"effectiveDensity": density},
    }


# ─── Auth gating ─────────────────────────────────────────────────────


class TestAuth:
    def test_unauthenticated_returns_401(self):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            json={"jobId": "j1", "pricingSnapshot": _snapshot("low")},
            timeout=15,
        )
        assert r.status_code in (401, 403), f"expected 401/403, got {r.status_code} {r.text}"


# ─── Locked policy table per tier ────────────────────────────────────


class TestLockedPolicy:
    @pytest.mark.parametrize("density", ["high", "medium", "low", "scarce"])
    def test_each_density_returns_locked_values(self, density, auth_headers):
        job_id = f"TEST_{density}_{uuid.uuid4().hex[:8]}"
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={"jobId": job_id, "pricingSnapshot": _snapshot(density)},
            timeout=15,
        )
        assert r.status_code == 200, f"{density} → {r.status_code} {r.text}"
        body = r.json()
        expected = LOCKED_POLICY[density]
        assert body["jobId"] == job_id
        assert body["matchingVersion"] == "v2"
        assert body["effectiveDensity"] == density
        assert body["dispatchRadiusKm"] == expected["dispatchRadiusKm"]
        assert body["batchSize"] == expected["batchSize"]
        assert body["ttlMinutes"] == expected["ttlMinutes"]
        assert body["policy"] == expected["policy"]

    def test_scarce_is_non_broadcast(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={"jobId": "TEST_scarce_nb", "pricingSnapshot": _snapshot("scarce")},
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["batchSize"] == 0
        assert body["dispatchRadiusKm"] is None
        assert body["ttlMinutes"] is None
        assert body["policy"] == "concierge"


# ─── Refusal cases — 422 ─────────────────────────────────────────────


class TestRefusalContract:
    def test_missing_density_snapshot_returns_422(self, auth_headers):
        # No densitySnapshot at all
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={"jobId": "TEST_no_density", "pricingSnapshot": {"pricingVersion": "v2"}},
            timeout=15,
        )
        assert r.status_code == 422, f"got {r.status_code}: {r.text}"

    def test_missing_effective_density_returns_422(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={
                "jobId": "TEST_no_eff",
                "pricingSnapshot": {"densitySnapshot": {}},
            },
            timeout=15,
        )
        assert r.status_code == 422, f"got {r.status_code}: {r.text}"

    def test_unknown_density_returns_422_with_locked_tiers(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={
                "jobId": "TEST_surge",
                "pricingSnapshot": {"densitySnapshot": {"effectiveDensity": "surge"}},
            },
            timeout=15,
        )
        assert r.status_code == 422, f"got {r.status_code}: {r.text}"
        # Error message must name the locked tiers so callers self-correct.
        text = r.text.lower()
        for tier in ("high", "medium", "low", "scarce"):
            assert tier in text, f"missing tier {tier} in error: {r.text}"

    def test_missing_pricing_snapshot_returns_422(self, auth_headers):
        r = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={"jobId": "TEST_no_snap"},
            timeout=15,
        )
        assert r.status_code == 422, f"got {r.status_code}: {r.text}"


# ─── End-to-end invariant: pricing snapshot → matching projection ────


class TestPricingToMatchingInvariant:
    """Real /api/customer/requests/{id}/quote → matching/v2/project.

    The whole point of Sprint 1: matching reads frozen density verbatim
    and never recomputes it.
    """

    def test_pricing_projection_density_equals_matching_density(self, auth_headers):
        # Create a customer request — Berlin resolves to density='low' in
        # seeded data (per iteration_1 report). Schema mirrors the pricing-v2C
        # contract test that the prior testing agent validated.
        req_payload = {
            "type": "inspection",
            "brand": "BMW",
            "model": "X5",
            "budget": 25000,
            "cities": ["Berlin"],
            "country": "DE",
            "links": [f"https://example.com/test-{uuid.uuid4().hex[:8]}"],
            "comment": "TEST_matching_v2 invariant probe",
        }
        create = requests.post(
            f"{BASE_URL}/api/customer/requests",
            headers=auth_headers,
            json=req_payload,
            timeout=20,
        )
        if create.status_code not in (200, 201):
            pytest.skip(f"cannot create request: {create.status_code} {create.text}")

        req_id = create.json().get("id") or create.json().get("_id") or create.json().get("requestId")
        assert req_id, f"no id in create response: {create.json()}"

        # Fetch the pricing-v2 quote projection
        quote = requests.post(
            f"{BASE_URL}/api/customer/requests/{req_id}/quote",
            headers=auth_headers,
            json={},
            timeout=20,
        )
        if quote.status_code != 200:
            # Fallback: try GET
            quote = requests.get(
                f"{BASE_URL}/api/customer/requests/{req_id}/quote",
                headers=auth_headers,
                timeout=20,
            )
        assert quote.status_code == 200, f"quote failed: {quote.status_code} {quote.text}"
        projection = quote.json()

        # Projection shape: { jobs: [ { jobId, projection: {densitySnapshot, ...} } ] }
        density_snapshot = projection.get("densitySnapshot")
        pricing_snapshot_in = projection
        if not density_snapshot and isinstance(projection.get("jobs"), list) and projection["jobs"]:
            job0 = projection["jobs"][0]
            job_proj = job0.get("projection") or job0
            density_snapshot = job_proj.get("densitySnapshot")
            pricing_snapshot_in = job_proj

        assert density_snapshot, f"projection missing densitySnapshot: {projection}"
        frozen_density = density_snapshot["effectiveDensity"]
        assert frozen_density in LOCKED_POLICY, f"unknown frozen tier: {frozen_density}"

        # Feed the projection AS-IS into matching
        match = requests.post(
            f"{BASE_URL}/api/matching/v2/project",
            headers=auth_headers,
            json={"jobId": f"TEST_inv_{req_id}", "pricingSnapshot": pricing_snapshot_in},
            timeout=15,
        )
        assert match.status_code == 200, f"matching projection failed: {match.status_code} {match.text}"
        mbody = match.json()

        # HARD INVARIANT: matching acted on the frozen density verbatim.
        assert mbody["effectiveDensity"] == frozen_density, (
            f"density drift! pricing said {frozen_density!r} "
            f"but matching returned {mbody['effectiveDensity']!r}"
        )
        # And the policy values match the locked table for that tier.
        expected = LOCKED_POLICY[frozen_density]
        assert mbody["dispatchRadiusKm"] == expected["dispatchRadiusKm"]
        assert mbody["batchSize"] == expected["batchSize"]
        assert mbody["ttlMinutes"] == expected["ttlMinutes"]
        assert mbody["policy"] == expected["policy"]
