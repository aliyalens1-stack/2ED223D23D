"""Sprint 4 — Service Chat router (customer/provider).

Endpoints (auth-based — роль определяется по полю в JWT и членству в чате):

  POST /api/service-chats/from-request/{requestId}     get-or-create (idempotent)
  GET  /api/service-chats/me                           мои чаты
  GET  /api/service-chats/{chatId}                     мета + участники
  GET  /api/service-chats/{chatId}/messages            polling (since=ts, limit)
  POST /api/service-chats/{chatId}/messages            отправить
  POST /api/service-chats/{chatId}/quick-action        I'm arriving / started / etc
  POST /api/service-chats/{chatId}/read                mark read (опционально)
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Request, Query

from app.core.utils import now_utc, uid
from app.core.db import get_db
from app.core.security import verify_user_token
from .models import SendMessageBody, QuickActionBody, MessageType
from .scanner import scan_message
from .timeline import append_event


logger = logging.getLogger(__name__)
service_chat_router = APIRouter(tags=["service_chat"])


# ── User helpers ──────────────────────────────────────────────────────────
# Users в Mongo могут иметь _id как ObjectId или как plain string. Helpers
# делают lookup и инкремент устойчивыми к обоим случаям.
async def _find_user_by_id(db, user_id: str):
    """Lookup пользователя по id (поле "id"), _id (string), либо _id (ObjectId)."""
    if not user_id:
        return None
    # Сначала по нашему uid (uuid string в поле "id")
    doc = await db.users.find_one({"id": user_id}, {"_id": 0})
    if doc:
        return doc
    # Затем по _id как string
    doc = await db.users.find_one({"_id": user_id}, {"_id": 0})
    if doc:
        return doc
    # И как ObjectId (legacy)
    try:
        from bson import ObjectId
        return await db.users.find_one({"_id": ObjectId(user_id)}, {"_id": 0})
    except Exception:
        return None


async def _increment_user_field(db, user_id: str, field: str, delta: int = 1):
    """Atomic $inc по любому из id-варианта документа пользователя."""
    if not user_id:
        return
    # Попытка по "id"
    res = await db.users.update_one({"id": user_id}, {"$inc": {field: delta}})
    if res.matched_count:
        return
    # По _id string
    res = await db.users.update_one({"_id": user_id}, {"$inc": {field: delta}})
    if res.matched_count:
        return
    # По _id ObjectId
    try:
        from bson import ObjectId
        await db.users.update_one({"_id": ObjectId(user_id)}, {"$inc": {field: delta}})
    except Exception:
        pass


# ── Helpers ───────────────────────────────────────────────────────────────
async def ensure_chat_for_request(*, request_doc: dict, db) -> dict:
    """Создать (или вернуть существующий) chat для заявки. Idempotent.

    Триггер: payment.status='paid'. Вызывается из escrow.router_payments
    при обработке webhook payment_intent.succeeded.
    """
    request_id = request_doc.get("id")
    existing = await db.service_chats.find_one({"requestId": request_id}, {"_id": 0})
    if existing:
        return existing

    customer_id = request_doc.get("customerId")
    provider_id = request_doc.get("assignedProviderId")
    if not customer_id or not provider_id:
        raise ValueError(f"Cannot create chat: missing participants on {request_id}")

    now = now_utc().isoformat()
    chat = {
        "id": uid(),
        "requestId": request_id,
        "customerId": customer_id,
        "providerId": provider_id,
        "status": "active",
        "lastMessageAt": now,
        "lastMessagePreview": "Чат открыт. Можно обсуждать детали работы.",
        "unreadCustomer": 1,
        "unreadProvider": 1,
        "flagsCount": 0,
        "createdAt": now,
        "updatedAt": now,
    }
    await db.service_chats.insert_one(dict(chat))
    chat.pop("_id", None)

    # Welcome system message
    await db.service_messages.insert_one({
        "id": uid(),
        "chatId": chat["id"],
        "senderId": None,
        "senderRole": "system",
        "type": "system",
        "body": "Чат открыт после оплаты. Контакты партнёра уже доступны на странице заявки. Любой обмен контактами здесь не нужен — платформа защитит сделку.",
        "createdAt": now,
        "shadowHidden": False,
        "flags": [],
    })

    # Timeline event
    await append_event(
        request_id=request_id,
        kind="chat_opened",
        actor_role="system",
        meta={"chatId": chat["id"]},
        db=db,
    )
    logger.info(f"[service_chat] opened chat {chat['id']} for request {request_id}")
    return chat


def _public_chat(chat: dict) -> dict:
    return {k: v for k, v in chat.items() if k != "_id"}


def _public_message(msg: dict, viewer_id: str | None) -> dict:
    """Скрыть body если message shadow-hidden И смотрит не отправитель."""
    out = {k: v for k, v in msg.items() if k != "_id"}
    if out.get("shadowHidden") and viewer_id and out.get("senderId") != viewer_id:
        # Получатель не видит контента (но видит факт «сообщение скрыто»).
        out["body"] = None
        out["hiddenReason"] = "Сообщение скрыто модерацией (попытка обмена контактами)."
    return out


async def _resolve_membership(chat_id: str, user_id: str, role: str, db) -> dict:
    """Возвращает чат, проверяя что пользователь — участник (или admin)."""
    chat = await db.service_chats.find_one({"id": chat_id}, {"_id": 0})
    if not chat:
        raise HTTPException(404, "Chat not found")
    if role == "admin":
        return chat
    if user_id not in (chat.get("customerId"), chat.get("providerId")):
        raise HTTPException(403, "Not a participant")
    return chat


# ── POST /api/service-chats/from-request/{requestId} ──────────────────────
@service_chat_router.post("/api/service-chats/from-request/{request_id}")
async def get_or_create_chat(request_id: str, request: Request):
    """Идемпотентно открыть чат. Требует request.status >= paid (escrow secured)."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if role != "admin" and user_id not in (req.get("customerId"), req.get("assignedProviderId")):
        raise HTTPException(403, "Forbidden")
    if req.get("status") not in ("paid", "in_progress", "completed", "released"):
        raise HTTPException(400, f"Chat unlocks after payment (status={req.get('status')})")

    chat = await ensure_chat_for_request(request_doc=req, db=db)
    return {"chat": _public_chat(chat)}


