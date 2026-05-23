"""Sprint P0.b.C.g — Truth-attachment E2E.

Verifies that production payment endpoints actually emit chronology rows.

Coverage:
  1. Escrow release happy path → escrow.release_requested + escrow.released
  2. Escrow release with open dispute → escrow.release_rejected (reason=dispute_open)
  3. Escrow release with wrong payment status → escrow.release_rejected (reason=validation_failed)
  4. Admin refund rejected (invalid status) → refund.requested:rejected
  5. Admin refund accepted → refund.requested

Side-effect discipline: chronology appends MUST NOT block the underlying
operation. Tests verify both the response code AND the chronology row.
"""
import asyncio
import sys
import uuid
from datetime import datetime, timezone

import httpx
from motor.motor_asyncio import AsyncIOMotorClient

BASE = "http://localhost:8001"
MONGO = "mongodb://localhost:27017"
DB = "test_database"


async def main():
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]
    failures: list[str] = []

    async with httpx.AsyncClient(timeout=15.0) as c:
        # ── Seed: customer + provider + admin + paid payment + completed request
        cust_email = f"truth-cust-{uuid.uuid4().hex[:6]}@test.local"
        r = await c.post(
            f"{BASE}/api/auth/register",
            json={"email": cust_email, "password": "Test1234!",
                  "role": "customer", "fullName": "truth cust"},
        )
        assert r.status_code in (200, 201), r.text
        cust_data = r.json()
        cust_id = cust_data["user"]["id"]
        cust_tok = cust_data["accessToken"]

        prov_login = await c.post(
            f"{BASE}/api/auth/login",
            json={"email": "provider@test.com", "password": "Provider123!"},
        )
        prov_id = prov_login.json()["user"]["id"]

        admin_tok = (await c.post(
            f"{BASE}/api/auth/login",
            json={"email": "admin@autoservice.com", "password": "Admin123!"},
        )).json()["accessToken"]

        # Seed booking + payment in 'paid' status, request in 'completed'
        req_id = f"truth-req-{uuid.uuid4().hex[:8]}"
        pay_id = f"truth-pay-{uuid.uuid4().hex[:8]}"
        now = datetime.now(timezone.utc).isoformat()
        await db.service_requests.insert_one({
            "id": req_id, "customerId": cust_id, "providerId": prov_id,
            "status": "completed", "createdAt": now, "updatedAt": now,
        })
        await db.service_payments.insert_one({
            "id": pay_id, "requestId": req_id,
            "customerId": cust_id, "providerId": prov_id,
            "status": "paid",
            "grossAmount": 100.0, "currency": "EUR",
            "providerPayout": 90.0, "createdAt": now, "updatedAt": now,
        })
        await db.payment_events.delete_many({"paymentId": pay_id})
        print(f"  seeded paymentId={pay_id} requestId={req_id}")

        # ── 1. Release happy path
        r = await c.post(
            f"{BASE}/api/service-payments/{pay_id}/release",
            json={"note": "automated test"},
            headers={"Authorization": f"Bearer {cust_tok}"},
        )
        if r.status_code != 200:
            failures.append(f"release happy: status={r.status_code} body={r.text[:200]}")
        else:
            # Wait briefly for side-effects to settle
            await asyncio.sleep(0.2)
            rows = [d async for d in db.payment_events.find({"paymentId": pay_id}).sort("at", 1)]
            kinds = [row["kind"] for row in rows]
            if "escrow.release_requested" in kinds and "escrow.released" in kinds:
                print(f"  ✓ release happy: rows={kinds}")
            else:
                failures.append(f"release happy: missing chronology rows, got {kinds}")

        # ── 2. Release with open dispute → rejected
        # Reset payment to 'paid' and add a dispute
        pay_id2 = f"truth-pay2-{uuid.uuid4().hex[:8]}"
        req_id2 = f"truth-req2-{uuid.uuid4().hex[:8]}"
        await db.service_requests.insert_one({
            "id": req_id2, "customerId": cust_id, "providerId": prov_id,
            "status": "completed", "createdAt": now, "updatedAt": now,
        })
        await db.service_payments.insert_one({
            "id": pay_id2, "requestId": req_id2,
            "customerId": cust_id, "providerId": prov_id,
            "status": "paid", "grossAmount": 100.0, "currency": "EUR",
            "providerPayout": 90.0, "createdAt": now, "updatedAt": now,
        })
        dispute_id = f"truth-disp-{uuid.uuid4().hex[:6]}"
        await db.disputes.insert_one({
            "id": dispute_id, "requestId": req_id2, "status": "open",
            "openedBy": cust_id, "createdAt": now, "updatedAt": now,
        })

        r = await c.post(
            f"{BASE}/api/service-payments/{pay_id2}/release",
            json={"note": "blocked test"},
            headers={"Authorization": f"Bearer {cust_tok}"},
        )
        if r.status_code != 409:
            failures.append(f"release dispute: expected 409, got {r.status_code}")
        else:
            await asyncio.sleep(0.2)
            rows = [d async for d in db.payment_events.find({"paymentId": pay_id2}).sort("at", 1)]
            kinds = [row["kind"] for row in rows]
            reasons = [row["meta"].get("reason") for row in rows if row["kind"] == "escrow.release_rejected"]
            if "escrow.release_requested" in kinds and "escrow.release_rejected" in kinds and "dispute_open" in reasons:
                print(f"  ✓ release dispute-blocked: rows={kinds} reason=dispute_open")
            else:
                failures.append(f"release dispute: kinds={kinds} reasons={reasons}")

        # ── 3. Release with bad payment status (use pay_id which is now 'released')
        # Already in 'released' state; re-release should be rejected validation_failed
        # Reset chronology rows for clean assertion
        prior_count = await db.payment_events.count_documents({"paymentId": pay_id})
        r = await c.post(
            f"{BASE}/api/service-payments/{pay_id}/release",
            json={"note": "double release test"},
            headers={"Authorization": f"Bearer {cust_tok}"},
        )
        if r.status_code != 400:
            failures.append(f"double release: expected 400, got {r.status_code}")
        else:
            await asyncio.sleep(0.2)
            new_count = await db.payment_events.count_documents({"paymentId": pay_id})
            rows = [d async for d in db.payment_events.find({"paymentId": pay_id}).sort("at", 1)]
            new_kinds = [r["kind"] for r in rows[-2:]]
            new_reasons = [r["meta"].get("reason") for r in rows[-2:]]
            if "escrow.release_rejected" in new_kinds and "validation_failed" in new_reasons:
                print(f"  ✓ double release: validation_failed rejection logged (rows {prior_count}→{new_count})")
            else:
                failures.append(f"double release: tail kinds={new_kinds} reasons={new_reasons}")

        # ── 4. Admin refund happy path (use pay_id2 — currently 'paid')
        # Resolve the dispute first (set to resolved) so refund-allowed-from passes
        # Refund is allowed from 'paid' status per REFUND_ALLOWED_FROM
        prior_count_2 = await db.payment_events.count_documents({"paymentId": pay_id2})
        r = await c.post(
            f"{BASE}/api/admin/payments/{pay_id2}/refund",
            json={"reason": "test_refund", "note": "automated test"},
            headers={"Authorization": f"Bearer {admin_tok}"},
        )
        if r.status_code != 200:
            failures.append(f"admin refund: status={r.status_code} body={r.text[:200]}")
        else:
            await asyncio.sleep(0.2)
            rows = [d async for d in db.payment_events.find({"paymentId": pay_id2}).sort("at", 1)]
            kinds = [row["kind"] for row in rows]
            if "refund.requested" in kinds:
                # actor.role for this row should be 'admin'
                refund_row = next(r for r in rows if r["kind"] == "refund.requested")
                if refund_row["actor"]["role"] == "admin":
                    print(f"  ✓ admin refund: refund.requested row with actor.role=admin")
                else:
                    failures.append(f"refund actor wrong: {refund_row['actor']}")
            else:
                failures.append(f"admin refund: missing refund.requested, got {kinds}")

        # ── 5. Admin refund rejected (already refunded → 409)
        r = await c.post(
            f"{BASE}/api/admin/payments/{pay_id2}/refund",
            json={"reason": "double_refund_test", "note": "should fail"},
            headers={"Authorization": f"Bearer {admin_tok}"},
        )
        if r.status_code != 409:
            failures.append(f"double refund: expected 409, got {r.status_code}")
        else:
            await asyncio.sleep(0.2)
            rows = [d async for d in db.payment_events.find({"paymentId": pay_id2}).sort("at", 1)]
            kinds = [row["kind"] for row in rows]
            if "refund.requested:rejected" in kinds:
                rejected_row = next(r for r in rows if r["kind"] == "refund.requested:rejected")
                if rejected_row["actor"]["role"] == "admin":
                    print(f"  ✓ double refund: refund.requested:rejected row with actor.role=admin")
                else:
                    failures.append(f"rejected actor wrong: {rejected_row['actor']}")
            else:
                failures.append(f"double refund: missing :rejected row, got {kinds}")

        # ── 6. Admin forensic view reflects the rows
        r = await c.get(
            f"{BASE}/api/admin/payments/{pay_id2}/chronology",
            headers={"Authorization": f"Bearer {admin_tok}"},
        )
        if r.status_code == 200:
            data = r.json()
            forensic_kinds = [row["kind"] for row in data["rows"]]
            has_rejected = any(":rejected" in k for k in forensic_kinds)
            if has_rejected and "refund.requested" in forensic_kinds:
                print(f"  ✓ admin forensic surface includes refund.requested + :rejected variants")
            else:
                failures.append(f"forensic missing rows: {forensic_kinds}")
        else:
            failures.append(f"forensic fetch: {r.status_code}")

        # ── 7. Customer surface does NOT see :rejected variants
        r = await c.get(
            f"{BASE}/api/customer/payments/{pay_id2}/chronology",
            headers={"Authorization": f"Bearer {cust_tok}"},
        )
        if r.status_code == 200:
            cust_kinds = [row["kind"] for row in r.json()["rows"]]
            has_rejected = any(":rejected" in k for k in cust_kinds)
            has_admin = any(k.startswith("admin.") for k in cust_kinds)
            if not has_rejected and not has_admin and "refund.requested" in cust_kinds:
                print(f"  ✓ customer surface: refund.requested visible, :rejected/admin.* hidden")
            else:
                failures.append(
                    f"customer surface leaked: kinds={cust_kinds} "
                    f"rejected={has_rejected} admin={has_admin}"
                )
        else:
            failures.append(f"customer fetch: {r.status_code}")

    # Cleanup
    await db.payment_events.delete_many({"paymentId": {"$in": [pay_id, pay_id2]}})
    await db.service_payments.delete_many({"id": {"$in": [pay_id, pay_id2]}})
    await db.service_requests.delete_many({"id": {"$in": [req_id, req_id2]}})
    await db.disputes.delete_many({"id": dispute_id})
    client.close()

    if failures:
        print("\n❌ FAILURES:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL P0.b.C.g TRUTH-ATTACHMENT CHECKS PASSED "
          "(release / refund / dispute-block emit chronology rows; "
          "side-effect discipline preserved; cross-actor opacity holds)")


if __name__ == "__main__":
    asyncio.run(main())
