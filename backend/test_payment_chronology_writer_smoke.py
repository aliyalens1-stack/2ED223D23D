"""Sprint P0.b.C.f — F.2: payment_events writer smoke test.

Verifies the frozen contract from /app/memory/P0bCf_F1_taxonomy_frozen_2026_02_22.md:

  - 19 kinds in the closed set (no drift)
  - Writer rejects unknown kinds with ValueError
  - Writer rejects unknown actor_role with ValueError
  - Writer rejects empty payment_id / actor_id
  - Insert is true append-only (multiple rows for same kind allowed; row.id unique)
  - Schema shape matches frozen contract
  - Indexes exist after ensure_indexes
  - No update/delete methods on the writer's public API
  - meta is loose (no whitelist enforced at writer level — that's projector's job)

Run: python /app/backend/test_payment_chronology_writer_smoke.py
"""
import asyncio
import sys
from datetime import datetime

from motor.motor_asyncio import AsyncIOMotorClient

from app.payments.chronology import writer as W


MONGO = "mongodb://localhost:27017"
DB = "test_database_payment_chronology"  # isolated test DB


async def main():
    failures: list[str] = []

    # Fresh isolated DB
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]
    await db.payment_events.drop()

    # ── 1. Frozen kind count
    if len(W.KINDS) == 19:
        print(f"  ✓ KINDS frozen at 19 literals")
    else:
        failures.append(f"KINDS drift: {len(W.KINDS)} (expected 19)")

    expected_kinds = {
        "payment.initiated", "payment.failed",
        "escrow.held", "escrow.release_requested", "escrow.release_rejected",
        "escrow.released",
        "refund.requested", "refund.requested:rejected",
        "refund.succeeded", "refund.failed",
        "dispute.linked", "dispute.resolved",
        "transfer.initiated", "transfer.succeeded", "transfer.failed",
        "admin.freeze.applied", "admin.freeze.lifted",
        "admin.force_release", "admin.force_release:rejected",
    }
    if W.KINDS == expected_kinds:
        print(f"  ✓ KINDS literal set matches F.1 taxonomy exactly")
    else:
        diff = (expected_kinds ^ W.KINDS)
        failures.append(f"KINDS literal mismatch: symmetric_diff={diff}")

    # ── 2. Indexes
    await W.ensure_indexes(db)
    idx_names = {idx["name"] async for idx in db.payment_events.list_indexes()}
    expected_idx = {
        "payment_chronology", "kind_history", "actor_history", "row_id_unique"
    }
    if expected_idx.issubset(idx_names):
        print(f"  ✓ indexes ensured: {sorted(expected_idx)}")
    else:
        failures.append(f"missing indexes: have={idx_names} expected⊇{expected_idx}")

    # ── 3. Happy-path insert (platform-initiated)
    doc1 = await W.append_payment_event(
        db,
        payment_id="pay-test-001",
        kind="payment.initiated",
        actor_id="platform",
        actor_role="platform",
        meta={"amount": 20000, "currency": "EUR"},
    )
    checks = [
        ("has id", "id" in doc1 and len(doc1["id"]) == 32),
        ("paymentId", doc1["paymentId"] == "pay-test-001"),
        ("kind", doc1["kind"] == "payment.initiated"),
        ("schemaVersion", doc1["schemaVersion"] == 1),
        ("actor", doc1["actor"] == {"id": "platform", "role": "platform"}),
        ("at is iso", isinstance(doc1["at"], str) and "T" in doc1["at"]),
        ("meta preserved", doc1["meta"] == {"amount": 20000, "currency": "EUR"}),
        ("sourceWebhookId null", doc1["sourceWebhookId"] is None),
        ("no _id in returned doc", "_id" not in doc1),
    ]
    for label, ok in checks:
        if not ok:
            failures.append(f"happy insert: {label} failed (doc={doc1})")
    if all(ok for _, ok in checks):
        print(f"  ✓ happy insert (platform actor, payment.initiated)")

    # ── 4. Webhook-translated insert
    doc2 = await W.append_payment_event(
        db,
        payment_id="pay-test-001",
        kind="escrow.held",
        actor_id="stripe",
        actor_role="stripe",
        meta={"amount": 20000, "currency": "EUR"},
        source_webhook_id="evt_stripe_abc123",
    )
    if doc2["sourceWebhookId"] == "evt_stripe_abc123" and doc2["actor"]["role"] == "stripe":
        print(f"  ✓ webhook-translated insert (stripe actor, escrow.held + sourceWebhookId)")
    else:
        failures.append(f"webhook insert wrong: {doc2}")

    # ── 5. Append-only: multiple rows of the same kind allowed
    doc3 = await W.append_payment_event(
        db, payment_id="pay-test-001", kind="escrow.release_requested",
        actor_id="customer-xyz", actor_role="customer",
    )
    doc4 = await W.append_payment_event(
        db, payment_id="pay-test-001", kind="escrow.release_rejected",
        actor_id="platform", actor_role="platform",
        meta={"reason": "dispute_open"},
    )
    doc5 = await W.append_payment_event(
        db, payment_id="pay-test-001", kind="escrow.release_requested",
        actor_id="customer-xyz", actor_role="customer",
    )  # second retry — also allowed
    cnt = await db.payment_events.count_documents({"paymentId": "pay-test-001"})
    if cnt == 5:
        print(f"  ✓ append-only: 5 rows accumulated for same paymentId (no overwrite)")
    else:
        failures.append(f"append-only broken: count={cnt}")

    # All 5 ids unique
    ids = {d["id"] async for d in db.payment_events.find({"paymentId": "pay-test-001"})}
    if len(ids) == 5:
        print(f"  ✓ all 5 row ids unique")
    else:
        failures.append(f"id uniqueness broken: {ids}")

    # ── 6. Closed-set rejection: unknown kind → ValueError
    try:
        await W.append_payment_event(
            db, payment_id="pay-x", kind="not_a_real_kind",
            actor_id="a", actor_role="platform",
        )
        failures.append("expected ValueError for unknown kind, none raised")
    except ValueError as e:
        if "Unknown payment_events kind" in str(e):
            print(f"  ✓ unknown kind → ValueError ('{e!s:.60}...')")
        else:
            failures.append(f"wrong ValueError message: {e}")

    # ── 7. Closed-set rejection: unknown actor_role
    try:
        await W.append_payment_event(
            db, payment_id="pay-x", kind="payment.initiated",
            actor_id="a", actor_role="hacker_role",
        )
        failures.append("expected ValueError for unknown actor_role, none raised")
    except ValueError as e:
        if "Unknown actor_role" in str(e):
            print(f"  ✓ unknown actor_role → ValueError")
        else:
            failures.append(f"wrong actor_role error: {e}")

    # ── 8. Empty payment_id / actor_id rejected
    for bad_kwargs, label in [
        ({"payment_id": "", "actor_id": "a"}, "empty payment_id"),
        ({"payment_id": "p", "actor_id": ""}, "empty actor_id"),
    ]:
        try:
            await W.append_payment_event(
                db, kind="payment.initiated", actor_role="platform",
                **bad_kwargs,
            )
            failures.append(f"expected ValueError for {label}")
        except ValueError:
            print(f"  ✓ {label} → ValueError")

    # ── 9. Writer module exposes NO update/delete entry-points
    public_callables = {
        name for name in dir(W)
        if not name.startswith("_") and callable(getattr(W, name))
    }
    forbidden = {"update_payment_event", "delete_payment_event",
                 "replace_payment_event", "modify_payment_event"}
    leaked = forbidden & public_callables
    if not leaked:
        print(f"  ✓ writer exposes no mutation entry-points "
              f"(no update/delete/replace functions)")
    else:
        failures.append(f"mutation API leak: {leaked}")

    # ── 10. unique row_id index actually enforces uniqueness
    try:
        await db.payment_events.insert_one({
            "id": doc1["id"],  # duplicate of doc1's id
            "paymentId": "pay-x", "kind": "payment.initiated",
            "at": doc1["at"], "actor": {"id": "x", "role": "platform"},
            "meta": {}, "sourceWebhookId": None, "schemaVersion": 1,
        })
        failures.append("duplicate row id was accepted (unique index broken)")
    except Exception:
        print(f"  ✓ row_id uniqueness enforced by index")

    # ── 11. Independence from money_audit and stripe_webhook_events
    ma_count = await db.money_audit.count_documents({})
    swe_count = await db.stripe_webhook_events.count_documents({})
    if ma_count == 0 and swe_count == 0:
        print(f"  ✓ no leakage into money_audit / stripe_webhook_events "
              f"(both untouched, count=0)")
    else:
        failures.append(
            f"leakage: money_audit={ma_count}, stripe_webhook_events={swe_count}"
        )

    # Cleanup
    await db.payment_events.drop()
    client.close()

    if failures:
        print("\n❌ FAILURES:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL P0.b.C.f F.2 WRITER CHECKS PASSED "
          "(19 kinds frozen · append-only · closed-set · independent collection)")


if __name__ == "__main__":
    asyncio.run(main())
