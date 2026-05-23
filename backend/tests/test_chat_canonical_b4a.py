"""Sprint B4a — Chat attachments backend tests.

Covers acceptance gates from the B4a spec:
  * POST /api/chat/v1/threads/{id}/attachments (multipart upload)
      - image / pdf / file kind classification
      - 415 invalid MIME, 413 oversize, 400 empty
      - 403 non-participant
      - 409 admin on non-support without /support/join, then 200 after join
      - 200 admin on support thread (implicit)
      - caption propagated to message.body (max 500 chars)
      - unread semantics (peer sees unreadByMe > 0)
      - markRead works on attachment messages (mutated=True first call)
  * GET /api/chat/v1/attachments/{id}
      - Bearer header auth → 200
      - ?token=<jwt> auth → 200
      - no auth → 401
      - bad token → 401
      - non-participant → 403
      - wrong id → 404
      - bytes round-trip identical (md5)
      - projection fields (id, kind, url, filename, mimeType, sizeBytes)
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

# Real 1x1 transparent PNG (sufficient to satisfy any naive sniffers; the
# backend uses content-type, not magic bytes, but using a valid PNG makes
# the md5 round-trip assertion meaningful).
PNG_1x1 = bytes.fromhex(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489"
    "0000000d49444154789c6300010000000500010d0a2db40000000049454e44ae426082"
)

PDF_MIN = (
    b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\n"
    b"xref\n0 3\n0000000000 65535 f \n0000000015 00000 n \n0000000060 00000 n \n"
    b"trailer<</Size 3/Root 1 0 R>>\nstartxref\n110\n%%EOF\n"
)


@pytest_asyncio.fixture
async def mongo():
    client = AsyncIOMotorClient(MONGO_URL)
    db = client[DB_NAME]
    yield db
    client.close()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


async def _make_thread(mongo, *, participant_user_id: str, kind: str = "support") -> str:
    tid = f"th-b4a-{uuid.uuid4().hex[:12]}"
    await mongo.chat_threads.insert_one({
        "id": tid,
        "type": kind,
        "participantUserId": participant_user_id,
        "providerSlug": None,
        "bookingId": None,
        "title": f"B4a test {tid}",
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
        {"threadId": {"$in": tids}}, {"attachment.id": 1}
    ).to_list(length=1000)
    attach_ids = [m["attachment"]["id"] for m in msgs if m.get("attachment", {}).get("id")]
    await mongo.chat_messages.delete_many({"threadId": {"$in": tids}})
    if attach_ids:
        await mongo.chat_attachments.delete_many({"_id": {"$in": attach_ids}})


def _upload(c: httpx.AsyncClient, tid: str, *, token: str, content: bytes,
            filename: str, content_type: str, caption: str | None = None):
    files = {"file": (filename, content, content_type)}
    data = {"caption": caption} if caption is not None else None
    return c.post(
        f"/api/chat/v1/threads/{tid}/attachments",
        files=files,
        data=data,
        headers=auth_headers(token),
    )


# ─────────────────────────────────────────────────────────────────
# Upload — happy paths (image / pdf / file)
# ─────────────────────────────────────────────────────────────────

class TestUploadHappyPaths:
    @pytest.mark.asyncio
    async def test_upload_image_png_envelope(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=30.0) as c:
                r = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                  filename="pixel.png", content_type="image/png",
                                  caption="hello image")
            assert r.status_code == 200, r.text
            env = r.json()
            assert "message" in env and "thread" in env
            m = env["message"]
            assert m["type"] == "attachment"
            assert m["body"] == "hello image"  # caption → body
            a = m["attachment"]
            assert a["kind"] == "image"
            assert a["mimeType"] == "image/png"
            assert a["filename"] == "pixel.png"
            assert a["sizeBytes"] == len(PNG_1x1)
            assert a["url"] == f"/api/chat/v1/attachments/{a['id']}"
            # Verify persistence
            doc = await mongo.chat_attachments.find_one({"_id": a["id"]})
            assert doc and doc["kind"] == "image" and doc["sizeBytes"] == len(PNG_1x1)
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_upload_pdf_kind(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=30.0) as c:
                r = await _upload(c, tid, token=customer_token, content=PDF_MIN,
                                  filename="doc.pdf", content_type="application/pdf")
            assert r.status_code == 200, r.text
            a = r.json()["message"]["attachment"]
            assert a["kind"] == "pdf"
            assert a["mimeType"] == "application/pdf"
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_upload_file_kind_text(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=30.0) as c:
                r = await _upload(c, tid, token=customer_token,
                                  content=b"hello world\n",
                                  filename="notes.txt", content_type="text/plain")
            assert r.status_code == 200, r.text
            a = r.json()["message"]["attachment"]
            assert a["kind"] == "file"
            assert a["mimeType"] == "text/plain"
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Upload — error paths
# ─────────────────────────────────────────────────────────────────

class TestUploadErrors:
    @pytest.mark.asyncio
    async def test_invalid_mime_415(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token,
                                  content=b"<html>x</html>",
                                  filename="bad.html", content_type="text/html")
            assert r.status_code == 415, r.text
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_oversize_image_413(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            big = b"\x00" * (8 * 1024 * 1024 + 1)  # 8 MB + 1
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=60.0) as c:
                r = await _upload(c, tid, token=customer_token, content=big,
                                  filename="big.png", content_type="image/png")
            assert r.status_code == 413, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_oversize_pdf_413(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            big = b"%PDF-1.4\n" + b"\x00" * (20 * 1024 * 1024)  # >20 MB
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=120.0) as c:
                r = await _upload(c, tid, token=customer_token, content=big,
                                  filename="big.pdf", content_type="application/pdf")
            assert r.status_code == 413, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_empty_file_400(self, mongo, customer_token, customer_user_id):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=b"",
                                  filename="empty.png", content_type="image/png")
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
                r = await _upload(c, tid, token=provider_token, content=PNG_1x1,
                                  filename="x.png", content_type="image/png")
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
                r = await _upload(c, tid, token=admin_token, content=PNG_1x1,
                                  filename="x.png", content_type="image/png")
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
                r = await _upload(c, tid, token=admin_token, content=PNG_1x1,
                                  filename="x.png", content_type="image/png")
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
                r = await _upload(c, tid, token=admin_token, content=PNG_1x1,
                                  filename="x.png", content_type="image/png")
            assert r.status_code == 200, r.text
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Caption propagation + projection assertions
# ─────────────────────────────────────────────────────────────────

class TestCaptionAndProjection:
    @pytest.mark.asyncio
    async def test_caption_propagated_via_get_messages(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="cap.png", content_type="image/png",
                                   caption="my caption here")
                assert up.status_code == 200, up.text
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(customer_token),
                )
            assert gr.status_code == 200
            msgs = gr.json()["messages"]
            att = [m for m in msgs if m["type"] == "attachment"]
            assert len(att) == 1
            m = att[0]
            assert m["body"] == "my caption here"
            a = m["attachment"]
            assert a["url"] == f"/api/chat/v1/attachments/{a['id']}"
            assert a["sizeBytes"] == len(PNG_1x1)
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_caption_too_long_422(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                r = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                  filename="x.png", content_type="image/png",
                                  caption="a" * 501)
            # FastAPI Form max_length triggers 422.
            assert r.status_code == 422, r.status_code
        finally:
            await _cleanup(mongo, [tid])


# ─────────────────────────────────────────────────────────────────
# Unread + mark-read after attachment messages
# ─────────────────────────────────────────────────────────────────

class TestUnreadAndMarkRead:
    @pytest.mark.asyncio
    async def test_unread_and_markread_after_upload(
        self, mongo, customer_token, customer_user_id, admin_token,
    ):
        # type=support so admin is implicit participant (peer).
        tid = await _make_thread(mongo, participant_user_id=customer_user_id,
                                 kind="support")
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                # Customer uploads → peer (admin) should see unreadByMe>0.
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="u.png", content_type="image/png")
                assert up.status_code == 200, up.text

                # Storage flag flipped.
                t = await mongo.chat_threads.find_one({"id": tid})
                assert t["unreadByOther"] is True

                # Admin GET messages → thread.unreadByMe > 0.
                gr = await c.get(
                    f"/api/chat/v1/threads/{tid}/messages",
                    headers=auth_headers(admin_token),
                )
                assert gr.status_code == 200
                assert gr.json()["thread"]["unreadByMe"] > 0

                # Admin marks read — first call mutated=True, second=False.
                m1 = await c.post(
                    f"/api/chat/v1/threads/{tid}/read",
                    headers=auth_headers(admin_token),
                )
                assert m1.status_code == 200, m1.text
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
# GET /attachments/{id} — auth, access, content
# ─────────────────────────────────────────────────────────────────

class TestServeAttachment:
    @pytest.mark.asyncio
    async def test_serve_bearer_200_and_md5_roundtrip(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="round.png", content_type="image/png")
                assert up.status_code == 200, up.text
                aid = up.json()["message"]["attachment"]["id"]

                # Bearer header auth.
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}",
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 200, r.text
            assert r.headers.get("content-type", "").startswith("image/png")
            assert "inline" in r.headers.get("content-disposition", "")
            assert hashlib.md5(r.content).hexdigest() == hashlib.md5(PNG_1x1).hexdigest()
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_token_query_200(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=15.0) as c:
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="q.png", content_type="image/png")
                aid = up.json()["message"]["attachment"]["id"]
                # NO Authorization header — use ?token= fallback.
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}?token={customer_token}",
                    headers=BYPASS_HEADERS or None,
                )
            assert r.status_code == 200, r.text
            assert r.content == PNG_1x1
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_no_auth_401(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="n.png", content_type="image/png")
                aid = up.json()["message"]["attachment"]["id"]
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}",
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
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="bad.png", content_type="image/png")
                aid = up.json()["message"]["attachment"]["id"]
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}",
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
                up = await _upload(c, tid, token=customer_token, content=PNG_1x1,
                                   filename="p.png", content_type="image/png")
                aid = up.json()["message"]["attachment"]["id"]
                # Provider is not a participant of customer's support thread.
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}",
                    headers=auth_headers(provider_token),
                )
            assert r.status_code == 403, r.status_code
        finally:
            await _cleanup(mongo, [tid])

    @pytest.mark.asyncio
    async def test_serve_wrong_id_404(self, customer_token):
        async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
            r = await c.get(
                f"/api/chat/v1/attachments/does-not-exist-{uuid.uuid4().hex}",
                headers=auth_headers(customer_token),
            )
        assert r.status_code == 404, r.status_code

    @pytest.mark.asyncio
    async def test_serve_file_kind_uses_attachment_disposition(
        self, mongo, customer_token, customer_user_id,
    ):
        tid = await _make_thread(mongo, participant_user_id=customer_user_id)
        try:
            async with httpx.AsyncClient(base_url=BACKEND_URL, timeout=10.0) as c:
                up = await _upload(c, tid, token=customer_token,
                                   content=b"plain text body",
                                   filename="report.txt",
                                   content_type="text/plain")
                aid = up.json()["message"]["attachment"]["id"]
                r = await c.get(
                    f"/api/chat/v1/attachments/{aid}",
                    headers=auth_headers(customer_token),
                )
            assert r.status_code == 200
            cd = r.headers.get("content-disposition", "")
            assert "attachment" in cd
            assert "report.txt" in cd
        finally:
            await _cleanup(mongo, [tid])
