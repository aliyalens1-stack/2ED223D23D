"""P0.d — end-to-end acceptance tests.

Proves the central invariant from the sprint brief:

    released / paid / refunded history cannot be silently rewritten

Uses the live backend (supervisor) via the shared conftest fixtures.
Direct Mongo only for seeding fixture rows (separate client bound to
the test event loop, so motor doesn't fight supervisor's loop).
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import pytest
import pytest_asyncio
import httpx
from motor.motor_asyncio import AsyncIOMotorClient


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest_asyncio.fixture
async def db():
    """Function-scoped motor client bound to the test event loop."""
    c = AsyncIOMotorClient(MONGO_URL)
    yield c[DB_NAME]
    c.close()


def _hdr(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


# ──────────────────────────────────────────────────────────────────
# Seeders
# ──────────────────────────────────────────────────────────────────


async def _seed_payout(db, status: str = "pending") -> str:
    pid = f"po_{uuid.uuid4().hex[:12]}"
    await db.payouts.insert_one({
        "id": pid,
        "inspectorId": "test-inspector-1",
        "amount": 100,
        "currency": "EUR",
        "status": status,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    })
    return pid


async def _seed_payment(db, status: str = "paid") -> str:
    pmid = f"sp_{uuid.uuid4().hex[:12]}"
    await db.service_payments.insert_one({
        "id": pmid,
        "requestId": "req-test-1",
        "customerId": "cust-test-1",
        "providerId": "prov-test-1",
        "grossAmount": 250,
        "commissionPct": 12,
        "commissionAmount": 30,
        "providerPayout": 220,
        "currency": "EUR",
        "status": status,
        "createdAt": _now_iso(),
        "updatedAt": _now_iso(),
    })
    return pmid


async def _seed_review(db, rating: int = 5) -> str:
    rid = f"rv_{uuid.uuid4().hex[:12]}"
    await db.provider_reviews.insert_one({
        "id": rid,
        "providerId": "prov-test-rev",
        "customerId": "cust-test-rev",
        "requestId": "req-test-rev",
        "rating": rating,
        "text": "Test review for P0.d",
        "createdAt": _now_iso(),
    })
    return rid


async def _audit_rows(db, entity: str, entity_id: str) -> list:
    return await db.money_audit.find(
        {"entity": entity, "entityId": entity_id},
        {"_id": 0},
    ).sort("timestamp", -1).to_list(50)


# ══════════════════════════════════════════════════════════════════
# 1. PAYOUT FSM — happy paths
# ══════════════════════════════════════════════════════════════════


async def test_payout_happy_path_pending_to_processing(client, admin_token, db):
    pid = await _seed_payout(db, status="pending")

    r = await client.post(f"/api/admin/payouts/{pid}/approve", json={"reason": "ok"}, headers=_hdr(admin_token))
    assert r.status_code == 200, r.text
    assert r.json()["payout"]["status"] == "approved"

    r = await client.post(f"/api/admin/payouts/{pid}/process", json={"reason": "queue"}, headers=_hdr(admin_token))
    assert r.status_code == 200, r.text
    assert r.json()["payout"]["status"] == "processing"

    rows = await _audit_rows(db, "payout", pid)
    actions = [r["action"] for r in rows]
    assert "approve" in actions and "process" in actions
    for row in rows:
        assert row["actorRole"] == "admin"
        assert row["entity"] == "payout"


async def test_payout_hold_and_unhold(client, admin_token, db):
    pid = await _seed_payout(db, status="pending")
    await client.post(f"/api/admin/payouts/{pid}/approve", json={"reason": "ok"}, headers=_hdr(admin_token))

    r = await client.post(f"/api/admin/payouts/{pid}/hold", json={"reason": "verify bank"}, headers=_hdr(admin_token))
    assert r.status_code == 200
    assert r.json()["payout"]["status"] == "hold"

    r = await client.post(f"/api/admin/payouts/{pid}/approve", json={"reason": "bank ok"}, headers=_hdr(admin_token))
    assert r.status_code == 200
    assert r.json()["payout"]["status"] == "approved"


# ══════════════════════════════════════════════════════════════════
# 2. PAYOUT FSM — invariant: terminal protection
# ══════════════════════════════════════════════════════════════════


async def test_payout_paid_is_terminal_rejects_all(client, admin_token, db):
    pid = await _seed_payout(db, status="paid")
    for action in ("approve", "hold", "process"):
        r = await client.post(f"/api/admin/payouts/{pid}/{action}", json={"reason": "x"}, headers=_hdr(admin_token))
        assert r.status_code == 409, f"{action}: {r.status_code}/{r.text}"

    rows = await _audit_rows(db, "payout", pid)
    rejected = [r["action"] for r in rows if r["action"].endswith(":rejected")]
    assert "approve:rejected" in rejected
    assert "hold:rejected" in rejected
    assert "process:rejected" in rejected

    doc = await db.payouts.find_one({"id": pid}, {"_id": 0, "status": 1})
    assert doc["status"] == "paid"


async def test_payout_failed_is_terminal_rejects_all(client, admin_token, db):
    pid = await _seed_payout(db, status="failed")
    for action in ("approve", "hold", "process"):
        r = await client.post(f"/api/admin/payouts/{pid}/{action}", json={"reason": "x"}, headers=_hdr(admin_token))
        assert r.status_code == 409

    doc = await db.payouts.find_one({"id": pid}, {"_id": 0, "status": 1})
    assert doc["status"] == "failed"


async def test_payout_process_only_from_approved(client, admin_token, db):
    pid = await _seed_payout(db, status="pending")
    r = await client.post(f"/api/admin/payouts/{pid}/process", json={"reason": "x"}, headers=_hdr(admin_token))
    assert r.status_code == 409

    pid_hold = await _seed_payout(db, status="hold")
    r = await client.post(f"/api/admin/payouts/{pid_hold}/process", json={"reason": "x"}, headers=_hdr(admin_token))
    assert r.status_code == 409


# ══════════════════════════════════════════════════════════════════
# 3. PAYMENT — refund + retry + immutability of refunded
# ══════════════════════════════════════════════════════════════════


async def test_payment_refund_from_paid_writes_audit(client, admin_token, db):
    pmid = await _seed_payment(db, status="paid")
    r = await client.post(
        f"/api/admin/payments/{pmid}/refund",
        json={"reason": "customer complaint", "note": "verified by support"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200, r.text
    assert r.json()["payment"]["status"] == "refunded"

    rows = await _audit_rows(db, "payment", pmid)
    assert any(r["action"] == "refund" and r["toStatus"] == "refunded" for r in rows)


async def test_critical_invariant_refunded_history_cannot_be_silently_rewritten(client, admin_token, db):
    """THE P0 acceptance test."""
    pmid = await _seed_payment(db, status="paid")
    # First refund — succeeds.
    r = await client.post(f"/api/admin/payments/{pmid}/refund", json={"reason": "1st"}, headers=_hdr(admin_token))
    assert r.status_code == 200, r.text
    snap1 = await db.service_payments.find_one({"id": pmid}, {"_id": 0})
    assert snap1["status"] == "refunded"
    assert snap1["refundReason"] == "1st"
    refunded_at = snap1["refundedAt"]

    # Second refund — must be rejected.
    r = await client.post(
        f"/api/admin/payments/{pmid}/refund",
        json={"reason": "covert rewrite attempt"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409, r.text

    # On-disk doc must be byte-identical (no rewrite).
    snap2 = await db.service_payments.find_one({"id": pmid}, {"_id": 0})
    assert snap2["status"] == "refunded"
    assert snap2["refundReason"] == "1st", "refundReason was silently rewritten!"
    assert snap2["refundedAt"] == refunded_at, "refundedAt was silently rewritten!"

    # Rejected audit row was written.
    rows = await _audit_rows(db, "payment", pmid)
    rejected = [r for r in rows if r["action"] == "refund:rejected"]
    assert len(rejected) == 1
    assert rejected[0]["meta"]["reason"] == "covert rewrite attempt"
    assert rejected[0]["fromStatus"] == "refunded"


async def test_payment_refund_rejected_from_pending(client, admin_token, db):
    pmid = await _seed_payment(db, status="pending")
    r = await client.post(f"/api/admin/payments/{pmid}/refund", json={"reason": "x"}, headers=_hdr(admin_token))
    assert r.status_code == 409

    rows = await _audit_rows(db, "payment", pmid)
    assert any(r["action"] == "refund:rejected" for r in rows)


async def test_payment_retry_only_from_failed(client, admin_token, db):
    pmid = await _seed_payment(db, status="failed")
    r = await client.post(f"/api/admin/payments/{pmid}/retry", json={"reason": "bank ok"}, headers=_hdr(admin_token))
    assert r.status_code == 200, r.text
    assert r.json()["payment"]["status"] == "pending"

    pmid2 = await _seed_payment(db, status="paid")
    r = await client.post(f"/api/admin/payments/{pmid2}/retry", json={"reason": "x"}, headers=_hdr(admin_token))
    assert r.status_code == 409


# ══════════════════════════════════════════════════════════════════
# 4. REVIEWS — flag / restore / exclude-rating
# ══════════════════════════════════════════════════════════════════


async def test_review_flag_and_restore_writes_audit(client, admin_token, db):
    rid = await _seed_review(db, rating=1)

    r = await client.post(f"/api/admin/reviews-mod/{rid}/flag", json={"reason": "spam"}, headers=_hdr(admin_token))
    assert r.status_code == 200
    assert r.json()["review"]["moderation"] == "flagged"

    r = await client.post(f"/api/admin/reviews-mod/{rid}/flag", json={"reason": "again"}, headers=_hdr(admin_token))
    assert r.status_code == 409

    r = await client.post(f"/api/admin/reviews-mod/{rid}/restore", json={"reason": "false alarm"}, headers=_hdr(admin_token))
    assert r.status_code == 200
    assert r.json()["review"]["moderation"] == "visible"

    rows = await _audit_rows(db, "review", rid)
    actions = [r["action"] for r in rows]
    assert "flag" in actions and "restore" in actions


async def test_review_exclude_rating_toggle(client, admin_token, db):
    rid = await _seed_review(db, rating=5)

    r = await client.post(
        f"/api/admin/reviews-mod/{rid}/exclude-rating",
        json={"exclude": True, "reason": "fake review evidence"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["review"]["excludeFromRating"] is True

    r = await client.post(
        f"/api/admin/reviews-mod/{rid}/exclude-rating",
        json={"exclude": True, "reason": "again"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 409

    r = await client.post(
        f"/api/admin/reviews-mod/{rid}/exclude-rating",
        json={"exclude": False, "reason": "re-included"},
        headers=_hdr(admin_token),
    )
    assert r.status_code == 200
    assert r.json()["review"]["excludeFromRating"] is False


# ══════════════════════════════════════════════════════════════════
# 5. money_audit — universal contract
# ══════════════════════════════════════════════════════════════════


async def test_money_audit_carries_actor_action_meta_timestamp(client, admin_token, db):
    pid = await _seed_payout(db, status="pending")
    await client.post(f"/api/admin/payouts/{pid}/approve", json={"reason": "spot check"}, headers=_hdr(admin_token))

    rows = await _audit_rows(db, "payout", pid)
    row = next(r for r in rows if r["action"] == "approve")
    assert row["actorId"]
    assert row["action"] == "approve"
    assert "timestamp" in row
    assert row["fromStatus"] == "pending"
    assert row["toStatus"] == "approved"
    assert row["meta"]["amount"] == 100
    assert row["meta"]["currency"] == "EUR"
