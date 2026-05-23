"""Pricing projection — deterministic calculator tests.

Run: pytest /app/backend/tests/test_pricing_projection.py -v
"""
from __future__ import annotations
import sys
import pytest

sys.path.insert(0, '/app/backend')

from app.pricing.projection import calculate_projection, calculate_projection_from_geo
from app.pricing.tiers import INCLUDED_KM, REMOTE_TIERS
from app.pricing.distance import haversine_km


# ── Included radius (0–100 km) ───────────────────────────────────────
@pytest.mark.parametrize("dist", [0, 1, 50, 99.9, 100])
def test_included_radius_no_surcharge(dist):
    p = calculate_projection(base_price=199, distance_km=dist)
    assert p["remoteTier"] == "included"
    assert p["distanceSurcharge"] == 0
    assert p["customerTotal"] == 199.0
    assert p["manualReview"] is False
    assert p["extraKm"] == 0


# ── Soft remote (101–150 km) ─────────────────────────────────────────
def test_soft_remote_min_floor_at_120km():
    """120 km → 20 extra × €0.35 = €7 → floored to €25 minimum fee."""
    p = calculate_projection(base_price=199, distance_km=120)
    assert p["remoteTier"] == "soft_remote"
    assert p["distanceSurcharge"] == 25.0
    assert p["customerTotal"] == 224.0
    assert p["manualReview"] is False


def test_soft_remote_min_floor_at_150km():
    """150 km → 50 extra × €0.35 = €17.5 → floored to €25."""
    p = calculate_projection(base_price=199, distance_km=150)
    assert p["remoteTier"] == "soft_remote"
    assert p["distanceSurcharge"] == 25.0


# ── Standard remote (151–250 km) ─────────────────────────────────────
def test_standard_remote_220km_exact_match_to_spec():
    """The spec's canonical example: 220 km → €54 surcharge → €253 total."""
    p = calculate_projection(base_price=199, distance_km=220)
    assert p["remoteTier"] == "standard_remote"
    assert p["extraKm"] == 120.0
    assert p["distanceRate"] == 0.45
    assert p["distanceSurcharge"] == 54.0
    assert p["customerTotal"] == 253.0
    assert p["manualReview"] is False


def test_standard_remote_min_floor_at_151km():
    """151 km → 51 extra × €0.45 = €22.95 → floored to €50."""
    p = calculate_projection(base_price=199, distance_km=151)
    assert p["remoteTier"] == "standard_remote"
    assert p["distanceSurcharge"] == 50.0


def test_standard_remote_top_boundary_250km():
    """250 km → 150 extra × €0.45 = €67.5 → rounded to €68."""
    p = calculate_projection(base_price=199, distance_km=250)
    assert p["remoteTier"] == "standard_remote"
    assert p["distanceSurcharge"] == 68.0


# ── Far remote (251+ km) ─────────────────────────────────────────────
def test_far_remote_300km_with_manual_review():
    """300 km → 200 extra × €0.60 = €120 (exactly at minimum)."""
    p = calculate_projection(base_price=199, distance_km=300)
    assert p["remoteTier"] == "far_remote"
    assert p["distanceSurcharge"] == 120.0
    assert p["customerTotal"] == 319.0
    assert p["manualReview"] is True


def test_far_remote_min_floor_at_251km():
    """251 km → 151 extra × €0.60 = €90.6 → floored to €120 minimum fee."""
    p = calculate_projection(base_price=199, distance_km=251)
    assert p["distanceSurcharge"] == 120.0
    assert p["manualReview"] is True


# ── Payout split (85/15) ─────────────────────────────────────────────
def test_payout_split_85_15():
    """€54 surcharge → €45.9 inspector + €8.1 platform (no rounding drift)."""
    p = calculate_projection(base_price=199, distance_km=220)
    assert p["distanceSurcharge"] == 54.0
    assert p["inspectorDistancePayout"] == 45.9
    assert p["platformDistanceFee"] == 8.1
    # sum must equal surcharge (no rounding loss)
    assert (
        p["inspectorDistancePayout"] + p["platformDistanceFee"]
        == pytest.approx(p["distanceSurcharge"])
    )


def test_payout_zero_when_included():
    p = calculate_projection(base_price=199, distance_km=50)
    assert p["inspectorDistancePayout"] == 0
    assert p["platformDistanceFee"] == 0


# ── Determinism ──────────────────────────────────────────────────────
def test_deterministic_same_inputs_same_output():
    """Same inputs MUST yield identical projection — quotes never drift."""
    a = calculate_projection(base_price=199, distance_km=220)
    b = calculate_projection(base_price=199, distance_km=220)
    assert a == b


# ── Geo-based input ──────────────────────────────────────────────────
def test_haversine_berlin_to_munich():
    """Berlin (52.52, 13.405) → Munich (48.1351, 11.582) ≈ 504 km."""
    d = haversine_km((52.52, 13.405), (48.1351, 11.582))
    assert 500 <= d <= 510


