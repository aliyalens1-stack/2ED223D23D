"""Matching-v2 Sprint 2 — frozen dispatch snapshot tests.

Five critical invariants verified:

  1. Idempotency — same jobId always returns the same snapshot doc.
  2. Pricing immutability bridge — changing current pricing version
     does NOT mutate an existing dispatch snapshot.
  3. Density bridge — dispatch density == pricing density (byte-for-byte).
  4. No pending pricing — refuses freeze with PricingNotConfirmedError
     when the pricing projection is missing or not confirmed.
  5. No recompute drift — after topology / provider counts change, a
     second freeze call returns the ORIGINAL snapshot unchanged.
"""
from __future__ import annotations
import os
import sys
import types

import pytest

# ── Break the server.py ↔ app.marketplace.cities circular import ─────
# Existing pricing tests use this same stub. Our test file only needs
# Motor handles, never the FastAPI app.
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.pricing.density_projection import DensitySnapshot  # noqa: E402
from app.pricing.projection_v2 import calculate_projection_v2  # noqa: E402
from app.pricing.projection import save_projection, confirm_projection  # noqa: E402
from app.matching_v2.snapshot import (  # noqa: E402
    PricingNotConfirmedError,
    freeze_dispatch_snapshot,
    get_dispatch_snapshot,
)


pytestmark = pytest.mark.asyncio


# ── Test-DB plumbing ──────────────────────────────────────────────────


def _mongo_url() -> str:
    return os.environ.get("MONGO_URL", "mongodb://localhost:27017")


def _db_name() -> str:
    # Isolate the suite — sprint 2 writes a fresh collection per test.
    return os.environ.get("DB_NAME_TEST", "test_matching_v2_sprint2")


@pytest.fixture
async def db():
    client = AsyncIOMotorClient(_mongo_url())
    database = client[_db_name()]
    # Clean BEFORE each test — sprint 2 must run with a known empty state.
    await database.matching_dispatch_snapshot.delete_many({})
    await database.inspection_pricing_projection.delete_many({})
    try:
        yield database
    finally:
        await database.matching_dispatch_snapshot.delete_many({})
        await database.inspection_pricing_projection.delete_many({})
        client.close()


# ── Helpers ───────────────────────────────────────────────────────────


def _density(tier: str = "low") -> DensitySnapshot:
    return DensitySnapshot(
        cityId="berlin",
        countryCode="DE",
        providers=2,
        partners=3,
        coverageRatio=0.33,
        cityDensity=tier,
        countryDensity=tier,
        effectiveDensity=tier,
        densityMultiplier=1.15 if tier == "low" else 1.0,
        manualReview=tier == "scarce",
        reason="Test fixture",
    )


async def _seed_pricing(
    db,
    job_id: str,
    *,
    confirmed: bool = True,
    density_tier: str = "low",
    distance_km: float = 220.0,
):
    """Insert a v2 pricing projection for `job_id`. Confirmed by default."""
    proj = calculate_projection_v2(
        base_price=199.0,
        distance_km=distance_km,
        density=_density(density_tier),
    )
    saved = await save_projection(db, job_id=job_id, projection=proj)
    if confirmed:
        return await confirm_projection(db, job_id=job_id, by_user_id="test-customer")
    return saved


# ── Invariant 1: idempotency ──────────────────────────────────────────


async def test_freeze_is_idempotent(db):
    job_id = "job-idem-1"
    await _seed_pricing(db, job_id)

    first = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor-a")
    second = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor-b")
    third = await freeze_dispatch_snapshot(db, job_id=job_id, created_by=None)

    assert first == second == third
    # createdBy is locked at first write — second call by another actor
    # MUST NOT overwrite provenance.
    assert first["createdBy"] == "actor-a"
    # Only one row in the collection regardless of how many freezes ran.
    count = await db.matching_dispatch_snapshot.count_documents({"jobId": job_id})
    assert count == 1


# ── Invariant 2: pricing immutability bridge ──────────────────────────


async def test_existing_snapshot_unaffected_by_pricing_version_change(db, monkeypatch):
    job_id = "job-bridge-1"
    await _seed_pricing(db, job_id, density_tier="low")
    first = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")

    # Simulate someone flipping the current pricing version (e.g. v3).
    # Existing snapshot must NOT mutate — it carries pricingVersion=v2.
    from app.pricing import version_registry
    monkeypatch.setattr(version_registry, "current_version", lambda: "v3")

    second = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")
    assert first == second
    assert second["pricingVersion"] == "v2"


