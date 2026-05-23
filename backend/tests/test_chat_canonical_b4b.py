"""Sprint B4b — Chat voice messages backend tests.

Covers the acceptance matrix from the B4b spec:

  POST /api/chat/v1/threads/{id}/voice (multipart upload)
    * Upload success (audio/mp4 ISO-BMFF blob)
    * Non-participant 403
    * Oversized 413 (> 12 MB)
    * Invalid mime 415 (audio/wav explicitly out for B4b)
    * Magic-byte mismatch 415 (mime says mp4 but bytes are PNG)
    * Duration missing 422 (FastAPI Form required)
    * Duration too long 422 (> 120000 ms)
    * Duration too short 422 (< 200 ms)
    * Admin on support thread 200 (implicit participation)
    * Admin on non-support without /support/join → 409, then 200 after join
    * Empty file 400

  Projection / wire shape
    * `type === 'voice'` and `voice` payload present
    * `voice.audioUrl == /api/chat/v1/voice/{id}`
    * `body` is empty for voice (caption explicitly excluded)
    * Caption form field is NOT exposed (we don't even send one — assert
      no body propagation if a stray caption form were attached)

  Unread + mark-read semantics (identical to text/attachment)
    * Peer sees thread.unreadByMe > 0 after upload
    * Mark-read mutates first call, no-op second call
    * Unread message count increments via /unread-summary

  GET /api/chat/v1/voice/{id}
    * Bearer header → 200, content matches
    * `?token=` query string → 200, content matches (no Authorization)
    * No auth → 401
    * Bad token → 401
    * Non-participant → 403
    * Wrong id → 404
    * Inline disposition + audio mime type round-tripped
"""
from __future__ import annotations

import hashlib
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


# ─────────────────────────────────────────────────────────────────
# Minimal valid blobs per accepted MIME. We craft just enough bytes
# for the magic-byte sniffer in `canonical._verify_magic_bytes` to
# pass: it inspects only the first 16 bytes.
# ─────────────────────────────────────────────────────────────────

# audio/mp4 + audio/m4a: ISO-BMFF — `ftyp` brand at offset 4. We pad
# with arbitrary bytes so the blob has non-trivial size (the sniffer
# only reads the first 16 bytes; the rest is opaque to the server).
M4A_MIN = b"\x00\x00\x00\x20ftypM4A \x00\x00\x00\x00M4A mp42isom" + b"\x00" * 256

# audio/webm: Matroska EBML header (\x1aE\xdf\xa3) at offset 0.
WEBM_MIN = b"\x1aE\xdf\xa3" + b"\x00" * 256

# audio/aac (ADTS): frame sync 0xFFF1 at offset 0.
AAC_MIN = b"\xff\xf1\x4c\x80" + b"\x00" * 256

# audio/mpeg: ID3 tag at offset 0 satisfies the sniffer.
MP3_MIN = b"ID3\x03\x00\x00\x00\x00\x00\x00" + b"\x00" * 256


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_thread(mongo, *, participant_user_id: str, kind: str = "support") -> str:
    tid = f"th-b4b-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": None,
        "bookingId": None,
        "title": f"B4b test {tid}",
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
    msgs = await mongo.chat_messages.find(
        {"threadId": {"$in": tids}}, {"voice.id": 1}
    ).to_list(length=1000)
    voice_ids = [m["voice"]["id"] for m in msgs if m.get("voice", {}).get("id")]
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})
    if voice_ids:
        await mongo.chat_voice.delete_many({"_id": {"$in": voice_ids}})


def _upload(
    c: httpx.AsyncClient,
    tid: str,
    *,
    token: str,
    content: bytes,
    filename: str = "voice.m4a",
    content_type: str = "audio/mp4",
    duration_ms: int | None = 1500,
):
    files = {"file": (filename, content, content_type)}
    data: dict = {}
    if duration_ms is not None:
        data["duration_ms"] = str(duration_ms)
    return c.post(
        f"/api/chat/v1/threads/{tid}/voice",
        files=files,
        data=data,
        headers=auth_headers(token),
    )


# ─────────────────────────────────────────────────────────────────
# Upload — happy paths
# ─────────────────────────────────────────────────────────────────

