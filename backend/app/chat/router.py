"""Chat & Notifications — Sprint 34 D8 (full functional, not mock).

Collections:
  - chat_threads          { id, type:'support'|'provider'|'admin_user', participantUserId, providerSlug?,
                            bookingId?, title, lastMessage, lastMessageAt, unreadByUser, unreadByOther, createdAt }
  - chat_messages         { id, threadId, senderType:'user'|'provider'|'admin', senderId,
                            text, createdAt, readAt? }
  - notifications         { id, userId, type, title, body, actionUrl?, isRead, createdAt }

Endpoints (USER):
  GET  /api/chat/threads                       — list current user's threads (with provider info hydrated)
  POST /api/chat/threads                       — create or reuse thread (type=support|provider, providerSlug?, bookingId?)
  GET  /api/chat/threads/{thread_id}/messages  — messages (newest last)
  POST /api/chat/threads/{thread_id}/messages  — send message as user
  POST /api/chat/threads/{thread_id}/read      — mark all unread as read for current user

  GET  /api/notifications                      — list user's notifications
  POST /api/notifications/{id}/read            — mark single notification read
  POST /api/notifications/read-all             — mark all read

Endpoints (ADMIN):
  GET  /api/admin/chat/threads                 — all threads (filter type=support)
  GET  /api/admin/chat/threads/{id}/messages   — messages
  POST /api/admin/chat/threads/{id}/reply      — reply as admin/support

Endpoints (PROVIDER):
  GET  /api/provider/chat/threads              — provider's threads (their slug)
  POST /api/provider/chat/threads/{id}/reply   — reply as provider
"""
from __future__ import annotations
import logging
from datetime import datetime, timezone
from typing import Optional, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.core.db import db
from app.core.security import verify_admin_token, verify_user_token
from app.core.utils import now_utc, uid
# P6.B.2 — Attribution wiring for /api/admin/chat/threads/{id}/reply.
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

router = APIRouter(prefix="/api", tags=["chat"])
logger = logging.getLogger(__name__)


def _user_id_from(payload: dict) -> str:
    """Extract canonical user id from JWT payload."""
    return str(payload.get("userId") or payload.get("sub") or payload.get("email") or "")


def _provider_slug_from(payload: dict) -> Optional[str]:
    return payload.get("providerSlug") or payload.get("slug")


async def _hydrate_provider(slug: str) -> dict:
    """Cheap provider snapshot — name + avatar initial."""
    if not slug:
        return {}
    p = await db.providers.find_one({"slug": slug}, {"_id": 0, "name": 1, "avatar": 1, "rating": 1})
    if not p:
        return {"slug": slug, "name": slug.replace("-", " ").title()}
    return {"slug": slug, **p}


# ── Models ────────────────────────────────────────────────────────────────
class CreateThreadRequest(BaseModel):
    type: Literal["support", "provider", "admin_user"]
    providerSlug: Optional[str] = None
    bookingId: Optional[str] = None
    title: Optional[str] = None
    initialMessage: Optional[str] = None


class SendMessageRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=4000)


class CreateNotificationRequest(BaseModel):
    """Internal helper — used by other modules to push a notification."""
    userId: str
    type: str
    title: str
    body: str
    actionUrl: Optional[str] = None


# ── Helpers ───────────────────────────────────────────────────────────────
async def push_notification(user_id: str, ntype: str, title: str, body: str, action_url: Optional[str] = None):
    """Internal API for other modules to fire a notification."""
    doc = {
        "id": uid(),
        "userId": user_id,
        "type": ntype,
        "title": title,
        "body": body,
        "actionUrl": action_url,
        "isRead": False,
        "createdAt": now_utc().isoformat(),
    }
    await db.notifications.insert_one(doc)
    return doc


async def _bump_thread(thread_id: str, last_message: str, sender_type: str):
    """Update last-message + unread counters."""
    update = {
        "lastMessage": last_message[:140],
        "lastMessageAt": now_utc().isoformat(),
    }
    if sender_type == "user":
        update["unreadByOther"] = True   # provider/admin sees unread
    else:
        update["unreadByUser"] = True    # user sees unread
    await db.chat_threads.update_one({"id": thread_id}, {"$set": update})


