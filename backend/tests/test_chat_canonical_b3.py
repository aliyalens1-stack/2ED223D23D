"""Sprint B3 — Admin Support / Dispute backend tests.

Covers:
  B3.1 — canonical admin participation projection (participants[].kind='admin',
         senderDisplayName, support/system labels).
  B3.2 — POST /api/chat/v1/threads/{id}/support/join (admin-only, idempotent,
         emits ONE 'support_joined' system message, sets adminJoined=true).
  B3.3 — POST /api/chat/v1/threads/{id}/dispute (participant-only, admin gets 409,
         idempotent, sets disputeOpen + disputeOpenedAt, emits 'dispute_opened',
         fans out customer_disputed notification).
  B3.4 — GET /api/chat/v1/threads as admin returns threads with type=support
         OR adminJoined=true OR disputeOpen=true.

Guardrails:
  - Admin send without join on non-support thread → 409.
  - Admin send after join → 200 with canonical envelope.
  - Non-participant → 403 on messages GET/POST and dispute POST.
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timezone

import httpx
import pytest
import pytest_asyncio
from motor.motor_asyncio import AsyncIOMotorClient

from tests.conftest import BACKEND_URL, auth_headers


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
    tid = f"th-b3-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": provider_slug,
        "bookingId": None,
        "title": f"B3 test thread {tid}",
        "lastMessage": "",
        "lastMessageAt": _now_iso(),
        "unreadByUser": False,
        "unreadByOther": False,
        "createdAt": _now_iso(),
    })
    return tid


async def _cleanup_threads(mongo, tids: list[str]) -> None:
    if not tids:
        return
    await mongo.chat_threads.delete_many({"id": {"$in": tids}})
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})
    await mongo.timeline_events.delete_many({"metadata.threadId": {"$in": tids}})


# ─────────────────────────────────────────────────────────────────
# B3.2 — Support join
# ─────────────────────────────────────────────────────────────────

class TestSupportJoin:
    @pytest.mark.asyncio
    async def test_support_join_admin_only(self, mongo, admin_token, customer_token, customer_user_id):
        """Non-admin caller on /support/join → 403."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 403, r.text
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_support_join_idempotent_first_call_mutates(self, mongo, admin_token, customer_user_id):
        """First admin join on provider-kind thread: mutated=true, emits ONE system msg, sets adminJoined."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r1 = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert r1.status_code == 200, r1.text
                env1 = r1.json()
                assert env1["mutated"] is True
                assert env1["thread"]["adminJoined"] is True

                # Second call — idempotent.
                r2 = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert r2.status_code == 200, r2.text
                env2 = r2.json()
                assert env2["mutated"] is False
                assert env2["thread"]["adminJoined"] is True

            # Exactly ONE 'support_joined' system message exists.
            sys_count = await mongo.chat_messages.count_documents({
                "threadId": tid,
                "type": "system",
                "body": "support_joined",
            })
            assert sys_count == 1
            # adminJoined flag set on thread doc.
            t = await mongo.chat_threads.find_one({"id": tid})
            assert t["adminJoined"] is True
            assert t.get("adminJoinedAt")
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_support_join_on_support_kind_no_new_message(self, mongo, admin_token, customer_user_id):
        """Joining a type=support thread (admin implicit) returns mutated=false and emits no extra system msg."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert r.status_code == 200
                assert r.json()["mutated"] is False
            sys_count = await mongo.chat_messages.count_documents({
                "threadId": tid, "type": "system", "body": "support_joined",
            })
            assert sys_count == 0
        finally:
            await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# B3.3 — Dispute
# ─────────────────────────────────────────────────────────────────

class TestDispute:
    @pytest.mark.asyncio
    async def test_dispute_by_participant_user_happy_path(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r1 = await c.post(
                    f"/api/chat/v1/threads/{tid}/dispute",
                    headers=auth_headers(customer_token),
                )
                assert r1.status_code == 200, r1.text
                env1 = r1.json()
                assert env1["mutated"] is True
                assert env1["thread"]["disputeOpen"] is True
                assert env1["thread"]["disputeOpenedAt"]

                # Idempotency.
                r2 = await c.post(
                    f"/api/chat/v1/threads/{tid}/dispute",
                    headers=auth_headers(customer_token),
                )
                assert r2.status_code == 200, r2.text
                assert r2.json()["mutated"] is False

            # System message emitted exactly once.
            sys_count = await mongo.chat_messages.count_documents({
                "threadId": tid, "type": "system", "body": "dispute_opened",
            })
            assert sys_count == 1

            # Thread persisted dispute fields.
            t = await mongo.chat_threads.find_one({"id": tid})
            assert t["disputeOpen"] is True
            assert t.get("disputeOpenedAt")
            assert t.get("disputeOpenedByKind") == "user"
            assert t.get("disputeOpenedById") == customer_user_id

            # Timeline event was projected (customer_disputed).
            te = await mongo.timeline_events.find_one({
                "kind": "customer_disputed",
                "metadata.threadId": tid,
            })
            assert te is not None
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_dispute_admin_forbidden_409(self, mongo, admin_token, customer_user_id):
        """Admin trying to open a dispute on someone's behalf → 409."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/dispute",
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 409, r.text
            assert "behalf" in r.text.lower() or "cannot" in r.text.lower()
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_dispute_non_participant_403(self, mongo, provider_token, customer_user_id):
        """Provider trying to open dispute on a customer's support thread (where provider is not participant) → 403."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/dispute",
                    headers=auth_headers(provider_token),
                )
            assert r.status_code == 403, r.text
        finally:
            await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Admin send-message gating (B3.2 guardrail)
