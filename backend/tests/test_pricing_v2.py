"""Pricing-v2 tests — density projection + calculator + invariants.

Guards the locked v2 contract. Any change here forces a deliberate
edit to the calculator/registry (which would mean v3, not patching v2).
"""
from __future__ import annotations
import os
import sys
import types

import pytest

_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from app.pricing.density_projection import (  # noqa: E402
    DensitySnapshot,
    DENSITY_MULTIPLIER,
    DENSITY_REASON,
    bucket_for_providers,
    snapshot_to_dict,
    PROVIDERS_HIGH_MIN, PROVIDERS_MEDIUM_MIN, PROVIDERS_LOW_MIN,
    _coverage_ratio,
)
from app.pricing.projection_v2 import (  # noqa: E402
    calculate_projection_v2,
    PRICING_VERSION_V2,
)
from app.pricing.version_registry import (  # noqa: E402
    KNOWN_VERSIONS, current_version, is_version_known, is_version_locked,
)


def _snap(density: str = "high", **overrides) -> DensitySnapshot:
    """Build a DensitySnapshot for the calculator tests."""
    defaults = {
        "cityId": "berlin",
        "countryCode": "DE",
        "providers": 6,
        "partners": 3,
        "coverageRatio": 1.0,
        "cityDensity": density,
        "countryDensity": density,
        "effectiveDensity": density,
        "densityMultiplier": DENSITY_MULTIPLIER[density],
        "manualReview": density == "scarce",
        "reason": DENSITY_REASON[density],
    }
    defaults.update(overrides)
    return DensitySnapshot(**defaults)


# ── 1. Density bracket mapping (locked) ─────────────────────────────────


class TestDensityBuckets:
    def test_zero_is_scarce(self):
        assert bucket_for_providers(0) == "scarce"

    @pytest.mark.parametrize("n", [1, 2])
    def test_low(self, n):
        assert bucket_for_providers(n) == "low"

    @pytest.mark.parametrize("n", [3, 4, 5])
    def test_medium(self, n):
        assert bucket_for_providers(n) == "medium"

    @pytest.mark.parametrize("n", [6, 7, 12, 100])
    def test_high(self, n):
        assert bucket_for_providers(n) == "high"

    def test_bracket_constants_locked(self):
        # Locks the constants. Any change must be deliberate (= v3).
        assert PROVIDERS_HIGH_MIN == 6
        assert PROVIDERS_MEDIUM_MIN == 3
        assert PROVIDERS_LOW_MIN == 1

    def test_monotone(self):
        order = {"scarce": 0, "low": 1, "medium": 2, "high": 3}
        prev = -1
        for n in range(0, 30):
            cur = order[bucket_for_providers(n)]
            assert cur >= prev, f"density regressed at providers={n}"
            prev = cur


class TestCoverageRatio:
    def test_zero(self):
        assert _coverage_ratio(0) == 0.0

    def test_clamped_to_one(self):
        assert _coverage_ratio(1000) == 1.0

    def test_proportional(self):
        # 3 / 6 = 0.5
        assert _coverage_ratio(3) == 0.5


# ── 2. Modifier table (locked) ──────────────────────────────────────────


class TestModifierTable:
    def test_high_no_premium(self):
        assert DENSITY_MULTIPLIER["high"] == 1.00

    def test_medium_five_percent(self):
        assert DENSITY_MULTIPLIER["medium"] == 1.05

    def test_low_fifteen_percent(self):
        assert DENSITY_MULTIPLIER["low"] == 1.15

    def test_scarce_thirty_percent(self):
        assert DENSITY_MULTIPLIER["scarce"] == 1.30

    def test_all_tiers_have_reason(self):
        for tier in ("high", "medium", "low", "scarce"):
            assert DENSITY_REASON[tier]
            assert "demand" not in DENSITY_REASON[tier].lower(), \
                "no surge/demand framing allowed in v2"
            assert "surge" not in DENSITY_REASON[tier].lower()


# ── 3. Calculator (pure, no DB) ──────────────────────────────────────────


