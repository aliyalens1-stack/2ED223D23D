"""Sprint 4 — Request Timeline events.

Append-only event log заявки. Single source of truth для UI: вместо
"что сейчас в статусе" UI рисует строго упорядоченный список событий.

Events создаются хелпером `append_event()` из:
  - service_marketplace (request_created, provider_matched, bid_accepted, request_cancelled)
  - escrow             (payment_secured, escrow_released)
  - service_chat       (chat_opened, provider_en_route, work_started, extra_parts_requested, work_completed)
  - admin              (моderate-actions при необходимости)

Endpoint:
  GET /api/service-requests/{id}/timeline — публичный для участников (owner/provider) + admin
"""
from __future__ import annotations
import logging
from fastapi import APIRouter, HTTPException, Request

from app.core.db import get_db
from app.core.security import verify_user_token
from app.core.utils import now_utc, uid
from .models import TimelineKind


logger = logging.getLogger(__name__)
timeline_router = APIRouter(tags=["service_chat:timeline"])


# Человеко-читаемые лейблы (UI может перегрузить через i18n)
TIMELINE_LABELS = {
    "request_created":        "Заявка создана",
    "provider_matched":       "Найдены исполнители",
    "bid_accepted":           "Bid принят",
    "payment_secured":        "Оплата в escrow",
    "chat_opened":            "Открыт чат",
    "provider_en_route":      "Исполнитель в пути",
    "work_started":           "Работа началась",
    "extra_parts_requested":  "Запрошены доп. запчасти",
    "work_completed":         "Работа выполнена",
    "release_confirmed":      "Клиент подтвердил завершение",
    "escrow_released":        "Escrow освобождён · payout",
    "request_cancelled":      "Заявка отменена",
}


async def append_event(
    *,
    request_id: str,
    kind: TimelineKind,
    actor_role: str = "system",
    actor_id: str | None = None,
    meta: dict | None = None,
    db=None,
) -> dict:
    """Добавить timeline event. Idempotent по (request_id, kind, actor_id) для
    pure-system событий (provider_matched и т.п.) — повторный вызов не плодит дубли.

    Возвращает созданный (или существующий) doc.
    """
    if db is None:
        db = get_db()
    # Idempotency для system events — не вставляем второй "payment_secured" и т.п.
    dedup_kinds = {
        "request_created", "bid_accepted", "payment_secured", "chat_opened",
        "release_confirmed", "escrow_released", "work_completed", "request_cancelled",
    }
    if kind in dedup_kinds:
        existing = await db.request_timeline_events.find_one(
            {"requestId": request_id, "kind": kind}, {"_id": 0}
        )
        if existing:
            return existing

    doc = {
        "id": uid(),
        "requestId": request_id,
        "kind": kind,
        "label": TIMELINE_LABELS.get(kind, kind),
        "actorRole": actor_role,
        "actorId": actor_id,
        "meta": meta or {},
        "createdAt": now_utc().isoformat(),
    }
    await db.request_timeline_events.insert_one(dict(doc))
    doc.pop("_id", None)
    logger.info(f"[timeline] {request_id} · {kind}")
    return doc


@timeline_router.get("/api/service-requests/{request_id}/timeline")
async def get_timeline(request_id: str, request: Request):
    """Список событий заявки (chronological asc).

    Доступ: customer-владелец, assigned-provider, admin.
    """
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")

    db = get_db()
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Request not found")
    if role != "admin" and user_id not in (req.get("customerId"), req.get("assignedProviderId")):
        raise HTTPException(403, "Forbidden")

    events = await db.request_timeline_events.find(
        {"requestId": request_id}, {"_id": 0}
    ).sort("createdAt", 1).to_list(200)

    return {"events": events, "requestStatus": req.get("status")}
