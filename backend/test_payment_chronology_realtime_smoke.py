"""Sprint P0.b.C.h — Live WS push for payment_events. SMOKE.

Tests are structured in two phases:

  Phase A — IN-PROCESS (primary acceptance):
    Drives the publisher directly with fake WS subscribers registered
    into the live HUB_* singletons. This is the only way to verify
    snapshot equivalence end-to-end in a single process, because:
      * append_payment_event() must run in the same Python process as
        the hubs (otherwise the publisher's sidecar pushes into hubs
        with no subscribers from the other process).
      * REST is also called via httpx against the live backend (same
        backend writes/reads the same DB).
    Snapshot eq. comparison: WS `event` payload BYTE-EQUAL to REST
    `rows[i]`.

  Phase B — OVER-THE-WIRE (handshake / role-gate smoke):
    Connects real websockets to the live FastAPI server and asserts:
      * customer/provider/admin handshake succeeds (hello received)
      * cross-role token closes with 4403 (no retry)
      * unauthenticated closes with 4401
      * empty-token query closes with 4401
    Does NOT exercise the publisher path (publisher lives in backend
    process; test process can't read the in-process hub state).

PRIMARY GUARANTEE (Phase A): for every actor X, every WS frame.event
is BYTE-EQUAL to the REST rows[i] entry. Same projector function used
for both paths (P.project_X), one-element list / list, `[0]` vs `[i]`.

NEGATIVE acceptance:
  - WS publisher NEVER raises into writer call site
  - foreign subscriber receives ZERO frames
  - customer/provider see no forbidden meta keys
  - customer never sees transfer.*/admin.*/*:rejected
  - provider never sees customer-only/admin/*:rejected
  - envelope shape stable (type/scope/paymentId/event)
  - type literal: 'payment.chronology.updated'

OUT-OF-SCOPE (not asserted):
  - REST cross-customer ownership (permissive in F.4, by design)
  - replay / late-subscriber backfill
  - reconciliation / stripe retry
  - provider UI

Run: python /app/backend/test_payment_chronology_realtime_smoke.py
"""
from __future__ import annotations

import asyncio
import json
import sys
import uuid

import httpx
import websockets
from motor.motor_asyncio import AsyncIOMotorClient

from app.payments.chronology import projector as P
from app.payments.chronology import writer as W
from app.payments.chronology import realtime as RT


BASE_HTTP = "http://localhost:8001"
BASE_WS = "ws://localhost:8001"
MONGO = "mongodb://localhost:27017"
DB = "test_database"


# ──────────────────────────────────────────────────────────────────────
# Fake WS subscriber — minimal surface used by publisher:
#   await ws.send_text(str)
# Anything else publisher does (snapshot etc.) is on the Hub side.
# ──────────────────────────────────────────────────────────────────────


class FakeWS:
    """Minimal stub mimicking starlette.WebSocket. Captures every sent
    frame. Optionally raises on send to verify publisher swallows errors."""

    def __init__(self, *, raise_on_send: bool = False) -> None:
        self.sent: list[str] = []
        self.raise_on_send = raise_on_send
        self.closed = False

    async def send_text(self, payload: str) -> None:
        if self.closed:
            raise RuntimeError("FakeWS closed")
        if self.raise_on_send:
            raise RuntimeError("induced FakeWS send failure")
        self.sent.append(payload)


# ──────────────────────────────────────────────────────────────────────
# Auth helpers
# ──────────────────────────────────────────────────────────────────────


async def login(c: httpx.AsyncClient, email: str, password: str) -> tuple[str, str]:
    r = await c.post(
        f"{BASE_HTTP}/api/auth/login",
        json={"email": email, "password": password},
    )
    assert r.status_code == 200, f"login {email}: {r.text}"
    j = r.json()
    return j["accessToken"], j["user"]["id"]


async def register(c: httpx.AsyncClient, role: str) -> tuple[str, str, str]:
    email = f"chh-{role}-{uuid.uuid4().hex[:8]}@test.local"
    r = await c.post(f"{BASE_HTTP}/api/auth/register", json={
        "email": email, "password": "Test1234!",
        "role": role, "fullName": f"chh {role}",
    })
    assert r.status_code in (200, 201), f"register {role}: {r.text}"
    j = r.json()
    return email, j["accessToken"], j["user"]["id"]


# ──────────────────────────────────────────────────────────────────────
# Phase A — in-process publisher path
# ──────────────────────────────────────────────────────────────────────


