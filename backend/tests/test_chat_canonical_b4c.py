"""Sprint B4c — Chat reactions backend tests.

Critical invariants verified here (per B4c doctrine):
  * Reactions DO NOT bump unread (`unreadByUser` / `unreadByOther` / `unreadByMe`)
  * Reactions DO NOT bump thread.lastMessageAt / lastMessage preview
  * Reactions DO NOT reorder threads in the list endpoint
  * Reactions DO NOT generate system messages or notifications
  * Canonical projection NEVER leaks user-id arrays — only
    `{emoji, count, reactedByMe}` is on the wire
  * Atomic toggle is race-safe: N parallel POSTs collapse to count==1
    (set semantics via `$addToSet`)
  * Idempotent: re-POST after present, re-DELETE after absent → no-op
  * Emoji whitelist enforced (422 on anything outside the 6 glyphs)
  * Participant gate (403 on non-participants)
  * Admin on support thread participates without `/support/join`
"""
from __future__ import annotations

import asyncio
import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from tests.conftest import BACKEND_URL, auth_headers, BYPASS_HEADERS

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

# Mirrors the backend whitelist in `app/chat/canonical.py:_REACTION_WHITELIST`.
WHITELIST = ("👍", "❤️", "😂", "😮", "😢", "👎")


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_thread(mongo, *, participant_user_id: str, kind: str = "support") -> str:
    tid = f"th-b4c-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": None,
        "bookingId": None,
        "title": f"B4c test {tid}",
        "lastMessage": "",
        "lastMessageAt": _now_iso(),
        "unreadByUser": False,
        "unreadByOther": False,
        "createdAt": _now_iso(),
    })
    return tid


async def _send_text(c: httpx.AsyncClient, tid: str, token: str, body: str = "hi") -> str:
    r = await c.post(
        f"/api/chat/v1/threads/{tid}/messages",
        json={"body": body},
        headers=auth_headers(token),
    )
    assert r.status_code == 200, r.text
    return r.json()["message"]["id"]


async def _cleanup(mongo, tids: list[str]) -> None:
    if not tids:
        return
    await mongo.chat_threads.delete_many({"id": {"$in": tids}})
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})


# ─────────────────────────────────────────────────────────────────
# Happy paths
# ─────────────────────────────────────────────────────────────────

