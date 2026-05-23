"""E2E smoke test for Sprint 5 — Trust & Retention.

Creates: customer + provider users → released service_request → both submit reviews
→ verify blind reveal + aggregate recompute + badges.

Run: python /app/backend/test_trust_e2e.py
"""
import asyncio
import json
import sys
import uuid

import httpx
import bcrypt
from motor.motor_asyncio import AsyncIOMotorClient

BASE = "http://localhost:8001"
MONGO = "mongodb://localhost:27017"
DB = "test_database"


async def setup_users():
    """Create a fresh customer + provider with known credentials."""
    client = AsyncIOMotorClient(MONGO)
    db = client[DB]
    customer_id = "trust-test-customer-" + uuid.uuid4().hex[:8]
    provider_id = "trust-test-provider-" + uuid.uuid4().hex[:8]
    pwd_hash = bcrypt.hashpw(b"Test1234!", bcrypt.gensalt()).decode()

    await db.users.insert_one({
        "_id": customer_id,
        "id": customer_id,
        "email": f"{customer_id}@test.local",
        "passwordHash": pwd_hash,
        "role": "customer",
        "firstName": "Trust",
        "lastName": "Customer",
        "isActive": True,
        "createdAt": "2026-05-19T22:00:00+00:00",
    })
    await db.users.insert_one({
        "_id": provider_id,
        "id": provider_id,
        "email": f"{provider_id}@test.local",
        "passwordHash": pwd_hash,
        "role": "provider",
        "firstName": "Trust",
        "lastName": "Provider",
        "subscriptionTier": "pro",
        "isActive": True,
        "createdAt": "2026-05-19T22:00:00+00:00",
    })
    # Insert a released request linking them.
    request_id = "trust-test-req-" + uuid.uuid4().hex[:8]
    await db.service_requests.insert_one({
        "id": request_id,
        "customerId": customer_id,
        "providerId": provider_id,
        "category": "repair",
        "title": "Замена тормозных колодок",
        "status": "released",
        "amount": 120,
        "responseSeconds": 360,  # 6 min
        "completedAt": "2026-05-19T22:00:00+00:00",
        "releasedAt": "2026-05-19T22:30:00+00:00",
        "updatedAt": "2026-05-19T22:30:00+00:00",
    })
    return customer_id, provider_id, request_id


async def login(email):
    async with httpx.AsyncClient() as c:
        r = await c.post(f"{BASE}/api/auth/login", json={"email": email, "password": "Test1234!"})
        r.raise_for_status()
        return r.json()["accessToken"]


async def main():
    customer_id, provider_id, request_id = await setup_users()
    print(f"Created: customer={customer_id}  provider={provider_id}  request={request_id}")

    cust_token = await login(f"{customer_id}@test.local")
    prov_token = await login(f"{provider_id}@test.local")
    print("Both logged in.")

    async with httpx.AsyncClient() as c:
        # Test 1: cold-start trust card
        r = await c.get(f"{BASE}/api/trust/providers/{provider_id}")
        print("Cold trust card:", r.status_code, r.json()["totalReviews"], "reviews")
        assert r.json()["totalReviews"] == 0

        # Test 2: customer submits review
        r = await c.post(
            f"{BASE}/api/trust/reviews",
            headers={"Authorization": f"Bearer {cust_token}"},
            json={"requestId": request_id, "rating": 5, "tags": ["fast", "professional"], "comment": "Отлично!"},
        )
        print("Customer→Provider:", r.status_code, "revealed=", r.json().get("revealed"))
        assert r.status_code == 200 and r.json()["revealed"] is False

        # Test 3: duplicate submit → 409
        r = await c.post(
            f"{BASE}/api/trust/reviews",
            headers={"Authorization": f"Bearer {cust_token}"},
            json={"requestId": request_id, "rating": 4, "tags": [], "comment": "dup"},
        )
        print("Duplicate customer→provider:", r.status_code)
        assert r.status_code == 409

        # Test 4: pending check (customer should NOT see it now)
        r = await c.get(
            f"{BASE}/api/trust/reviews/pending",
            headers={"Authorization": f"Bearer {cust_token}"},
        )
        print("Customer pending:", r.status_code, "items=", len(r.json()["items"]))

        # Test 5: provider should still see in pending
        r = await c.get(
            f"{BASE}/api/trust/reviews/pending",
            headers={"Authorization": f"Bearer {prov_token}"},
        )
        items = r.json()["items"]
        print("Provider pending:", r.status_code, "items=", len(items))
        assert any(i["requestId"] == request_id for i in items)

        # Test 6: by-request before reveal (counterparty masked)
        r = await c.get(
            f"{BASE}/api/trust/reviews/by-request/{request_id}",
            headers={"Authorization": f"Bearer {prov_token}"},
        )
        reviews = r.json()["reviews"]
        print("Provider sees pair (before own review):")
        for rv in reviews:
            print(" ", {k: v for k, v in rv.items() if k in ("authorRole", "visibility", "rating")})
        # Customer's review must be masked (no rating/comment)
        masked = [rv for rv in reviews if rv["authorRole"] == "customer"]
        assert all("rating" not in rv for rv in masked), "Counterparty review leaked!"

        # Test 7: provider submits review → reveal triggers
        r = await c.post(
            f"{BASE}/api/trust/reviews",
            headers={"Authorization": f"Bearer {prov_token}"},
            json={"requestId": request_id, "rating": 5, "tags": ["communicative"], "comment": "Хороший клиент"},
        )
        print("Provider→Customer:", r.status_code, "revealed=", r.json().get("revealed"))
        assert r.status_code == 200 and r.json()["revealed"] is True

        # Test 8: by-request after reveal — both visible
        r = await c.get(
            f"{BASE}/api/trust/reviews/by-request/{request_id}",
            headers={"Authorization": f"Bearer {prov_token}"},
        )
        reviews = r.json()["reviews"]
        assert all(rv["visibility"] == "revealed" for rv in reviews)
        print("After reveal — both visible:")
        for rv in reviews:
            print(" ", rv["authorRole"], "→", rv["targetRole"], rv["rating"], "★", rv.get("tags"))

        # Test 9: trust card now has data
        r = await c.get(f"{BASE}/api/trust/providers/{provider_id}")
        card = r.json()
        print("Trust card after reveal:")
        print(" avg:", card["avgRating"], "reviews:", card["totalReviews"],
              "subscriptionTier:", card["subscriptionTier"], "badges:", card["badges"],
              "tags:", card["tagCounts"])
        assert card["avgRating"] == 5.0
        assert card["totalReviews"] == 1
        assert card["subscriptionTier"] == "pro"

        # Test 10: public revealed reviews list
        r = await c.get(f"{BASE}/api/trust/providers/{provider_id}/reviews")
        public_list = r.json()
        print("Public reviews list:", public_list["total"], "items")
        assert public_list["total"] == 1
        # Should not leak authorId/customerId in public list
        first = public_list["items"][0]
        assert "authorId" not in first and "customerId" not in first

    print("\n✅ ALL SPRINT 5 TRUST CHECKS PASSED")


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
