"""P0.b.C.d.UI.c — Inspector job timeline REST + WS contract smoke.

Validates what the inspector consumer hook depends on:

  1. REST returns inspector-projected events under the **jobId-keyed**
     envelope. `requestId` and `bookingId` are NOT echoed.
  2. Inspector meta whitelist is honored:
       allowed:  eta, reason, note, reportId, inspectorPayoutAmount
       blocked:  payoutAmount (provider's, different aggregate),
                 customerNote, platformCut, internalNotes
  3. `mark_confirmed` (provider's commitment) is dropped from the
     inspector projection — inspector chronology starts at `assigned`.
  4. Inspector WS subscribe → `scope: inspector` hello echoes jobId.
  5. WS handshake + keepalive.
  6. Bad-token close.
  7. Foreign caller (customer) → 404 (job opacity preserved).

Run:
    cd /app/backend && python test_inspector_timeline_ws_smoke.py
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
        # We use provider@test.com because that login has a stable
        # password and the user id matches the inspectorId stamped
        # on the existing demo jobs in seed data. Role doesn't matter
        # for inspector_router — ownership comes from
        # inspection_jobs.inspectorId, not the auth role claim.
        r = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "provider@test.com", "password": "Provider123!"},
        )
        if r.status_code != 200:
            print(f"FAIL: login → {r.status_code} {r.text}")
            return 1
        inspector_login = r.json()
        inspector_token = inspector_login["accessToken"]
        inspector_user_id = inspector_login["user"]["id"]
        print(f"✓ inspector login · userId={inspector_user_id}")

        r2 = await client.post(
            f"{BACKEND}/api/auth/login",
            json={"email": "customer@test.com", "password": "Customer123!"},
        )
        customer_token = r2.json()["accessToken"]
        print(f"✓ customer login (for foreign-token negative test)")

    mongo = AsyncIOMotorClient(MONGO_URL)
    db = mongo[DB_NAME]

    # Seed: one inspection_job assigned to our caller, with a
    # requestId pointing to a service_request that has timeline rows.
    request_id = f"test-req-{uuid.uuid4().hex[:8]}"
    job_id = f"test-job-{uuid.uuid4().hex[:8]}"

    await db.service_requests.insert_one(
        {
            "id": request_id,
            "customerId": "some-customer",
            "status": "in_progress",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    await db.inspection_jobs.insert_one(
        {
            "_id": job_id,
            "id": job_id,
            "requestId": request_id,
            "inspectorId": inspector_user_id,
            "status": "inspecting",
            "createdAt": datetime.now(timezone.utc).isoformat(),
        }
    )
    print(f"✓ seeded inspection_job _id={job_id} → requestId={request_id}")

    # Timeline rows. Include a `mark_confirmed` (provider commitment)
    # which the inspector projection MUST drop.
    now = datetime.now(timezone.utc)
    rows = [
        # 1. Inspector assignment with inspector meta whitelist test.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": request_id,
            "action": "mark_matched",
            "actorRole": "system",
            "actorId": "matcher",
            "fromStatus": "requested",
            "toStatus": "matched",
            "timestamp": now.isoformat(),
            "meta": {
                "reason": "Auto-assigned by routing",
                # Forbidden meta — must NOT surface.
                "customerNote": "should NOT leak to inspector",
                "platformCut": 999,
                "internalNotes": "admin only",
            },
        },
        # 2. Provider commitment — must be DROPPED from inspector view.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": request_id,
            "action": "mark_confirmed",
            "actorRole": "provider",
            "actorId": "some-provider",
            "fromStatus": "matched",
            "toStatus": "confirmed",
            "timestamp": (
                now.replace(microsecond=now.microsecond + 1)
            ).isoformat(),
            "meta": {},
        },
        # 3. Inspector's own travel.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": request_id,
            "action": "mark_on_route",
            "actorRole": "inspector",
            "actorId": inspector_user_id,
            "fromStatus": "confirmed",
            "toStatus": "on_route",
            "timestamp": (
                now.replace(microsecond=now.microsecond + 2)
            ).isoformat(),
            "meta": {"eta": "12 min"},
        },
        # 4. Inspector completion with reportId + inspectorPayoutAmount.
        {
            "id": f"tl-{uuid.uuid4().hex[:8]}",
            "bookingId": request_id,
            "action": "mark_completed",
            "actorRole": "inspector",
            "actorId": inspector_user_id,
            "fromStatus": "in_progress",
            "toStatus": "completed",
            "timestamp": (
                now.replace(microsecond=now.microsecond + 3)
            ).isoformat(),
            "meta": {
                "reportId": "RPT-abc12",
                "inspectorPayoutAmount": 65.00,
                # Forbidden — provider aggregate.
                "payoutAmount": 142.50,
                # Forbidden — admin-side comment.
                "internalNotes": "deep internal",
            },
        },
    ]
    await db.booking_timeline.insert_many(rows)
    print(f"✓ wrote {len(rows)} timeline rows (incl. mark_confirmed for drop test)")

    # ── 1. REST as assigned inspector ────────────────────────────
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{BACKEND}/api/inspector/jobs/{job_id}/timeline",
            headers={"Authorization": f"Bearer {inspector_token}"},
        )
        if r.status_code != 200:
            print(f"FAIL: GET inspector timeline → {r.status_code} {r.text}")
            return 1
        snap = r.json()

        # Wire-shape: only jobId surfaces.
        if "jobId" not in snap or snap["jobId"] != job_id:
            print(f"FAIL: missing/wrong jobId echo: {snap}")
            return 1
        if "requestId" in snap or "bookingId" in snap:
            print(f"FAIL: requestId/bookingId leaked in REST envelope: {snap}")
            return 1
        for e in snap["events"]:
            if "requestId" in e or "bookingId" in e:
                print(f"FAIL: requestId/bookingId leaked in event: {e}")
                return 1

        # `mark_confirmed` must be dropped.
        keys = [e["key"] for e in snap["events"]]
        if keys != ["assigned", "on_route", "completed"]:
            print(f"FAIL: expected [assigned, on_route, completed], got {keys}")
            return 1

        tones = [e["tone"] for e in snap["events"]]
        if tones != ["ready", "travel", "submitted"]:
            print(f"FAIL: expected tones [ready, travel, submitted], got {tones}")
            return 1

        # Meta whitelist assertions.
        assigned_meta = snap["events"][0]["meta"]
        on_route_meta = snap["events"][1]["meta"]
        completed_meta = snap["events"][2]["meta"]

        if assigned_meta.get("reason") != "Auto-assigned by routing":
            print(f"FAIL: reason not surfaced: {assigned_meta}")
            return 1
        for forbidden in ("customerNote", "platformCut", "internalNotes"):
            if forbidden in assigned_meta:
                print(f"FAIL: forbidden meta '{forbidden}' leaked: {assigned_meta}")
                return 1

        if on_route_meta.get("eta") != "12 min":
            print(f"FAIL: eta not surfaced: {on_route_meta}")
            return 1

        if completed_meta.get("reportId") != "RPT-abc12":
            print(f"FAIL: reportId not surfaced: {completed_meta}")
            return 1
        if completed_meta.get("inspectorPayoutAmount") not in (
            65.0, 65, "65.0", "65",
        ):
            print(f"FAIL: inspectorPayoutAmount missing/wrong: {completed_meta}")
            return 1
        for forbidden in ("payoutAmount", "internalNotes", "customerNote"):
            if forbidden in completed_meta:
                print(f"FAIL: forbidden meta '{forbidden}' leaked: {completed_meta}")
                return 1

        # isSelfAction discipline.
        if snap["events"][0]["isSelfAction"] is not False:
            print(f"FAIL: assigned should not be self (system actor)")
            return 1
        if snap["events"][1]["isSelfAction"] is not True:
            print(f"FAIL: on_route should be self")
            return 1
        if snap["events"][2]["isSelfAction"] is not True:
            print(f"FAIL: completed should be self")
            return 1

        print(f"✓ REST projection OK · keys={keys} tones={tones}")
        print(f"  · reportId=RPT-abc12, inspectorPayoutAmount=65.0 surfaced")
        print(f"  · provider payoutAmount, customerNote, platformCut, internalNotes filtered")
        print(f"  · mark_confirmed dropped (provider commitment not in inspector chronology)")
        print(f"  · No requestId/bookingId in envelope or events")

    # ── 2. Foreign caller (customer token) → 404 ─────────────────
    async with httpx.AsyncClient(timeout=30) as client:
        r = await client.get(
            f"{BACKEND}/api/inspector/jobs/{job_id}/timeline",
            headers={"Authorization": f"Bearer {customer_token}"},
        )
        if r.status_code != 404:
            print(f"FAIL: foreign caller expected 404, got {r.status_code}")
            return 1
        print(f"✓ Foreign caller (customer) → 404 (job opacity preserved)")

    # ── 3. WS handshake ─────────────────────────────────────────
    ws_url = f"{WS_BACKEND}/api/inspector/jobs/{job_id}/timeline/stream?token={inspector_token}"
    async with websockets.connect(ws_url) as ws:
        hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if hello.get("type") != "hello":
            print(f"FAIL: expected hello, got {hello}")
            return 1
        if hello.get("payload", {}).get("scope") != "inspector":
            print(f"FAIL: expected scope=inspector, got {hello}")
            return 1
        if hello.get("payload", {}).get("jobId") != job_id:
            print(f"FAIL: hello jobId mismatch: {hello}")
            return 1
        # `payload` MUST NOT echo bookingId/requestId
        payload = hello.get("payload", {})
        if "bookingId" in payload or "requestId" in payload:
            print(f"FAIL: WS hello payload leaked bookingId/requestId: {payload}")
            return 1
        print(f"✓ WS hello received · scope=inspector jobId={job_id}")
        print(f"  · payload does not echo bookingId or requestId")

        await ws.send("pong")
        pong = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if pong.get("type") != "pong":
            print(f"FAIL: expected pong, got {pong}")
            return 1
        print(f"✓ WS keepalive pong")

    # ── 4. Bad-token close ──────────────────────────────────────
    ws_url_bad = f"{WS_BACKEND}/api/inspector/jobs/{job_id}/timeline/stream?token=bogus"
    try:
        async with websockets.connect(ws_url_bad) as ws_bad:
            await asyncio.wait_for(ws_bad.recv(), timeout=3)
            print(f"FAIL: expected close on bad token, got message")
            return 1
    except Exception as exc:
        print(f"✓ WS bad-token rejected · {type(exc).__name__}")

    # Cleanup
    await db.inspection_jobs.delete_one({"_id": job_id})
    await db.service_requests.delete_one({"id": request_id})
    await db.booking_timeline.delete_many({"bookingId": request_id})
    print(f"✓ cleanup done")

    print(
        "\n✅ ALL CHECKS PASSED — inspector REST projection (jobId-only) + "
        "WS handshake + opacity + mark_confirmed drop + meta whitelist"
    )
    return 0


if __name__ == "__main__":
    sys.path.insert(0, os.path.dirname(__file__))
    raise SystemExit(asyncio.run(main()))
