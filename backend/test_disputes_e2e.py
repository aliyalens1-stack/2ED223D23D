"""E2E smoke test for Sprint 6 — Disputes & Resolution Layer.

Flow tested:
    1. Setup customer + provider + admin
    2. Create paid service_request + payment in escrow
    3. Customer opens dispute
    4. Verify request.status='disputed', payment.status='disputed'
    5. Verify release endpoint blocked (409)
    6. Verify duplicate open returns alreadyOpen=true (idempotent)
    7. Admin tries each resolution action:
        a. release_to_provider → payment.status='released', request.status='released'
        b. partial_refund 30%   → split payout/refund
        c. full_refund          → payment.status='refunded', request.status='cancelled'

Run: python /app/backend/test_disputes_e2e.py
"""
import asyncio
import sys
import uuid

import httpx
import bcrypt
from motor.motor_asyncio import AsyncIOMotorClient

BASE = "http://localhost:8001"
MONGO = "mongodb://localhost:27017"
DB = "test_database"


async def make_user(db, role, suffix, extra=None):
    user_id = f"disp-test-{role}-{suffix}"
    pwd_hash = bcrypt.hashpw(b"Test1234!", bcrypt.gensalt()).decode()
    doc = {
        "_id": user_id, "id": user_id,
        "email": f"{user_id}@test.local", "passwordHash": pwd_hash,
        "role": role, "firstName": role.capitalize(), "lastName": "Test",
        "isActive": True, "createdAt": "2026-05-19T22:00:00+00:00",
    }
    if extra:
        doc.update(extra)
    await db.users.delete_one({"_id": user_id})
    await db.users.insert_one(doc)
    return user_id


async def setup_request(db, customer_id, provider_id, suffix):
    """Create a paid service_request + service_payment ready for dispute."""
    request_id = f"disp-test-req-{suffix}"
    payment_id = f"disp-test-pay-{suffix}"
    await db.service_requests.delete_one({"id": request_id})
    await db.service_payments.delete_one({"id": payment_id})
    now = "2026-05-19T22:00:00+00:00"
    await db.service_requests.insert_one({
        "id": request_id,
        "customerId": customer_id, "providerId": provider_id,
        "category": "repair", "title": "Замена тормозных колодок",
        "status": "paid", "amount": 200, "currency": "EUR",
        "createdAt": now, "updatedAt": now,
    })
    await db.service_payments.insert_one({
        "id": payment_id,
        "requestId": request_id,
        "customerId": customer_id, "providerId": provider_id,
        "amount": 200, "currency": "EUR",
        "status": "paid",
        "providerPayout": 180,
        "createdAt": now, "updatedAt": now,
    })
    return request_id, payment_id


async def login(email):
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{BASE}/api/auth/login", json={"email": email, "password": "Test1234!"})
        r.raise_for_status()
        return r.json()["accessToken"]


