"""Sprint B5 — Realtime transport (WebSocket) backend tests.

Critical invariants (per B5 spec):
  * WS and REST envelopes are **byte-compatible** for shared fields.
    `new_message.payload` matches the REST `{message, thread}` response.
    `reaction_update.payload.reactions` matches `_project_reactions(...)`.
  * Hub is read-side ONLY. The WS connection NEVER mutates DB; we
    confirm by sending text frames and observing they're echoed as
    `pong` and never produce side effects.
  * Participation gate identical to REST: non-participants get NO
    events for threads they're not in.
  * Disconnect recovery: a closed socket doesn't leak subscribers
    (hub.size returns to baseline).
  * No-duplicate-projection: when the same mutation is observed by
    BOTH the WS feed and a subsequent polling refresh, the message id
    is identical and the projection bytes are identical (so client
    dedupe by id is correct).

Allowed event types (B5 scope-locked):
  hello · ping · pong · new_message · reaction_update · thread_update · unread_update
"""
from __future__ import annotations

import asyncio
import json
import os
import uuid
from datetime import datetime, timezone
from urllib.parse import quote

import httpx
import pytest
import pytest_asyncio
import websockets
from motor.motor_asyncio import AsyncIOMotorClient

from tests.conftest import BACKEND_URL, auth_headers

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

WS_URL = BACKEND_URL.replace("http://", "ws://").replace("https://", "wss://")


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_thread(mongo, *, participant_user_id: str, kind: str = "support") -> str:
    tid = f"th-b5-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": None,
        "bookingId": None,
        "title": f"B5 test {tid}",
        "lastMessage": "",
        "lastMessageAt": _now_iso(),
        "unreadByUser": False,
        "unreadByOther": False,
        "createdAt": _now_iso(),
    })
    return tid


async def _cleanup(mongo, tids: list[str]) -> None:
    if not tids:
        return
    await mongo.chat_threads.delete_many({"id": {"$in": tids}})
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})


async def _connect(token: str):
    """Open WS, swallow the `hello` frame, return the open connection."""
    url = f"{WS_URL}/api/chat/v1/ws?token={quote(token)}"
    ws = await websockets.connect(url, open_timeout=10, close_timeout=5)
    hello = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
    assert hello["type"] == "hello", hello
    return ws


async def _next_event(ws, timeout: float = 5.0) -> dict:
    raw = await asyncio.wait_for(ws.recv(), timeout=timeout)
    return json.loads(raw)


async def _next_event_of_type(ws, want: str, timeout: float = 5.0) -> dict:
    """Drain incidental ping/pong frames until the next semantic event."""
    deadline = asyncio.get_event_loop().time() + timeout
    while True:
        remaining = max(0.05, deadline - asyncio.get_event_loop().time())
        ev = await _next_event(ws, timeout=remaining)
        if ev["type"] == want:
            return ev
        if ev["type"] in ("ping", "pong", "hello"):
            continue
        # Different semantic event — unexpected for this test.
        raise AssertionError(f"expected {want}, got {ev}")


# ─────────────────────────────────────────────────────────────────
# Connect / auth
# ─────────────────────────────────────────────────────────────────

class TestConnectAndAuth:
    @pytest.mark.asyncio
    async def test_connect_emits_hello(self, customer_token):
        url = f"{WS_URL}/api/chat/v1/ws?token={quote(customer_token)}"
        async with websockets.connect(url, open_timeout=10) as ws:
            ev = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
            assert ev["type"] == "hello"
            assert ev["payload"]["role"] == "customer"

    @pytest.mark.asyncio
    async def test_missing_token_rejected(self):
        url = f"{WS_URL}/api/chat/v1/ws"
        with pytest.raises(websockets.exceptions.WebSocketException):
            async with websockets.connect(url, open_timeout=5) as ws:
                # Server closes before accept — recv must raise.
                await ws.recv()

    @pytest.mark.asyncio
    async def test_bad_token_rejected(self):
        url = f"{WS_URL}/api/chat/v1/ws?token=not.a.jwt"
        with pytest.raises(websockets.exceptions.WebSocketException):
            async with websockets.connect(url, open_timeout=5) as ws:
                await ws.recv()

    @pytest.mark.asyncio
    async def test_client_frame_echoed_as_pong(self, customer_token):
        ws = await _connect(customer_token)
        try:
            await ws.send("ping")
            ev = await _next_event(ws, timeout=3)
            assert ev["type"] == "pong"
        finally:
            await ws.close()


# ─────────────────────────────────────────────────────────────────
# Envelope byte-compatibility — the cornerstone of B5
# ─────────────────────────────────────────────────────────────────