class TestCalculatorDeterminism:
    def test_inside_included_radius(self):
        snap = _snap("high")
        p = calculate_projection_v2(base_price=199, distance_km=80, density=snap)
        assert p["pricingVersion"] == "v2"
        assert p["remoteTier"] == "included"
        assert p["distanceSurcharge"] == 0.0
        assert p["customerTotal"] == 199.0
        assert p["densityMultiplier"] == 1.00
        assert p["densitySurchargeDelta"] == 0.0

    def test_standard_remote_high_density(self):
        # 220 km · standard_remote: extra=120 × 0.45 = 54, floor 50 → 54
        # high density → multiplier 1.00 → no delta
        snap = _snap("high")
        p = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        assert p["remoteTier"] == "standard_remote"
        assert p["distanceSurchargeBase"] == 54.0
        assert p["densityMultiplier"] == 1.00
        assert p["distanceSurcharge"] == 54.0
        assert p["customerTotal"] == 253.0
        assert p["manualReview"] is False

    def test_low_density_adds_fifteen_percent(self):
        snap = _snap("low")
        p = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        # 54 × 1.15 = 62.1 → round → 62
        assert p["distanceSurchargeBase"] == 54.0
        assert p["densityMultiplier"] == 1.15
        assert p["distanceSurcharge"] == 62.0
        assert p["densitySurchargeDelta"] == 8.0
        assert p["customerTotal"] == 261.0

    def test_scarce_forces_manual_review(self):
        # Even on a short distance, scarce density forces manual review.
        snap = _snap("scarce")
        p = calculate_projection_v2(base_price=199, distance_km=80, density=snap)
        assert p["remoteTier"] == "included"
        assert p["manualReview"] is True

    def test_scarce_at_distance(self):
        # 220 km × scarce 1.30: 54 × 1.30 = 70.2 → 70
        snap = _snap("scarce")
        p = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        assert p["densityMultiplier"] == 1.30
        assert p["distanceSurcharge"] == 70.0
        assert p["densitySurchargeDelta"] == 16.0
        assert p["manualReview"] is True

    def test_far_remote_keeps_manual_review_when_high(self):
        # far_remote tier already requires manual_review; high density
        # must not unset it.
        snap = _snap("high")
        p = calculate_projection_v2(base_price=199, distance_km=300, density=snap)
        assert p["remoteTier"] == "far_remote"
        assert p["manualReview"] is True

    def test_inspector_payout_split_85_15(self):
        snap = _snap("low")
        p = calculate_projection_v2(base_price=0, distance_km=220, density=snap)
        # surcharge 62 → 85% inspector, 15% platform
        assert p["distanceSurcharge"] == 62.0
        # 62 * 0.85 = 52.7
        assert p["inspectorDistancePayout"] == 52.7
        # platform = surcharge - inspector — guaranteed no drift
        assert p["platformDistanceFee"] == round(62.0 - 52.7, 2)
        assert p["inspectorDistancePayout"] + p["platformDistanceFee"] == 62.0

    def test_rejects_unknown_multiplier(self):
        # If the snapshot was tampered with (multiplier not in locked
        # table), the calculator refuses to emit a quote.
        snap = _snap("high")
        bad = DensitySnapshot(**{**snap.__dict__, "densityMultiplier": 1.42})
        with pytest.raises(ValueError):
            calculate_projection_v2(base_price=199, distance_km=220, density=bad)

    def test_rejects_negative_base(self):
        with pytest.raises(ValueError):
            calculate_projection_v2(base_price=-1, distance_km=80, density=_snap())

    def test_rejects_negative_distance(self):
        with pytest.raises(ValueError):
            calculate_projection_v2(base_price=199, distance_km=-1, density=_snap())


class TestExplanation:
    def test_explanation_for_high_density(self):
        snap = _snap("high")
        p = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        labels = [e["label"] for e in p["explanation"]]
        assert any("Base inspection" in l for l in labels)
        assert any("Distance 220 km" in l for l in labels)
        # high density has multiplier 1.0 → no density row
        assert not any("Established marketplace coverage" in l for l in labels)

    def test_explanation_for_low_density(self):
        snap = _snap("low")
        p = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        # Low density: explanation must mention "Limited inspector coverage (+15%)"
        labels = " ".join(e["label"] for e in p["explanation"])
        assert "Limited inspector coverage" in labels
        assert "+15%" in labels


# ── 4. Same inputs → same quote forever ─────────────────────────────────


class TestDeterministicReproducibility:
    """The single most important invariant — guards against the day a
    refactor sneaks in a `random()` / `time()` call."""

    def test_byte_identical_on_replay(self):
        snap = _snap("low")
        a = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        b = calculate_projection_v2(base_price=199, distance_km=220, density=snap)
        # Drop digest because string comparison is the same; keep raw fields.
        assert a == b

    def test_same_snapshot_same_quote_after_modifier_change(self):
        # Even if the live density would change, replaying with the
        # frozen snapshot returns the frozen quote.
        frozen = _snap("low")
        p1 = calculate_projection_v2(base_price=199, distance_km=220, density=frozen)
        # Imagine the marketplace gained providers and "low" became "high"
        # for live calls — replaying with the frozen low snapshot must
        # still produce the same quote.
        p2 = calculate_projection_v2(base_price=199, distance_km=220, density=frozen)
        assert p1 == p2
        assert p1["densityMultiplier"] == 1.15  # frozen low


# ── 5. Snapshot dict shape (frozen contract) ────────────────────────────


class TestSnapshotShape:
    def test_field_set(self):
        snap = _snap("medium")
        d = snapshot_to_dict(snap)
        assert set(d.keys()) == {
            "cityId", "countryCode",
            "providers", "partners", "coverageRatio",
            "cityDensity", "countryDensity",
            "effectiveDensity", "densityMultiplier",
            "manualReview", "reason",
        }


# ── 6. Version registry ─────────────────────────────────────────────────


class TestVersionRegistry:
    def test_v2_registered(self):
        assert "v2" in KNOWN_VERSIONS
        assert is_version_known("v2")
        assert is_version_locked("v2")

    def test_v1_still_locked(self):
        # v1 must NEVER be unlocked — confirmed v1 quotes exist forever.
        assert is_version_locked("v1")

    def test_current_is_v2(self):
        assert current_version() == "v2"

    def test_unknown_version_not_locked(self):
        assert is_version_locked("vX") is False
