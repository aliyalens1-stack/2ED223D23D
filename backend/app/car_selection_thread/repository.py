"""Data access for car_selection_thread.

Two collections:

  car_selection_messages       — append-only conversation
  car_selection_notifications  — per-recipient inbox projection

Access discipline:

  - `assert_access(req_doc, ctx, role)` is the single chokepoint that
    decides whether a non-admin caller may see a request's thread.
    Provider routers + customer routers both go through it. Admin
    routers skip it (they already passed the admin gate).

  - `append_message` writes the message and then synchronously runs
    the notifier so the inbox view stays consistent with the source
    of truth. The notifier is idempotent enough not to matter on
    duplicates, but we never *retry* — projection convergence is
    best-effort by design (the thread itself is the canonical log).

  - There are deliberately NO `update_message` / `delete_message`
    methods. The collection is forensic-safe.

Indices:
  car_selection_messages       → (requestId, createdAt)
  car_selection_notifications  → (recipientId, readAt, createdAt)
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Optional

from fastapi import HTTPException
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.car_selection.repository import CarSelectionRepository
from app.car_selection_thread.models import (
    AuthorRole, AttachmentIn, MessageIn,
)


MESSAGES = "car_selection_messages"
NOTIFICATIONS = "car_selection_notifications"


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _err(status: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={
            "error": True, "code": code, "message": message,
            "details": details or {},
        },
    )


def _not_found(request_id: str) -> HTTPException:
    """Existence-privacy 404 matching the parent namespace's envelope."""
    return _err(
        404, "CAR_SELECTION_NOT_FOUND",
        f"request {request_id!r} not found",
        requestId=request_id,
    )


class ThreadRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.messages = db[MESSAGES]
        self.notifs = db[NOTIFICATIONS]
        self.selection = CarSelectionRepository(db)

    # ── Access ────────────────────────────────────────────────────

    async def fetch_for(
        self,
        request_id: str,
        *,
        actor_id: str,
        actor_role: AuthorRole,
    ) -> Dict[str, Any]:
        """Load the parent request and enforce role-scoped access.

        Returns the request document on success. Raises 404 for
        non-admins peeking at someone else's request (existence
        privacy preserved).
        """
        doc = await self.selection.get_by_id(request_id)
        if doc is None:
            raise _not_found(request_id)

        if actor_role == "admin":
            return doc
        if actor_role == "customer":
            if doc.get("customerId") != actor_id:
                raise _not_found(request_id)
            return doc
        if actor_role == "provider":
            if doc.get("assignedProviderId") != actor_id:
                raise _not_found(request_id)
            return doc
        # Unknown role — be conservative.
        raise _not_found(request_id)

    # ── Messages ──────────────────────────────────────────────────

    async def list_messages(self, request_id: str, *, limit: int = 200) -> List[Dict[str, Any]]:
        cursor = self.messages.find(
            {"requestId": request_id},
            {"_id": 0},  # we store id as a string column
        ).sort("createdAt", 1).limit(limit)
        return [m async for m in cursor]

    async def append_message(
        self,
        request_doc: Mapping[str, Any],
        *,
        body: MessageIn,
        author_id: str,
        author_role: AuthorRole,
        resolved_attachments: Optional[List[Dict[str, Any]]] = None,
    ) -> Dict[str, Any]:
        """Persist a new message and fan out notifications.

        `resolved_attachments` is the server-side projection of any
        `attachmentIds` that came in `body`. The route layer is the
        only thing that knows how to resolve them (it has access to
        the surface prefix used to render `url`) so we accept the
        already-projected list here rather than re-fetching.

        The write is unconditional — append-only — but we capture the
        full message so the notifier can derive its preview without a
        second read.
        """
        request_id = str(request_doc["_id"])
        msg_id = uuid.uuid4().hex
        created_at = _iso(_now())

        msg = {
            "id": msg_id,
            "requestId": request_id,
            "authorId": author_id,
            "authorRole": author_role,
            "body": body.body,
            # Stored as the resolved artifact projection at attachment
            # time. Artifacts are immutable so this projection never
            # goes stale.
            "attachments": resolved_attachments or [],
            "visibility": body.visibility,
            "createdAt": created_at,
        }
        await self.messages.insert_one(dict(msg))  # copy so _id is not added to msg

        # Project to inbox — runs in the same request to keep the
        # observable invariant: "if append returned 200, recipients
        # CAN see the message in their inbox immediately".
        await _project_message_notifications(self, request_doc, msg)

        return msg

    # ── Notifications (inbox view) ────────────────────────────────

    async def list_notifications(
        self,
        recipient_id: str,
        *,
        limit: int = 50,
        unread_only: bool = False,
    ) -> Dict[str, Any]:
        q: Dict[str, Any] = {"recipientId": recipient_id}
        if unread_only:
            q["readAt"] = None
        cursor = self.notifs.find(q, {"_id": 0}).sort("createdAt", -1).limit(limit)
        items = [n async for n in cursor]
        unread = await self.notifs.count_documents(
            {"recipientId": recipient_id, "readAt": None},
        )
        return {"items": items, "unread": unread, "total": len(items)}

    async def mark_read(
        self,
        recipient_id: str,
        *,
        ids: Optional[List[str]] = None,
        all_unread: bool = False,
    ) -> int:
        q: Dict[str, Any] = {"recipientId": recipient_id, "readAt": None}
        if not all_unread:
            if not ids:
                return 0
            q["id"] = {"$in": ids}
        res = await self.notifs.update_many(
            q, {"$set": {"readAt": _iso(_now())}},
        )
        return int(res.modified_count or 0)

    # Used by the lifecycle hook (notifier.py) to write rows without
    # going through `append_message`.
    async def write_notification(self, row: Mapping[str, Any]) -> None:
        await self.notifs.insert_one(dict(row))

    # Ensure indices exist. Called at startup once via a thin shim
    # in server.py if/when wired; missing indices are not fatal but
    # hurt list latency for hot threads.
    async def ensure_indices(self) -> None:
        await self.messages.create_index([("requestId", 1), ("createdAt", 1)])
        await self.notifs.create_index([("recipientId", 1), ("readAt", 1), ("createdAt", -1)])
        await self.notifs.create_index([("requestId", 1)])