# ── GET /api/service-chats/me ─────────────────────────────────────────────
@service_chat_router.get("/api/service-chats/me")
async def my_chats(request: Request, limit: int = 50):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    db = get_db()
    cursor = db.service_chats.find(
        {"$or": [{"customerId": user_id}, {"providerId": user_id}]},
        {"_id": 0},
    ).sort("lastMessageAt", -1).limit(limit)
    items = await cursor.to_list(limit)
    # Подкинем счётчики unread по роли + краткие данные заявки для inbox
    request_ids = list({c.get("requestId") for c in items if c.get("requestId")})
    request_map: dict[str, dict] = {}
    if request_ids:
        req_cursor = db.service_requests.find(
            {"id": {"$in": request_ids}},
            {"_id": 0, "id": 1, "title": 1, "category": 1, "city": 1, "status": 1},
        )
        async for r in req_cursor:
            request_map[r["id"]] = {
                "title": r.get("title"),
                "category": r.get("category"),
                "city": r.get("city"),
                "status": r.get("status"),
            }
    for c in items:
        c["unreadForMe"] = c.get("unreadCustomer", 0) if c.get("customerId") == user_id else c.get("unreadProvider", 0)
        c["request"] = request_map.get(c.get("requestId")) or None
    return {"chats": items, "total": len(items)}