async def main():
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]

    # ── Setup ────────────────────────────────────────────────────────
    customer_id = await make_user(db, "customer", "1")
    provider_id = await make_user(db, "provider", "1")
    admin_id = await make_user(db, "admin", "1")
    print(f"Users: customer={customer_id} provider={provider_id} admin={admin_id}")

    cust_token = await login(f"{customer_id}@test.local")
    prov_token = await login(f"{provider_id}@test.local")
    admin_token = await login(f"{admin_id}@test.local")
    print("Logged in all 3.")

    async def run_scenario(suffix, resolve_action, expected_payment_status, expected_request_status, partial_pct=None):
        request_id, payment_id = await setup_request(db, customer_id, provider_id, suffix)
        # Cleanup stale disputes from prior runs.
        await db.disputes.delete_many({"requestId": request_id})
        print(f"\n── Scenario: {resolve_action} (req={request_id}) ──")
        async with httpx.AsyncClient() as c:
            # 1. Customer opens dispute
            r = await c.post(
                f"{BASE}/api/disputes",
                headers={"Authorization": f"Bearer {cust_token}"},
                json={"requestId": request_id, "reason": "quality_issue", "description": "Issue: " + suffix},
            )
            assert r.status_code == 200, f"open dispute: {r.status_code} {r.text}"
            dispute = r.json()["dispute"]
            print(f"  ✓ opened dispute id={dispute['id']}")
            assert dispute["status"] == "open"

            # 2. Verify request + payment are frozen
            req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
            pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
            assert req["status"] == "disputed", f"request status: {req['status']}"
            assert pay["status"] == "disputed", f"payment status: {pay['status']}"
            print(f"  ✓ request.status=disputed payment.status=disputed")

            # 3. Duplicate open → alreadyOpen=true
            r = await c.post(
                f"{BASE}/api/disputes",
                headers={"Authorization": f"Bearer {cust_token}"},
                json={"requestId": request_id, "reason": "quality_issue"},
            )
            assert r.status_code == 200 and r.json()["alreadyOpen"] is True
            print(f"  ✓ duplicate open returns alreadyOpen=true")

            # 4. Customer tries release → blocked
            r = await c.post(
                f"{BASE}/api/service-payments/{payment_id}/release",
                headers={"Authorization": f"Bearer {cust_token}"},
                json={"note": "try release"},
            )
            assert r.status_code == 409, f"release should be blocked: {r.status_code}"
            print(f"  ✓ release blocked (409) while dispute open")

            # 5. List my disputes (customer)
            r = await c.get(f"{BASE}/api/disputes/my", headers={"Authorization": f"Bearer {cust_token}"})
            assert r.status_code == 200
            mine = r.json()
            assert any(d["id"] == dispute["id"] for d in mine)
            print(f"  ✓ /disputes/my has {len(mine)} items")

            # 6. Admin sees in queue
            r = await c.get(f"{BASE}/api/admin/disputes", headers={"Authorization": f"Bearer {admin_token}"})
            queue = r.json()
            assert any(d["id"] == dispute["id"] for d in queue["items"])
            print(f"  ✓ admin queue has {queue['stats']['open']} open · {queue['stats']['resolved']} resolved")

            # 7. Admin detail
            r = await c.get(
                f"{BASE}/api/admin/disputes/{dispute['id']}",
                headers={"Authorization": f"Bearer {admin_token}"},
            )
            detail = r.json()
            assert detail["dispute"]["id"] == dispute["id"]
            assert detail["request"] is not None
            assert detail["payment"] is not None
            print(f"  ✓ admin detail loaded (timeline={len(detail['timeline'])} chat={len(detail['chatPreview'])})")

            # 8. Admin resolves
            body = {"action": resolve_action, "adminNote": f"Resolved as {resolve_action}"}
            if partial_pct:
                body["partialRefundPercent"] = partial_pct
            r = await c.post(
                f"{BASE}/api/admin/disputes/{dispute['id']}/resolve",
                headers={"Authorization": f"Bearer {admin_token}"},
                json=body,
            )
            assert r.status_code == 200, f"resolve: {r.status_code} {r.text}"
            res = r.json()
            print(f"  ✓ resolved: payout=€{res['payoutAmount']} refund=€{res['refundAmount']}")

            # 9. Verify final state
            req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
            pay = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
            assert pay["status"] == expected_payment_status, f"final payment.status: {pay['status']} (expected {expected_payment_status})"
            assert req["status"] == expected_request_status, f"final request.status: {req['status']} (expected {expected_request_status})"
            print(f"  ✓ final: payment.status={pay['status']} request.status={req['status']}")

    # ── Scenario A: release_to_provider ──────────────────────────────
    await run_scenario(
        "release", "release_to_provider",
        expected_payment_status="released", expected_request_status="released",
    )

    # ── Scenario B: partial_refund 30% ───────────────────────────────
    await run_scenario(
        "partial", "partial_refund",
        expected_payment_status="resolved_partial", expected_request_status="released",
        partial_pct=30,
    )

    # ── Scenario C: full_refund ──────────────────────────────────────
    await run_scenario(
        "refund", "full_refund",
        expected_payment_status="refunded", expected_request_status="cancelled",
    )

    print("\n✅ ALL SPRINT 6 DISPUTE CHECKS PASSED")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except AssertionError as e:
        print(f"\n❌ FAIL: {e}")
        sys.exit(1)
    except Exception as e:
        print(f"\n💥 ERROR: {e}")
        import traceback; traceback.print_exc()
        sys.exit(1)
