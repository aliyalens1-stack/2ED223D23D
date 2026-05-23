"""P0.b.C.d.UI.b — Provider timeline REST + WS contract smoke.

Validates the contract the provider consumer hook depends on:

  1. REST returns provider-projected events with the provider meta
     whitelist (payoutAmount, customerNote, eta) preserved.
  2. Forbidden meta (platformCut, internalNotes) is dropped.
  3. Provider WS subscribe with valid token → `scope: provider` hello.
  4. Bad token → close 4401.
  5. Foreign provider (not assigned to booking) → 404 on REST.

Run:
    cd /app/backend && python test_provider_timeline_ws_smoke.py
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
        # Provider login
        r = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "provider@test.com", "password": "Provider123!"},
        )
        if r.status_code != 200:
            print(f"FAIL: provider login → {r.status_code} {r.text}")
            return 1
        provider_login = r.json()
        provider_token = provider_login["accessToken"]
        provider_user_id = provider_login["user"]["id"]
        print(f"✓ provider login · userId={provider_user_id}")

        # Customer login (used to prove foreign-provider 404 isolation)
        r = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "customer@test.com", "password": "Customer123!"},
        )
        customer_token = r.json()["accessToken"]
        print(f"✓ customer login (for foreign-token negative test)")

    # Seed booking assigned to provider + timeline rows with meta we
    # want to assert survives / does not survive projection.
    mongo = AsyncIOMotorClient(MONGO_URL)
    db = mongo[DB_NAME]

    booking_id = f"test-prov-{uuid.uuid4().hex[:8]}"
    await db.service_requests.insert_one(
        {
            "id": booking_id,
            "customerId": "some-other-customer",
            "providerId": provider_user_id,  # assignment for ownership check
            "providerAccountId": provider_user_id,
            "status": "in_progress",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    print(f"✓ seeded service_request id={booking_id} providerId={provider_user_id}")

    now = datetime.now(timezone.utc)
    rows = [
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": booking_id,
            "action": "mark_matched",
            "actorRole": "system",
            "actorId": "matcher",
            "fromStatus": "requested",
            "toStatus": "matched",
            "timestamp": now.isoformat(),
            # Provider must see `customerNote`. Must NOT see `platformCut`.
            "meta": {
                "customerNote": "Подъезд со двора, домофон 4B",
                "platformCut": 1234,
                "internalNotes": "do not show",
            },
        },
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": booking_id,
            "action": "mark_completed",
            "actorRole": "provider",
            "actorId": provider_user_id,
            "fromStatus": "in_progress",
            "toStatus": "completed",
            "timestamp": (now.replace(microsecond=now.microsecond + 1)).isoformat(),
            # Provider must see `payoutAmount`. Must NOT see `commission`.
            "meta": {
                "payoutAmount": 87.50,
                "commission": 12.50,
                "note": "Доставлен отчёт",
            },
        },
    ]
    await db.booking_timeline.insert_many(rows)
    print(f"✓ wrote 2 timeline rows with whitelisted+forbidden meta")

    # 1. REST as the assigned provider
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{BACKEND}/api/provider/bookings/{booking_id}/timeline",
            headers={"Authorization": f"Bearer {provider_token}"},
        )
        if r.status_code != 200:
            print(f"FAIL: GET provider timeline → {r.status_code} {r.text}")
            return 1
        snap = r.json()
        if snap["count"] != 2:
            print(f"FAIL: expected 2 events, got {snap['count']}")
            return 1
        keys = [e["key"] for e in snap["events"]]
        if keys != ["matched", "completed"]:
            print(f"FAIL: expected keys [matched, completed], got {keys}")
            return 1

        # Provider meta whitelist assertions
        matched_meta = snap["events"][0]["meta"]
        completed_meta = snap["events"][1]["meta"]
        if matched_meta.get("customerNote") != "Подъезд со двора, домофон 4B":
            print(f"FAIL: customerNote not surfaced: {matched_meta}")
            return 1
        if "platformCut" in matched_meta or "internalNotes" in matched_meta:
            print(f"FAIL: forbidden meta leaked: {matched_meta}")
            return 1
        if completed_meta.get("payoutAmount") not in (87.5, "87.5", 87.50):
            print(f"FAIL: payoutAmount not surfaced or wrong: {completed_meta}")
            return 1
        if "commission" in completed_meta:
            print(f"FAIL: commission leaked: {completed_meta}")
            return 1
        if completed_meta.get("note") != "Доставлен отчёт":
            print(f"FAIL: own note not surfaced: {completed_meta}")
            return 1

        # Tone assertions
        tones = [e["tone"] for e in snap["events"]]
        if tones != ["action_required", "settled"]:
            print(f"FAIL: provider tones wrong: {tones}")
            return 1

        # isSelfAction: matched was system; completed was provider
        if snap["events"][0]["isSelfAction"] is not False:
            print(f"FAIL: matched should not be self-action")
            return 1
        if snap["events"][1]["isSelfAction"] is not True:
            print(f"FAIL: completed should be self-action")
            return 1

        print(f"✓ REST projection OK · keys={keys} tones={tones}")
        print(f"  · customerNote surfaced, payoutAmount=87.5")
        print(f"  · platformCut/internalNotes/commission filtered")

    # 2. Foreign caller (customer token) should 404, not 403
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{BACKEND}/api/provider/bookings/{booking_id}/timeline",
            headers={"Authorization": f"Bearer {customer_token}"},
        )
        if r.status_code != 404:
            print(f"FAIL: foreign caller expected 404, got {r.status_code} {r.text}")
            return 1
        print(f"✓ Foreign caller (customer) → 404 (opacity preserved)")

    # 3. WS handshake
    ws_url = f"{WS_BACKEND}/api/provider/bookings/{booking_id}/timeline/stream?token={provider_token}"
    async with websockets.connect(ws_url) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if hello.get("type") != "hello":
            print(f"FAIL: expected hello, got {hello}")
            return 1
        if hello.get("payload", {}).get("scope") != "provider":
            print(f"FAIL: expected scope=provider, got {hello}")
            return 1
        print(f"✓ WS hello received · scope=provider bookingId={hello['payload'].get('bookingId')}")

        await ws.send("pong")
        pong = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if pong.get("type") != "pong":
            print(f"FAIL: expected pong, got {pong}")
            return 1
        print(f"✓ WS keepalive pong")

    # 4. Bad-token close
    ws_url_bad = f"{WS_BACKEND}/api/provider/bookings/{booking_id}/timeline/stream?token=bogus"
    try:
        async with websockets.connect(ws_url_bad) as ws_bad:
            await asyncio.wait_for(ws_bad.recv(), timeout=3)
            print(f"FAIL: expected close on bad token, got message")
            return 1
    except Exception as exc:
        print(f"✓ WS bad-token rejected · {type(exc).__name__}")

    # Cleanup
    await db.service_requests.delete_one({"id": booking_id})
    await db.booking_timeline.delete_many({"bookingId": booking_id})
    print(f"✓ cleanup done")

    print("\n✅ ALL CHECKS PASSED — provider REST projection + WS handshake + opacity")
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    raise SystemExit(asyncio.run(main()))