# ── USER: Threads ─────────────────────────────────────────────────────────
@router.get("/chat/threads")
async def list_user_threads(payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)
    cursor = db.chat_threads.find({"participantUserId": user_id}, {"_id": 0}).sort("lastMessageAt", -1)
    threads = await cursor.to_list(length=100)
    # Hydrate provider info
    for t in threads:
        if t.get("providerSlug"):
            t["provider"] = await _hydrate_provider(t["providerSlug"])
    return {"threads": threads}


@router.post("/chat/threads")
async def create_thread(body: CreateThreadRequest, payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)

    # Reuse existing thread per (user, type, providerSlug, bookingId)
    query = {"participantUserId": user_id, "type": body.type}
    if body.providerSlug:
        query["providerSlug"] = body.providerSlug
    if body.bookingId:
        query["bookingId"] = body.bookingId
    existing = await db.chat_threads.find_one(query, {"_id": 0})
    if existing:
        # If initial message provided — append it
        if body.initialMessage:
            await _send_user_message(existing["id"], user_id, body.initialMessage)
            existing = await db.chat_threads.find_one({"id": existing["id"]}, {"_id": 0})
        if existing.get("providerSlug"):
            existing["provider"] = await _hydrate_provider(existing["providerSlug"])
        return {"thread": existing, "reused": True}

    title = body.title
    if not title:
        if body.type == "support":
            title = "AutoSearch Support"
        elif body.type == "provider" and body.providerSlug:
            p = await _hydrate_provider(body.providerSlug)
            title = p.get("name", "Provider")
        else:
            title = "Chat"

    thread = {
        "id": uid(),
        "type": body.type,
        "participantUserId": user_id,
        "providerSlug": body.providerSlug,
        "bookingId": body.bookingId,
        "title": title,
        "lastMessage": "",
        "lastMessageAt": now_utc().isoformat(),
        "unreadByUser": False,
        "unreadByOther": False,
        "createdAt": now_utc().isoformat(),
    }
    await db.chat_threads.insert_one(dict(thread))
    thread.pop("_id", None)

    if body.initialMessage:
        await _send_user_message(thread["id"], user_id, body.initialMessage)
        thread = await db.chat_threads.find_one({"id": thread["id"]}, {"_id": 0})

    if thread.get("providerSlug"):
        thread["provider"] = await _hydrate_provider(thread["providerSlug"])
    return {"thread": thread, "reused": False}


@router.get("/chat/threads/{thread_id}/messages")
async def list_messages(thread_id: str, payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)
    role = payload.get("role")
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    # Access: customer (participantUserId) OR provider (matching slug) OR admin
    is_customer = t.get("participantUserId") == user_id
    is_provider = role == "provider" and t.get("providerSlug") and t.get("providerSlug") == _provider_slug_from(payload)
    # Sprint 1D.3: switched off raw legacy role check (now reads JWT kind claim).
    # `kind` is the JWT claim populated by 1C `issue_account_jwt` from the
    # active `account.kind` — single source of truth, and reflects account
    # switching once 1E ships (admin user in customer persona will lose
    # admin chat privileges, which is the desired semantic).
    is_admin = payload.get("kind") == "admin"
    if not (is_customer or is_provider or is_admin):
        raise HTTPException(403, "Not your thread")
    cursor = db.chat_messages.find({"threadId": thread_id}, {"_id": 0}).sort("createdAt", 1)
    msgs = await cursor.to_list(length=500)
    return {"thread": t, "messages": msgs}


async def _send_user_message(thread_id: str, user_id: str, text: str) -> dict:
    msg = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": "user",
        "senderId": user_id,
        "text": text,
        "createdAt": now_utc().isoformat(),
    }
    await db.chat_messages.insert_one(dict(msg))
    msg.pop("_id", None)
    await _bump_thread(thread_id, text, "user")
    return msg


