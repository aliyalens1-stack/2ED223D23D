"""Chat canonical contract — Sprint B1 Chat Contract Normalization.

ADAPTER, not rewrite. Wraps the existing `app.chat.router` storage in the
canonical wire shape declared in `shared/domain/contracts/chat.ts`. Legacy
endpoints keep working byte-for-byte; the v1 endpoints below expose:

    GET  /api/chat/v1/threads                       — paginated, canonical
    GET  /api/chat/v1/threads/{id}/messages         — paginated, canonical
    POST /api/chat/v1/threads/{id}/messages         — canonical send envelope
    POST /api/chat/v1/threads/{id}/read             — canonical mark-read (mutated flag)
    GET  /api/chat/v1/unread-summary                — backend-derived totals

Hardening invariants:
  * Participant ownership: caller MUST be the thread's participant
    (user) OR the matching provider slug. Anything else → 403.
  * Cross-thread access: impossible — ownership check is per-thread, not
    per-list. The list endpoint already filters by the caller.
  * Cursor pagination: opaque ISO-8601 strings. Surfaces echo verbatim.
  * Unread is backend-derived from `chat_messages` (real count of unread
    rows where `senderType != caller's perspective` and `readAt is null`).
  * Mark-read is idempotent: filtered update → `mutated: false` when there
    was nothing to flip.

Explicitly NOT here:
  * attachments / voice / emoji reactions / typing
  * disputes / admin intervention flows beyond the existing legacy surface
  * websocket / chat UI rewrite
  * admin support endpoints (audit-only this sprint)
"""
from __future__ import annotations
import base64
import logging
import mimetypes
from typing import Optional, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File, Form, Request, WebSocket
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import verify_user_token
from app.core.utils import now_utc, uid

router = APIRouter(prefix="/api/chat/v1", tags=["chat-v1"])
logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────
# Sprint B4a — Attachment whitelist & size caps
# ─────────────────────────────────────────────────────────────────
# Strict per-kind whitelist. New MIME types must land here AND be wired
# into _classify_attachment(). No wildcards — adversarial uploads are
# the #1 source of subtle bugs in v1 chat surfaces.
_IMAGE_MIMES = {"image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"}
_PDF_MIMES = {"application/pdf"}
_FILE_MIMES = {
    "text/plain",
    "application/zip",
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/octet-stream",  # generic fallback (mobile pickers can default to this)
}
_MAX_IMAGE_BYTES = 8 * 1024 * 1024
_MAX_PDF_BYTES = 20 * 1024 * 1024
_MAX_FILE_BYTES = 10 * 1024 * 1024


def _classify_attachment(mime: str) -> tuple[Optional[str], int]:
    """Map raw MIME → (kind, size cap). Returns `(None, 0)` on reject.

    Whitelist-first to keep the audit narrow. Surfaces that need a new
    MIME extend this set (single source of truth)."""
    m = (mime or "").lower().strip()
    if m in _IMAGE_MIMES:
        return ("image", _MAX_IMAGE_BYTES)
    if m in _PDF_MIMES:
        return ("pdf", _MAX_PDF_BYTES)
    if m in _FILE_MIMES:
        return ("file", _MAX_FILE_BYTES)
    return (None, 0)


# ─────────────────────────────────────────────────────────────────
# Sprint B4a.1 — Hardening primitives shared with B4b (voice)
# ─────────────────────────────────────────────────────────────────

_UPLOAD_CHUNK = 64 * 1024  # 64 KB — bounded memory, ~1.5 ms per chunk on commodity disks


async def _stream_read_capped(file: UploadFile, cap: int) -> bytes:
    """Read an UploadFile in 64 KB chunks, aborting the moment we exceed
    `cap` bytes. Prevents pathological multipart payloads from forcing us
    to materialise the full body before validating size — important once
    we start accepting 12 MB audio blobs (B4b) and 20 MB PDFs (B4a).

    Returns the assembled bytes if total ≤ cap; raises HTTPException(413)
    otherwise. Returns b'' on empty stream so the caller can hand back a
    400 (empty file is a different failure mode than oversize)."""
    buf = bytearray()
    while True:
        chunk = await file.read(_UPLOAD_CHUNK)
        if not chunk:
            break
        buf.extend(chunk)
        if len(buf) > cap:
            raise HTTPException(413, f"File too large: >{cap}")
    return bytes(buf)


# Magic-byte signatures. We sniff the first N bytes ONLY for the families
# we accept — defence in depth on top of the MIME whitelist. Adversaries
# can still spoof the wire content-type; the magic bytes catch the most
# obvious "rename .exe to .png" attacks. Each tuple = (offset, signature).
#
# References:
#   PNG  — RFC 2083 §3.1
#   JPEG — JFIF/EXIF SOI marker
#   WebP — RIFF container with 'WEBP' fourcc at offset 8
#   HEIC/HEIF — ISO BMFF with 'ftyp' at offset 4
#   PDF  — ISO 32000 §7.5.2
#   ZIP/Office — APPNOTE.TXT §4.3.7
#   MP4/M4A — ISO BMFF with 'ftyp' at offset 4
#   WebM — Matroska EBML header
#   MP3  — frame sync 0xFFFB / 0xFFF3 / 0xFFF2 OR 'ID3' tag
#   AAC ADTS — frame sync 0xFFF1 / 0xFFF9
_MAGIC_SIGNATURES: dict[str, list[tuple[int, bytes]]] = {
    "image/png":  [(0, b"\x89PNG\r\n\x1a\n")],
    "image/jpeg": [(0, b"\xff\xd8\xff")],
    "image/webp": [(0, b"RIFF"), (8, b"WEBP")],
    # HEIC/HEIF: 'ftyp' brand at offset 4. Brands vary (heic, heix, mif1,
    # msf1, heim, heis, hevc, hevx). We only require 'ftyp' marker.
    "image/heic": [(4, b"ftyp")],
    "image/heif": [(4, b"ftyp")],
    "application/pdf": [(0, b"%PDF-")],
    "application/zip": [(0, b"PK\x03\x04")],
    # Office Open XML = zip container under the hood
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [(0, b"PK\x03\x04")],
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": [(0, b"PK\x03\x04")],
    # MP4 / M4A / AAC-in-MP4: ISO BMFF
    "audio/mp4":  [(4, b"ftyp")],
    "audio/m4a":  [(4, b"ftyp")],
    "audio/aac":  [],  # ADTS frame sync — checked specially below
    "audio/mpeg": [],  # ID3 or frame sync — checked specially below
    "audio/webm": [(0, b"\x1aE\xdf\xa3")],
    # Pass-through families that have no reliable magic: text/plain,
    # legacy .doc (CFB header is too generic), .xls (CFB), octet-stream.
    "text/plain": [],
    "application/msword": [],
    "application/vnd.ms-excel": [],
    "application/octet-stream": [],
}