# ── GET /api/service-chats/{chatId} ───────────────────────────────────────
@service_chat_router.get("/api/service-chats/{chat_id}")
async def get_chat(chat_id: str, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    chat = await _resolve_membership(chat_id, user_id, role, db)
    return {"chat": _public_chat(chat)}


# ── GET /api/service-chats/{chatId}/messages?since=&limit= ────────────────
@service_chat_router.get("/api/service-chats/{chat_id}/messages")
async def list_messages(
    chat_id: str,
    request: Request,
    since: str | None = Query(None, description="ISO timestamp, fetch messages > since"),
    limit: int = Query(100, ge=1, le=200),
):
    """Polling endpoint. Клиент дёргает каждые 5–10s с last-known timestamp."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    chat = await _resolve_membership(chat_id, user_id, role, db)

    q: dict = {"chatId": chat_id}
    if since:
        q["createdAt"] = {"$gt": since}
    cursor = db.service_messages.find(q, {"_id": 0}).sort("createdAt", 1).limit(limit)
    raw = await cursor.to_list(limit)
    messages = [_public_message(m, user_id) for m in raw]

    # Auto mark-read для текущего пользователя (его unread обнуляется при чтении)
    if messages and role != "admin":
        update_field = "unreadCustomer" if chat["customerId"] == user_id else "unreadProvider"
        await db.service_chats.update_one({"id": chat_id}, {"$set": {update_field: 0}})

    server_ts = now_utc().isoformat()
    return {"messages": messages, "serverTime": server_ts, "count": len(messages)}


# ── POST /api/service-chats/{chatId}/messages ─────────────────────────────
@service_chat_router.post("/api/service-chats/{chat_id}/messages")
async def send_message(chat_id: str, body: SendMessageBody, request: Request):
    """Отправить сообщение. Текст пропускается через anti-bypass scanner."""
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    chat = await _resolve_membership(chat_id, user_id, role, db)

    if chat.get("status") in ("closed", "frozen"):
        raise HTTPException(409, f"Chat is {chat['status']}")
    if role == "admin":
        # admin пишет через /admin endpoint, не сюда
        raise HTTPException(400, "Admin must use /api/admin/service-chats/.../reply")

    sender_role = "customer" if user_id == chat.get("customerId") else "provider"
    now = now_utc().isoformat()

    # Scan body for bypass attempts (только для text)
    scan = scan_message(body.body) if body.type == "text" and body.body else {"severity": "clean", "kinds": [], "hits": [], "redacted": body.body}
    severity = scan["severity"]

    # Hard block если bypass-attempt уже подтверждён 2+ раза за провайдером
    if severity == "shadow_hide" and sender_role == "provider":
        # users._id может быть BSON ObjectId — пробуем строку и ObjectId
        provider_doc = await _find_user_by_id(db, user_id)
        strikes = (provider_doc or {}).get("bypassStrikes", 0)
        if strikes >= 3:
            severity = "block"

    if severity == "block":
        raise HTTPException(400, "Сообщение заблокировано: попытка обхода платформы (контакты вне приложения).")

    shadow_hidden = severity == "shadow_hide"
    flags = scan["kinds"] if severity != "clean" else []

    msg_doc = {
        "id": uid(),
        "chatId": chat_id,
        "senderId": user_id,
        "senderRole": sender_role,
        "type": body.type,
        "body": body.body,
        "mediaBase64": body.mediaBase64 if body.type == "image" else None,
        "location": body.location if body.type == "location" else None,
        "createdAt": now,
        "shadowHidden": shadow_hidden,
        "flags": flags,
        "bypassSeverity": severity,
        "bypassHits": scan.get("hits", []),
        "redacted": scan.get("redacted") if severity != "clean" else None,
    }
    await db.service_messages.insert_one(dict(msg_doc))
    msg_doc.pop("_id", None)

    # Update chat counters / preview
    preview = (body.body[:80] if body.body else f"[{body.type}]")
    other_unread_field = "unreadProvider" if sender_role == "customer" else "unreadCustomer"
    update_set = {
        "lastMessageAt": now,
        "lastMessagePreview": preview if not shadow_hidden else "[скрыто модерацией]",
        "updatedAt": now,
    }
    if not shadow_hidden:
        await db.service_chats.update_one(
            {"id": chat_id},
            {"$set": update_set, "$inc": {other_unread_field: 1}},
        )
    else:
        # Shadow-hidden: не показываем превью получателю, не инкрементим unread, но
        # увеличиваем flagsCount чата для admin moderation queue.
        await db.service_chats.update_one(
            {"id": chat_id},
            {"$set": update_set, "$inc": {"flagsCount": 1}},
        )
        # Лог strike-counter (мягкий) для отправителя.
        await _increment_user_field(db, user_id, "bypassStrikes")
        logger.warning(
            f"[service_chat] bypass-attempt by {sender_role} {user_id} in chat {chat_id}: {scan['kinds']}"
        )

    # Возвращаем отправителю полный doc — он его видит как есть; получатель
    # увидит хидден-маркер при polling.
    # UNIFIED: создаём notification в canonical коллекции (только если не shadow_hide,
    # чтобы получатель действительно увидел этот в bell-колокольчике).
    if not shadow_hidden:
        try:
            from app.notifications.emit import emit_notification
            other_user_id = chat["providerId"] if sender_role == "customer" else chat["customerId"]
            preview_safe = (body.body or f"[{body.type}]")[:120]
            await emit_notification(
                db=db, user_id=other_user_id,
                kind="service_chat_message",
                title=f"💬 Новое сообщение",
                body=preview_safe,
                severity="info",
                metadata={"chatId": chat_id, "requestId": chat.get("requestId"), "senderRole": sender_role},
                action_url=f"/chat/service/{chat_id}",
            )
        except Exception as e:
            logger.warning(f"[service_chat] notification emit failed: {e}")
    return {"message": msg_doc, "scan": {"severity": severity, "kinds": flags}}


# ── POST /api/service-chats/{chatId}/quick-action ─────────────────────────
QUICK_ACTION_MESSAGES = {
    "arriving":            ("Уже еду к вам", "provider_en_route", "system"),
    "work_started":        ("Работа началась", "work_started", "in_progress"),
    "extra_parts":         ("Требуются доп. запчасти", "extra_parts_requested", None),
    "completed":           ("Работа выполнена", "work_completed", None),
    "confirm_completed":   ("Клиент подтвердил завершение", "release_confirmed", None),
}


@service_chat_router.post("/api/service-chats/{chat_id}/quick-action")
async def quick_action(chat_id: str, body: QuickActionBody, request: Request):
    """Быстрая кнопка → создаёт system message + timeline event + (опц.) меняет
    статус заявки.

    Roles:
      provider: arriving / work_started / extra_parts / completed
      customer: confirm_completed
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    chat = await _resolve_membership(chat_id, user_id, role, db)
    if chat.get("status") in ("closed", "frozen"):
        raise HTTPException(409, f"Chat is {chat['status']}")

    sender_role = "customer" if user_id == chat.get("customerId") else "provider"
    action = body.action
    # Авторизация: provider не может делать customer-actions и наоборот
    if action == "confirm_completed" and sender_role != "customer":
        raise HTTPException(403, "Only customer can confirm completion")
    if action in ("arriving", "work_started", "extra_parts", "completed") and sender_role != "provider":
        raise HTTPException(403, "Only provider can use this action")

    label, timeline_kind, request_status = QUICK_ACTION_MESSAGES.get(action, (action, None, None))
    body_text = label + (f": {body.note}" if body.note else "")
    now = now_utc().isoformat()

    msg = {
        "id": uid(),
        "chatId": chat_id,
        "senderId": user_id,
        "senderRole": sender_role,
        "type": "status_change",
        "body": body_text,
        "quickAction": action,
        "createdAt": now,
        "shadowHidden": False,
        "flags": [],
    }
    await db.service_messages.insert_one(dict(msg))
    msg.pop("_id", None)

    other_unread_field = "unreadProvider" if sender_role == "customer" else "unreadCustomer"
    await db.service_chats.update_one(
        {"id": chat_id},
        {"$set": {"lastMessageAt": now, "lastMessagePreview": label, "updatedAt": now},
         "$inc": {other_unread_field: 1}},
    )

    # Optional: update request.status (только для work_started)
    if request_status == "in_progress":
        await db.service_requests.update_one(
            {"id": chat["requestId"], "status": "paid"},
            {"$set": {"status": "in_progress", "inProgressAt": now, "updatedAt": now}},
        )

    # Append timeline event
    if timeline_kind:
        await append_event(
            request_id=chat["requestId"],
            kind=timeline_kind,
            actor_role=sender_role,
            actor_id=user_id,
            meta={"chatId": chat_id, "action": action},
            db=db,
        )

    # UNIFIED: ping in canonical bell для другой стороны
    try:
        from app.notifications.emit import emit_notification
        other_user_id = chat["providerId"] if sender_role == "customer" else chat["customerId"]
        await emit_notification(
            db=db, user_id=other_user_id,
            kind="service_request_status",
            title=f"📍 {label}",
            body=body_text,
            severity="success" if action in ("completed", "confirm_completed") else "info",
            metadata={"chatId": chat_id, "requestId": chat["requestId"], "action": action},
            action_url=f"/service-marketplace/{chat['requestId']}",
        )
    except Exception as e:
        logger.warning(f"[service_chat] quick-action notification failed: {e}")

    return {"message": msg, "action": action}


# ── POST /api/service-chats/{chatId}/read ─────────────────────────────────
@service_chat_router.post("/api/service-chats/{chat_id}/read")
async def mark_read(chat_id: str, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")
    db = get_db()
    chat = await _resolve_membership(chat_id, user_id, role, db)
    update_field = "unreadCustomer" if chat["customerId"] == user_id else "unreadProvider"
    await db.service_chats.update_one({"id": chat_id}, {"$set": {update_field: 0}})
    return {"ok": True}
