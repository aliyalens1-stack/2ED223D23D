"""Pricing-v2B — freeze-path migration tests.

Guards the migration invariants:

  1. `freeze_for_job` routes by `current_version()` for new/pending docs.
  2. Confirmed v1 quotes stay v1 FOREVER even after `current_version`
     flips to v2.
  3. v2 frozen docs carry the full `densitySnapshot` and the verbatim
     `explanation` array.
  4. Re-freeze on a confirmed doc is a no-op (immutability).
  5. Re-freeze on a pending doc refreshes numbers but keeps version
     consistency with `current_version()`.

These are async tests using the real Motor client against the in-process
mongo (same database as the seed flow). We isolate by writing into a
dedicated collection scope using random job_ids.
"""
from __future__ import annotations
import os
import sys
import types
import uuid

import pytest

_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402
from app.core.context import ctx  # noqa: E402
from app.pricing.freeze import freeze_for_job  # noqa: E402
from app.pricing.projection import (  # noqa: E402
    confirm_projection, get_projection,
)
from app.pricing import version_registry  # noqa: E402


@pytest.fixture
async def db():
    """Real Motor handle. Tests pollute `inspection_pricing_projection`
    only on random ids and clean up after themselves."""
    client = AsyncIOMotorClient(
        os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    )
    handle = client[os.environ.get("DB_NAME", "test_database")]
    ctx.db = handle
    try:
        yield handle
    finally:
        client.close()


@pytest.fixture
def job_id():
    """Unique job id per test to avoid cross-test pollution."""
    return f"v2b-test-{uuid.uuid4().hex[:10]}"


@pytest.fixture(autouse=True)
async def _cleanup(db, job_id):
    yield
    await db.inspection_pricing_projection.delete_many({"jobId": job_id})


# ── Routing tests ────────────────────────────────────────────────────────


class TestFreezeRoutesByVersion:

    async def test_v2_default_writes_density_snapshot(self, db, job_id):
        # current_version == "v2" — locked by version_registry tests.
        doc = await freeze_for_job(
            db, job_id=job_id, base_price=199, city_id="berlin", country_code="DE",
        )
        assert doc["pricingVersion"] == "v2"
        assert doc["status"] == "pending"
        # Density snapshot embedded verbatim — this is the immutability
        # contract that lets quotes stay reproducible forever.
        snap = doc["densitySnapshot"]
        assert snap["cityId"] == "berlin"
        assert snap["countryCode"] == "DE"
        assert snap["densityMultiplier"] in (1.00, 1.05, 1.15, 1.30)
        # Explanation array is frozen text.
        assert isinstance(doc["explanation"], list)
        assert all("label" in e and "amount" in e for e in doc["explanation"])

    async def test_v2_with_inspector_base_and_vehicle(self, db, job_id):
        # 220 km Berlin → Pricing-v2 standard_remote × medium multiplier.
        doc = await freeze_for_job(
            db, job_id=job_id, base_price=199,
            inspector_base=(52.52, 13.40),
            vehicle_location=(53.50, 16.00),  # ~220 km roughly NE
            city_id="berlin", country_code="DE",
        )
        assert doc["pricingVersion"] == "v2"
        assert "densitySnapshot" in doc
        assert doc["densitySnapshot"]["cityId"] == "berlin"
        assert doc["geo"]["source"] == "haversine"
        # Density delta should be > 0 OR multiplier == 1.0 — either way the
        # explanation must have a Base inspection row.
        labels = [e["label"] for e in doc["explanation"]]
        assert any("Base inspection" in lbl for lbl in labels)


# ── Immutability tests ──────────────────────────────────────────────────


class TestImmutability:

    async def test_confirmed_doc_is_locked(self, db, job_id):
        # Freeze under v2, confirm, then re-freeze — confirmed doc must
        # be returned unchanged.
        await freeze_for_job(
            db, job_id=job_id, base_price=199, city_id="berlin", country_code="DE",
        )
        confirmed = await confirm_projection(db, job_id=job_id, by_user_id="u1")
        assert confirmed["status"] == "confirmed"
        assert confirmed["pricingVersion"] == "v2"
        frozen_total = confirmed["customerTotal"]
        frozen_explanation = confirmed.get("explanation")

        # Replay freeze — must return the confirmed doc, unchanged.
        replay = await freeze_for_job(
            db, job_id=job_id, base_price=999,  # different inputs
            city_id="berlin", country_code="DE",
        )
        assert replay["status"] == "confirmed"
        assert replay["customerTotal"] == frozen_total
        assert replay.get("explanation") == frozen_explanation
        assert replay["pricingVersion"] == "v2"

    async def test_v1_confirmed_stays_v1_after_version_flip(self, db, job_id, monkeypatch):
        # Pretend the platform was on v1 when this job was confirmed.
        monkeypatch.setattr(version_registry, "_CURRENT_VERSION", "v1")
        assert version_registry.current_version() == "v1"

        v1_doc = await freeze_for_job(db, job_id=job_id, base_price=199)
        assert v1_doc["pricingVersion"] == "v1"
        confirmed = await confirm_projection(db, job_id=job_id, by_user_id="u1")
        assert confirmed["pricingVersion"] == "v1"
        # v1 docs have NO densitySnapshot / explanation — that's part of
        # the contract.
        assert "densitySnapshot" not in confirmed
        assert "explanation" not in confirmed

        # Flip back to v2 (current default). The confirmed v1 doc must
        # NOT be silently upgraded to v2 on re-freeze.
        monkeypatch.setattr(version_registry, "_CURRENT_VERSION", "v2")
        assert version_registry.current_version() == "v2"

        replay = await freeze_for_job(
            db, job_id=job_id, base_price=199,
            city_id="berlin", country_code="DE",
        )
        assert replay["pricingVersion"] == "v1"  # locked forever
        assert replay["status"] == "confirmed"
        assert "densitySnapshot" not in replay
        assert "explanation" not in replay


# ── Pending refresh tests ───────────────────────────────────────────────


class TestPendingRefresh:

    async def test_pending_v2_can_refresh(self, db, job_id):
        a = await freeze_for_job(
            db, job_id=job_id, base_price=199, city_id="berlin", country_code="DE",
        )
        b = await freeze_for_job(
            db, job_id=job_id, base_price=249, city_id="berlin", country_code="DE",
        )
        # Pending → refresh with new base_price reflected.
        assert a["status"] == "pending"
        assert b["status"] == "pending"
        assert b["basePrice"] == 249.0
        # createdAt preserved.
        assert a["createdAt"] == b["createdAt"]


# ── Explanation snapshot contract ───────────────────────────────────────


class TestExplanationFrozen:

    async def test_explanation_survives_round_trip(self, db, job_id):
        # The exact text of explanation rows must be stored verbatim, so
        # future copy changes don't mutate historical quote semantics.
        a = await freeze_for_job(
            db, job_id=job_id, base_price=199,
            inspector_base=(52.52, 13.40),
            vehicle_location=(53.50, 16.00),
            city_id="berlin", country_code="DE",
        )
        confirmed = await confirm_projection(db, job_id=job_id, by_user_id="u1")
        # Confirmed has the SAME explanation array — confirm doesn't
        # recompute it.
        assert confirmed["explanation"] == a["explanation"]
        # Re-read from disk — still identical.
        fetched = await get_projection(db, job_id=job_id)
        assert fetched["explanation"] == a["explanation"]