def _verify_magic_bytes(mime: str, data: bytes) -> bool:
    """Return True iff the first ~16 bytes match the claimed MIME family.

    Falsy claims fail fast. Empty signature list = "we accept this MIME
    but have no reliable magic to enforce" (text, legacy office, generic
    octet-stream) — still narrows the attack surface because the upload
    must already be on the MIME whitelist.

    Special cases:
      - audio/aac: ADTS frame sync 0xFFF1 / 0xFFF9 at offset 0
      - audio/mpeg: 'ID3' tag at offset 0 OR MPEG frame sync 0xFFFB/F3/F2
    """
    if not data:
        return False
    if mime == "audio/aac":
        if len(data) < 2:
            return False
        # ADTS sync word: 12 bits set + MPEG layer 0
        return data[0] == 0xFF and (data[1] & 0xF6) == 0xF0
    if mime == "audio/mpeg":
        if len(data) < 3:
            return False
        if data[:3] == b"ID3":
            return True
        # MPEG audio frame sync (11 bits set) — be lenient on bitrate
        return data[0] == 0xFF and (data[1] & 0xE0) == 0xE0
    sigs = _MAGIC_SIGNATURES.get(mime)
    if sigs is None:
        # MIME is not on the whitelist at all — should already have been
        # rejected by `_classify_*`. Bail explicitly.
        return False
    if not sigs:
        # Whitelisted but no magic-byte enforcement (text, doc/xls, octet).
        return True
    for offset, sig in sigs:
        if data[offset:offset + len(sig)] != sig:
            return False
    return True


def _decode_chat_jwt(request: Request, token_qs: Optional[str]) -> dict:
    """Resolve a chat-attachment/voice JWT from either the Authorization
    header OR the `?token=` query string.

    Centralises the dual-transport auth dance used by every chat media
    serve endpoint (`GET /attachments/{id}`, `GET /voice/{id}`, …).
    Single source of truth so any future change (e.g. signed URLs,
    short-lived chat tokens) lands in one place.

    Returns the decoded JWT payload dict. Raises 401 on missing/invalid.
    """
    import jwt as _jwt
    from app.core.security import JWT_SECRET, JWT_ALGO

    raw_jwt: Optional[str] = None
    auth_header = (request.headers.get("authorization") or "") if request else ""
    if auth_header.lower().startswith("bearer "):
        raw_jwt = auth_header.split(None, 1)[1].strip()
    if not raw_jwt and token_qs:
        raw_jwt = token_qs
    if not raw_jwt:
        raise HTTPException(401, "Auth required")
    try:
        return _jwt.decode(raw_jwt, JWT_SECRET, algorithms=[JWT_ALGO])
    except _jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except _jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")


# ─────────────────────────────────────────────────────────────────
# Helpers — viewer identity
# ─────────────────────────────────────────────────────────────────

def _user_id_from(payload: dict) -> str:
    return str(payload.get("userId") or payload.get("sub") or payload.get("email") or "")


def _provider_slug_from(payload: dict) -> Optional[str]:
    return payload.get("providerSlug") or payload.get("slug")


def _viewer_kind(payload: dict, thread: dict) -> Optional[Literal["user", "provider", "admin"]]:
    """Return the caller's kind in the context of THIS thread.

    `None` means: caller is not a participant. Callers MUST 403 on `None`.
    The check is intentionally narrow — admin support intervention rides
    a separate endpoint and is not part of B1.
    """
    if not thread:
        return None
    viewer_user_id = _user_id_from(payload)
    if thread.get("participantUserId") and thread["participantUserId"] == viewer_user_id:
        return "user"
    provider_slug = _provider_slug_from(payload)
    if (
        payload.get("role") == "provider"
        and thread.get("providerSlug")
        and provider_slug
        and thread["providerSlug"] == provider_slug
    ):
        return "provider"
    # `kind` claim from the issued JWT — single source of truth post-1C.
    if payload.get("kind") == "admin":
        return "admin"
    return None


async def _hydrate_provider_snapshot(slug: Optional[str]) -> Optional[dict]:
    if not slug:
        return None
    p = await db.providers.find_one(
        {"slug": slug},
        {"_id": 0, "name": 1, "avatar": 1},
    )
    if not p:
        return {"slug": slug, "name": slug.replace("-", " ").title()}
    return {"slug": slug, **p}


async def _hydrate_user_snapshot(user_id: Optional[str]) -> Optional[dict]:
    if not user_id:
        return None
    try:
        from bson import ObjectId
        u = None
        try:
            u = await db.users.find_one(
                {"_id": ObjectId(user_id)},
                {"_id": 0, "firstName": 1, "lastName": 1, "email": 1},
            )
        except Exception:
            pass
        if not u:
            u = await db.users.find_one(
                {"_id": user_id},
                {"_id": 0, "firstName": 1, "lastName": 1, "email": 1},
            )
        return u
    except Exception:
        return None


# ─────────────────────────────────────────────────────────────────
# Canonical projectors
# ─────────────────────────────────────────────────────────────────

async def _count_unread_for_viewer(thread: dict, viewer_kind: str) -> int:
    """Backend-derived per-thread unread count.

    The caller is 'unread' on any message whose sender is NOT the caller
    and whose `readAt` is null. We never let the client recompute this —
    pagination would lie.
    """
    if not viewer_kind:
        return 0
    # Sender perspective: a user reads provider+admin; a provider reads
    # user+admin; an admin reads user+provider. Mirrors the senderType
    # vocabulary across `_send_user_message` / admin-reply / provider-reply.
    if viewer_kind == "user":
        sender_filter = {"$ne": "user"}
    elif viewer_kind == "provider":
        sender_filter = {"$ne": "provider"}
    else:  # admin
        sender_filter = {"$ne": "admin"}
    return await db.chat_messages.count_documents({
        "threadId": thread["id"],
        "senderType": sender_filter,
        "readAt": None,
    })


async def _project_participants(thread: dict) -> list[dict]:
    """Build the canonical participants array from the storage shape."""
    participants: list[dict] = []
    # User side.
    user_id = thread.get("participantUserId")
    if user_id:
        u = await _hydrate_user_snapshot(user_id)
        display = ""
        if u:
            first = (u.get("firstName") or "").strip()
            last = (u.get("lastName") or "").strip()
            display = f"{first} {last}".strip() or (u.get("email") or "")
        participants.append({
            "id": user_id,
            "kind": "user",
            "displayName": display or None,
            "avatarHint": None,
            "providerSlug": None,
        })
    # Provider side, if any.
    slug = thread.get("providerSlug")
    if slug:
        prov = await _hydrate_provider_snapshot(slug)
        participants.append({
            "id": slug,
            "kind": "provider",
            "displayName": (prov or {}).get("name") if prov else None,
            "avatarHint": (prov or {}).get("avatar") if prov else None,
            "providerSlug": slug,
        })
    # Admin (support) is implicit on `support`-kind threads OR explicit after
    # Sprint B3.2 `/support/join`. Once admin has joined ANY thread kind, the
    # admin participant appears in projections going forward.
    if thread.get("type") == "support" or thread.get("adminJoined"):
        participants.append({
            "id": "admin",
            "kind": "admin",
            "displayName": "AutoSearch Support",
            "avatarHint": None,
            "providerSlug": None,
        })
    return participants


