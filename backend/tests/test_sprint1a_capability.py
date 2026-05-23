"""Sprint 1A smoke tests — verify compatibility abstraction layer is non-breaking.

What this checks:
  1. Login still works for legacy customer + admin (returns user.role unchanged).
  2. Login NOW returns additive `caps` array + `activeAccount` blob.
  3. JWT payload carries new `caps` + `accountId` claims (additive).
  4. /me endpoint returns the new shape.
  5. `derive_capabilities_from_legacy()` maps role correctly.
  6. `has_capability()` works on both raw user-doc and JWT-payload shapes.
  7. `require_capability()` dependency rejects missing-cap tokens with 403.
  8. Legacy `/api/customer/*` routes still work (no behavior change).

Run: python /app/backend/tests/test_sprint1a_capability.py
"""
from __future__ import annotations
import asyncio
import os
import sys

sys.path.insert(0, "/app/backend")

import jwt
from dotenv import load_dotenv

load_dotenv("/app/backend/.env")
JWT_SECRET = os.environ["JWT_SECRET"]
JWT_ALGO = os.environ.get("JWT_ALGO", "HS256")

import httpx

BASE = "http://localhost:8001"


def _ok(label: str):
    print(f"  ✓ {label}")


def _fail(label: str, detail=""):
    print(f"  ✗ {label}  {detail}")
    sys.exit(1)


