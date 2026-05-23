"""E2E smoke test for Sprint P0.b.C.e — Deep-link resolver.

CONTRACT being verified:
  - 4 chronology surfaces resolve to correct route/params/requiredRole
  - unknown surface → 400 INVALID_DEEPLINK
  - malformed ref → 400 INVALID_DEEPLINK
  - missing ?ref= → 422 MISSING_REF
  - RESOLVER OPACITY INVARIANT: identical response shape regardless of
    Authorization header (unauth vs customer JWT vs admin JWT) — proves
    resolver is NOT a permission engine.

Run: python /app/backend/test_deeplink_resolver_smoke.py
"""
import asyncio
import json
import sys
import httpx

BASE = "http://localhost:8001"


EXPECTED = {
    "booking-timeline.customer": {
        "route": "/customer/booking/[id]/timeline",
        "paramKey": "id",
        "requiredRole": "customer",
    },
    "booking-timeline.provider": {
        "route": "/provider/booking/[id]/timeline",
        "paramKey": "id",
        "requiredRole": "provider",
    },
    "job-timeline.inspector": {
        "route": "/inspector/jobs/[jobId]/timeline",
        "paramKey": "jobId",
        "requiredRole": "inspector",
    },
    "booking-forensic.admin": {
        "route": "/admin/booking/[id]/forensic",
        "paramKey": "id",
        "requiredRole": "admin",
    },
}


async def get_admin_token(c: httpx.AsyncClient) -> str:
    r = await c.post(
        f"{BASE}/api/auth/login",
        json={"email": "admin@autoservice.com", "password": "Admin123!"},
    )
    assert r.status_code == 200, f"admin login failed: {r.status_code} {r.text}"
    return r.json()["accessToken"]


async def get_customer_token(c: httpx.AsyncClient) -> str:
    import uuid

    email = f"deeplink-test-{uuid.uuid4().hex[:8]}@test.local"
    r = await c.post(
        f"{BASE}/api/auth/register",
        json={
            "email": email,
            "password": "Test1234!",
            "role": "customer",
            "fullName": "Deeplink Test",
        },
    )
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    return r.json()["accessToken"]


async def main():
    failures = []

    async with httpx.AsyncClient(timeout=10.0) as c:
        # ── 1. Happy paths
        for key, expected in EXPECTED.items():
            ref = f"{key}:test-resource-1234"
            r = await c.get(f"{BASE}/api/deeplink/resolve", params={"ref": ref})
            if r.status_code != 200:
                failures.append(f"[{key}] expected 200, got {r.status_code}: {r.text}")
                continue
            body = r.json()
            checks = [
                ("surface", body.get("surface") == key),
                ("route", body.get("route") == expected["route"]),
                ("requiredRole", body.get("requiredRole") == expected["requiredRole"]),
                (
                    "params",
                    body.get("params") == {expected["paramKey"]: "test-resource-1234"},
                ),
            ]
            for field, ok in checks:
                if not ok:
                    failures.append(f"[{key}] field {field}: got {body}")
            if all(ok for _, ok in checks):
                print(f"  ✓ {key} → {body['route']} role={body['requiredRole']}")

        # ── 2. Unknown surface
        r = await c.get(
            f"{BASE}/api/deeplink/resolve", params={"ref": "unknown.surface:foo"}
        )
        if r.status_code == 400 and r.json().get("code") == "INVALID_DEEPLINK":
            print(f"  ✓ unknown surface → 400 INVALID_DEEPLINK")
        else:
            failures.append(f"unknown surface: expected 400 INVALID_DEEPLINK, got {r.status_code} {r.text}")

        # ── 3. Malformed ref (no colon)
        r = await c.get(f"{BASE}/api/deeplink/resolve", params={"ref": "brokenref"})
        if r.status_code == 400 and r.json().get("code") == "INVALID_DEEPLINK":
            print(f"  ✓ malformed ref (no colon) → 400 INVALID_DEEPLINK")
        else:
            failures.append(f"malformed ref: expected 400, got {r.status_code} {r.text}")

        # ── 4. Empty resource id
        r = await c.get(
            f"{BASE}/api/deeplink/resolve", params={"ref": "booking-timeline.customer:"}
        )
        if r.status_code == 400 and r.json().get("code") == "INVALID_DEEPLINK":
            print(f"  ✓ empty resource id → 400 INVALID_DEEPLINK")
        else:
            failures.append(
                f"empty resource id: expected 400, got {r.status_code} {r.text}"
            )

        # ── 5. Missing ?ref=
        r = await c.get(f"{BASE}/api/deeplink/resolve")
        if r.status_code == 422:
            print(f"  ✓ missing ref query → 422")
        else:
            failures.append(f"missing ref: expected 422, got {r.status_code} {r.text}")

        # ── 6. RESOLVER OPACITY INVARIANT
        # Resolver MUST return identical JSON for unauth / customer JWT /
        # admin JWT. This proves it is not a permission engine.
        admin_token = await get_admin_token(c)
        customer_token = await get_customer_token(c)
        target_ref = "booking-forensic.admin:opacity-test-id"

        r_unauth = await c.get(
            f"{BASE}/api/deeplink/resolve", params={"ref": target_ref}
        )
        r_customer = await c.get(
            f"{BASE}/api/deeplink/resolve",
            params={"ref": target_ref},
            headers={"Authorization": f"Bearer {customer_token}"},
        )
        r_admin = await c.get(
            f"{BASE}/api/deeplink/resolve",
            params={"ref": target_ref},
            headers={"Authorization": f"Bearer {admin_token}"},
        )

        bodies = [r_unauth.json(), r_customer.json(), r_admin.json()]
        statuses = [r_unauth.status_code, r_customer.status_code, r_admin.status_code]
        if statuses == [200, 200, 200] and bodies[0] == bodies[1] == bodies[2]:
            print(
                f"  ✓ OPACITY INVARIANT: unauth/customer/admin → identical JSON "
                f"(role-agnostic resolver, NOT a permission engine)"
            )
        else:
            failures.append(
                f"opacity invariant broken: statuses={statuses} bodies={bodies}"
            )

        # ── 7. /api/deeplink/surfaces catalogue
        r = await c.get(f"{BASE}/api/deeplink/surfaces")
        if r.status_code == 200:
            keys = {s["key"] for s in r.json().get("surfaces", [])}
            # baseline 4 chronology surfaces must exist (P0.b.C.a..d)
            if set(EXPECTED.keys()).issubset(keys):
                print(f"  ✓ /surfaces catalogue contains all 4 P0.b.C chronology surfaces ({len(keys)} total)")
            else:
                missing = set(EXPECTED.keys()) - keys
                failures.append(f"surfaces missing: {missing}")
        else:
            failures.append(
                f"surfaces endpoint: {r.status_code} body={r.text}"
            )

    if failures:
        print("\n❌ FAILURES:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL P0.b.C.e DEEP-LINK RESOLVER CHECKS PASSED")


if __name__ == "__main__":
    asyncio.run(main())