async def _project_thread(thread: dict, viewer_kind: str) -> dict:
    """Storage shape → canonical `ChatThread`."""
    unread = await _count_unread_for_viewer(thread, viewer_kind)
    return {
        "id": thread["id"],
        "kind": thread.get("type", "support"),
        "title": thread.get("title", ""),
        "participants": await _project_participants(thread),
        "providerSlug": thread.get("providerSlug") or None,
        "bookingId": thread.get("bookingId") or None,
        "lastMessagePreview": (thread.get("lastMessage") or "")[:140],
        "lastMessageAt": thread.get("lastMessageAt") or None,
        "unreadByMe": int(unread),
        # Sprint B3 — operational primitives.
        "disputeOpen": bool(thread.get("disputeOpen")),
        "disputeOpenedAt": thread.get("disputeOpenedAt") or None,
        "adminJoined": bool(thread.get("adminJoined") or thread.get("type") == "support"),
        "createdAt": thread.get("createdAt", ""),
    }


def _project_message(
    msg: dict,
    viewer_kind: str,
    viewer_user_id: str,
    viewer_slug: Optional[str],
    sender_name_map: Optional[dict] = None,
) -> dict:
    sender_kind = msg.get("senderType", "user")
    sender_id = msg.get("senderId", "")
    if sender_kind == "user":
        is_mine = viewer_kind == "user" and sender_id == viewer_user_id
    elif sender_kind == "provider":
        is_mine = viewer_kind == "provider" and sender_id == viewer_slug
    else:  # admin
        is_mine = viewer_kind == "admin"
    # Sprint B3.1 — emit senderDisplayName for the "other side" rendering.
    # Surfaces fall back to participant lookup or generic role labels when
    # absent. `sender_name_map` is a pre-resolved (sender_kind, sender_id)
    # → name lookup; callers populate it once per page to avoid N+1.
    display_name = None
    if sender_name_map:
        display_name = sender_name_map.get((sender_kind, sender_id))
    if not display_name and sender_kind == "admin":
        display_name = "AutoSearch Support"
    out = {
        "id": msg["id"],
        "threadId": msg["threadId"],
        "senderKind": sender_kind,
        "senderId": sender_id,
        "type": msg.get("type", "text"),
        "body": msg.get("text", "") if msg.get("type") != "system" else (msg.get("body") or msg.get("text", "")),
        "createdAt": msg.get("createdAt", ""),
        "readAt": msg.get("readAt") or None,
        "isMine": bool(is_mine),
    }
    if display_name:
        out["senderDisplayName"] = display_name
    # Sprint B4a — surface the canonical attachment payload alongside
    # the message envelope. Storage shape mirrors the wire shape so the
    # projector is a verbatim passthrough (no per-call hydration costs).
    if msg.get("type") == "attachment" and msg.get("attachment"):
        a = msg["attachment"]
        out["attachment"] = {
            "id": a.get("id"),
            "kind": a.get("kind"),
            "url": f"/api/chat/v1/attachments/{a.get('id')}",
            "filename": a.get("filename") or "",
            "mimeType": a.get("mimeType") or "application/octet-stream",
            "sizeBytes": int(a.get("sizeBytes") or 0),
        }
        # `body` for an attachment message carries the optional caption.
        # Storage uses `caption` to keep `text` reserved for type=text rows.
        out["body"] = msg.get("caption") or ""
    # Sprint B4b — voice message projection. Same passthrough discipline:
    # storage shape matches wire shape so the projector adds zero hops.
    # Voice messages NEVER carry a caption (B4b spec) — `body` is always
    # the empty string for type='voice'.
    if msg.get("type") == "voice" and msg.get("voice"):
        v = msg["voice"]
        out["voice"] = {
            "id": v.get("id"),
            "audioUrl": f"/api/chat/v1/voice/{v.get('id')}",
            "durationMs": int(v.get("durationMs") or 0),
            "mimeType": v.get("mimeType") or "audio/mp4",
            "sizeBytes": int(v.get("sizeBytes") or 0),
        }
        out["body"] = ""
    # Sprint B4c — reactions decoration. Skipped for `system` messages
    # (admin-system messages have no user feedback semantics). For every
    # other type we emit the canonical `[{emoji, count, reactedByMe}]`
    # array — even when empty, so clients don't have to undefined-check.
    if msg.get("type") != "system":
        out["reactions"] = _project_reactions(msg.get("reactions") or {},
                                              viewer_kind, viewer_user_id, viewer_slug)
    return out


async def _build_sender_name_map(messages: list[dict]) -> dict:
    """Bulk hydrate senderDisplayName for a page of messages.

    Returns a dict keyed by (sender_kind, sender_id). Misses are silently
    omitted; the projector falls back to role-based labels.
    """
    user_ids: set = set()
    provider_slugs: set = set()
    for m in messages:
        sk = m.get("senderType")
        sid = m.get("senderId")
        if not sid:
            continue
        if sk == "user":
            user_ids.add(sid)
        elif sk == "provider":
            provider_slugs.add(sid)
    cache: dict = {}
    if user_ids:
        try:
            from bson import ObjectId
            or_clauses: list[dict] = [{"_id": sid} for sid in user_ids]
            for sid in user_ids:
                try:
                    or_clauses.append({"_id": ObjectId(sid)})
                except Exception:
                    pass
            async for u in db.users.find(
                {"$or": or_clauses},
                {"_id": 1, "firstName": 1, "lastName": 1, "email": 1},
            ):
                uid_str = str(u.get("_id"))
                first = (u.get("firstName") or "").strip()
                last = (u.get("lastName") or "").strip()
                display = f"{first} {last}".strip() or (u.get("email") or "")
                if display:
                    cache[("user", uid_str)] = display
        except Exception as e:
            logger.warning(f"_build_sender_name_map users hydrate failed: {e}")
    if provider_slugs:
        try:
            async for p in db.providers.find(
                {"slug": {"$in": list(provider_slugs)}},
                {"_id": 0, "slug": 1, "name": 1},
            ):
                if p.get("name"):
                    cache[("provider", p["slug"])] = p["name"]
        except Exception as e:
            logger.warning(f"_build_sender_name_map providers hydrate failed: {e}")
    return cache


async def _load_thread_or_403(thread_id: str, payload: dict) -> tuple[dict, str]:
    """Fetch thread, enforce participant ownership.

    Returns `(thread_doc, viewer_kind)`. Caller can trust both. The 404
    happens BEFORE the participant check intentionally — exposing 404 vs
    403 for thread existence is fine for the participant-only audience
    (admins use a different surface), and surfacing 404 lets clients show
    "thread no longer exists" instead of "you're not allowed".
    """
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    vk = _viewer_kind(payload, t)
    if vk is None:
        raise HTTPException(403, "Not a participant of this thread")
    return t, vk


# ─────────────────────────────────────────────────────────────────
# Pydantic models
# ─────────────────────────────────────────────────────────────────

class V1SendMessageRequest(BaseModel):
    body: str = Field(..., min_length=1, max_length=4000)
    # `type` is reserved; for B1 we only accept text and silently coerce.
    type: Optional[Literal["text"]] = "text"


# ─────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────