class TestEnvelopeByteCompatibility:
    @pytest.mark.asyncio
    async def test_new_message_ws_matches_rest_envelope(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            ws = await _connect(customer_token)
            try:
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                    r = await c.post(
                        f"/api/chat/v1/threads/{tid}/messages",
                        json={"body": "hello realtime"},
                        headers=auth_headers(customer_token),
                    )
                assert r.status_code == 200, r.text
                rest_envelope = r.json()  # { message, thread }

                ev = await _next_event_of_type(ws, "new_message")
                ws_payload = ev["payload"]

                # Same `message` projection, same `thread` projection.
                # We compare field-by-field — order in the dict can
                # differ across runtimes but values must match.
                assert ws_payload["message"] == rest_envelope["message"], (
                    f"ws message ≠ rest message:\n{json.dumps(ws_payload['message'], indent=2)}\n"
                    f"vs\n{json.dumps(rest_envelope['message'], indent=2)}"
                )
                assert ws_payload["thread"] == rest_envelope["thread"]
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_reaction_update_payload_matches_rest(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                sm = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "react please"},
                    headers=auth_headers(customer_token),
                )
                mid = sm.json()["message"]["id"]

            ws = await _connect(customer_token)
            try:
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                    rr = await c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": "👍"},
                        headers=auth_headers(customer_token),
                    )
                assert rr.status_code == 200, rr.text
                rest_reactions = rr.json()["reactions"]

                ev = await _next_event_of_type(ws, "reaction_update")
                assert ev["payload"]["messageId"] == mid
                assert ev["payload"]["threadId"] == tid
                assert ev["payload"]["reactions"] == rest_reactions
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_unread_update_emitted_on_mark_read(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "ping admin"},
                    headers=auth_headers(customer_token),
                )

            ws = await _connect(admin_token)
            try:
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                    mr = await c.post(
                        f"/api/chat/v1/threads/{tid}/read",
                        headers=auth_headers(admin_token),
                    )
                    assert mr.status_code == 200 and mr.json()["mutated"] is True
                ev = await _next_event_of_type(ws, "unread_update")
                # Admin marked as read → admin's projection now shows unreadByMe=0.
                assert ev["payload"]["thread"]["unreadByMe"] == 0
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Participation gate — non-participants must not receive events
# ─────────────────────────────────────────────────────────────────

class TestParticipationGate:
    @pytest.mark.asyncio
    async def test_non_participant_gets_no_events(
        self, mongo, customer_token, provider_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            # Provider connects but is NOT a participant of this support thread.
            ws = await _connect(provider_token)
            try:
                # Drive a mutation from the customer side.
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                    r = await c.post(
                        f"/api/chat/v1/threads/{tid}/messages",
                        json={"body": "secret"},
                        headers=auth_headers(customer_token),
                    )
                    assert r.status_code == 200

                # Give the hub a beat to fanout. We expect NO new_message
                # frame for this provider. Either a server ping or
                # timeout is the success condition.
                with pytest.raises(asyncio.TimeoutError):
                    await _next_event_of_type(ws, "new_message", timeout=2.0)
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Disconnect / recovery — no leaks, polling is the source-of-truth
# ─────────────────────────────────────────────────────────────────

class TestDisconnectRecovery:
    @pytest.mark.asyncio
    async def test_repeated_connect_disconnect_no_server_corruption(
        self, customer_token, mongo, customer_user_id,
    ):
        # The hub lives inside the uvicorn process; we can't inspect
        # its in-memory state from the test process. Instead we treat
        # subscriber cleanup as a black-box: after N quick churns,
        # the server must (a) accept a fresh connection, (b) still
        # fanout events to it correctly, (c) keep REST working.
        for _ in range(5):
            ws = await _connect(customer_token)
            await ws.close()

        # A fresh connection still gets a `hello` and the next
        # mutation fans out to it — proving the hub isn't stuck on
        # zombie sockets.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            ws = await _connect(customer_token)
            try:
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                    r = await c.post(
                        f"/api/chat/v1/threads/{tid}/messages",
                        json={"body": "post-churn"},
                        headers=auth_headers(customer_token),
                    )
                    assert r.status_code == 200
                ev = await _next_event_of_type(ws, "new_message")
                assert ev["payload"]["message"]["body"] == "post-churn"
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_messages_during_disconnect_recoverable_via_rest(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # The doctrine: WS is acceleration, REST is recovery.
        # During disconnect, messages still land canonically; the
        # client recovers state by polling GET /threads/{id}/messages.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            # Customer's WS is NOT connected during the admin's send.
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                send = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "while you were offline"},
                    headers=auth_headers(admin_token),
                )
                assert send.status_code == 200
                # The customer reconnects (or just polls). REST returns
                # the message it would have received over WS.
                pol = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
            assert pol.status_code == 200
            bodies = [m["body"] for m in pol.json()["messages"] if m["type"] == "text"]
            assert "while you were offline" in bodies
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# No duplicate projection — WS + polling converge on same bytes
# ─────────────────────────────────────────────────────────────────

class TestNoDuplicateProjection:
    @pytest.mark.asyncio
    async def test_ws_message_id_matches_rest_listing(
        self, mongo, customer_token, customer_user_id,
    ):
        # Client uses message.id for dedupe. If WS and REST produce the
        # same id and the same bytes for that id, deduplication is a
        # no-op merge regardless of arrival order. This is the
        # "no-dup" invariant in concrete form.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            ws = await _connect(customer_token)
            try:
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                    r = await c.post(
                        f"/api/chat/v1/threads/{tid}/messages",
                        json={"body": "dedupe-me"},
                        headers=auth_headers(customer_token),
                    )
                rest_msg = r.json()["message"]
                ev = await _next_event_of_type(ws, "new_message")
                ws_msg = ev["payload"]["message"]

                # Same id, same bytes — client merge by id is idempotent.
                assert ws_msg["id"] == rest_msg["id"]
                assert ws_msg == rest_msg

                # And the polling endpoint will surface the same id-bytes pair.
                async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                    poll = await c.get(
                        f"/api/chat/v1/threads/{tid}/messages",
                        headers=auth_headers(customer_token),
                    )
                same = [m for m in poll.json()["messages"] if m["id"] == ws_msg["id"]]
                assert len(same) == 1
                assert same[0] == ws_msg
            finally:
                await ws.close()
        finally:
            await _cleanup(mongo, [tid])
