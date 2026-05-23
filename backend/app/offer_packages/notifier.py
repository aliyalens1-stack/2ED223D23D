"""offer_packages.notifier — lifecycle fan-out into the unified inbox.

This module is intentionally thin: it does NOT own a new inbox, nor a
new collection. Instead it writes one row per fan-out target into the
existing `car_selection_notifications` collection (managed by
`car_selection_thread.repository`). Why:

  • the customer / provider / admin inbox already exists at
    GET /api/car-selection/notifications/me — building a second
    notification surface for commercial events would split the audit
    trail and force every UI to merge two streams.

  • the row shape mirrors the lifecycle-event rows already written by
    `project_lifecycle_event(...)`: `messageId=None`,
    `eventType="<domain>.<action>"`. The inbox endpoint doesn't care
    which projector wrote a row — it just returns the recipient's
    backlog.

What this is NOT:

  • we do NOT post fake messages into the thread. An offer-package
    delivery is a commercial event, not a chat event. Polluting the
    thread with synthetic rows would corrupt the append-only
    conversation truth.

  • we do NOT auto-decline siblings or otherwise mutate other
    packages — that's a domain decision, not a notification concern.

Fan-out rules (matching the user-supplied spec exactly):

    transition       targets
    ─────────────────────────────────────────
    delivered    →   customer  +  admin
    accepted     →   provider  +  admin
    declined     →   provider  +  admin
    revoked      →   provider  +  customer
                       (admin is the actor → no self-notify)

The actor is never their own recipient; same rule the message
projector follows. If a target id is missing (e.g. a request with no
assigned provider somehow reaches `revoked`), that target is
silently skipped — same defensive behaviour as the lifecycle
projector. Missing notifications never block a transition.
"""
from __future__ import annotations
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Mapping, Tuple

from motor.motor_asyncio import AsyncIOMotorDatabase

from app.car_selection_thread.repository import ADMIN_SENTINEL, NOTIFICATIONS


log = logging.getLogger("offer_packages.notifier")


# Event-type strings are part of the wire contract — the inbox UI keys
# off them. Adding a new transition that wants notifications requires
# adding an entry here AND a localized label in the i18n layer (Phase
# 5 freeze). Removing one is a breaking change.
EVENT_TYPE: Dict[str, str] = {
    "delivered": "offer_package.delivered",
    "accepted":  "offer_package.accepted",
    "declined":  "offer_package.declined",
    "revoked":   "offer_package.revoked",
}


# Fan-out rules per transition. Stored as `(recipient_kind, recipient_role)`
# where `recipient_kind` is one of:
#   "customer"       → request_doc.customerId
#   "provider"       → request_doc.assignedProviderId
#   "admin_sentinel" → ADMIN_SENTINEL
#
# The actor never gets notified; the route layer guarantees who can
# fire each transition (see router_*.py), so we can encode the rule
# statically here.
FANOUT: Dict[str, List[Tuple[str, str]]] = {
    "delivered": [("customer", "customer"), ("admin_sentinel", "admin")],
    "accepted":  [("provider", "provider"), ("admin_sentinel", "admin")],
    "declined":  [("provider", "provider"), ("admin_sentinel", "admin")],
    "revoked":   [("provider", "provider"), ("customer", "customer")],
}


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _resolve_recipient(
    kind: str,
    request_doc: Mapping[str, Any],
) -> str | None:
    if kind == "customer":
        return request_doc.get("customerId")
    if kind == "provider":
        return request_doc.get("assignedProviderId")
    if kind == "admin_sentinel":
        return ADMIN_SENTINEL
    return None


async def project_offer_package_event(
    db: AsyncIOMotorDatabase,
    *,
    package_doc: Mapping[str, Any],
    request_doc: Mapping[str, Any],
    transition: str,
    actor_id: str,
    actor_role: str,
) -> int:
    """Fan out one notification row per target.

    Returns the number of rows actually written (handy for tests).
    Never raises into the caller — the lifecycle update has already
    been committed at this point. Any failure here is logged and the
    transition stands.

    Discipline:
      • `eventType` must come from `EVENT_TYPE[transition]`.
      • `messageId` is always None — these are not thread messages.
      • `preview` carries the (truncated) package title; if the
        package has no title, we fall back to a short identifier so
        the inbox row still reads as a recognizable event.
      • the actor is never written as their own recipient — we skip
        any row whose `recipientId` equals `actor_id`.
    """
    event_type = EVENT_TYPE.get(transition)
    rule = FANOUT.get(transition)
    if event_type is None or rule is None:
        # Unsupported transition — no fan-out (e.g. `draft` → never
        # notifies anyone; sibling silence is the goal).
        return 0

    package_id = str(package_doc.get("_id") or package_doc.get("id"))
    request_id = str(request_doc.get("_id") or request_doc.get("id"))
    title = (package_doc.get("title") or "").strip()
    body = title if title else f"package {package_id[:8]}"
    # Phase 9 — Offer Package Versioning (decision 7.4): the inbox
    # preview gets a `(vN) ` prefix only when N > 1. v1 packages keep
    # the original look so the inbox doesn't become version-noisy for
    # the 99% case where there is no revision history.
    version = int(package_doc.get("version") or 1)
    if version > 1:
        preview = f"(v{version}) {body}"[:140]
    else:
        preview = body[:140]

    now = _iso(datetime.now(timezone.utc))
    written = 0

    for kind, recipient_role in rule:
        recipient_id = _resolve_recipient(kind, request_doc)
        if not recipient_id:
            continue
        # Self-notify guard. Admin sentinel is a flat queue so it
        # never equals an individual actor id and always proceeds.
        if recipient_id == actor_id:
            continue
        row: Dict[str, Any] = {
            "id": uuid.uuid4().hex,
            "recipientId": recipient_id,
            "recipientRole": recipient_role,
            "requestId": request_id,
            "eventType": event_type,
            # We intentionally do NOT echo `messageId` for commercial
            # events. The inbox UI uses `eventType` to know it should
            # navigate to the offer-package detail (or list), not to
            # a thread message anchor.
            "messageId": None,
            "offerPackageId": package_id,
            "actorRole": actor_role,
            "preview": preview,
            "createdAt": now,
            "readAt": None,
        }
        try:
            await db[NOTIFICATIONS].insert_one(row)
            written += 1
        except Exception:  # pragma: no cover — defensive
            # Notifications are projection, not source of truth. Log
            # and continue so a flaky insert can never roll back a
            # committed lifecycle transition.
            log.exception(
                "offer_package notifier failed for %s/%s (%s → %s)",
                request_id, package_id, transition, recipient_role,
            )
    return written


__all__ = [
    "EVENT_TYPE",
    "FANOUT",
    "project_offer_package_event",
]
