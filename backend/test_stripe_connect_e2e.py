"""E2E smoke test for Sprint 7 — Stripe Connect Express (sandbox).

Validates:
    1. Provider onboarding (creates synthetic stripe_account_id)
    2. Customer creates PaymentIntent for service_request
    3. Release flow (admin override skips 12h delay) → Transfer created
    4. Refund via dispute resolution → real refund record on payment
    5. Admin freeze blocks subsequent release
    6. Webhook idempotency: posting same event twice → second is dedup
"""
import asyncio
import json
import sys
import uuid

import bcrypt
import httpx
from motor.motor_asyncio import AsyncIOMotorClient

BASE = "http://localhost:8001"
MONGO = "mongodb://localhost:27017"
DB = "test_database"


async def make_user(db, role, suffix):
    user_id = f"s7-{role}-{suffix}"
    pwd_hash = bcrypt.hashpw(b"Test1234!", bcrypt.gensalt()).decode()
    await db.users.delete_one({"_id": user_id})
    await db.users.insert_one({
        "_id": user_id, "id": user_id,
        "email": f"{user_id}@test.local", "passwordHash": pwd_hash,
        "role": role, "firstName": role.capitalize(),
        "isActive": True, "createdAt": "2026-05-19T22:00:00+00:00",
    })
    return user_id


async def login(email):
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{BASE}/api/auth/login", json={"email": email, "password": "Test1234!"})
        r.raise_for_status()
        return r.json()["accessToken"]