class TestUploadHappyPaths:
    @pytest.mark.asyncio
    async def test_upload_m4a_envelope(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=30.0) as c:
                r = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                  filename="hi.m4a", content_type="audio/mp4",
                                  duration_ms=3200)
            assert r.status_code == 200, r.text
            env = r.json()
            assert "message" in env and "thread" in env
            m = env["message"]
            assert m["type"] == "voice"
            # Voice MUST NOT carry a caption (spec explicit).
            assert m["body"] == ""
            v = m["voice"]
            assert v["mimeType"] == "audio/mp4"
            assert v["durationMs"] == 3200
            assert v["sizeBytes"] == len(M4A_MIN)
            assert v["audioUrl"] == f"/api/chat/v1/voice/{v['id']}"
            # Storage persisted with same id.
            doc = await mongo.chat_voice.find_one({"_id": v["id"]})
            assert doc and doc["durationMs"] == 3200 and doc["sizeBytes"] == len(M4A_MIN)
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_upload_webm_kind(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r = await _upload(c, tid, token=customer_token, content=WEBM_MIN,
                                  filename="v.webm", content_type="audio/webm",
                                  duration_ms=1800)
            assert r.status_code == 200, r.text
            v = r.json()["message"]["voice"]
            assert v["mimeType"] == "audio/webm"
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_upload_aac_kind(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r = await _upload(c, tid, token=customer_token, content=AAC_MIN,
                                  filename="v.aac", content_type="audio/aac",
                                  duration_ms=900)
            assert r.status_code == 200, r.text
            assert r.json()["message"]["voice"]["mimeType"] == "audio/aac"
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_upload_mp3_kind(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                r = await _upload(c, tid, token=customer_token, content=MP3_MIN,
                                  filename="v.mp3", content_type="audio/mpeg",
                                  duration_ms=2200)
            assert r.status_code == 200, r.text
            assert r.json()["message"]["voice"]["mimeType"] == "audio/mpeg"
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Upload — error paths (MIME / size / duration / participant)
# ─────────────────────────────────────────────────────────────────

class TestUploadErrors:
    @pytest.mark.asyncio
    async def test_invalid_mime_wav_415(self, mongo, customer_token, customer_user_id):
        # WAV is explicitly excluded from B4b ("No WAV initially").
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=b"RIFF" + b"\x00" * 100,
                                  filename="v.wav", content_type="audio/wav",
                                  duration_ms=1500)
            assert r.status_code == 415, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_invalid_mime_html_415(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=b"<html/>",
                                  filename="x.html", content_type="text/html",
                                  duration_ms=1500)
            assert r.status_code == 415, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_magic_bytes_mismatch_415(self, mongo, customer_token, customer_user_id):
        # Wire content-type claims audio/mp4 but bytes are PNG — magic-byte
        # sniffer must reject. Defence-in-depth on top of the MIME allowlist.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            png = bytes.fromhex("89504e470d0a1a0a") + b"\x00" * 64
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=png,
                                  filename="fake.m4a", content_type="audio/mp4",
                                  duration_ms=1500)
            assert r.status_code == 415, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_oversize_413(self, mongo, customer_token, customer_user_id):
        # 12 MB + 1 = oversize. Streaming size guard must abort before
        # the full body materialises.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            # Keep the 16-byte ftyp header so it would pass the sniffer
            # IF the size check let it through. The streaming guard runs
            # first, so 413 is the expected outcome regardless.
            big = M4A_MIN[:16] + b"\x00" * (12 * 1024 * 1024 + 1)
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=120.0) as c:
                r = await _upload(c, tid, token=customer_token, content=big,
                                  filename="big.m4a", content_type="audio/mp4",
                                  duration_ms=5000)
            assert r.status_code == 413, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_duration_missing_422(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=None)  # explicit omit
            assert r.status_code == 422, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_duration_too_long_422(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=120 * 1000 + 1)
            assert r.status_code == 422, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_duration_too_short_422(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                # Below 200 ms floor — fat-finger / accidental tap.
                r = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=50)
            assert r.status_code == 422, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_empty_file_400(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=b"",
                                  filename="empty.m4a", content_type="audio/mp4",
                                  duration_ms=1000)
            assert r.status_code == 400, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_non_participant_provider_403(
        self, mongo, provider_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=provider_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=1500)
            assert r.status_code == 403, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_admin_non_support_without_join_409(
        self, mongo, admin_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=admin_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=1500)
            assert r.status_code == 409, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_admin_on_support_thread_200(
        self, mongo, admin_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=admin_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=1500)
            assert r.status_code == 200, r.text
            assert r.json()["message"]["senderKind"] == "admin"
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_admin_after_join_200(
        self, mongo, admin_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="provider")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                jr = await c.post(
                    f"/api/chat/v1/threads/{tid}/support/join",
                    headers=auth_headers(admin_token),
                )
                assert jr.status_code == 200, jr.text
                r = await _upload(c, tid, token=admin_token, content=M4A_MIN,
                                  filename="v.m4a", content_type="audio/mp4",
                                  duration_ms=1500)
            assert r.status_code == 200, r.text
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Projection assertions via GET /threads/{id}/messages
# ─────────────────────────────────────────────────────────────────