DEFAULT_THREADS_LIMIT = 30
MAX_THREADS_LIMIT = 100
DEFAULT_MESSAGES_LIMIT = 50
MAX_MESSAGES_LIMIT = 200


@router.get("/threads")
async def v1_list_threads(
    after: Optional[str] = Query(None, description="Opaque cursor (echo from previous nextCursor)"),
    limit: int = Query(DEFAULT_THREADS_LIMIT, ge=1, le=MAX_THREADS_LIMIT),
    payload: dict = Depends(verify_user_token),
):
    """List canonical threads the caller participates in.

    The caller's identity drives the filter. A user sees their own threads;
    a provider sees threads attached to their slug. Sprint B3.4: an admin
    sees threads where they've joined OR which have an open dispute. This
    is the canonical admin inbox view — narrower than "all threads ever"
    on purpose.
    """
    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    is_admin = payload.get("kind") == "admin"

    if is_admin:
        # Admin inbox scope (Sprint B3.4):
        #   1. `type=support` threads — the customer-initiated support
        #      surface. Admin needs discovery here BEFORE invoking
        #      /support/join; otherwise the join endpoint is unusable.
        #   2. Anything the admin has actively joined (e.g. a provider
        #      thread the admin stepped into).
        #   3. Every open dispute on any thread kind.
        # Mutually inclusive — duplicates collapse on the {id} natural key.
        q: dict = {
            "$or": [
                {"type": "support"},
                {"adminJoined": True},
                {"disputeOpen": True},
            ]
        }
    else:
        or_clauses: list[dict] = []
        if user_id:
            or_clauses.append({"participantUserId": user_id})
        if payload.get("role") == "provider" and slug:
            or_clauses.append({"providerSlug": slug})
        if not or_clauses:
            return {"threads": [], "nextCursor": None}
        q = {"$or": or_clauses}

    if after:
        # Reverse-chrono pagination: next page is OLDER than `after`.
        q["lastMessageAt"] = {"$lt": after}

    cursor = (
        db.chat_threads
        .find(q, {"_id": 0})
        .sort("lastMessageAt", -1)
        .limit(limit + 1)
    )
    docs = await cursor.to_list(length=limit + 1)

    has_more = len(docs) > limit
    page = docs[:limit]
    next_cursor = page[-1].get("lastMessageAt") if has_more and page else None

    out: list[dict] = []
    for t in page:
        vk = _viewer_kind(payload, t) or ("admin" if is_admin else "user")
        out.append(await _project_thread(t, vk))
    return {"threads": out, "nextCursor": next_cursor}


@router.get("/threads/{thread_id}/messages")
async def v1_list_messages(
    thread_id: str,
    after: Optional[str] = Query(None, description="ISO timestamp; returns messages newer than this"),
    limit: int = Query(DEFAULT_MESSAGES_LIMIT, ge=1, le=MAX_MESSAGES_LIMIT),
    payload: dict = Depends(verify_user_token),
):
    """Return canonical messages, oldest-first within the page.

    Cursor advances forward in time: pass back `nextCursor` to get the
    next batch.
    """
    t, vk = await _load_thread_or_403(thread_id, payload)
    q: dict = {"threadId": thread_id}
    if after:
        q["createdAt"] = {"$gt": after}
    cursor = (
        db.chat_messages
        .find(q, {"_id": 0})
        .sort("createdAt", 1)
        .limit(limit + 1)
    )
    docs = await cursor.to_list(length=limit + 1)
    has_more = len(docs) > limit
    page = docs[:limit]
    next_cursor = page[-1].get("createdAt") if has_more and page else None

    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    sender_map = await _build_sender_name_map(page)
    msgs_canonical = [_project_message(m, vk, user_id, slug, sender_map) for m in page]
    thread_canonical = await _project_thread(t, vk)
    return {"thread": thread_canonical, "messages": msgs_canonical, "nextCursor": next_cursor}


@router.post("/threads/{thread_id}/messages")
async def v1_send_message(
    thread_id: str,
    body: V1SendMessageRequest,
    payload: dict = Depends(verify_user_token),
):
    """Send a text message. Mirrors the legacy `_send_user_message` /
    provider-reply paths but emits a canonical envelope.

    Sending is restricted to participants. Sprint B3.2: an admin who has
    invoked `/support/join` on this thread can also send canonically;
    legacy `/api/admin/chat/threads/{id}/reply` continues to work and is
    NOT replaced here.
    """
    t, vk = await _load_thread_or_403(thread_id, payload)
    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    if vk == "user":
        sender_type, sender_id = "user", user_id
    elif vk == "provider":
        sender_type, sender_id = "provider", (slug or "")
    else:  # admin
        if not t.get("adminJoined") and t.get("type") != "support":
            # An admin who hasn't joined the thread must POST /support/join
            # first. This keeps canonical admin sends always co-located with
            # an explicit, audited admin participation event.
            raise HTTPException(409, "Admin must POST /support/join before sending")
        sender_type, sender_id = "admin", "admin"
    if not sender_id:
        raise HTTPException(409, "Sender identity not resolvable")

    msg_doc = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": sender_type,
        "senderId": sender_id,
        "type": "text",
        "text": body.body,
        "createdAt": now_utc().isoformat(),
        "readAt": None,
    }
    await db.chat_messages.insert_one(dict(msg_doc))
    msg_doc.pop("_id", None)
    # Bump thread last-message + counter for "the other side".
    update = {
        "lastMessage": body.body[:140],
        "lastMessageAt": msg_doc["createdAt"],
    }
    if sender_type == "user":
        update["unreadByOther"] = True
    elif sender_type == "provider":
        update["unreadByUser"] = True
    else:  # admin
        update["unreadByUser"] = True
    await db.chat_threads.update_one({"id": thread_id}, {"$set": update})
    t2 = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    sender_map = await _build_sender_name_map([msg_doc])
    # Sprint B5 — broadcast to live WS subscribers. Read-side only;
    # the canonical state has already been written above. Failures
    # in the hub never bubble up to the REST caller.
    from . import realtime as _rt
    try:
        await _rt.publish_new_message(t2, msg_doc)
    except Exception:
        pass
    return {
        "message": _project_message(msg_doc, vk, user_id, slug, sender_map),
        "thread": await _project_thread(t2, vk),
    }


@router.post("/threads/{thread_id}/read")
async def v1_mark_read(thread_id: str, payload: dict = Depends(verify_user_token)):
    """Idempotent mark-all-as-read.

    Filtered update flips only the rows that need flipping; `mutated`
    tells the caller whether anything changed, so clients can skip
    redundant cache invalidation.
    """
    t, vk = await _load_thread_or_403(thread_id, payload)
    other_sender = {"$ne": "user"} if vk == "user" else "user"
    read_at = now_utc().isoformat()
    res = await db.chat_messages.update_many(
        {"threadId": thread_id, "senderType": other_sender, "readAt": None},
        {"$set": {"readAt": read_at}},
    )
    # Mirror the legacy flag for compat surfaces still reading it.
    flag_field = "unreadByUser" if vk == "user" else "unreadByOther"
    await db.chat_threads.update_one(
        {"id": thread_id, flag_field: True}, {"$set": {flag_field: False}}
    )
    # Sprint B5 — broadcast unread state change. We only fan out when
    # the mark-read actually mutated rows (otherwise the projection is
    # identical to what subscribers already have and the frame is noise).
    if bool(res.modified_count):
        from . import realtime as _rt
        try:
            t_after = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
            if t_after:
                await _rt.publish_unread_update(t_after)
        except Exception:
            pass
    return {
        "ok": True,
        "threadId": thread_id,
        "unreadByMe": 0,
        "mutated": bool(res.modified_count),
    }


