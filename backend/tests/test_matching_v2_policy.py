"""Matching-v2 Sprint 1 — tests for the dispatch policy projection.

These tests pin the locked policy table byte-by-byte. Any drift here
is intentional and requires Matching-v3, not a value edit.

Hard invariants verified:
  1. The 4-row policy table matches the spec exactly.
  2. Same density → same DispatchPolicy (purity).
  3. The projection refuses to run when the pricing snapshot lacks
     `densitySnapshot.effectiveDensity` — matching MUST never guess.
  4. `scarce` is non-broadcast (batchSize=0, ttl=None, radius=None,
     policy=concierge) — operational semantics match pricing-v2C copy.
  5. Unknown density tier → ValueError. Never a silent fallback.
"""
from __future__ import annotations
import pytest

from app.matching_v2.policy import (
    DISPATCH_POLICY,
    DispatchPolicy,
    project_dispatch_policy,
    policy_to_dict,
)


def _snapshot(density: str) -> dict:
    """Pricing-v2 projection-shaped snapshot for tests."""
    return {
        "pricingVersion": "v2",
        "densitySnapshot": {"effectiveDensity": density},
    }


# ─── Locked policy table — byte-identical assertions ──────────────────


def test_policy_high_is_locked():
    p = DISPATCH_POLICY["high"]
    assert p == DispatchPolicy(
        effectiveDensity="high",
        dispatchRadiusKm=50,
        batchSize=3,
        ttlMinutes=5,
        policy="fast_local",
    )


def test_policy_medium_is_locked():
    p = DISPATCH_POLICY["medium"]
    assert p == DispatchPolicy(
        effectiveDensity="medium",
        dispatchRadiusKm=100,
        batchSize=5,
        ttlMinutes=10,
        policy="standard",
    )


def test_policy_low_is_locked():
    p = DISPATCH_POLICY["low"]
    assert p == DispatchPolicy(
        effectiveDensity="low",
        dispatchRadiusKm=150,
        batchSize=10,
        ttlMinutes=20,
        policy="expanded",
    )


def test_policy_scarce_is_locked_and_non_broadcast():
    p = DISPATCH_POLICY["scarce"]
    assert p == DispatchPolicy(
        effectiveDensity="scarce",
        dispatchRadiusKm=None,   # no radius — concierge handles
        batchSize=0,             # no broadcast
        ttlMinutes=None,         # no auto-expiration
        policy="concierge",
    )
    # Operational semantics MUST match pricing-v2C copy ("Remote
    # availability check required"): no auto-broadcast.
    assert p.batchSize == 0
    assert p.dispatchRadiusKm is None
    assert p.ttlMinutes is None


def test_policy_table_has_exactly_four_tiers():
    assert set(DISPATCH_POLICY.keys()) == {"high", "medium", "low", "scarce"}


# ─── Purity: same input → same output ─────────────────────────────────


@pytest.mark.parametrize("density", ["high", "medium", "low", "scarce"])
def test_projection_is_pure(density):
    a = project_dispatch_policy(_snapshot(density))
    b = project_dispatch_policy(_snapshot(density))
    assert a == b
    # Identity holds because DISPATCH_POLICY values are frozen.
    assert a is DISPATCH_POLICY[density]


# ─── Projection returns the right row for each density ────────────────


@pytest.mark.parametrize(
    "density,expected_radius,expected_batch,expected_ttl,expected_policy",
    [
        ("high",   50,   3,   5,    "fast_local"),
        ("medium", 100,  5,   10,   "standard"),
        ("low",    150,  10,  20,   "expanded"),
        ("scarce", None, 0,   None, "concierge"),
    ],
)
def test_projection_maps_density_to_policy(
    density, expected_radius, expected_batch, expected_ttl, expected_policy,
):
    p = project_dispatch_policy(_snapshot(density))
    assert p.effectiveDensity == density
    assert p.dispatchRadiusKm == expected_radius
    assert p.batchSize == expected_batch
    assert p.ttlMinutes == expected_ttl
    assert p.policy == expected_policy


def test_projection_tolerates_extra_pricing_snapshot_fields():
    # Real pricing-v2 snapshots carry many more fields; the projection
    # MUST ignore them and act only on effectiveDensity.
    snapshot = {
        "pricingVersion": "v2",
        "basePrice": 199.0,
        "distanceKm": 220,
        "customerTotal": 261.0,
        "manualReview": False,
        "explanation": [{"label": "Base", "amount": 199}],
        "densitySnapshot": {
            "cityId": "berlin",
            "countryCode": "DE",
            "providers": 1,
            "partners": 3,
            "coverageRatio": 0.17,
            "cityDensity": "low",
            "countryDensity": "low",
            "effectiveDensity": "low",
            "densityMultiplier": 1.15,
            "manualReview": False,
            "reason": "Limited inspector coverage",
        },
    }
    p = project_dispatch_policy(snapshot)
    assert p.effectiveDensity == "low"
    assert p.dispatchRadiusKm == 150


# ─── Refusal cases — matching MUST NOT guess ──────────────────────────


def test_missing_density_snapshot_raises():
    # No densitySnapshot at all — matching cannot read frozen economics.
    with pytest.raises(ValueError, match="densitySnapshot"):
        project_dispatch_policy({"pricingVersion": "v2"})


def test_missing_effective_density_raises():
    with pytest.raises(ValueError):
        project_dispatch_policy({"densitySnapshot": {}})


def test_unknown_density_raises():
    with pytest.raises(ValueError, match="not in the locked policy table"):
        project_dispatch_policy({"densitySnapshot": {"effectiveDensity": "surge"}})


def test_non_dict_snapshot_raises():
    with pytest.raises(ValueError):
        project_dispatch_policy(None)  # type: ignore[arg-type]


def test_non_dict_density_snapshot_raises():
    with pytest.raises(ValueError):
        project_dispatch_policy({"densitySnapshot": "low"})  # type: ignore[dict-item]


# ─── Serializer ───────────────────────────────────────────────────────


def test_policy_to_dict_round_trips():
    p = project_dispatch_policy(_snapshot("medium"))
    d = policy_to_dict(p)
    assert d == {
        "effectiveDensity": "medium",
        "dispatchRadiusKm": 100,
        "batchSize": 5,
        "ttlMinutes": 10,
        "policy": "standard",
    }