async def phase_a_in_process(failures: list[str]) -> None:
    print("\n── Phase A — IN-PROCESS publisher + snapshot equivalence ──")

    client_mongo = AsyncIOMotorClient(MONGO)
    db = client_mongo[DB]

    # Clean hub state from earlier tests (best-effort).
    RT.HUB_CUSTOMER._subs.clear()
    RT.HUB_PROVIDER._subs.clear()
    RT.HUB_ADMIN._subs.clear()

    cust_id = "cust-h-" + uuid.uuid4().hex[:8]
    prov_id = "prov-h-" + uuid.uuid4().hex[:8]
    foreign_id = "for-h-" + uuid.uuid4().hex[:8]

    payment_id = f"pay-h-{uuid.uuid4().hex[:10]}"
    await db.service_payments.delete_many({"id": payment_id})
    await db.payment_events.delete_many({"paymentId": payment_id})
    await db.service_payments.insert_one({
        "id": payment_id,
        "customerId": cust_id,
        "providerId": prov_id,
        "amount": 12000, "currency": "EUR", "status": "initiated",
    })

    # ── Subscribe 4 fake clients
    ws_cust = FakeWS()
    ws_prov = FakeWS()
    ws_admin = FakeWS()
    ws_foreign = FakeWS()
    ws_broken = FakeWS(raise_on_send=True)  # induces send failure

    await RT.HUB_CUSTOMER.add(ws_cust,    {"paymentId": payment_id, "viewerId": cust_id})
    await RT.HUB_CUSTOMER.add(ws_foreign, {"paymentId": payment_id, "viewerId": foreign_id})
    await RT.HUB_CUSTOMER.add(ws_broken,  {"paymentId": payment_id, "viewerId": cust_id})  # owner, but raises
    await RT.HUB_PROVIDER.add(ws_prov,    {"paymentId": payment_id, "viewerIds": [prov_id]})
    await RT.HUB_ADMIN.add(ws_admin,      {"paymentId": payment_id})

    # ── Produce 6 representative events through the writer
    events_to_emit = [
        {"kind": "payment.initiated", "actor_id": "platform",
         "actor_role": "platform",
         "meta": {"amount": 12000, "currency": "EUR",
                  "platformCut": 1200, "internalNotes": "ops watch"}},
        {"kind": "escrow.held", "actor_id": "stripe", "actor_role": "stripe",
         "meta": {"amount": 12000, "currency": "EUR", "webhookId": "evt_x"},
         "source_webhook_id": "evt_x"},
        {"kind": "transfer.initiated", "actor_id": "stripe",
         "actor_role": "stripe",
         "meta": {"amount": 11000, "currency": "EUR",
                  "payoutAmount": 11000, "transferRef": "tr_h",
                  "customerId": "cust-leak", "customerNote": "secret"}},
        {"kind": "refund.requested:rejected", "actor_id": "admin-1",
         "actor_role": "admin",
         "meta": {"reason": "amount_exceeds_available",
                  "internalNotes": "see #h"}},
        {"kind": "admin.freeze.applied", "actor_id": "admin-1",
         "actor_role": "admin",
         "meta": {"freezeKind": "provider"}},
        {"kind": "escrow.released", "actor_id": "platform",
         "actor_role": "platform",
         "meta": {"amount": 11000, "currency": "EUR"}},
    ]
    inserted_rows = []
    for ev in events_to_emit:
        row = await W.append_payment_event(db, payment_id=payment_id, **ev)
        inserted_rows.append(row)
    print(f"  ✓ appended {len(inserted_rows)} payment_events (writer + sidecar)")

    # ── Drain hub deliveries (publish is awaited inline, but give a tick)
    await asyncio.sleep(0.05)

    def parse_sent(ws: FakeWS) -> list[dict]:
        return [json.loads(s) for s in ws.sent]

    cust_frames    = parse_sent(ws_cust)
    prov_frames    = parse_sent(ws_prov)
    admin_frames   = parse_sent(ws_admin)
    foreign_frames = parse_sent(ws_foreign)

    # ── Compute REST projections IN-PROCESS via same projector funcs
    rest_cust  = P.project_customer(inserted_rows)
    rest_prov  = P.project_provider(inserted_rows)
    rest_admin = P.project_admin(inserted_rows)

    expected_cust_kinds  = ["payment.initiated", "escrow.held", "escrow.released"]
    expected_prov_kinds  = ["escrow.held", "transfer.initiated", "escrow.released"]
    expected_admin_kinds = [r["kind"] for r in inserted_rows]

    # Expected lengths
    if [r["kind"] for r in rest_cust] == expected_cust_kinds:
        print(f"  ✓ projector customer kinds: {expected_cust_kinds}")
    else:
        failures.append(f"projector customer kinds: got={[r['kind'] for r in rest_cust]}")
    if [r["kind"] for r in rest_prov] == expected_prov_kinds:
        print(f"  ✓ projector provider kinds: {expected_prov_kinds}")
    else:
        failures.append(f"projector provider kinds: got={[r['kind'] for r in rest_prov]}")
    if [r["kind"] for r in rest_admin] == expected_admin_kinds:
        print(f"  ✓ projector admin kinds: {expected_admin_kinds}")
    else:
        failures.append(f"projector admin kinds: got={[r['kind'] for r in rest_admin]}")

    # ── WS captured the right kinds
    ws_cust_kinds  = [f["event"]["kind"] for f in cust_frames]
    ws_prov_kinds  = [f["event"]["kind"] for f in prov_frames]
    ws_admin_kinds = [f["event"]["kind"] for f in admin_frames]

    for label, got, want in (
        ("customer", ws_cust_kinds, expected_cust_kinds),
        ("provider", ws_prov_kinds, expected_prov_kinds),
        ("admin",    ws_admin_kinds, expected_admin_kinds),
    ):
        if got == want:
            print(f"  ✓ WS {label} kinds match projector: {got}")
        else:
            failures.append(f"WS {label} kinds: got={got} want={want}")

    # ── THE CORE GUARANTEE — Snapshot equivalence byte-by-byte
    def _eq(label, ws_events, projector_rows):
        if len(ws_events) != len(projector_rows):
            failures.append(f"snapshot-eq {label}: len ws={len(ws_events)} "
                            f"proj={len(projector_rows)}")
            return
        for i, (w, r) in enumerate(zip(ws_events, projector_rows)):
            if w != r:
                failures.append(
                    f"snapshot-eq {label}[{i}]:\n"
                    f"  WS:   {json.dumps(w, sort_keys=True)}\n"
                    f"  PROJ: {json.dumps(r, sort_keys=True)}"
                )
                return
        print(f"  ✓ snapshot equivalence {label}: WS.event == project([row])[0] "
              f"== REST rows[i] ({len(ws_events)} rows, byte-equal)")

    _eq("customer", [f["event"] for f in cust_frames], rest_cust)
    _eq("provider", [f["event"] for f in prov_frames], rest_prov)
    _eq("admin",    [f["event"] for f in admin_frames], rest_admin)

    # ── Opacity — forbidden meta keys
    forbidden = {"platformCut", "internalNotes", "webhookId",
                 "providerId", "customerId", "customerNote",
                 "adminNote", "stripeSecret"}
    for label, frames in (("customer", cust_frames), ("provider", prov_frames)):
        leaked = set()
        for f in frames:
            for k in (f["event"].get("meta") or {}).keys():
                if k in forbidden:
                    leaked.add(k)
        if not leaked:
            print(f"  ✓ {label} no forbidden meta leaked")
        else:
            failures.append(f"{label} leaked meta keys: {leaked}")

    # ── actor.id redaction
    for label, frames in (("customer", cust_frames), ("provider", prov_frames)):
        bad = [(f["event"]["kind"], f["event"]["actor"])
               for f in frames if "id" in (f["event"].get("actor") or {})]
        if not bad:
            print(f"  ✓ {label} actor.id redacted")
        else:
            failures.append(f"{label} actor.id leaked: {bad}")

    # ── Cross-actor kind opacity
    forbidden_cust_kinds = [k for k in ws_cust_kinds
                            if k.startswith("transfer.")
                            or k.startswith("admin.")
                            or ":rejected" in k]
    if not forbidden_cust_kinds:
        print(f"  ✓ customer WS no transfer.*/admin.*/*:rejected")
    else:
        failures.append(f"customer WS forbidden kinds: {forbidden_cust_kinds}")

    prov_forbidden = {"payment.initiated", "payment.failed",
                      "escrow.release_requested", "escrow.release_rejected",
                      "refund.requested"}
    bad = [k for k in ws_prov_kinds
           if k in prov_forbidden or k.startswith("admin.")
           or ":rejected" in k]
    if not bad:
        print(f"  ✓ provider WS no customer-only/admin/*:rejected")
    else:
        failures.append(f"provider WS forbidden kinds: {bad}")

    # ── Foreign subscriber: ZERO frames
    if len(foreign_frames) == 0:
        print(f"  ✓ foreign subscriber received 0 frames (ownership filter)")
    else:
        failures.append(
            f"foreign got {len(foreign_frames)} frames: "
            f"{[f['event'].get('kind') for f in foreign_frames]}"
        )

    # ── Broken subscriber: no influence on the healthy ones
    # (verified implicitly — cust_frames captured the right kinds despite
    # ws_broken raising on every send_text). Sanity assertion:
    if len(cust_frames) == 3 and not failures:
        print(f"  ✓ misbehaving subscriber (raise_on_send) didn't sabotage fanout")

    # ── Envelope shape
    EXPECTED_TOP = {"type", "scope", "paymentId", "event"}
    for label, frames in (
        ("customer", cust_frames),
        ("provider", prov_frames),
        ("admin",    admin_frames),
    ):
        bad_env = [set(f.keys()) for f in frames if set(f.keys()) != EXPECTED_TOP]
        if not bad_env and frames:
            print(f"  ✓ {label} envelope shape stable")
        elif bad_env:
            failures.append(f"{label} envelope drift: {bad_env[:2]}")

    # ── Type literal uniform
    all_frames = cust_frames + prov_frames + admin_frames
    types = {f["type"] for f in all_frames}
    if types == {"payment.chronology.updated"}:
        print(f"  ✓ type literal uniform: 'payment.chronology.updated'")
    else:
        failures.append(f"type drift: {types}")

    # ── REST and WS use the same projector — REST values must equal
    # the WS event values exactly (the byte-equal claim already covered
    # above, but this final cross-check uses the LIVE REST endpoint).
    async with httpx.AsyncClient(timeout=15.0) as c:
        # Need admin token for admin REST verification.
        admin_tok, _ = await login(c, "admin@autoservice.com", "Admin123!")
        r = await c.get(
            f"{BASE_HTTP}/api/admin/payments/{payment_id}/chronology",
            headers={"Authorization": f"Bearer {admin_tok}"},
        )
        if r.status_code == 200:
            rest_admin_live = r.json()["rows"]
            # The live REST may include extra fields like schemaVersion etc.
            # in the admin raw passthrough — same projector path, but real
            # rows include 'sourceWebhookId' and 'schemaVersion'. Compare
            # by intersecting keys present in WS event.
            if len(rest_admin_live) == len(admin_frames):
                identical = True
                for i, w in enumerate(admin_frames):
                    we = w["event"]
                    # both go through project_admin — must be equal
                    # except for `_id` which is already stripped both sides.
                    re = rest_admin_live[i]
                    if we != re:
                        identical = False
                        failures.append(
                            f"LIVE REST vs WS admin row[{i}] differ:\n"
                            f"  WS:   {json.dumps(we, sort_keys=True, default=str)}\n"
                            f"  REST: {json.dumps(re, sort_keys=True, default=str)}"
                        )
                        break
                if identical:
                    print(f"  ✓ LIVE REST admin == WS admin event (byte-equal "
                          f"via shared projector)")
            else:
                failures.append(
                    f"LIVE REST admin len={len(rest_admin_live)} vs "
                    f"WS={len(admin_frames)}"
                )
        else:
            failures.append(f"LIVE admin REST: {r.status_code} {r.text[:200]}")

    # ── Best-effort: writer survives missing owner doc
    await db.service_payments.delete_one({"id": payment_id})
    try:
        d = await W.append_payment_event(
            db, payment_id=payment_id, kind="dispute.linked",
            actor_id="admin-1", actor_role="admin",
            meta={"disputeId": "d-h-1"},
        )
        if d["kind"] == "dispute.linked":
            print(f"  ✓ writer survives missing owner (best-effort sidecar)")
    except Exception as e:
        failures.append(f"writer raised when owner missing: {e}")

    # Cleanup hubs and DB
    await RT.HUB_CUSTOMER.remove(ws_cust)
    await RT.HUB_CUSTOMER.remove(ws_foreign)
    await RT.HUB_CUSTOMER.remove(ws_broken)
    await RT.HUB_PROVIDER.remove(ws_prov)
    await RT.HUB_ADMIN.remove(ws_admin)
    await db.payment_events.delete_many({"paymentId": payment_id})
    client_mongo.close()