@router.get("/unread-summary")
async def v1_unread_summary(payload: dict = Depends(verify_user_token)):
    """Backend-derived total + per-thread unread counts for the caller.

    Replaces `sum(thread.unreadCount)` heuristics on the client. The
    response is small enough (≤ 100 threads) that a single endpoint is
    appropriate; chat-list pages get decoration data for free.
    """
    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    is_admin = payload.get("kind") == "admin"

    if is_admin:
        # Mirror admin inbox scope from `v1_list_threads`.
        q: dict = {
            "$or": [
                {"type": "support"},
                {"adminJoined": True},
                {"disputeOpen": True},
            ]
        }
    else:
        or_clauses: list[dict] = []
        if user_id:
            or_clauses.append({"participantUserId": user_id})
        if payload.get("role") == "provider" and slug:
            or_clauses.append({"providerSlug": slug})
        if not or_clauses:
            return {"totalUnread": 0, "perThread": [], "serverTime": now_utc().isoformat()}
        q = {"$or": or_clauses}

    cursor = db.chat_threads.find(q, {"_id": 0, "id": 1, "participantUserId": 1, "providerSlug": 1, "type": 1, "adminJoined": 1, "disputeOpen": 1})
    threads = await cursor.to_list(length=200)

    per_thread: list[dict] = []
    total = 0
    for t in threads:
        vk = _viewer_kind(payload, t) or ("admin" if is_admin else "user")
        n = await _count_unread_for_viewer(t, vk)
        if n > 0:
            per_thread.append({"threadId": t["id"], "unread": int(n)})
            total += int(n)
    return {
        "totalUnread": total,
        "perThread": per_thread,
        "serverTime": now_utc().isoformat(),
    }


# ─────────────────────────────────────────────────────────────────
# Sprint B3.2 — Support join (admin canonical participation)
# Sprint B3.3 — Dispute flag (operational primitive)
# ─────────────────────────────────────────────────────────────────

# System message body codes — see `ChatSystemCode` in
# `shared/domain/contracts/chat.ts`. Surfaces translate to the user's
# language; the wire stays language-neutral.
_SYS_SUPPORT_JOINED = "support_joined"
_SYS_DISPUTE_OPENED = "dispute_opened"


async def _emit_system_message(thread_id: str, code: str, actor_id: str) -> dict:
    """Insert a canonical `type=system` message and bump the thread.

    The body is the stable machine-readable code (`support_joined`,
    `dispute_opened`, ...). Surfaces render localised copy off the code.
    Returns the inserted doc (sans `_id`).
    """
    msg_doc = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": "system",
        "senderId": actor_id or "system",
        "type": "system",
        "body": code,
        "text": code,
        "createdAt": now_utc().isoformat(),
        "readAt": None,
    }
    await db.chat_messages.insert_one(dict(msg_doc))
    msg_doc.pop("_id", None)
    await db.chat_threads.update_one(
        {"id": thread_id},
        {"$set": {
            "lastMessage": code,
            "lastMessageAt": msg_doc["createdAt"],
        }},
    )
    return msg_doc


@router.post("/threads/{thread_id}/support/join")
async def v1_support_join(thread_id: str, payload: dict = Depends(verify_user_token)):
    """Sprint B3.2 — admin canonically joins a thread.

    Admin-only. Idempotent: re-invoking after the first join is a no-op
    (returns `mutated: false` and the existing canonical thread).

    Effects:
      - `thread.adminJoined = True`, `adminJoinedBy`, `adminJoinedAt`
      - Emits ONE canonical system message with body `"support_joined"`
        (only on first join — idempotent)

    Out of scope for B3.2:
      - reassignment, locking, escalation tree
      - notification fan-out (B4+)
    """
    if payload.get("kind") != "admin":
        raise HTTPException(403, "Admin role required")
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")

    already_joined = bool(t.get("adminJoined")) or t.get("type") == "support"
    actor_id = _user_id_from(payload) or "admin"

    mutated = False
    if not already_joined:
        await db.chat_threads.update_one(
            {"id": thread_id},
            {"$set": {
                "adminJoined": True,
                "adminJoinedBy": actor_id,
                "adminJoinedAt": now_utc().isoformat(),
            }},
        )
        await _emit_system_message(thread_id, _SYS_SUPPORT_JOINED, actor_id)
        mutated = True

    t2 = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    return {
        "ok": True,
        "threadId": thread_id,
        "mutated": mutated,
        "thread": await _project_thread(t2, "admin"),
    }


@router.post("/threads/{thread_id}/dispute")
async def v1_open_dispute(thread_id: str, payload: dict = Depends(verify_user_token)):
    """Sprint B3.3 — open a dispute on a thread.

    Allowed callers: any participant of the thread (user or provider).
    Admins themselves don't *open* disputes — they respond to them.

    Effects:
      - `thread.disputeOpen = True`, `disputeOpenedAt`, `disputeOpenedBy{Kind,Id}`
      - Emits ONE canonical system message `"dispute_opened"`
      - Fans out notifications to admins via the existing
        `customer_disputed` timeline kind → notification projector

    Idempotent: re-opening an already-open dispute is a no-op.

    Out of scope for B3.3:
      - Resolution workflow (closing, escalation tiers)
      - Refund / payout reversal
      - Auto-escalation rules
    """
    t, vk = await _load_thread_or_403(thread_id, payload)
    if vk == "admin":
        # Admin should respond to disputes via /support/join + send. We
        # don't let admin *open* a dispute on someone else's behalf —
        # that would muddle "who complained".
        raise HTTPException(409, "Admin cannot open a dispute on behalf of a participant")

    actor_id = _user_id_from(payload) if vk == "user" else (_provider_slug_from(payload) or "")
    if not actor_id:
        raise HTTPException(409, "Disputant identity not resolvable")

    already_open = bool(t.get("disputeOpen"))
    mutated = False

    if not already_open:
        await db.chat_threads.update_one(
            {"id": thread_id},
            {"$set": {
                "disputeOpen": True,
                "disputeOpenedAt": now_utc().isoformat(),
                "disputeOpenedByKind": vk,
                "disputeOpenedById": actor_id,
            }},
        )
        await _emit_system_message(thread_id, _SYS_DISPUTE_OPENED, actor_id)
        # Fan out to admins via the existing timeline → projector path.
        # `customer_disputed` is already in ADMIN_FANOUT_KINDS, so this
        # produces one notification row per admin (idempotent via the
        # projector's unique index on (userId, sourceTimelineId)).
        try:
            from app.notifications.projector import project_event
            event_doc = {
                "id": uid(),
                "kind": "customer_disputed",
                "metadata": {
                    "threadId": thread_id,
                    "disputeOpenedByKind": vk,
                    "disputeOpenedById": actor_id,
                    "title": f"Dispute opened on chat {thread_id[:8]}",
                },
                "timestamp": now_utc().isoformat(),
                "createdAt": now_utc().isoformat(),
                "actorType": vk,
                "actorId": actor_id,
                "severity": "warning",
            }
            await db.timeline_events.insert_one(dict(event_doc))
            event_doc.pop("_id", None)
            await project_event(event_doc)
        except Exception as e:
            # Notification projection is best-effort; thread state is the
            # source of truth and stays consistent regardless.
            logger.warning(f"dispute notification projection failed: {e}")
        mutated = True

    t2 = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    return {
        "ok": True,
        "threadId": thread_id,
        "mutated": mutated,
        "thread": await _project_thread(t2, vk),
    }



