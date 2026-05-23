"""Payments-1 — snapshot-bound checkout gate tests.

The endpoint itself goes through Stripe / mock; here we test the gate
function `_load_confirmed_snapshot` in isolation, since it carries the
critical anti-drift invariant:

  • snapshot missing → 409 PRICING_SNAPSHOT_MISSING
  • confirmedAt missing → 409 PRICING_SNAPSHOT_UNCONFIRMED
  • amount <= 0 → 500 (server-side bug-fence)
  • wrong owner → 403
  • missing request → 404
  • happy path → returns snapshot dict
"""
from __future__ import annotations
import sys
import pytest

sys.path.insert(0, '/app/backend')

from fastapi import HTTPException
from app.payments.snapshot_checkout import _load_confirmed_snapshot


class _Coll:
    def __init__(self, doc=None):
        self._doc = doc

    async def find_one(self, query, projection=None):
        if not self._doc:
            return None
        if self._doc.get("_id") != query.get("_id"):
            return None
        return dict(self._doc)


class _DB:
    def __init__(self, doc=None):
        self.car_requests = _Coll(doc)


@pytest.mark.asyncio
async def test_404_when_request_missing():
    db = _DB(None)
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "missing", "user_a")
    assert ex.value.status_code == 404


@pytest.mark.asyncio
async def test_403_when_owner_mismatch():
    db = _DB({"_id": "r1", "userId": "user_b", "pricing": {"customerTotal": 442, "confirmedAt": "x"}})
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "r1", "user_a")
    assert ex.value.status_code == 403


@pytest.mark.asyncio
async def test_409_when_pricing_field_missing():
    db = _DB({"_id": "r1", "userId": "user_a"})
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "r1", "user_a")
    assert ex.value.status_code == 409
    assert ex.value.detail["code"] == "PRICING_SNAPSHOT_MISSING"


@pytest.mark.asyncio
async def test_409_when_pricing_not_a_dict():
    db = _DB({"_id": "r1", "userId": "user_a", "pricing": "wat"})
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "r1", "user_a")
    assert ex.value.status_code == 409


@pytest.mark.asyncio
async def test_409_when_confirmed_at_missing():
    """The Pricing-2 invariant gate: pending quotes cannot be charged."""
    db = _DB({"_id": "r1", "userId": "user_a", "pricing": {"customerTotal": 442}})
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "r1", "user_a")
    assert ex.value.status_code == 409
    assert ex.value.detail["code"] == "PRICING_SNAPSHOT_UNCONFIRMED"


@pytest.mark.asyncio
async def test_500_when_total_invalid():
    """Server-side bug-fence — confirmed snapshots MUST have a positive total."""
    db = _DB({"_id": "r1", "userId": "user_a",
              "pricing": {"customerTotal": 0, "confirmedAt": "2026-05-16T22:00:00Z"}})
    with pytest.raises(HTTPException) as ex:
        await _load_confirmed_snapshot(db, "r1", "user_a")
    assert ex.value.status_code == 500


@pytest.mark.asyncio
async def test_happy_path_returns_snapshot():
    snap = {
        "pricingVersion": "v1",
        "currency": "EUR",
        "customerTotal": 442.0,
        "confirmedAt": "2026-05-16T22:00:00+00:00",
        "digest": "Berlin: 505 km · far_remote · +€243",
    }
    db = _DB({"_id": "r1", "userId": "user_a", "pricing": snap})
    out = await _load_confirmed_snapshot(db, "r1", "user_a")
    assert out == snap


@pytest.mark.asyncio
async def test_happy_path_when_request_has_no_owner_field():
    """Legacy requests w/o userId are accessible by the asking user
    (back-compat). We do NOT silently deny — we let through."""
    snap = {"customerTotal": 199, "confirmedAt": "x"}
    db = _DB({"_id": "r1", "pricing": snap})
    out = await _load_confirmed_snapshot(db, "r1", "user_a")
    assert out == snap