# ── Notification projection ──────────────────────────────────────────

# Recipients per emit-rule (spec):
#
#   customer message → assigned provider + admin*
#   provider message → customer + admin*
#   admin message    → customer + provider
#
# * admin "fan-out" — there is no single admin user we can address. We
#   record ONE admin-targeted row with recipientId = "__admin__" so
#   the admin panel can read a flat backlog without enumerating
#   individual admin accounts. The admin inbox endpoint resolves this
#   sentinel from the ctx role rather than the user id.

ADMIN_SENTINEL = "__admin__"


async def _project_message_notifications(
    repo: "ThreadRepository",
    request_doc: Mapping[str, Any],
    msg: Mapping[str, Any],
) -> None:
    role: AuthorRole = msg["authorRole"]
    request_id = str(request_doc["_id"])
    customer_id = request_doc.get("customerId")
    provider_id = request_doc.get("assignedProviderId")

    preview = (msg["body"] or "")[:140]
    base = {
        "requestId": request_id,
        "eventType": "message",
        "messageId": msg["id"],
        "actorRole": role,
        "preview": preview,
        "createdAt": msg["createdAt"],
        "readAt": None,
    }

    targets: List[tuple[str, AuthorRole]] = []  # (recipientId, recipientRole)
    if role == "customer":
        if provider_id:
            targets.append((provider_id, "provider"))
        targets.append((ADMIN_SENTINEL, "admin"))
    elif role == "provider":
        if customer_id:
            targets.append((customer_id, "customer"))
        targets.append((ADMIN_SENTINEL, "admin"))
    elif role == "admin":
        if customer_id:
            targets.append((customer_id, "customer"))
        if provider_id:
            targets.append((provider_id, "provider"))

    for rid, rrole in targets:
        if not rid:
            continue
        row = dict(base, id=uuid.uuid4().hex, recipientId=rid, recipientRole=rrole)
        await repo.write_notification(row)


# Lifecycle projector. Routers (admin assign / admin status /
# provider status) call this AFTER the canonical lifecycle update
# succeeds. Failure here is logged but never blocks the lifecycle
# transition — notifications are projection, not source of truth.

LIFECYCLE_EVENTS = {
    # lifecycle status → (notification eventType, recipientRole)
    "assigned":         ("lifecycle.assigned",         "provider"),
    "waiting_customer": ("lifecycle.waiting_customer", "customer"),
    "completed":        ("lifecycle.completed",        "customer"),
}


async def project_lifecycle_event(
    db: AsyncIOMotorDatabase,
    request_doc: Mapping[str, Any],
    *,
    new_status: str,
    actor_role: AuthorRole,
) -> None:
    spec = LIFECYCLE_EVENTS.get(new_status)
    if not spec:
        return
    event_type, recipient_role = spec
    request_id = str(request_doc["_id"])

    if recipient_role == "provider":
        recipient_id = request_doc.get("assignedProviderId")
    elif recipient_role == "customer":
        recipient_id = request_doc.get("customerId")
    else:
        recipient_id = None
    if not recipient_id:
        return

    row = {
        "id": uuid.uuid4().hex,
        "recipientId": recipient_id,
        "recipientRole": recipient_role,
        "requestId": request_id,
        "eventType": event_type,
        "messageId": None,
        "actorRole": actor_role,
        "preview": None,
        "createdAt": _iso(_now()),
        "readAt": None,
    }
    await db[NOTIFICATIONS].insert_one(row)


__all__ = [
    "ThreadRepository",
    "project_lifecycle_event",
    "ADMIN_SENTINEL",
    "MESSAGES",
    "NOTIFICATIONS",
]