# ─────────────────────────────────────────────────────────────────

class TestAdminSendGating:
    @pytest.mark.asyncio
    async def test_admin_send_without_join_409(self, mongo, admin_token, customer_user_id):
        """Admin POST messages on non-support thread without prior /support/join → 409."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "should be blocked"},
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 409, r.text
            assert "support/join" in r.text or "join" in r.text
            count = await mongo.chat_messages.count_documents({
                "threadId": tid, "senderType": "admin",
            })
            assert count == 0
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_admin_send_after_join_200_with_envelope(
        self, mongo, admin_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                # Join first.
                jr = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert jr.status_code == 200, jr.text
                # Send.
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "admin replying"},
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 200, r.text
            env = r.json()
            assert env["message"]["senderKind"] == "admin"
            assert env["message"]["body"] == "admin replying"
            # senderDisplayName should be populated for admin.
            assert env["message"].get("senderDisplayName") == "AutoSearch Support"
            # Thread envelope reflects admin participation.
            participant_kinds = {p["kind"] for p in env["thread"]["participants"]}
            assert "admin" in participant_kinds
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_admin_send_on_support_thread_no_join_needed(
        self, mongo, admin_token, customer_user_id,
    ):
        """Admin can send on type=support thread without explicit /join (implicit participation)."""
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "support hi"},
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 200, r.text
            assert r.json()["message"]["senderKind"] == "admin"
        finally:
            await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# B3.4 — Admin inbox scope
# ─────────────────────────────────────────────────────────────────

class TestAdminInboxScope:
    @pytest.mark.asyncio
    async def test_admin_list_includes_support_joined_dispute(
        self, mongo, admin_token, customer_token, customer_user_id,
    ):
        # 3 threads: support (in), provider with adminJoined (in after join),
        # provider with dispute (in after dispute), provider plain (out).
        t_support = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        t_admin = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        t_disp = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        t_plain = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                # admin joins t_admin.
                jr = await c.post(
                    f"/api/chat/v1/threads/{t_admin}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert jr.status_code == 200, jr.text
                # customer opens dispute on t_disp.
                dr = await c.post(
                    f"/api/chat/v1/threads/{t_disp}/dispute",
                    headers=auth_headers(customer_token),
                )
                assert dr.status_code == 200, dr.text
                # admin list.
                r = await c.get(
                    "/api/chat/v1/threads?limit=100",
                    headers=auth_headers(admin_token),
                )
                assert r.status_code == 200, r.text
                ids = {t["id"] for t in r.json()["threads"]}
                assert t_support in ids
                assert t_admin in ids
                assert t_disp in ids
                assert t_plain not in ids
        finally:
            await _cleanup_threads(mongo, [t_support, t_admin, t_disp, t_plain])


# ─────────────────────────────────────────────────────────────────
# B3.1 — Canonical projection assertions (deeper)
# ─────────────────────────────────────────────────────────────────

class TestCanonicalProjection:
    @pytest.mark.asyncio
    async def test_system_messages_have_stable_codes(
        self, mongo, admin_token, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                await c.post(
                    f"/api/chat/v1/threads/{tid}/dispute",
                    headers=auth_headers(customer_token),
                )
                r = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages?limit=100",
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 200, r.text
            msgs = r.json()["messages"]
            sys_msgs = [m for m in msgs if m["type"] == "system"]
            bodies = [m["body"] for m in sys_msgs]
            assert "support_joined" in bodies
            assert "dispute_opened" in bodies
        finally:
            await _cleanup_threads(mongo, [tid])

    @pytest.mark.asyncio
    async def test_participants_include_admin_kind_after_join(
        self, mongo, admin_token, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                # Before join — no admin in participants.
                r0 = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
                kinds_before = {p["kind"] for p in r0.json()["thread"]["participants"]}
                assert "admin" not in kinds_before

                await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                r1 = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
                t = r1.json()["thread"]
                kinds_after = {p["kind"] for p in t["participants"]}
                assert "admin" in kinds_after
                admin_p = next(p for p in t["participants"] if p["kind"] == "admin")
                assert admin_p["displayName"] == "AutoSearch Support"
        finally:
            await _cleanup_threads(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Cross-cutting 403 (non-participant) on canonical surfaces
# ─────────────────────────────────────────────────────────────────

class TestNonParticipantForbidden:
    @pytest.mark.asyncio
    async def test_provider_403_on_messages_get_and_post(
        self, mongo, provider_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id, kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                rg = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(provider_token),
                )
                assert rg.status_code == 403, rg.text
                rp = await c.post(
                    f"/api/chat/v1/threads/{tid}/messages",
                    json={"body": "nope"},
                    headers=auth_headers(provider_token),
                )
                assert rp.status_code == 403, rp.text
        finally:
            await _cleanup_threads(mongo, [tid])