# ─────────────────────────────────────────────────────────────────
# Sprint B4a — Attachments (image / pdf / file)
# ─────────────────────────────────────────────────────────────────

@router.post("/threads/{thread_id}/attachments")
async def v1_upload_attachment(
    thread_id: str,
    file: UploadFile = File(...),
    caption: str = Form("", max_length=500),
    payload: dict = Depends(verify_user_token),
):
    """Upload one attachment to a thread.

    Acceptance criteria (B4a):
      * participant-only (403 otherwise) — admin needs prior /support/join
      * MIME whitelist per `_classify_attachment` (415 on reject)
      * per-kind size cap (413 on oversize)
      * emits ONE canonical `attachment` message and bumps the thread's
        last-message pointer + unread flag
      * idempotency is per-upload (each call yields a new attachment id)

    Out of scope: chunked uploads, presigned URLs, virus scan, image
    transcoding, gallery semantics. Bytes are stored base64 in the
    `chat_attachments` collection (same v1 pattern as inspection media).
    """
    t, vk = await _load_thread_or_403(thread_id, payload)

    # Resolve sender identity — mirror the gating in `v1_send_message`.
    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    if vk == "user":
        sender_type, sender_id = "user", user_id
    elif vk == "provider":
        sender_type, sender_id = "provider", (slug or "")
    else:  # admin
        if not t.get("adminJoined") and t.get("type") != "support":
            raise HTTPException(409, "Admin must POST /support/join before sending")
        sender_type, sender_id = "admin", "admin"
    if not sender_id:
        raise HTTPException(409, "Sender identity not resolvable")

    # MIME — prefer explicit upload content-type; fall back to filename sniff.
    raw_mime = (file.content_type or "").lower().strip()
    if not raw_mime or raw_mime == "application/octet-stream":
        guess, _ = mimetypes.guess_type(file.filename or "")
        if guess:
            raw_mime = guess.lower()
    kind, cap = _classify_attachment(raw_mime)
    if not kind:
        raise HTTPException(415, f"Unsupported mime type: {raw_mime or '(none)'}")

    # Read payload as a streaming chunked read with rolling size guard
    # (Sprint B4a.1 hardening). Aborts the moment we cross the kind's cap
    # so a 100 GB pathological multipart never materialises into memory.
    data = await _stream_read_capped(file, cap)
    size = len(data)
    if size == 0:
        raise HTTPException(400, "Empty file")

    # Magic-byte sniff on top of the MIME whitelist (defence in depth).
    # Catches the obvious "fake mime + raw bytes" attack pattern. We
    # check the first 16 bytes only — every signature in our whitelist
    # fits within that window.
    if not _verify_magic_bytes(raw_mime, data[:16]):
        raise HTTPException(415, f"Magic bytes do not match declared MIME: {raw_mime}")

    # Persist attachment metadata + bytes (base64). Bytes never leave
    # this collection — `_project_message` references via URL only.
    attach_id = uid()
    now_iso = now_utc().isoformat()
    attach_doc = {
        "_id": attach_id,
        "id": attach_id,
        "threadId": thread_id,
        "kind": kind,
        "mimeType": raw_mime,
        "filename": file.filename or f"attachment-{attach_id[:8]}",
        "sizeBytes": size,
        "uploaderKind": sender_type,
        "uploaderId": sender_id,
        "dataBase64": base64.b64encode(data).decode("ascii"),
        "createdAt": now_iso,
    }
    await db.chat_attachments.insert_one(attach_doc)

    # Emit canonical attachment message. `caption` may be empty; `body`
    # in the projection falls through to `caption` on the wire.
    msg_doc = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": sender_type,
        "senderId": sender_id,
        "type": "attachment",
        "text": "",
        "caption": (caption or "").strip(),
        "attachment": {
            "id": attach_id,
            "kind": kind,
            "filename": attach_doc["filename"],
            "mimeType": raw_mime,
            "sizeBytes": size,
        },
        "createdAt": now_iso,
        "readAt": None,
    }
    await db.chat_messages.insert_one(dict(msg_doc))
    msg_doc.pop("_id", None)

    # Bump thread — last-message preview is a humane label.
    preview = (caption.strip() if caption else "") or (
        "📎 Файл" if kind == "file" else ("📄 PDF" if kind == "pdf" else "🖼 Фото")
    )
    update = {"lastMessage": preview[:140], "lastMessageAt": now_iso}
    if sender_type == "user":
        update["unreadByOther"] = True
    elif sender_type == "provider":
        update["unreadByUser"] = True
    else:  # admin
        update["unreadByUser"] = True
    await db.chat_threads.update_one({"id": thread_id}, {"$set": update})

    t2 = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    sender_map = await _build_sender_name_map([msg_doc])
    # Sprint B5 — broadcast attachment message to live subscribers.
    from . import realtime as _rt
    try:
        await _rt.publish_new_message(t2, msg_doc)
    except Exception:
        pass
    return {
        "message": _project_message(msg_doc, vk, user_id, slug, sender_map),
        "thread": await _project_thread(t2, vk),
    }


@router.get("/attachments/{attachment_id}")
async def v1_serve_attachment(
    attachment_id: str,
    request: Request,
    token: Optional[str] = Query(None, description="Optional JWT fallback for surfaces that can't send Authorization headers (RN Linking, <img>, anchor tags). Same JWT as Bearer."),
):
    """Serve raw attachment bytes. Auth: caller MUST be a participant of
    the thread that owns the attachment.

    Two auth paths:
      1. `Authorization: Bearer <jwt>` — standard, used by fetch/axios
      2. `?token=<jwt>` — fallback for surfaces that can't set headers
         (React Native `Linking.openURL`, raw `<img>` tags, anchor tags).
         Same JWT, same claims; the query string is HTTPS-encrypted on
         the wire and the ids are random UUIDs, so leakage risk is
         comparable to a signed S3 URL.

    Cache headers: `private, max-age=3600`. Inline-disposition for image/pdf
    so the OS picks the right viewer; attachment-disposition for `file`
    kind triggers a download prompt with the original filename."""
    payload = _decode_chat_jwt(request, token)
    a = await db.chat_attachments.find_one({"_id": attachment_id})
    if not a:
        raise HTTPException(404, "Attachment not found")
    thread = await db.chat_threads.find_one({"id": a.get("threadId")}, {"_id": 0})
    if not thread:
        raise HTTPException(404, "Thread not found")
    vk = _viewer_kind(payload, thread)
    if vk is None:
        raise HTTPException(403, "Not a participant of this thread")
    try:
        raw = base64.b64decode(a["dataBase64"])
    except Exception:
        raise HTTPException(500, "Corrupted attachment payload")
    mime = a.get("mimeType") or "application/octet-stream"
    filename = a.get("filename") or attachment_id
    disposition = "inline" if a.get("kind") in ("image", "pdf") else f'attachment; filename="{filename}"'
    return Response(
        content=raw,
        media_type=mime,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": disposition,
        },
    )



