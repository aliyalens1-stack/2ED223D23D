"""Chat Contract Normalization — backend tests.

Sprint B1 — `/api/chat/v1/*` canonical wire shape.

Test surface:
  1. Cross-thread access — user cannot read thread where not participant (403).
  2. Send message — only participant can send.
  3. Mark-read idempotent — second call is a no-op with `mutated: false`.
  4. Thread list returns only participant threads (no leakage).
  5. Unread summary is backend-derived (matches per-thread on demand).

NOT in scope (per sprint spec):
  - admin/support endpoints
  - attachments / voice / emoji / typing
  - websocket / UI rewrite

Each test seeds its own threads + messages tagged with a uuid so suites
can run in parallel safely.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from tests.conftest import BACKEND_URL, BYPASS_HEADERS, auth_headers


MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_thread(
    mongo,
    *,
    participant_user_id: str,
    kind: str = "support",
    provider_slug: str | None = None,
) -> str:
    tid = f"th-test-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": provider_slug,
        "bookingId": None,
        "title": f"Test thread {tid}",
        "lastMessage": "",
        "lastMessageAt": _now_iso(),
        "unreadByUser": False,
        "unreadByOther": False,
        "createdAt": _now_iso(),
    })
    return tid


async def _seed_message(
    mongo,
    *,
    thread_id: str,
    sender_type: str,
    sender_id: str,
    text: str,
) -> str:
    mid = f"msg-test-{uuid.uuid4().hex[:12]}"
    await mongo.chat_messages.insert_one({
        "id": mid,
        "threadId": thread_id,
        "senderType": sender_type,
        "senderId": sender_id,
        "type": "text",
        "text": text,
        "createdAt": _now_iso(),
        "readAt": None,
    })
    return mid


async def _cleanup_threads(mongo, tids: list[str]) -> None:
    if not tids:
        return
    await mongo.chat_threads.delete_many({"id": {"$in": tids}})
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})


# ─────────────────────────────────────────────────────────────────
# 1. Cross-thread access
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cannot_read_other_users_thread(mongo, customer_token):
    """Caller is `customer_token`; thread belongs to a stranger.
    GET /threads/{id}/messages → 403."""
    stranger_user_id = f"stranger-{uuid.uuid4().hex[:8]}"
    tid = await _make_thread(mongo, participant_user_id=stranger_user_id)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.get(
                f"/api/chat/v1/threads/{tid}/messages",
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 403, r.text
    finally:
        await _cleanup_threads(mongo, [tid])


@pytest.mark.asyncio
async def test_cannot_send_to_other_users_thread(mongo, customer_token):
    """Sending into a thread you don't participate in → 403, no message stored."""
    stranger_user_id = f"stranger-{uuid.uuid4().hex[:8]}"
    tid = await _make_thread(mongo, participant_user_id=stranger_user_id)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/chat/v1/threads/{tid}/messages",
                json={"body": "should never appear"},
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 403, r.text
        count = await mongo.chat_messages.count_documents({"threadId": tid})
        assert count == 0
    finally:
        await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# 2. Send happy path + canonical envelope
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_send_message_returns_canonical_envelope(
    mongo, customer_token, customer_user_id,
):
    tid = await _make_thread(mongo, participant_user_id=customer_user_id)
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/chat/v1/threads/{tid}/messages",
                json={"body": "hello canonical"},
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 200, r.text
        env = r.json()
        # Canonical message shape.
        msg = env["message"]
        assert msg["threadId"] == tid
        assert msg["senderKind"] == "user"
        assert msg["senderId"] == customer_user_id
        assert msg["type"] == "text"
        assert msg["body"] == "hello canonical"
        assert msg["isMine"] is True
        assert msg["readAt"] is None
        # Canonical thread shape (returned alongside).
        t = env["thread"]
        assert t["id"] == tid
        assert t["kind"] == "support"
        assert t["lastMessagePreview"] == "hello canonical"
        assert isinstance(t["participants"], list)
        # No unread for me (I just sent it; my own messages don't count).
        assert t["unreadByMe"] == 0
    finally:
        await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# 3. Mark-read idempotency
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_mark_read_is_idempotent(
    mongo, customer_token, customer_user_id,
):
    tid = await _make_thread(mongo, participant_user_id=customer_user_id)
    # Seed one incoming admin message → unread.
    await _seed_message(
        mongo, thread_id=tid, sender_type="admin", sender_id="admin", text="hello from support",
    )
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            # Confirm unread is 1.
            r0 = await c.get(
                f"/api/chat/v1/threads/{tid}/messages",
                headers=auth_headers(customer_token),
            )
            assert r0.status_code == 200, r0.text
            assert r0.json()["thread"]["unreadByMe"] == 1

            # First mark-read: mutates.
            r1 = await c.post(
                f"/api/chat/v1/threads/{tid}/read",
                headers=auth_headers(customer_token),
            )
            assert r1.status_code == 200, r1.text
            env1 = r1.json()
            assert env1["unreadByMe"] == 0
            assert env1["mutated"] is True

            # Second mark-read: nothing to flip → mutated=false.
            r2 = await c.post(
                f"/api/chat/v1/threads/{tid}/read",
                headers=auth_headers(customer_token),
            )
            assert r2.status_code == 200, r2.text
            env2 = r2.json()
            assert env2["unreadByMe"] == 0
            assert env2["mutated"] is False
    finally:
        await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# 4. Thread list returns only participant threads
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_thread_list_excludes_other_participants(
    mongo, customer_token, customer_user_id,
):
    mine = await _make_thread(mongo, participant_user_id=customer_user_id)
    stranger = await _make_thread(mongo, participant_user_id=f"stranger-{uuid.uuid4().hex[:8]}")
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.get(
                "/api/chat/v1/threads?limit=100",
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 200, r.text
        env = r.json()
        ids = {t["id"] for t in env["threads"]}
        assert mine in ids
        assert stranger not in ids
    finally:
        await _cleanup_threads(mongo, [mine, stranger])


# ─────────────────────────────────────────────────────────────────
# 5. Unread summary is backend-derived
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_unread_summary_matches_per_thread(
    mongo, customer_token, customer_user_id,
):
    tid_a = await _make_thread(mongo, participant_user_id=customer_user_id)
    tid_b = await _make_thread(mongo, participant_user_id=customer_user_id)
    # 2 unread admin messages on A, 1 on B.
    await _seed_message(mongo, thread_id=tid_a, sender_type="admin", sender_id="admin", text="a1")
    await _seed_message(mongo, thread_id=tid_a, sender_type="admin", sender_id="admin", text="a2")
    await _seed_message(mongo, thread_id=tid_b, sender_type="admin", sender_id="admin", text="b1")
    # Also seed an "outgoing" user message — must NOT count toward my unread.
    await _seed_message(mongo, thread_id=tid_a, sender_type="user", sender_id=customer_user_id, text="my own echo")
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.get(
                "/api/chat/v1/unread-summary",
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 200, r.text
        env = r.json()
        by_id = {row["threadId"]: row["unread"] for row in env["perThread"]}
        assert by_id.get(tid_a) == 2
        assert by_id.get(tid_b) == 1
        # totalUnread MUST equal the per-thread sum exactly.
        assert env["totalUnread"] == sum(row["unread"] for row in env["perThread"])
        assert env["totalUnread"] == 3
    finally:
        await _cleanup_threads(mongo, [tid_a, tid_b])


# ─────────────────────────────────────────────────────────────────
# Bonus: pagination cursor advances forward in time
# ─────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_messages_pagination_cursor(
    mongo, customer_token, customer_user_id,
):
    tid = await _make_thread(mongo, participant_user_id=customer_user_id)
    # Seed 5 messages.
    for i in range(5):
        await _seed_message(mongo, thread_id=tid, sender_type="admin", sender_id="admin", text=f"m{i}")
    try:
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r1 = await c.get(
                f"/api/chat/v1/threads/{tid}/messages",
                params={"limit": 3},
                headers=auth_headers(customer_token),
            )
            assert r1.status_code == 200, r1.text
            env1 = r1.json()
            assert len(env1["messages"]) == 3
            assert env1["nextCursor"] is not None
            r2 = await c.get(
                f"/api/chat/v1/threads/{tid}/messages",
                params={"limit": 3, "after": env1["nextCursor"]},
                headers=auth_headers(customer_token),
            )
            assert r2.status_code == 200, r2.text
            env2 = r2.json()
            # Remaining 2 messages on the second page; no nextCursor.
            assert len(env2["messages"]) == 2
            assert env2["nextCursor"] is None
            # No overlap.
            ids1 = {m["id"] for m in env1["messages"]}
            ids2 = {m["id"] for m in env2["messages"]}
            assert ids1.isdisjoint(ids2)
    finally:
        await _cleanup_threads(mongo, [tid])