# ── Invariant 3: density bridge — byte identical ──────────────────────


@pytest.mark.parametrize("tier,radius,batch,ttl,policy", [
    ("high",   50,   3,  5,    "fast_local"),
    ("medium", 100,  5,  10,   "standard"),
    ("low",    150,  10, 20,   "expanded"),
    ("scarce", None, 0,  None, "concierge"),
])
async def test_density_bridge_byte_identical(db, tier, radius, batch, ttl, policy):
    job_id = f"job-bridge-{tier}"
    pricing = await _seed_pricing(db, job_id, density_tier=tier)
    pricing_density = pricing["densitySnapshot"]["effectiveDensity"]

    snapshot = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")

    # Density text travels verbatim from pricing → dispatch.
    assert snapshot["effectiveDensity"] == pricing_density == tier
    # Locked policy values flow through unchanged.
    assert snapshot["dispatchRadiusKm"] == radius
    assert snapshot["batchSize"] == batch
    assert snapshot["ttlMinutes"] == ttl
    assert snapshot["policy"] == policy
    # Economics bridge fields copied verbatim from pricing.
    assert snapshot["pricingDigest"] == pricing["digest"]
    assert snapshot["pricingConfirmedAt"] == pricing["confirmedAt"]


# ── Invariant 4: no pending pricing — refuses freeze ─────────────────


async def test_refuses_freeze_when_pricing_missing(db):
    with pytest.raises(PricingNotConfirmedError) as ex:
        await freeze_dispatch_snapshot(db, job_id="no-pricing-yet", created_by="actor")
    assert ex.value.code == "PRICING_NOT_CONFIRMED"
    assert ex.value.status is None


async def test_refuses_freeze_when_pricing_pending(db):
    job_id = "job-pending-pricing"
    await _seed_pricing(db, job_id, confirmed=False)
    with pytest.raises(PricingNotConfirmedError) as ex:
        await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")
    assert ex.value.code == "PRICING_NOT_CONFIRMED"
    assert ex.value.status == "pending"


async def test_refuses_freeze_when_pricing_lacks_density_snapshot(db):
    # Simulates a hand-built v1 pricing doc (no density snapshot) being
    # the only pricing for the job. Dispatch must refuse — matching-v2
    # NEVER guesses density.
    job_id = "job-v1-pricing"
    await db.inspection_pricing_projection.insert_one({
        "jobId": job_id,
        "pricingVersion": "v1",
        "status": "confirmed",
        "confirmedAt": "2026-05-17T00:00:00+00:00",
        "customerTotal": 199.0,
        # NO densitySnapshot
    })
    with pytest.raises(PricingNotConfirmedError):
        await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")


# ── Invariant 5: no recompute drift after topology change ────────────


async def test_no_recompute_after_topology_change(db):
    """Simulate provider_topology shifting AFTER the snapshot was frozen
    (e.g. providers join Berlin → density would now be 'medium' instead
    of 'low'). A second freeze MUST return the original snapshot.
    """
    job_id = "job-drift-1"
    await _seed_pricing(db, job_id, density_tier="low")
    original = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")
    assert original["effectiveDensity"] == "low"
    assert original["dispatchRadiusKm"] == 150
    assert original["batchSize"] == 10

    # Drop the existing pricing projection and seed a brand-new one with
    # a different density tier. This is the harshest possible drift —
    # both topology AND the pricing doc changed. The dispatch snapshot
    # must STILL be the original one because matching_dispatch_snapshot
    # is the source of truth once frozen.
    await db.inspection_pricing_projection.delete_one({"jobId": job_id})
    await _seed_pricing(db, job_id, density_tier="high")
    after_drift = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")

    assert after_drift == original
    assert after_drift["effectiveDensity"] == "low"
    assert after_drift["dispatchRadiusKm"] == 150


# ── Read helper ──────────────────────────────────────────────────────


async def test_get_dispatch_snapshot_returns_none_when_missing(db):
    assert await get_dispatch_snapshot(db, job_id="never-frozen") is None


async def test_get_dispatch_snapshot_returns_frozen_doc(db):
    job_id = "job-read-1"
    await _seed_pricing(db, job_id)
    frozen = await freeze_dispatch_snapshot(db, job_id=job_id, created_by="actor")
    fetched = await get_dispatch_snapshot(db, job_id=job_id)
    assert fetched == frozen