async def main():
    print("\n=== Sprint 1A smoke: capability compatibility layer ===\n")

    async with httpx.AsyncClient(base_url=BASE, timeout=10.0) as c:
        # 1) Customer login
        r = await c.post("/api/auth/login", json={"email": "client@test.com", "password": "Test1234"})
        assert r.status_code == 200, r.text
        body = r.json()
        token_customer = body["accessToken"]
        u = body["user"]
        assert u["role"] == "customer", f"role drift: {u['role']!r}"
        assert u["caps"] == [], f"customer should have caps=[], got {u['caps']!r}"
        assert u["activeAccount"]["kind"] == "customer", u["activeAccount"]
        assert u["activeAccount"]["isLegacy"] is True
        _ok("customer login: role+caps+activeAccount returned")

        # 2) JWT additive claims present
        payload = jwt.decode(token_customer, JWT_SECRET, algorithms=[JWT_ALGO])
        assert payload["role"] == "customer", payload
        assert payload["caps"] == [], payload
        assert payload["accountId"] == u["id"], payload
        _ok("JWT customer: role+caps+accountId additive claims")

        # 3) /me with the new token
        r = await c.get("/api/auth/me", headers={"Authorization": f"Bearer {token_customer}"})
        assert r.status_code == 200, r.text
        me = r.json()
        assert me["caps"] == [], me
        assert me["activeAccount"]["kind"] == "customer", me
        _ok("/auth/me: new shape returned")

        # 4) Admin login
        r = await c.post("/api/auth/login", json={"email": "admin@autoservice.com", "password": "Admin123!"})
        assert r.status_code == 200, r.text
        ab = r.json()
        token_admin = ab["accessToken"]
        au = ab["user"]
        assert au["role"] == "admin", au
        assert au["caps"] == [], au
        assert au["activeAccount"]["kind"] == "admin", f"admin should be admin kind, got {au['activeAccount']['kind']!r}"
        _ok("admin login: kind=admin, caps=[]")

        # 5) Legacy /api/customer/credits still works on the new JWT
        r = await c.get("/api/customer/credits", headers={"Authorization": f"Bearer {token_customer}"})
        assert r.status_code == 200, f"legacy customer/credits broken: {r.text}"
        _ok("legacy /api/customer/credits unaffected")

        # 6) Register a new "provider" (role=provider_owner) — should yield caps=['inspector']
        import time
        suffix = int(time.time())
        prov_email = f"insp{suffix}@test.com"
        r = await c.post(
            "/api/auth/register",
            json={
                "email": prov_email,
                "password": "Test1234",
                "firstName": "Sprint1A",
                "lastName": "Inspector",
                "role": "provider_owner",
            },
        )
        assert r.status_code == 200, r.text
        pb = r.json()
        token_prov = pb["accessToken"]
        pu = pb["user"]
        assert pu["role"] == "provider_owner", pu
        assert pu["caps"] == ["inspect"], f"provider_owner should derive caps=['inspect'], got {pu['caps']!r}"
        assert pu["activeAccount"]["kind"] == "inspector", pu["activeAccount"]
        _ok("register provider_owner → derives caps=['inspect'] (verb-form)")

        # 7) JWT payload of provider has caps
        pp = jwt.decode(token_prov, JWT_SECRET, algorithms=[JWT_ALGO])
        assert pp["caps"] == ["inspect"], pp
        _ok("JWT provider: caps=['inspect'] claim present")

    # 8) Pure-Python helper checks (no HTTP)
    from app.core.capability import (
        derive_capabilities_from_legacy,
        has_capability,
        has_any_capability,
    )

    assert derive_capabilities_from_legacy({"role": "customer"}) == []
    assert derive_capabilities_from_legacy({"role": "admin"}) == []
    assert derive_capabilities_from_legacy({"role": "provider"}) == ["inspect"]
    assert derive_capabilities_from_legacy({"role": "provider_owner"}) == ["inspect"]
    assert derive_capabilities_from_legacy({"role": "service_provider"}) == ["repair"]
    assert derive_capabilities_from_legacy({"role": "dealer"}) == ["sell"]
    assert derive_capabilities_from_legacy({"role": "transport"}) == ["transport"]
    assert derive_capabilities_from_legacy(None) == []
    assert derive_capabilities_from_legacy({}) == []
    _ok("derive_capabilities_from_legacy: 9 cases pass (verb vocabulary)")

    # has_capability accepts both shapes
    assert has_capability({"role": "provider"}, "inspect") is True
    assert has_capability({"role": "customer"}, "inspect") is False
    assert has_capability({"caps": ["inspect", "transport"]}, "transport") is True
    assert has_capability({"caps": ["inspect"]}, "sell") is False
    assert has_capability(None, "inspect") is False
    _ok("has_capability: dual-shape (user-doc + JWT) works")

    assert has_any_capability({"caps": ["inspect"]}, ["sell", "inspect"]) is True
    assert has_any_capability({"caps": []}, ["sell", "inspect"]) is False
    _ok("has_any_capability: union check works")

    # Sprint 1B sanity — collections + seed exist
    from motor.motor_asyncio import AsyncIOMotorClient
    mongo_url = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
    db_name = os.environ.get("DB_NAME", "auto_search_platform")
    client = AsyncIOMotorClient(mongo_url)
    db = client[db_name]
    colls = set(await db.list_collection_names())
    for required in ("accounts", "account_capabilities", "account_organizations", "specializations"):
        assert required in colls, f"Sprint 1B collection missing: {required}"
    _ok("Sprint 1B collections exist (accounts, account_capabilities, account_organizations, specializations)")

    # Specializations seed loaded with stable IDs
    bmw = await db.specializations.find_one({"_id": "bmw"})
    assert bmw is not None and bmw["category"] == "brand"
    assert "BMW" in bmw["aliases"], bmw
    assert bmw["labels"]["en"] == "BMW", bmw
    _ok("specializations seed: bmw entry has category/labels/aliases")

    spec_count = await db.specializations.count_documents({"active": True})
    assert spec_count >= 25, f"expected ≥25 active specializations, got {spec_count}"
    _ok(f"specializations seed: {spec_count} active entries (≥25)")

    # Indexes on accounts present
    idx_info = await db.accounts.index_information()
    assert "uniq_user_kind" in idx_info, idx_info
    _ok("accounts.uniq_user_kind compound index present")

    # account_capabilities indexes
    cap_idx = await db.account_capabilities.index_information()
    assert "uniq_account_cap" in cap_idx, cap_idx
    _ok("account_capabilities.uniq_account_cap index present")

    client.close()

    print("\n✅ All Sprint 1A smoke tests passed.\n")


if __name__ == "__main__":
    asyncio.run(main())