# ─────────────────────────────────────────────────────────────────
# Sprint B4b — Voice messages (record → upload → playback)
# ─────────────────────────────────────────────────────────────────

_VOICE_MIMES = {"audio/m4a", "audio/mp4", "audio/aac", "audio/mpeg", "audio/webm"}
_VOICE_MAX_BYTES = 12 * 1024 * 1024
_VOICE_MAX_DURATION_MS = 120 * 1000
_VOICE_MIN_DURATION_MS = 200


@router.post("/threads/{thread_id}/voice")
async def v1_upload_voice(
    thread_id: str,
    file: UploadFile = File(..., description="Voice blob (audio/mp4|m4a|aac|mpeg|webm)"),
    duration_ms: int = Form(..., ge=1),
    payload: dict = Depends(verify_user_token),
):
    """Upload one complete voice blob to a thread.

    Acceptance criteria (B4b):
      * participant-only (403 otherwise) — admin needs prior /support/join
        on non-support threads, auto-joined on support-type
      * MIME whitelist (_VOICE_MIMES) → 415 otherwise
      * size cap 12 MB (streaming check) → 413 otherwise
      * duration cap 120 000 ms, floor 200 ms → 422 otherwise
      * magic-byte sniff defends against fake-mime payloads
      * emits ONE canonical `voice` message and bumps the thread last
        message + unread (same semantics as text/attachment)
      * NO caption (spec: "Caption ❌")"""
    t, vk = await _load_thread_or_403(thread_id, payload)

    user_id = _user_id_from(payload)
    slug = _provider_slug_from(payload)
    if vk == "user":
        sender_type, sender_id = "user", user_id
    elif vk == "provider":
        sender_type, sender_id = "provider", (slug or "")
    else:
        if not t.get("adminJoined") and t.get("type") != "support":
            raise HTTPException(409, "Admin must POST /support/join before sending")
        sender_type, sender_id = "admin", "admin"
    if not sender_id:
        raise HTTPException(409, "Sender identity not resolvable")

    if duration_ms < _VOICE_MIN_DURATION_MS or duration_ms > _VOICE_MAX_DURATION_MS:
        raise HTTPException(
            422,
            f"durationMs out of range: must be [{_VOICE_MIN_DURATION_MS}, {_VOICE_MAX_DURATION_MS}]",
        )

    raw_mime = (file.content_type or "").lower().strip()
    if not raw_mime or raw_mime == "application/octet-stream":
        guess, _ = mimetypes.guess_type(file.filename or "")
        if guess:
            raw_mime = guess.lower()
    if raw_mime not in _VOICE_MIMES:
        raise HTTPException(415, f"Unsupported voice mime: {raw_mime or '(none)'}")

    data = await _stream_read_capped(file, _VOICE_MAX_BYTES)
    size = len(data)
    if size == 0:
        raise HTTPException(400, "Empty file")
    if not _verify_magic_bytes(raw_mime, data[:16]):
        raise HTTPException(415, f"Magic bytes do not match declared voice MIME: {raw_mime}")

    voice_id = uid()
    now_iso = now_utc().isoformat()
    voice_doc = {
        "_id": voice_id,
        "id": voice_id,
        "threadId": thread_id,
        "mimeType": raw_mime,
        "durationMs": int(duration_ms),
        "sizeBytes": size,
        "uploaderKind": sender_type,
        "uploaderId": sender_id,
        "dataBase64": base64.b64encode(data).decode("ascii"),
        "createdAt": now_iso,
    }
    await db.chat_voice.insert_one(voice_doc)

    msg_doc = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": sender_type,
        "senderId": sender_id,
        "type": "voice",
        "text": "",
        "voice": {
            "id": voice_id,
            "mimeType": raw_mime,
            "durationMs": int(duration_ms),
            "sizeBytes": size,
        },
        "createdAt": now_iso,
        "readAt": None,
    }
    await db.chat_messages.insert_one(dict(msg_doc))
    msg_doc.pop("_id", None)

    secs_total = int(duration_ms // 1000)
    mins = secs_total // 60
    secs = secs_total % 60
    preview = f"🎤 Голосовое {mins}:{secs:02d}"
    update = {"lastMessage": preview, "lastMessageAt": now_iso}
    if sender_type == "user":
        update["unreadByOther"] = True
    elif sender_type == "provider":
        update["unreadByUser"] = True
    else:
        update["unreadByUser"] = True
    await db.chat_threads.update_one({"id": thread_id}, {"$set": update})

    t2 = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    sender_map = await _build_sender_name_map([msg_doc])
    # Sprint B5 — broadcast voice message to live subscribers.
    from . import realtime as _rt
    try:
        await _rt.publish_new_message(t2, msg_doc)
    except Exception:
        pass
    return {
        "message": _project_message(msg_doc, vk, user_id, slug, sender_map),
        "thread": await _project_thread(t2, vk),
    }


@router.get("/voice/{voice_id}")
async def v1_serve_voice(
    voice_id: str,
    request: Request,
    token: Optional[str] = Query(None),
):
    """Serve raw voice bytes. Auth: caller MUST be a participant of the
    thread that owns the blob. Dual-auth (Authorization header OR
    `?token=` query). Inline disposition so HTML5 `<audio controls>` /
    RN expo-av can preview directly."""
    payload = _decode_chat_jwt(request, token)
    v = await db.chat_voice.find_one({"_id": voice_id})
    if not v:
        raise HTTPException(404, "Voice not found")
    thread = await db.chat_threads.find_one({"id": v.get("threadId")}, {"_id": 0})
    if not thread:
        raise HTTPException(404, "Thread not found")
    vk = _viewer_kind(payload, thread)
    if vk is None:
        raise HTTPException(403, "Not a participant of this thread")
    try:
        raw = base64.b64decode(v["dataBase64"])
    except Exception:
        raise HTTPException(500, "Corrupted voice payload")
    mime = v.get("mimeType") or "audio/mp4"
    return Response(
        content=raw,
        media_type=mime,
        headers={
            "Cache-Control": "private, max-age=3600",
            "Content-Disposition": "inline",
        },
    )


# ─────────────────────────────────────────────────────────────────
# Sprint B4c — Reactions (metadata, NOT messages)
# ─────────────────────────────────────────────────────────────────
#
# Hard invariants enforced below:
#   - reactions DO NOT bump thread.lastMessageAt / lastMessage preview
#   - reactions DO NOT increment unreadByUser / unreadByOther
#   - reactions DO NOT generate system messages or notifications
#   - reactions DO NOT reorder threads in the list endpoint
# Reactions are a per-message decoration. The atomic primitives
# `$addToSet` (POST) and `$pull` (DELETE) keep parallel-toggle races
# coherent: simultaneous adds → set semantics (count stays 1, never 2),
# simultaneous removes → idempotent (count stays 0).

# Tiny whitelist by doctrine — see `ChatReactionEmoji` in
# `shared/domain/contracts/chat.ts`. Skin tones, ZWJ-composed sequences
# and variation selectors are intentionally out: each one is a separate
# storage/normalization headache. Growing the set is a deliberate review.
_REACTION_WHITELIST: tuple[str, ...] = ("👍", "❤️", "😂", "😮", "😢", "👎")
_REACTION_SET = set(_REACTION_WHITELIST)


def _reactor_id_for(vk: str, user_id: str, slug: Optional[str]) -> str:
    """Stable identity of "the caller" for the reactions storage layer.

    Mirrors the `sender_id` resolution used in message-send so a message
    author's reactor-id matches their author-id.
    """
    if vk == "user":
        return user_id
    if vk == "provider":
        return slug or ""
    return "admin"


def _project_reactions(
    stored: dict,
    viewer_kind: str,
    viewer_user_id: str,
    viewer_slug: Optional[str],
) -> list[dict]:
    """Storage-shape `{ "👍": ["u1","u2"], "❤️": ["u3"] }` → canonical
    `[{emoji, count, reactedByMe}]` array.

    Sort order: `count desc, emoji whitelist-index asc`. The whitelist
    index gives a stable, deterministic tie-break that doesn't depend on
    Unicode collation across DB/runtime versions.

    User-id arrays are deliberately stripped from the wire — clients
    must never see who-reacted-with-what; that's a moderation surface,
    not a chat-decoration concern.
    """
    if not stored:
        return []
    me = _reactor_id_for(viewer_kind, viewer_user_id, viewer_slug)
    rows: list[dict] = []
    for emoji in _REACTION_WHITELIST:
        ids = stored.get(emoji)
        if not ids:
            continue
        # `ids` could legitimately be a list or a set depending on
        # write path quirks. Coerce defensively but cheaply.
        if not isinstance(ids, (list, tuple, set)):
            continue
        count = len(ids)
        if count <= 0:
            continue
        rows.append({
            "emoji": emoji,
            "count": int(count),
            "reactedByMe": me in ids if me else False,
        })
    rows.sort(key=lambda r: (-r["count"], _REACTION_WHITELIST.index(r["emoji"])))
    return rows


class V1ReactionRequest(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=8)


async def _load_message_for_reaction(message_id: str, payload: dict) -> tuple[dict, dict, str, str, Optional[str]]:
    """Resolve `(message, thread, viewer_kind, viewer_user_id, viewer_slug)`.

    404 → message missing. 403 → caller is not a participant of the
    enclosing thread. Same gate that protects message reads (any
    participant can react; reactions are a chat-wide decoration).
    """
    m = await db.chat_messages.find_one({"id": message_id}, {"_id": 0})
    if not m:
        raise HTTPException(404, "Message not found")
    t = await db.chat_threads.find_one({"id": m.get("threadId")}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    vk = _viewer_kind(payload, t)
    if vk is None:
        raise HTTPException(403, "Not a participant of this thread")
    return m, t, vk, _user_id_from(payload), _provider_slug_from(payload)


@router.post("/messages/{message_id}/reactions")
async def v1_add_reaction(
    message_id: str,
    body: V1ReactionRequest,
    payload: dict = Depends(verify_user_token),
):
    """Add a reaction to a message. Idempotent (`$addToSet`).

    No thread bump, no unread bump, no system message, no notification.
    These invariants are the explicit doctrine of B4c (see module-level
    comment above)."""
    emoji = body.emoji
    if emoji not in _REACTION_SET:
        raise HTTPException(
            422,
            f"Unsupported reaction emoji. Allowed: {' '.join(_REACTION_WHITELIST)}",
        )
    _msg, _t, vk, user_id, slug = await _load_message_for_reaction(message_id, payload)
    reactor = _reactor_id_for(vk, user_id, slug)
    if not reactor:
        raise HTTPException(409, "Reactor identity not resolvable")
    # Atomic add — Mongo guarantees `$addToSet` is set-semantic so
    # concurrent adds collapse to a single entry. NO `$set` on thread.
    await db.chat_messages.update_one(
        {"id": message_id},
        {"$addToSet": {f"reactions.{emoji}": reactor}},
    )
    fresh = await db.chat_messages.find_one(
        {"id": message_id}, {"_id": 0}
    )
    # Sprint B5 — broadcast reaction change to live subscribers.
    from . import realtime as _rt
    try:
        if fresh:
            await _rt.publish_reaction_update(_t, fresh)
    except Exception:
        pass
    return {
        "ok": True,
        "messageId": message_id,
        "reactions": _project_reactions(
            (fresh or {}).get("reactions") or {}, vk, user_id, slug,
        ),
    }


@router.delete("/messages/{message_id}/reactions/{emoji}")
async def v1_remove_reaction(
    message_id: str,
    emoji: str,
    payload: dict = Depends(verify_user_token),
):
    """Remove the caller's reaction from a message. Idempotent (`$pull`).

    Same invariants as POST: no thread bump, no unread mutation."""
    if emoji not in _REACTION_SET:
        raise HTTPException(
            422,
            f"Unsupported reaction emoji. Allowed: {' '.join(_REACTION_WHITELIST)}",
        )
    _msg, _t, vk, user_id, slug = await _load_message_for_reaction(message_id, payload)
    reactor = _reactor_id_for(vk, user_id, slug)
    if not reactor:
        raise HTTPException(409, "Reactor identity not resolvable")
    await db.chat_messages.update_one(
        {"id": message_id},
        {"$pull": {f"reactions.{emoji}": reactor}},
    )
    fresh = await db.chat_messages.find_one(
        {"id": message_id}, {"_id": 0}
    )
    # Sprint B5 — broadcast reaction removal to live subscribers.
    from . import realtime as _rt
    try:
        if fresh:
            await _rt.publish_reaction_update(_t, fresh)
    except Exception:
        pass
    return {
        "ok": True,
        "messageId": message_id,
        "reactions": _project_reactions(
            (fresh or {}).get("reactions") or {}, vk, user_id, slug,
        ),
    }


# ─────────────────────────────────────────────────────────────────
# Sprint B5 — WebSocket endpoint
# ─────────────────────────────────────────────────────────────────
#
# Mounted on the same canonical router (`/api/chat/v1`). REST and WS
# share the prefix so subscribers reach the hub at the predictable URL
# `/api/chat/v1/ws?token=<jwt>`. The endpoint delegates to
# `realtime.chat_ws_handler` — see that module for doctrine notes.

@router.websocket("/ws")
async def v1_chat_ws(websocket: WebSocket, token: Optional[str] = Query(None)):
    from . import realtime as _rt
    await _rt.chat_ws_handler(websocket, token)