@router.post("/chat/threads/{thread_id}/messages")
async def send_message(thread_id: str, body: SendMessageRequest, payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    if t.get("participantUserId") != user_id:
        raise HTTPException(403, "Not your thread")
    msg = await _send_user_message(thread_id, user_id, body.text)

    # Auto-reply for support if no admin online (simple bot)
    if t.get("type") == "support":
        # Notify admin via notifications collection
        await push_notification(
            "admin", "support_message",
            "Новое сообщение в поддержку",
            f"От {user_id[:30]}: {body.text[:80]}",
            action_url=f"/billing/support-chat?threadId={thread_id}"
        )

    return {"message": msg}


@router.post("/chat/threads/{thread_id}/read")
async def mark_read(thread_id: str, payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)
    role = payload.get("role")
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    is_customer = t.get("participantUserId") == user_id
    is_provider = role == "provider" and t.get("providerSlug") and t.get("providerSlug") == _provider_slug_from(payload)
    # Sprint 1D.3: see comment on `list_messages` — same migration to `kind`.
    is_admin = payload.get("kind") == "admin"
    if not (is_customer or is_provider or is_admin):
        raise HTTPException(403, "Not your thread")
    update_filter: dict = {}
    if is_customer:
        update_filter["unreadByUser"] = False
    if is_provider or is_admin:
        update_filter["unreadByOther"] = False
    await db.chat_threads.update_one({"id": thread_id}, {"$set": update_filter})
    other_filter = {"threadId": thread_id, "readAt": None}
    if is_customer:
        other_filter["senderType"] = {"$ne": "user"}
    else:
        other_filter["senderType"] = "user"
    await db.chat_messages.update_many(other_filter, {"$set": {"readAt": now_utc().isoformat()}})
    return {"ok": True}


# ── USER: Notifications ───────────────────────────────────────────────────
@router.get("/notifications")
async def list_notifications(payload: dict = Depends(verify_user_token)):
    user_id = _user_id_from(payload)
    cursor = db.notifications.find({"userId": user_id}, {"_id": 0}).sort("createdAt", -1)
    items = await cursor.to_list(length=100)
    unread = sum(1 for x in items if not x.get("isRead"))
    return {"notifications": items, "unread": unread}


@router.post("/notifications/{nid}/read")
async def mark_notification_read(nid: str, payload: dict = Depends(verify_user_token)):
    """Sprint 3 Step 2 — atomic + idempotent mark-read.

    The `isRead: False` filter makes the update a no-op on re-delivery, so
    `readAt` is set exactly once even if the client retries (polling +
    optimistic UI may race). 404 is returned only when the row doesn't
    exist at all (vs already-read), so clients can distinguish.
    """
    user_id = _user_id_from(payload)
    read_at = now_utc().isoformat()
    res = await db.notifications.update_one(
        {"id": nid, "userId": user_id, "isRead": False},
        {"$set": {"isRead": True, "readAt": read_at}},
    )
    if res.matched_count == 0:
        # Either the row doesn't exist OR it was already read. Distinguish.
        exists = await db.notifications.count_documents(
            {"id": nid, "userId": user_id}, limit=1
        )
        if not exists:
            raise HTTPException(404, "Notification not found")
        # Already read — idempotent success.
        return {"ok": True, "alreadyRead": True}
    return {"ok": True}


@router.post("/notifications/read-all")
async def mark_all_read(payload: dict = Depends(verify_user_token)):
    """Sprint 3 Step 2 — atomic batch mark-read.

    Filtered to `isRead: False` so the operation is naturally idempotent
    and `readAt` only stamps the rows that actually transition.
    """
    user_id = _user_id_from(payload)
    read_at = now_utc().isoformat()
    res = await db.notifications.update_many(
        {"userId": user_id, "isRead": False},
        {"$set": {"isRead": True, "readAt": read_at}},
    )
    return {"ok": True, "modified": res.modified_count}


# ── ADMIN: Support chat ───────────────────────────────────────────────────
@router.get("/admin/chat/threads", dependencies=[Depends(verify_admin_token)])
async def admin_list_threads(type: Optional[str] = None):
    q: dict = {}
    if type:
        q["type"] = type
    cursor = db.chat_threads.find(q, {"_id": 0}).sort("lastMessageAt", -1)
    threads = await cursor.to_list(length=200)
    for t in threads:
        if t.get("providerSlug"):
            t["provider"] = await _hydrate_provider(t["providerSlug"])
        # hydrate user
        u = await db.users.find_one({"_id": t.get("participantUserId")}, {"_id": 0, "email": 1, "firstName": 1, "lastName": 1}) \
            or await db.users.find_one({"email": t.get("participantUserId")}, {"_id": 0, "email": 1, "firstName": 1, "lastName": 1})
        if u:
            t["user"] = u
        else:
            t["user"] = {"email": t.get("participantUserId", ""), "firstName": "", "lastName": ""}
    return {"threads": threads}


@router.get("/admin/chat/threads/{thread_id}/messages", dependencies=[Depends(verify_admin_token)])
async def admin_list_messages(thread_id: str):
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    cursor = db.chat_messages.find({"threadId": thread_id}, {"_id": 0}).sort("createdAt", 1)
    msgs = await cursor.to_list(length=500)
    # mark unread-by-other (= unread for admin) as read on view
    await db.chat_threads.update_one({"id": thread_id}, {"$set": {"unreadByOther": False}})
    return {"thread": t, "messages": msgs}


@router.post("/admin/chat/threads/{thread_id}/reply", dependencies=[Depends(verify_admin_token)])
async def admin_reply(
    thread_id: str,
    body: SendMessageRequest,
    ctx_attr: AttributionContext = Depends(get_attribution_context),
):
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t:
        raise HTTPException(404, "Thread not found")
    msg = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": "admin",
        "senderId": "admin",
        "text": body.text,
        "createdAt": now_utc().isoformat(),
    }
    await db.chat_messages.insert_one(dict(msg))
    msg.pop("_id", None)
    await _bump_thread(thread_id, body.text, "admin")
    # Notify user
    user_id = t.get("participantUserId")
    if user_id:
        await push_notification(
            user_id, "support_reply",
            "Новый ответ от поддержки",
            body.text[:140],
            action_url=f"/chat/{thread_id}",
        )
    # P6.B.2 — Attribution: governance trail for admin/support reply.
    try:
        await record_admin_mutation(
            db, ctx_attr,
            action="chat.admin_reply",
            domain="other",
            entity_id=thread_id,
            extra={"threadType": t.get("type"),
                   "participantUserId": user_id,
                   "messageId": msg["id"],
                   "textLen": len(body.text or "")},
        )
    except Exception as _attr_e:
        logger.warning(f"[chat] attribution admin_reply failed: {_attr_e}")
    return {"message": msg}