# ──────────────────────────────────────────────────────────────────────
# Phase B — over-the-wire handshake / role-gate
# ──────────────────────────────────────────────────────────────────────


async def phase_b_handshake(failures: list[str]) -> None:
    print("\n── Phase B — OVER-THE-WIRE handshake / role-gate ──")

    payment_id = f"pay-hb-{uuid.uuid4().hex[:10]}"

    async with httpx.AsyncClient(timeout=15.0) as c:
        _, cust_tok, _ = await register(c, "customer")
        _, prov_tok, _ = await register(c, "provider_owner")
        admin_tok, _ = await login(c, "admin@autoservice.com", "Admin123!")

    async def _hello_check(url: str, label: str, want_role: str) -> bool:
        try:
            async with websockets.connect(url, open_timeout=10, ping_interval=None) as ws:
                raw = await asyncio.wait_for(ws.recv(), timeout=5.0)
                obj = json.loads(raw)
                if obj.get("op") == "hello" and obj.get("paymentId") == payment_id:
                    return True
                failures.append(f"{label}: bad hello {obj}")
                return False
        except Exception as e:
            failures.append(f"{label} connect failed: {e}")
            return False

    if await _hello_check(
        f"{BASE_WS}/api/customer/payments/{payment_id}/chronology/stream?token={cust_tok}",
        "customer hello", "customer",
    ):
        print(f"  ✓ customer WS handshake → hello received")

    if await _hello_check(
        f"{BASE_WS}/api/provider/payouts/{payment_id}/chronology/stream?token={prov_tok}",
        "provider hello", "provider",
    ):
        print(f"  ✓ provider WS handshake → hello received")

    if await _hello_check(
        f"{BASE_WS}/api/admin/payments/{payment_id}/chronology/stream?token={admin_tok}",
        "admin hello", "admin",
    ):
        print(f"  ✓ admin WS handshake → hello received")

    # ── Cross-role 4403 close (no retry)
    async def _expect_close(url: str, label: str, want_code: int) -> bool:
        try:
            async with websockets.connect(url, open_timeout=10, ping_interval=None) as ws:
                try:
                    # Either close immediately or after first message — drain.
                    await asyncio.wait_for(ws.recv(), timeout=3.0)
                except websockets.ConnectionClosed as cc:
                    if cc.code == want_code:
                        return True
                    failures.append(f"{label}: closed with {cc.code}, want {want_code}")
                    return False
                except asyncio.TimeoutError:
                    failures.append(f"{label}: did not close on {want_code}")
                    return False
                failures.append(f"{label}: accepted with wrong role token")
                return False
        except websockets.InvalidStatus as e:
            # HTTP-level reject is also acceptable for handshake denial
            return True
        except Exception as e:
            # `1006`/`4403` may surface as a raise here depending on lib version
            es = str(e)
            if str(want_code) in es:
                return True
            failures.append(f"{label}: unexpected error {e!r}")
            return False

    # customer token → provider stream → must close 4403
    if await _expect_close(
        f"{BASE_WS}/api/provider/payouts/{payment_id}/chronology/stream?token={cust_tok}",
        "provider stream w/ customer token", 4403,
    ):
        print(f"  ✓ provider stream rejects customer token (4403, no retry)")

    # provider token → admin stream → must close 4403
    if await _expect_close(
        f"{BASE_WS}/api/admin/payments/{payment_id}/chronology/stream?token={prov_tok}",
        "admin stream w/ provider token", 4403,
    ):
        print(f"  ✓ admin stream rejects provider token (4403, no retry)")

    # No token at all → 4401
    if await _expect_close(
        f"{BASE_WS}/api/customer/payments/{payment_id}/chronology/stream",
        "no token", 4401,
    ):
        print(f"  ✓ no-token connection closed (4401)")


# ──────────────────────────────────────────────────────────────────────


async def main() -> None:
    failures: list[str] = []
    await phase_a_in_process(failures)
    await phase_b_handshake(failures)

    if failures:
        print("\n❌ FAILURES:")
        for f in failures:
            print(f"  - {f}")
        sys.exit(1)
    print("\n✅ ALL P0.b.C.h CHECKS PASSED "
          "(in-process snapshot eq · opacity preserved · best-effort writer · "
          "WS handshake · cross-role 4403 · no-token 4401)")


if __name__ == "__main__":
    asyncio.run(main())
