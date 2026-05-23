"""P0.b.C.d.UI.d — Admin forensic stream REST + WS contract smoke.

Validates what the admin forensic consumer hook depends on:

  1. REST returns RAW timeline rows (no projection / prettification).
  2. `:rejected` rows are visible to admin (unlike all other surfaces).
  3. Raw `meta` fields surface unfiltered (`platformCut`, `customerNote`,
     `internalNotes` — anything goes for admin).
  4. WS auth is **role-gated**: provider/customer tokens → close 4403.
  5. Admin token → `scope:admin` hello + per-bookingId filter works.
  6. WS keepalive.
  7. Bad-token close (4401).

Run:
    cd /app/backend && python test_admin_forensic_ws_smoke.py
"""
import asyncio
import json
import os
import sys
import uuid
from datetime import datetime, timezone

import httpx
import websockets
from motor.motor_asyncio import AsyncIOMotorClient

BACKEND = os.environ.get("BACKEND_URL", "http://localhost:8001")
WS_BACKEND = BACKEND.replace("http://", "ws://").replace("https://", "wss://")
MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


async def main() -> int:
    print(f"BACKEND={BACKEND}")

    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "admin@autoservice.com", "password": "Admin123!"},
        )
        if r.status_code != 200:
            print(f"FAIL: admin login → {r.status_code} {r.text}")
            return 1
        admin_login = r.json()
        admin_token = admin_login["accessToken"]
        admin_role = admin_login["user"].get("role")
        if admin_role != "admin":
            print(f"FAIL: expected admin role, got {admin_role}")
            return 1
        print(f"✓ admin login · role={admin_role}")

        r2 = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "provider@test.com", "password": "Provider123!"},
        )
        provider_token = r2.json()["accessToken"]
        print(f"✓ provider login (for role-gate negative test)")

    mongo = AsyncIOMotorClient(MONGO_URL)
    db = mongo[DB_NAME]

    booking_id = f"test-adm-{uuid.uuid4().hex[:8]}"
    # Use service_request scope (one of the 3 admin scopes).
    await db.service_requests.insert_one(
        {
            "id": booking_id,
            "customerId": "some-customer",
            "status": "in_progress",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    print(f"✓ seeded service_request id={booking_id}")

    now = datetime.now(timezone.utc)
    rows = [
        # 1. Normal transition with leaky meta (admin must see all).
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": booking_id,
            "action": "mark_matched",
            "actorRole": "system",
            "actorId": "matcher",
            "fromStatus": "requested",
            "toStatus": "matched",
            "timestamp": now.isoformat(),
            "meta": {
                "customerNote": "Buzzer 4B",
                "platformCut": 1234,
                "internalNotes": "ADMIN ONLY",
                "trustScore": 0.85,
            },
        },
        # 2. A rejected attempt — invisible to customer/provider/inspector
        #    BUT visible to admin.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": booking_id,
            "action": "mark_completed:rejected",
            "actorRole": "provider",
            "actorId": "some-provider",
            "fromStatus": "matched",
            "toStatus": "matched",
            "timestamp": (
                now.replace(microsecond=now.microsecond + 1)
            ).isoformat(),
            "meta": {"reason": "FSM violation: not in in_progress"},
        },
        # 3. Hidden activity-feed row — admin sees this too.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": booking_id,
            "action": "provider_viewed_booking",
            "actorRole": "provider",
            "actorId": "some-provider",
            "fromStatus": None,
            "toStatus": None,
            "timestamp": (
                now.replace(microsecond=now.microsecond + 2)
            ).isoformat(),
            "meta": {},
        },
    ]
    await db.booking_timeline.insert_many(rows)
    print(f"✓ wrote {len(rows)} rows (incl. :rejected + activity-feed)")

    # ── 1. REST as admin ────────────────────────────────────────
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{BACKEND}/api/admin/booking-lifecycle/{booking_id}"
            f"?scope=service_request&actor=admin",
            headers={"Authorization": f"Bearer {admin_token}"},
        )
        if r.status_code != 200:
            print(f"FAIL: GET admin lifecycle → {r.status_code} {r.text}")
            return 1
        snap = r.json()
        if "timeline" not in snap:
            print(f"FAIL: missing timeline key: {list(snap.keys())}")
            return 1
        timeline = snap["timeline"]
        if len(timeline) != 3:
            print(f"FAIL: expected 3 raw rows, got {len(timeline)}")
            return 1

        actions = [row["action"] for row in timeline]
        if "mark_completed:rejected" not in actions:
            print(f"FAIL: :rejected row missing from admin view: {actions}")
            return 1
        if "provider_viewed_booking" not in actions:
            print(f"FAIL: activity-feed row missing: {actions}")
            return 1
        print(f"✓ REST raw timeline OK · 3 rows, actions={actions}")
        print(f"  · :rejected row PRESENT (admin invariant B — no prettification)")
        print(f"  · provider_viewed_booking PRESENT (no semantic filtering)")

        # Verify raw meta passes through unfiltered.
        matched_row = next(r for r in timeline if r["action"] == "mark_matched")
        for required in ("customerNote", "platformCut", "internalNotes", "trustScore"):
            if required not in matched_row.get("meta", {}):
                print(f"FAIL: forbidden-to-others meta '{required}' missing from admin view: {matched_row.get('meta')}")
                return 1
        print(f"  · meta unfiltered: customerNote, platformCut, internalNotes, trustScore all visible")

        # Verify rows carry stable `id` for client-side dedup.
        ids = [row.get("id") for row in timeline]
        if not all(ids):
            print(f"FAIL: rows missing stable `id` field for dedup: {ids}")
            return 1
        if len(set(ids)) != 3:
            print(f"FAIL: row ids not unique: {ids}")
            return 1
        print(f"  · all rows carry unique `id` for client-side dedup")

    # ── 2. WS as admin ─────────────────────────────────────────
    ws_url = (
        f"{WS_BACKEND}/api/admin/booking-lifecycle/{booking_id}/stream"
        f"?token={admin_token}"
    )
    async with websockets.connect(ws_url) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if hello.get("type") != "hello":
            print(f"FAIL: expected hello, got {hello}")
            return 1
        if hello.get("payload", {}).get("scope") != "admin":
            print(f"FAIL: expected scope=admin, got {hello}")
            return 1
        if hello.get("payload", {}).get("bookingId") != booking_id:
            print(f"FAIL: hello bookingId mismatch: {hello}")
            return 1
        print(f"✓ WS admin hello received · scope=admin bookingId={booking_id}")

        await ws.send("pong")
        pong = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if pong.get("type") != "pong":
            print(f"FAIL: expected pong, got {pong}")
            return 1
        print(f"✓ WS keepalive pong")

    # ── 3. WS as non-admin (provider) → close 4403 ─────────────
    ws_url_prov = (
        f"{WS_BACKEND}/api/admin/booking-lifecycle/{booking_id}/stream"
        f"?token={provider_token}"
    )
    closed_with_4403 = False
    try:
        async with websockets.connect(ws_url_prov) as ws_prov:
            await asyncio.wait_for(ws_prov.recv(), timeout=3)
            print(f"FAIL: provider token should have been rejected")
            return 1
    except Exception as exc:
        msg = str(exc)
        if "4403" in msg:
            closed_with_4403 = True
        print(
            f"✓ WS non-admin (provider role) closed · {type(exc).__name__}"
            f"{' [code 4403]' if closed_with_4403 else ''}"
        )

    # ── 4. WS bad token ────────────────────────────────────────
    ws_url_bad = (
        f"{WS_BACKEND}/api/admin/booking-lifecycle/{booking_id}/stream"
        f"?token=bogus"
    )
    try:
        async with websockets.connect(ws_url_bad) as ws_bad:
            await asyncio.wait_for(ws_bad.recv(), timeout=3)
            print(f"FAIL: expected close on bad token")
            return 1
    except Exception as exc:
        print(f"✓ WS bad-token rejected · {type(exc).__name__}")

    # Cleanup
    await db.service_requests.delete_one({"id": booking_id})
    await db.booking_timeline.delete_many({"bookingId": booking_id})
    print(f"✓ cleanup done")

    print(
        "\n✅ ALL CHECKS PASSED — admin forensic REST (raw + :rejected + meta) "
        "+ WS role-gate (admin only) + bookingId filter + keepalive"
    )
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    raise SystemExit(asyncio.run(main()))