async def main():
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]

    customer_id = await make_user(db, "customer", "1")
    provider_id = await make_user(db, "provider", "1")
    admin_id = await make_user(db, "admin", "1")
    print(f"Users: {customer_id} / {provider_id} / {admin_id}")

    cust_token = await login(f"{customer_id}@test.local")
    prov_token = await login(f"{provider_id}@test.local")
    admin_token = await login(f"{admin_id}@test.local")

    request_id = "s7-req-1"
    await db.service_requests.delete_one({"id": request_id})
    await db.service_requests.insert_one({
        "id": request_id,
        "customerId": customer_id, "providerId": provider_id,
        "category": "repair", "title": "Замена тормозов",
        "status": "pending", "amount": 200, "currency": "eur",
        "createdAt": "2026-05-19T22:00:00+00:00",
        "updatedAt": "2026-05-19T22:00:00+00:00",
    })

    async with httpx.AsyncClient() as c:
        # 1. Provider onboarding
        r = await c.post(
            f"{BASE}/api/connect/onboarding/start",
            headers={"Authorization": f"Bearer {prov_token}"},
            json={"country": "DE"},
        )
        assert r.status_code == 200, f"onboarding/start: {r.status_code} {r.text}"
        onb = r.json()
        print(f"  ✓ onboarding/start: stripeAccountId={onb['stripeAccountId']} sandbox={onb['sandbox']}")
        assert onb["sandbox"] is True
        assert onb["stripeAccountId"].startswith("acct_sandbox_")

        # 2. Provider checks status
        r = await c.get(
            f"{BASE}/api/connect/onboarding/status",
            headers={"Authorization": f"Bearer {prov_token}"},
        )
        s = r.json()
        print(f"  ✓ onboarding/status: onboarded={s['onboarded']} payoutsEnabled={s.get('payoutsEnabled')}")
        assert s["onboarded"] is True
        assert s["payoutsEnabled"] is True

        # 3. Customer creates PaymentIntent
        r = await c.post(
            f"{BASE}/api/payments/stripe/escrow/intent",
            headers={"Authorization": f"Bearer {cust_token}"},
            json={"requestId": request_id, "currency": "eur"},
        )
        assert r.status_code == 200, f"intent: {r.status_code} {r.text}"
        pi = r.json()
        print(f"  ✓ PaymentIntent: id={pi['paymentIntentId']} sandbox={pi['sandbox']}")
        assert pi["paymentIntentId"].startswith("pi_sandbox_")

        # 4. Mark service_payment as paid (simulating customer confirmation)
        payment_id = f"pay_{pi['paymentIntentId']}"
        await db.service_payments.update_one(
            {"id": payment_id},
            {"$set": {"status": "paid", "completedAt": "2026-05-19T22:00:00+00:00"}},
        )

        # 5. Release escrow (admin override — bypass 12h)
        r = await c.post(
            f"{BASE}/api/payments/stripe/escrow/release/{payment_id}",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.status_code == 200, f"release: {r.status_code} {r.text}"
        rel = r.json()
        print(f"  ✓ Release: transfer={rel['transferId']} payout=€{rel['payoutAmount']} fee=€{rel['applicationFee']}")
        assert rel["transferId"].startswith("tr_sandbox_")
        assert rel["payoutAmount"] == 180.0  # 200 * 0.9
        assert rel["applicationFee"] == 20.0  # 10%

        # 6. Admin freezes platform
        r = await c.post(
            f"{BASE}/api/admin/payments/freeze",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"reason": "Suspicious activity"},
        )
        assert r.status_code == 200 and r.json()["frozen"] is True
        print("  ✓ Platform frozen by admin")

        # 7. Create second payment, attempt release as non-admin → blocked
        request_id2 = "s7-req-2"
        await db.service_requests.delete_one({"id": request_id2})
        await db.service_requests.insert_one({
            "id": request_id2, "customerId": customer_id, "providerId": provider_id,
            "category": "wash", "title": "Мойка", "status": "pending", "amount": 50, "currency": "eur",
            "createdAt": "2026-05-19T22:00:00+00:00", "updatedAt": "2026-05-19T22:00:00+00:00",
        })
        r = await c.post(
            f"{BASE}/api/payments/stripe/escrow/intent",
            headers={"Authorization": f"Bearer {cust_token}"},
            json={"requestId": request_id2, "currency": "eur"},
        )
        pi2 = r.json()
        pay_id2 = f"pay_{pi2['paymentIntentId']}"
        await db.service_payments.update_one(
            {"id": pay_id2},
            {"$set": {"status": "paid", "completedAt": "2026-05-19T22:00:00+00:00"}},
        )
        # Customer attempts release while platform frozen
        r = await c.post(
            f"{BASE}/api/payments/stripe/escrow/release/{pay_id2}",
            headers={"Authorization": f"Bearer {cust_token}"},
        )
        assert r.status_code == 423, f"frozen release: {r.status_code}"
        print("  ✓ Customer release blocked (423 — platform frozen)")

        # 8. Admin unfreeze
        r = await c.post(
            f"{BASE}/api/admin/payments/unfreeze",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        assert r.json()["frozen"] is False
        print("  ✓ Platform unfrozen")

        # 9. Refund flow
        r = await c.post(
            f"{BASE}/api/payments/stripe/escrow/refund",
            headers={"Authorization": f"Bearer {admin_token}"},
            json={"paymentId": pay_id2, "amount": 25.0, "reason": "requested_by_customer"},
        )
        assert r.status_code == 200, f"refund: {r.status_code} {r.text}"
        ref = r.json()
        print(f"  ✓ Refund: id={ref['refundId']} status={ref['status']}")
        assert ref["refundId"].startswith("re_sandbox_")

        # 10. Webhook idempotency — post fake event twice
        evt = {
            "id": f"evt_test_{uuid.uuid4().hex}",
            "type": "payment_intent.succeeded",
            "data": {"object": {"id": pi["paymentIntentId"], "charges": {"data": [{"id": "ch_test"}]}}},
        }
        body = json.dumps(evt).encode()
        r1 = await c.post(f"{BASE}/api/billing/webhook/connect", content=body, headers={"content-type": "application/json"})
        r2 = await c.post(f"{BASE}/api/billing/webhook/connect", content=body, headers={"content-type": "application/json"})
        assert r1.status_code == 200 and r1.json().get("duplicate") is not True
        assert r2.status_code == 200 and r2.json().get("duplicate") is True
        print(f"  ✓ Webhook idempotency: 1st={r1.json()}  2nd={r2.json()}")

        # 11. Admin platform status
        r = await c.get(
            f"{BASE}/api/admin/payments/platform-status",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        ps = r.json()
        print(f"  ✓ Platform status: providersOnboarded={ps['providersOnboarded']} paid={ps['totalPaid']} disputed={ps['totalDisputed']}")
        assert ps["providersOnboarded"] >= 1

    print("\n✅ ALL SPRINT 7 STRIPE CONNECT CHECKS PASSED (sandbox mode)")


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