class TestAddAndRemove:
    @pytest.mark.asyncio
    async def test_add_returns_projection(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 200, r.text
            body = r.json()
            assert body["ok"] is True
            assert body["messageId"] == mid
            assert body["reactions"] == [{"emoji": "👍", "count": 1, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_add_then_remove_zeroes(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "❤️"},
                    headers=auth_headers(customer_token),
                )
                rd = await c.delete(
                    f"/api/chat/v1/messages/{mid}/reactions/{'❤️'}",
                    headers=auth_headers(customer_token),
                )
            assert rd.status_code == 200, rd.text
            assert rd.json()["reactions"] == []
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_double_add_idempotent(self, mongo, customer_token, customer_user_id):
        # Same user POSTing twice in a row → still count == 1.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                for _ in range(2):
                    r = await c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": "😂"},
                        headers=auth_headers(customer_token),
                    )
                    assert r.status_code == 200, r.text
                assert r.json()["reactions"] == [{"emoji": "😂", "count": 1, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_double_remove_idempotent(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                # Two DELETEs on something never set — no error, no count.
                for _ in range(2):
                    r = await c.delete(
                        f"/api/chat/v1/messages/{mid}/reactions/{'👎'}",
                        headers=auth_headers(customer_token),
                    )
                    assert r.status_code == 200, r.text
                assert r.json()["reactions"] == []
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Critical invariant — atomic parallel toggle race
# ─────────────────────────────────────────────────────────────────

class TestParallelRace:
    @pytest.mark.asyncio
    async def test_parallel_adds_same_user_count_is_one(
        self, mongo, customer_token, customer_user_id,
    ):
        # Spec line 5: "Two toggle одновременно от одного user: итог либо
        # ON либо OFF, но никогда duplicated count." We fire 8 simultaneous
        # adds and the final count must be 1 (set semantics via $addToSet).
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                results = await asyncio.gather(*[
                    c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": "👍"},
                        headers=auth_headers(customer_token),
                    )
                    for _ in range(8)
                ])
                for r in results:
                    assert r.status_code == 200, r.text
                # Read storage directly: invariant is on the SET length,
                # not just the projection.
                msg = await mongo.chat_messages.find_one({"id": mid})
                ids = (msg.get("reactions") or {}).get("👍") or []
                assert len(ids) == 1, f"parallel addToSet produced {len(ids)} entries"
                # Projection mirrors storage.
                last = results[-1].json()
                assert last["reactions"] == [{"emoji": "👍", "count": 1, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_parallel_adds_distinct_users_no_dup(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Two different reactor identities → final count = 2 with distinct
        # storage entries. Tests the no-collapse invariant in the other
        # direction: $addToSet must NOT dedupe across reactors.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                # 4 customer + 4 admin, fully parallel.
                ops = []
                for _ in range(4):
                    ops.append(c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": "😮"},
                        headers=auth_headers(customer_token),
                    ))
                    ops.append(c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": "😮"},
                        headers=auth_headers(admin_token),
                    ))
                results = await asyncio.gather(*ops)
                for r in results:
                    assert r.status_code == 200, r.text
                msg = await mongo.chat_messages.find_one({"id": mid})
                ids = (msg.get("reactions") or {}).get("😮") or []
                assert len(set(ids)) == 2, f"distinct reactors collapsed: {ids!r}"
                assert len(ids) == 2  # no duplicates either
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Critical invariant — reactions do NOT affect thread state
# ─────────────────────────────────────────────────────────────────

class TestThreadStateInvariants:
    @pytest.mark.asyncio
    async def test_reactions_do_not_bump_unread(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Customer posts message → admin sees unreadByMe=1.
        # Customer marks-read for themselves (no-op for admin side).
        # Admin reacts. After admin's reaction: customer's unreadByMe
        # MUST stay 0. Otherwise reactions are masquerading as messages.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)

                # Admin marks-read to baseline at zero unread for admin.
                await c.post(
                    f"/api/chat/v1/threads/{tid}/read",
                    headers=auth_headers(admin_token),
                )

                # Now: admin reacts on customer's message.
                rr = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(admin_token),
                )
                assert rr.status_code == 200, rr.text

                # CUSTOMER's perspective: thread.unreadByMe must remain 0.
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
                assert gr.status_code == 200
                assert gr.json()["thread"]["unreadByMe"] == 0, (
                    "reaction must not generate an unread bump for the peer"
                )

                # Storage flags also untouched.
                t = await mongo.chat_threads.find_one({"id": tid})
                assert t.get("unreadByUser") in (False, None)
                assert t.get("unreadByOther") in (False, None)
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_reactions_do_not_bump_last_message_at(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token, body="anchor msg")
                t_before = await mongo.chat_threads.find_one({"id": tid})
                last_at_before = t_before["lastMessageAt"]
                preview_before = t_before["lastMessage"]

                # Wait a beat so any accidental write would be visible.
                await asyncio.sleep(0.05)

                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "❤️"},
                    headers=auth_headers(admin_token),
                )
                assert r.status_code == 200, r.text

                t_after = await mongo.chat_threads.find_one({"id": tid})
                assert t_after["lastMessageAt"] == last_at_before, (
                    "reactions must not bump thread.lastMessageAt"
                )
                assert t_after["lastMessage"] == preview_before, (
                    "reactions must not rewrite thread.lastMessage preview"
                )
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_reactions_do_not_reorder_threads(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Two threads under the same admin scope (support).
        # t_old has an older lastMessageAt; we react on its message.
        # The thread listing must still rank t_new BEFORE t_old.
        t_old = await _make_thread(mongo, participant_user_id=customer_user_id,
                                   kind="support")
        await asyncio.sleep(0.05)
        t_new = await _make_thread(mongo, participant_user_id=customer_user_id,
                                   kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                old_mid = await _send_text(c, t_old, customer_token, body="OLD")
                await asyncio.sleep(0.05)
                await _send_text(c, t_new, customer_token, body="NEW")
                await asyncio.sleep(0.05)

                # React on the OLDER thread's message.
                rr = await c.post(
                    f"/api/chat/v1/messages/{old_mid}/reactions",
                    json={"emoji": "😢"},
                    headers=auth_headers(admin_token),
                )
                assert rr.status_code == 200, rr.text

                gl = await c.get(
                    "/api/chat/v1/threads",
                    headers=auth_headers(admin_token),
                )
                assert gl.status_code == 200, gl.text
                ids = [t["id"] for t in gl.json()["threads"]]
                # t_new MUST appear before t_old — reaction on t_old did
                # NOT promote it to the top.
                assert ids.index(t_new) < ids.index(t_old), (
                    f"reaction reordered threads: {ids!r}"
                )
        finally:
            await _cleanup(mongo, [t_old, t_new])

    @pytest.mark.asyncio
    async def test_reactions_do_not_generate_system_messages(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                msg_count_before = await mongo.chat_messages.count_documents({"threadId": tid})
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(admin_token),
                )
                msg_count_after = await mongo.chat_messages.count_documents({"threadId": tid})
            assert msg_count_after == msg_count_before, (
                "reaction must not add any new message row (system or otherwise)"
            )
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Critical invariant — projection abstraction boundary
# ─────────────────────────────────────────────────────────────────

class TestProjection:
    @pytest.mark.asyncio
    async def test_projection_never_leaks_user_ids(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Wire response keys: only {emoji, count, reactedByMe}.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(customer_token),
                )
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(admin_token),
                )
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
            assert gr.status_code == 200, gr.text
            msg = [m for m in gr.json()["messages"] if m["id"] == mid][0]
            reactions = msg["reactions"]
            assert reactions == [{"emoji": "👍", "count": 2, "reactedByMe": True}]
            # Defensive: the projection MUST NOT carry user-id arrays.
            for row in reactions:
                assert set(row.keys()) == {"emoji", "count", "reactedByMe"}, (
                    f"reaction projection leaked extra keys: {row.keys()}"
                )

            # Same projection from admin's perspective: reactedByMe still True
            # (admin also reacted), count==2.
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c2:
                gr2 = await c2.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(admin_token),
                )
            msg2 = [m for m in gr2.json()["messages"] if m["id"] == mid][0]
            assert msg2["reactions"] == [{"emoji": "👍", "count": 2, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_reacted_by_me_perspective_specific(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Only admin reacts. Customer's projection: reactedByMe=False.
        # Admin's projection: reactedByMe=True. Same underlying row.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                rr = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "❤️"},
                    headers=auth_headers(admin_token),
                )
                assert rr.status_code == 200
                cust = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
                admin_view = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(admin_token),
                )
            cust_m = [m for m in cust.json()["messages"] if m["id"] == mid][0]
            admin_m = [m for m in admin_view.json()["messages"] if m["id"] == mid][0]
            assert cust_m["reactions"] == [{"emoji": "❤️", "count": 1, "reactedByMe": False}]
            assert admin_m["reactions"] == [{"emoji": "❤️", "count": 1, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_sort_order_count_desc_then_whitelist_index(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                # 1 customer + 1 admin on 👎 (count=2). 1 customer on 👍 (count=1).
                # Expected order: 👎 (2) then 👍 (1).
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👎"},
                    headers=auth_headers(customer_token),
                )
                await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👎"},
                    headers=auth_headers(admin_token),
                )
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(customer_token),
                )
            emojis = [row["emoji"] for row in r.json()["reactions"]]
            assert emojis == ["👎", "👍"], emojis
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Validation & access control
# ─────────────────────────────────────────────────────────────────

class TestValidationAndAccess:
    @pytest.mark.asyncio
    async def test_unknown_emoji_422(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                mid = await _send_text(c, tid, customer_token)
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "🔥"},  # not on the whitelist
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 422, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_skin_tone_emoji_422(self, mongo, customer_token, customer_user_id):
        # 👍🏽 is composed (👍 + skin tone modifier). It MUST be rejected:
        # the whitelist is the raw glyph only.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                mid = await _send_text(c, tid, customer_token)
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍🏽"},
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 422, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_non_participant_403(
        self, mongo, customer_token, provider_token, customer_user_id,
    ):
        # Customer's support thread — provider is not a participant.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                mid = await _send_text(c, tid, customer_token)
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(provider_token),
                )
            assert r.status_code == 403, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_message_not_found_404(self, customer_token):
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.post(
                f"/api/chat/v1/messages/does-not-exist-{uuid.uuid4().hex}/reactions",
                json={"emoji": "👍"},
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 404, r.text

    @pytest.mark.asyncio
    async def test_admin_on_support_thread_200(
        self, mongo, admin_token, customer_token, customer_user_id,
    ):
        # Admin reacts on a customer message in a support thread — no
        # `/support/join` required (admin is implicit on support).
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                mid = await _send_text(c, tid, customer_token)
                r = await c.post(
                    f"/api/chat/v1/messages/{mid}/reactions",
                    json={"emoji": "👍"},
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 200, r.text
            assert r.json()["reactions"] == [{"emoji": "👍", "count": 1, "reactedByMe": True}]
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_all_six_whitelisted_emojis_accepted(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                mid = await _send_text(c, tid, customer_token)
                for emoji in WHITELIST:
                    r = await c.post(
                        f"/api/chat/v1/messages/{mid}/reactions",
                        json={"emoji": emoji},
                        headers=auth_headers(customer_token),
                    )
                    assert r.status_code == 200, (emoji, r.text)
                rs = r.json()["reactions"]
                assert {row["emoji"] for row in rs} == set(WHITELIST)
                assert all(row["count"] == 1 and row["reactedByMe"] for row in rs)
        finally:
            await _cleanup(mongo, [tid])