class TestProjection:
    @pytest.mark.asyncio
    async def test_voice_projection_via_get_messages(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=4200)
                assert up.status_code == 200, up.text
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
            assert gr.status_code == 200
            msgs = gr.json()["messages"]
            voice_msgs = [m for m in msgs if m["type"] == "voice"]
            assert len(voice_msgs) == 1
            m = voice_msgs[0]
            assert m["body"] == ""
            v = m["voice"]
            assert v["audioUrl"] == f"/api/chat/v1/voice/{v['id']}"
            assert v["durationMs"] == 4200
            assert v["sizeBytes"] == len(M4A_MIN)
            assert v["mimeType"] == "audio/mp4"
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_last_message_preview_is_voice_label(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=65 * 1000)  # 1:05
                assert up.status_code == 200, up.text
            t = await mongo.chat_threads.find_one({"id": tid})
            # Preview should mention a voice marker — server-side label.
            assert "🎤" in (t.get("lastMessage") or "")
            assert "1:05" in (t.get("lastMessage") or "")
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Unread + mark-read after voice messages
# ─────────────────────────────────────────────────────────────────

class TestUnreadAndMarkRead:
    @pytest.mark.asyncio
    async def test_unread_and_markread_after_upload(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                assert up.status_code == 200, up.text

                t = await mongo.chat_threads.find_one({"id": tid})
                assert t["unreadByOther"] is True

                # Admin sees thread.unreadByMe > 0
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(admin_token),
                )
                assert gr.status_code == 200
                assert gr.json()["thread"]["unreadByMe"] > 0

                # /unread-summary reflects increment too
                us = await c.get(
                    "/api/chat/v1/unread-summary",
                    headers=auth_headers(admin_token),
                )
                assert us.status_code == 200
                per = {x["threadId"]: x["unread"] for x in us.json()["perThread"]}
                assert per.get(tid, 0) >= 1

                # Mark-read idempotency
                m1 = await c.post(
                    f"/api/chat/v1/threads/{tid}/read",
                    headers=auth_headers(admin_token),
                )
                assert m1.status_code == 200
                assert m1.json()["mutated"] is True
                m2 = await c.post(
                    f"/api/chat/v1/threads/{tid}/read",
                    headers=auth_headers(admin_token),
                )
                assert m2.status_code == 200
                assert m2.json()["mutated"] is False
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# GET /voice/{id} — auth, access, content
# ─────────────────────────────────────────────────────────────────

class TestServeVoice:
    @pytest.mark.asyncio
    async def test_serve_bearer_200_and_md5_roundtrip(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}",
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 200, r.text
            assert r.headers.get("content-type", "").startswith("audio/")
            assert "inline" in r.headers.get("content-disposition", "")
            assert hashlib.md5(r.content).hexdigest() == hashlib.md5(M4A_MIN).hexdigest()
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_token_query_200(
        self, mongo, customer_token, customer_user_id,
    ):
        # Web `<audio src>` and RN expo-av loaders can't set Authorization
        # headers — the ?token= fallback is the canonical workaround.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}?token={customer_token}",
                    headers=BYPASS_HEADERS or None,
                )
            assert r.status_code == 200, r.text
            assert r.content == M4A_MIN
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_no_auth_401(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}",
                    headers=BYPASS_HEADERS or None,
                )
            assert r.status_code == 401, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_invalid_token_401(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}",
                    headers={**(BYPASS_HEADERS or {}),
                             "Authorization": "Bearer not.a.jwt"},
                )
            assert r.status_code == 401, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_non_participant_403(
        self, mongo, customer_token, provider_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                # Provider is not a participant of customer's support thread.
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}",
                    headers=auth_headers(provider_token),
                )
            assert r.status_code == 403, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_wrong_id_404(self, customer_token):
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.get(
                f"/api/chat/v1/voice/does-not-exist-{uuid.uuid4().hex}",
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 404, r.status_code

    @pytest.mark.asyncio
    async def test_admin_support_thread_playback(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # Admin must be able to play back voice in a support thread —
        # the "Admin support thread playback" line of the spec matrix.
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=M4A_MIN,
                                   duration_ms=1500)
                vid = up.json()["message"]["voice"]["id"]
                # Admin GET via Bearer — admin is implicit participant on
                # type=support threads, no /support/join required.
                r = await c.get(
                    f"/api/chat/v1/voice/{vid}",
                    headers=auth_headers(admin_token),
                )
            assert r.status_code == 200, r.text
            assert r.content == M4A_MIN
        finally:
            await _cleanup(mongo, [tid])
