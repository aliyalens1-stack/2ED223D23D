"""Sprint 4 — Admin moderation endpoints for service chats.

Endpoints:
  GET  /api/admin/service-chats                       список чатов (фильтр flagged/active/frozen)
  GET  /api/admin/service-chats/{chatId}              мета + участники + flags summary
  GET  /api/admin/service-chats/{chatId}/messages     все сообщения (включая shadow-hidden)
  POST /api/admin/service-chats/{chatId}/moderate     действие модерации
  POST /api/admin/service-chats/{chatId}/reply        ответить как admin/support
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, Depends, HTTPException, Request, Query

from app.core.utils import now_utc, uid
from app.core.db import get_db
from app.core.security import verify_admin_token
from .models import ModerateBody


logger = logging.getLogger(__name__)
admin_chats_router = APIRouter(
    prefix="/api/admin/service-chats",
    tags=["service_chat:admin"],
    dependencies=[Depends(verify_admin_token)],
)


@admin_chats_router.get("")
async def list_chats(
    status: str | None = Query(None),
    flagged_only: bool = Query(False),
    limit: int = Query(50, ge=1, le=200),
):
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    if flagged_only:
        q["flagsCount"] = {"$gt": 0}
    cursor = db.service_chats.find(q, {"_id": 0}).sort("flagsCount", -1).sort("lastMessageAt", -1).limit(limit)
    chats = await cursor.to_list(limit)
    return {"chats": chats, "total": len(chats)}


@admin_chats_router.get("/{chat_id}")
async def get_chat_admin(chat_id: str):
    db = get_db()
    chat = await db.service_chats.find_one({"id": chat_id}, {"_id": 0})
    if not chat:
        raise HTTPException(404, "Chat not found")
    # Aggregate flags
    flag_counts = {}
    async for m in db.service_messages.find({"chatId": chat_id, "flags": {"$ne": []}}, {"_id": 0, "flags": 1}):
        for f in m.get("flags", []):
            flag_counts[f] = flag_counts.get(f, 0) + 1
    return {"chat": chat, "flagBreakdown": flag_counts}


@admin_chats_router.get("/{chat_id}/messages")
async def list_messages_admin(chat_id: str, limit: int = Query(500, ge=1, le=1000)):
    db = get_db()
    cursor = db.service_messages.find({"chatId": chat_id}, {"_id": 0}).sort("createdAt", 1).limit(limit)
    msgs = await cursor.to_list(limit)
    return {"messages": msgs, "count": len(msgs)}


@admin_chats_router.post("/{chat_id}/moderate")
async def moderate(chat_id: str, body: ModerateBody, request: Request):
    """Применить действие модерации.

    Действия:
      warn                    — записать инцидент, ничего не скрывать
      shadow_hide_message     — пометить конкретное сообщение скрытым
      strike_provider         — провайдер получает +1 strike (3 → block)
      freeze_chat             — chat.status='frozen' (никто не может писать)
      unfreeze_chat           — chat.status='active'
    """
    db = get_db()
    chat = await db.service_chats.find_one({"id": chat_id}, {"_id": 0})
    if not chat:
        raise HTTPException(404, "Chat not found")
    now = now_utc().isoformat()

    action = body.action
    if action == "warn":
        await db.service_messages.insert_one({
            "id": uid(), "chatId": chat_id, "senderId": None, "senderRole": "admin",
            "type": "system", "body": f"⚠️ Admin warning: {body.reason or 'обмен контактами запрещён'}",
            "createdAt": now, "shadowHidden": False, "flags": [],
        })
    elif action == "shadow_hide_message":
        if not body.messageId:
            raise HTTPException(400, "messageId required")
        await db.service_messages.update_one(
            {"id": body.messageId, "chatId": chat_id},
            {"$set": {"shadowHidden": True, "moderatedAt": now, "moderationReason": body.reason}},
        )
    elif action == "strike_provider":
        prov_id = chat.get("providerId")
        if not prov_id:
            raise HTTPException(400, "Chat has no provider")
        # users._id может быть BSON ObjectId — пробуем оба варианта
        result = await db.users.update_one({"_id": prov_id}, {"$inc": {"bypassStrikes": 1}})
        if result.matched_count == 0:
            try:
                from bson import ObjectId
                result = await db.users.update_one({"_id": ObjectId(prov_id)}, {"$inc": {"bypassStrikes": 1}})
            except Exception:
                pass
        if result.matched_count == 0:
            raise HTTPException(404, "Provider not found")
    elif action == "freeze_chat":
        await db.service_chats.update_one({"id": chat_id}, {"$set": {"status": "frozen", "frozenAt": now}})
    elif action == "unfreeze_chat":
        await db.service_chats.update_one({"id": chat_id}, {"$set": {"status": "active", "frozenAt": None}})
    else:
        raise HTTPException(400, f"Unknown action: {action}")

    # Audit log
    await db.service_chat_moderations.insert_one({
        "id": uid(), "chatId": chat_id, "action": action,
        "messageId": body.messageId, "reason": body.reason,
        "createdAt": now,
    })
    return {"ok": True, "action": action}


@admin_chats_router.post("/{chat_id}/reply")
async def admin_reply(chat_id: str, request: Request):
    """Admin отвечает в чат."""
    body = await request.json()
    text = (body.get("body") or "").strip()
    if not text:
        raise HTTPException(400, "body required")
    db = get_db()
    chat = await db.service_chats.find_one({"id": chat_id}, {"_id": 0})
    if not chat:
        raise HTTPException(404, "Chat not found")
    now = now_utc().isoformat()
    msg = {
        "id": uid(), "chatId": chat_id, "senderId": None, "senderRole": "admin",
        "type": "text", "body": text, "createdAt": now,
        "shadowHidden": False, "flags": [],
    }
    await db.service_messages.insert_one(dict(msg))
    msg.pop("_id", None)
    await db.service_chats.update_one(
        {"id": chat_id},
        {"$set": {"lastMessageAt": now, "lastMessagePreview": f"[admin] {text[:60]}", "updatedAt": now},
         "$inc": {"unreadCustomer": 1, "unreadProvider": 1}},
    )
    return {"message": msg}
