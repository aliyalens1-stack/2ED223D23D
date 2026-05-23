"""Sprint 4 Cleanup — Unified Notification Emitter.

Этот хелпер — единственная точка записи в canonical `notifications` коллекцию
для service-domain (marketplace + chat + escrow). До этого здесь был параллельный
`service_notifications` ; теперь всё стекает в общий «колокольчик».

Контракт совместим с `notifications.projector` (inspector-domain):
  id, userId, kind, type, title, body, text, severity, metadata,
  isRead, readAt, createdAt, projectedAt, actionUrl

Все эти поля читает `/api/notifications/since` и мобильный bell.

Использование:
  from app.notifications.emit import emit_notification
  await emit_notification(db=db, user_id=..., kind="service_request_new",
                          title="...", body="...", action_url="/service-marketplace/<id>")

Bulk-вариант для fanout:
  await emit_notifications_bulk(db=db, user_ids=[...], kind=..., title=..., body=...)
"""
from __future__ import annotations
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, Iterable


logger = logging.getLogger(__name__)


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _build_doc(
    *,
    user_id: str,
    kind: str,
    title: str,
    body: str,
    severity: str = "info",
    metadata: Optional[dict] = None,
    action_url: Optional[str] = None,
    actor_type: Optional[str] = None,
    actor_label: Optional[str] = None,
) -> dict:
    now = _now_iso()
    return {
        "id": uuid.uuid4().hex,
        "userId": user_id,
        "type": kind,           # legacy `type` field — оставляем равным kind
        "kind": kind,
        "title": title,
        "body": body,
        "text": body,
        "severity": severity,
        "metadata": metadata or {},
        "isRead": False,
        "readAt": None,
        "createdAt": now,
        "projectedAt": now,
        "actorType": actor_type,
        "actorLabel": actor_label,
        "actionUrl": action_url,
    }


async def emit_notification(
    *,
    db,
    user_id: str,
    kind: str,
    title: str,
    body: str,
    severity: str = "info",
    metadata: Optional[dict] = None,
    action_url: Optional[str] = None,
    actor_type: Optional[str] = None,
    actor_label: Optional[str] = None,
) -> dict | None:
    """Записать одну нотификацию в canonical `notifications`. Никогда не
    выбрасывает наружу — на исключении возвращает None, чтобы не ронять
    основной flow (отправка сообщения, оплата, и т.п.)."""
    if not user_id:
        return None
    try:
        doc = _build_doc(
            user_id=user_id, kind=kind, title=title, body=body,
            severity=severity, metadata=metadata, action_url=action_url,
            actor_type=actor_type, actor_label=actor_label,
        )
        await db.notifications.insert_one(dict(doc))
        # Sprint 8 — fire-and-forget push delivery so user sees notification
        # the moment escrow/dispute/payout/match event fires. Lifecycle write
        # is handled inside deliver_audit_row; we never block the parent flow.
        try:
            import asyncio as _asyncio
            from app.notifications.delivery import deliver_audit_row
            _asyncio.create_task(deliver_audit_row({
                "id": doc.get("id"),
                "userId": user_id,
                "kind": kind,
                "title": title,
                "body": body,
                "severity": severity,
                "metadata": metadata or {},
                "actionUrl": action_url,
                "createdAt": doc.get("createdAt"),
            }))
        except Exception as _push_err:
            logger.debug(f"[notifications.emit] push fire-and-forget skipped: {_push_err}")
        return doc
    except Exception as e:
        logger.warning(f"[notifications.emit] failed kind={kind} user={user_id}: {e}")
        return None


async def emit_notifications_bulk(
    *,
    db,
    user_ids: Iterable[str],
    kind: str,
    title: str,
    body: str,
    severity: str = "info",
    metadata: Optional[dict] = None,
    action_url: Optional[str] = None,
) -> int:
    """Bulk-fanout (marketplace new_request, broadcasts). Возвращает counts вставленных."""
    docs = []
    seen: set[str] = set()
    for uid in user_ids:
        if not uid or uid in seen:
            continue
        seen.add(uid)
        docs.append(_build_doc(
            user_id=uid, kind=kind, title=title, body=body,
            severity=severity, metadata=metadata, action_url=action_url,
        ))
    if not docs:
        return 0
    try:
        res = await db.notifications.insert_many(docs, ordered=False)
        return len(res.inserted_ids)
    except Exception as e:
        logger.warning(f"[notifications.emit] bulk failed kind={kind}: {e}")
        return 0