# ── PROVIDER: chat ────────────────────────────────────────────────────────
@router.get("/provider/chat/threads")
async def provider_list_threads(payload: dict = Depends(verify_user_token)):
    role = payload.get("role")
    if role != "provider":
        raise HTTPException(403, "Provider role required")
    slug = _provider_slug_from(payload)
    if not slug:
        return {"threads": []}
    cursor = db.chat_threads.find({"providerSlug": slug, "type": "provider"}, {"_id": 0}).sort("lastMessageAt", -1)
    threads = await cursor.to_list(length=100)
    # Hydrate customer (the participant) — name + email
    for t in threads:
        uid_v = t.get("participantUserId")
        if uid_v:
            u = await db.users.find_one({"_id": uid_v}, {"_id": 0, "email": 1, "firstName": 1, "lastName": 1}) \
                or await db.users.find_one({"id": uid_v}, {"_id": 0, "email": 1, "firstName": 1, "lastName": 1}) \
                or await db.users.find_one({"email": uid_v}, {"_id": 0, "email": 1, "firstName": 1, "lastName": 1})
            t["user"] = u or {"email": uid_v, "firstName": "", "lastName": ""}
    return {"threads": threads}


@router.post("/provider/chat/threads/{thread_id}/reply")
async def provider_reply(thread_id: str, body: SendMessageRequest, payload: dict = Depends(verify_user_token)):
    if payload.get("role") != "provider":
        raise HTTPException(403, "Provider role required")
    slug = _provider_slug_from(payload)
    t = await db.chat_threads.find_one({"id": thread_id}, {"_id": 0})
    if not t or t.get("providerSlug") != slug:
        raise HTTPException(404, "Thread not found")
    msg = {
        "id": uid(),
        "threadId": thread_id,
        "senderType": "provider",
        "senderId": slug,
        "text": body.text,
        "createdAt": now_utc().isoformat(),
    }
    await db.chat_messages.insert_one(dict(msg))
    msg.pop("_id", None)
    await _bump_thread(thread_id, body.text, "provider")
    # Notify user
    user_id = t.get("participantUserId")
    if user_id:
        await push_notification(
            user_id, "provider_reply",
            t.get("title", "Мастер"),
            body.text[:140],
            action_url=f"/chat/{thread_id}",
        )
    return {"message": msg}