def test_geo_projection_attaches_provenance():
    p = calculate_projection_from_geo(
        base_price=199,
        inspector_base=(52.52, 13.405),
        vehicle_location=(48.1351, 11.582),
    )
    assert p["remoteTier"] == "far_remote"
    assert p["manualReview"] is True
    assert p["geo"]["source"] == "haversine"
    assert p["geo"]["from"] == [52.52, 13.405]


# ── Validation ───────────────────────────────────────────────────────
def test_rejects_negative_distance():
    with pytest.raises(ValueError):
        calculate_projection(base_price=199, distance_km=-1)


def test_rejects_negative_base_price():
    with pytest.raises(ValueError):
        calculate_projection(base_price=-1, distance_km=80)


# ── Lifecycle: save / confirm / immutability ──────────────────────────
class _FakeProjectionCollection:
    """Minimal in-memory stand-in for `db.inspection_pricing_projection`.
    Only supports the two methods our projection module touches."""
    def __init__(self):
        self.docs = {}  # jobId → doc

    async def find_one(self, query, projection=None):
        doc = self.docs.get(query.get("jobId"))
        if doc is None:
            return None
        return dict(doc)

    async def update_one(self, query, update, upsert=False):
        from copy import deepcopy
        job_id = query["jobId"]
        existing = self.docs.get(job_id, {})
        new = deepcopy(existing)
        new.update(update.get("$set", {}))
        self.docs[job_id] = new


class _FakeDB:
    def __init__(self):
        self.inspection_pricing_projection = _FakeProjectionCollection()


@pytest.mark.asyncio
async def test_save_creates_pending():
    from app.pricing.projection import save_projection, calculate_projection
    db = _FakeDB()
    proj = calculate_projection(base_price=199, distance_km=220)
    saved = await save_projection(db, job_id="job_a", projection=proj)
    assert saved["status"] == "pending"
    assert saved["jobId"] == "job_a"
    assert saved["distanceSurcharge"] == 54.0


@pytest.mark.asyncio
async def test_save_pending_refreshes_keeps_created_at():
    from app.pricing.projection import save_projection, calculate_projection
    db = _FakeDB()
    first = await save_projection(
        db, job_id="job_b",
        projection=calculate_projection(base_price=199, distance_km=220),
    )
    second = await save_projection(
        db, job_id="job_b",
        projection=calculate_projection(base_price=250, distance_km=180),
    )
    assert second["createdAt"] == first["createdAt"]
    assert second["basePrice"] == 250.0
    assert second["status"] == "pending"


@pytest.mark.asyncio
async def test_confirm_locks_projection():
    from app.pricing.projection import save_projection, confirm_projection, calculate_projection
    db = _FakeDB()
    await save_projection(
        db, job_id="job_c",
        projection=calculate_projection(base_price=199, distance_km=220),
    )
    confirmed = await confirm_projection(db, job_id="job_c", by_user_id="u1")
    assert confirmed is not None
    assert confirmed["status"] == "confirmed"
    assert confirmed["confirmedBy"] == "u1"
    assert "confirmedAt" in confirmed


@pytest.mark.asyncio
async def test_confirm_is_idempotent():
    from app.pricing.projection import save_projection, confirm_projection, calculate_projection
    db = _FakeDB()
    await save_projection(
        db, job_id="job_d",
        projection=calculate_projection(base_price=199, distance_km=220),
    )
    first = await confirm_projection(db, job_id="job_d")
    second = await confirm_projection(db, job_id="job_d")
    assert second["confirmedAt"] == first["confirmedAt"]
    assert second["status"] == "confirmed"


@pytest.mark.asyncio
async def test_confirm_returns_none_for_missing_job():
    from app.pricing.projection import confirm_projection
    db = _FakeDB()
    assert await confirm_projection(db, job_id="ghost") is None


@pytest.mark.asyncio
async def test_save_on_confirmed_is_noop():
    """THE marketplace invariant: once confirmed, the quote is immutable."""
    from app.pricing.projection import save_projection, confirm_projection, calculate_projection
    db = _FakeDB()
    await save_projection(
        db, job_id="job_e",
        projection=calculate_projection(base_price=199, distance_km=220),
    )
    await confirm_projection(db, job_id="job_e")

    # Try to overwrite with a wildly different price after confirmation.
    after = await save_projection(
        db, job_id="job_e",
        projection=calculate_projection(base_price=999, distance_km=300),
    )
    # Returned doc is the ORIGINAL confirmed one — totals unchanged.
    assert after["status"] == "confirmed"
    assert after["basePrice"] == 199.0
    assert after["customerTotal"] == 253.0
    assert after["distanceSurcharge"] == 54.0
