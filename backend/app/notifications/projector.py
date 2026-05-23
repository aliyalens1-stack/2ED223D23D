"""
Sprint 3 · Step 2 — Notification Projector.

Architectural contract:
    timeline_events  =  source of operational truth
    notifications    =  user-facing projection

Notifications are NOT a parallel write path. Every notification row maps
1:N from exactly one timeline event. The projector is:

    deterministic  — same event always yields the same rows
    idempotent     — re-projecting the same event is a no-op (unique
                     index on (userId, sourceTimelineId))
    safe-by-default — projector failures NEVER bubble up to the
                     producer; the timeline event is always durable

Wiring:
    `app.inspector.timeline.append_event` calls `project_event(...)` after
    the event document is inserted. Out-of-band backfill is also exposed
    via `POST /api/admin/notifications/backfill` for ops repair.

Recipient resolution:
    Single-recipient kinds (verification_approved/rejected, report_*)
    target the inspector encoded on the event itself.

    Broadcast-to-admins kinds (verification_submitted, customer_disputed)
    fan out across the live `users` collection filtered by role. Spread
    semantics keep mark-read state per admin.

    Customer-facing kinds (report_submitted) resolve customerId via the
    auto_request → inspectionJobs hop. If resolution fails (orphaned
    event), the projector silently skips that recipient — the timeline
    event stays authoritative.

Backend endpoints (added by this module):
    GET  /api/notifications/unread-count         user
    POST /api/admin/notifications/backfill       admin (defensive)
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse
from pymongo.errors import DuplicateKeyError

from app.core.db import get_db
from app.core.security import verify_admin_token, verify_user_token
# P6.B.3 — Attribution wiring for /api/admin/notifications/* mutations.
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

# Sprint Customer-Notify-1 — route-stage deny list. Even though the
# legacy projector below only handles snake_case kinds (report_submitted,
# verification_*, …) and Customer-Notify-1 events use dot.notation
# (inspection.started, report.submitted, item.flagged_*), this guard
# ensures that any operational/forensic event that ever reaches
# `project_event` is dropped BEFORE any COPY lookup. Routing-stage
# drop, not render-stage drop — `ocr.*` / `correlation.*` / `evidence.*`
# / `internal.*` / `suspicion.*` never become a notification on any
# transport, ever. The canonical kernel that owns customer narrative
# copy is `app.notifications.customer_kernel`.
from app.notifications.customer_kernel import is_forbidden_route


logger = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Projection rules — single source of truth for kind → recipient mapping.
# ─────────────────────────────────────────────────────────────────────

# Channels — recipients that can't be resolved from the event itself.
CHANNEL_ADMINS = "__admins__"  # purely symbolic; spread happens at insert time

# Single-recipient = inspector_id from event.
INSPECTOR_KINDS = {
    "verification_approved",
    "verification_rejected",
    "report_approved",
    "report_rejected",
    "customer_accepted",
    "customer_disputed",  # inspector must know: copy is "open the job + contact customer"
    "job_assigned",
    "payout_sent",
    "assignment_offered",  # Sprint 3 Step 4 — new offer for this inspector
}

# Spread-to-admins on top of any inspector recipient.
ADMIN_FANOUT_KINDS = {
    "verification_submitted",
    "report_submitted",
    "customer_disputed",
    "assignment_accepted",   # ops should see who took what
    "assignment_declined",   # ops can react if pattern emerges
}

# Customer-recipient kinds — recipient resolved via jobId → request.
CUSTOMER_KINDS = {
    "report_submitted",
    "report_approved",   # customer also wants to know the QA verdict
    "inspector_assigned",  # Sprint 3 Step 4 — your inspector picked the job up
}

# Display copy per kind. Kept here (not in the event document) so we can
# rewrite Russian phrasing without rewriting timeline rows.
COPY: Dict[str, Dict[str, str]] = {
    "verification_submitted": {
        "title": "Документ на проверку",
        "body": "Инспектор отправил документ.",
        "type": "verification",
    },
    "verification_approved": {
        "title": "Документ подтверждён",
        "body": "Админ принял ваш документ.",
        "type": "verification",
    },
    "verification_rejected": {
        "title": "Документ отклонён",
        "body": "Откройте раздел верификации — там причина и кнопка загрузить заново.",
        "type": "verification",
    },
    "report_submitted": {
        "title": "Отчёт инспектора готов",
        "body": "Откройте проверку, чтобы посмотреть и принять решение.",
        "type": "report",
    },
    "report_approved": {
        "title": "Отчёт одобрен QA",
        "body": "Отчёт прошёл проверку и доступен клиенту.",
        "type": "report",
    },
    "report_rejected": {
        "title": "Отчёт отправлен на доработку",
        "body": "Откройте задание и поправьте отчёт.",
        "type": "report",
    },
    "customer_accepted": {
        "title": "Клиент принял проверку",
        "body": "Сделка закрыта.",
        "type": "customer",
    },
    "customer_disputed": {
        "title": "Клиент открыл спор",
        "body": "Откройте задание и свяжитесь с клиентом.",
        "type": "customer",
    },
    "job_assigned": {
        "title": "Новое задание",
        "body": "Откройте задание, чтобы начать проверку.",
        "type": "job",
    },
    "payout_sent": {
        "title": "Выплата отправлена",
        "body": "Деньги ушли на ваш счёт.",
        "type": "payout",
    },
    # Sprint 3 Step 4 — Live Assignments
    "assignment_offered": {
        "title": "Новое предложение",
        "body": "Откройте, чтобы принять или отклонить — у вас есть время.",
        "type": "assignment",
    },
    "assignment_accepted": {
        "title": "Инспектор принял предложение",
        "body": "Задание ушло в работу.",
        "type": "assignment",
    },
    "assignment_declined": {
        "title": "Инспектор отклонил предложение",
        "body": "Возможно, потребуется ручное переназначение.",
        "type": "assignment",
    },
    "inspector_assigned": {
        "title": "Инспектор назначен",
        "body": "Инспектор принял вашу проверку.",
        "type": "assignment",
    },
    # Sprint A1 — admin broadcast.
    # Copy is a fallback only; title/body come from metadata.title/body
    # (admin-supplied) on the timeline event.
    "admin_broadcast": {
        "title": "Сообщение от администрации",
        "body": "",
        "type": "broadcast",
    },
}


# ─────────────────────────────────────────────────────────────────────
# Sprint A1 — admin broadcast targeting
# ─────────────────────────────────────────────────────────────────────

# Canonical roles admin send can target. Mirror of `NotificationRole` in
# `shared/domain/contracts/notification.ts`. 'guest' is excluded (no JWT).
BROADCAST_ROLE_TO_LEGACY_ROLES: Dict[str, List[str]] = {
    "customer":  ["customer"],
    "inspector": ["inspector", "provider_owner"],   # both perform inspection work
    "admin":     ["admin", "superadmin", "operator"],
}
ALLOWED_BROADCAST_ROLES = frozenset(BROADCAST_ROLE_TO_LEGACY_ROLES.keys())


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_indexes(db) -> None:
    """
    Idempotent. The unique index on (userId, sourceTimelineId) is the
    backbone of idempotent projection: two concurrent calls to
    `project_event` for the same timeline event produce one row total.
    """
    try:
        # NOTE: existing code already creates (userId, createdAt desc) in
        # chat/watchlist setup paths. Re-creating is a no-op.
        await db.notifications.create_index(
            [("userId", 1), ("createdAt", -1)],
            background=True,
        )
        await db.notifications.create_index(
            [("userId", 1), ("isRead", 1), ("createdAt", -1)],
            background=True,
            name="userId_isRead_createdAt",
        )
        # Idempotency anchor.
        # `partialFilterExpression` keeps the unique constraint scoped to
        # rows that actually carry the projection marker — legacy direct
        # `push_notification` rows have no `sourceTimelineId` and are
        # exempt.
        await db.notifications.create_index(
            [("userId", 1), ("sourceTimelineId", 1)],
            unique=True,
            background=True,
            name="proj_unique_user_source",
            partialFilterExpression={"sourceTimelineId": {"$exists": True}},
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"Sprint 3 Step 2: ensure_indexes (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Recipient resolvers
# ─────────────────────────────────────────────────────────────────────

async def _resolve_customer_id(db, metadata: Dict[str, Any]) -> Optional[str]:
    """
    `report_*` events store `jobId` in metadata. The inspection job lives
    inside an auto_request document under `inspectionJobs[*]`. We look up
    the parent and pull the customerId from there.

    Returns None on miss (orphaned job, schema drift, etc). Caller must
    silently skip — timeline event is still the source of truth.
    """
    job_id = (metadata or {}).get("jobId")
    if not job_id:
        return None
    try:
        req = await db.auto_requests.find_one(
            {"inspectionJobs.id": job_id},
            {"_id": 0, "customerId": 1, "userId": 1, "ownerId": 1},
        )
        if not req:
            return None
        return req.get("customerId") or req.get("userId") or req.get("ownerId")
    except Exception:
        return None


async def _list_admin_user_ids(db) -> List[str]:
    """
    All currently-active admin users. Cached read would be nicer but the
    list is tiny (typically <10) and projection rate is low.
    """
    ids: List[str] = []
    try:
        async for u in db.users.find(
            {"role": {"$in": ["admin", "superadmin", "operator"]}},
            {"_id": 1, "role": 1},
        ):
            uid = u.get("_id")
            if uid:
                ids.append(str(uid))
    except Exception:
        pass
    return ids


async def _list_user_ids_by_roles(db, legacy_roles: List[str]) -> List[str]:
    """
    Resolve user ids for a flat list of legacy `users.role` values.
    Used by `admin_broadcast` recipient resolution. Returns a de-duped
    list of stringified ids in insertion order.
    """
    if not legacy_roles:
        return []
    out: List[str] = []
    seen: set = set()
    try:
        async for u in db.users.find(
            {"role": {"$in": legacy_roles}, "isActive": {"$ne": False}},
            {"_id": 1},
        ):
            uid = u.get("_id")
            if not uid:
                continue
            sid = str(uid)
            if sid in seen:
                continue
            seen.add(sid)
            out.append(sid)
    except Exception as e:
        logger.warning(f"_list_user_ids_by_roles failed (roles={legacy_roles}): {e}")
    return out


async def _resolve_broadcast_recipients(db, metadata: Dict[str, Any]) -> List[str]:
    """
    Sprint A1 — resolve the recipient list from an `admin_broadcast`
    timeline event's metadata.target. Returns a de-duped list of
    stringified user ids.

    Target shapes (mirror of `NotificationTarget` in
    `shared/domain/contracts/notification.ts`):
      - {"type": "all"}
      - {"type": "role", "roles": ["customer", "inspector", "admin"]}
      - {"type": "user", "userId": "..."}

    On invalid/unknown shape: returns []. The endpoint validates upfront,
    so this is defensive only.
    """
    target = (metadata or {}).get("target") or {}
    ttype = target.get("type")

    if ttype == "all":
        all_legacy = sorted({r for rs in BROADCAST_ROLE_TO_LEGACY_ROLES.values() for r in rs})
        return await _list_user_ids_by_roles(db, all_legacy)

    if ttype == "role":
        roles = target.get("roles") or []
        legacy: List[str] = []
        seen_legacy: set = set()
        for r in roles:
            if r not in ALLOWED_BROADCAST_ROLES:
                continue
            for legacy_r in BROADCAST_ROLE_TO_LEGACY_ROLES[r]:
                if legacy_r not in seen_legacy:
                    seen_legacy.add(legacy_r)
                    legacy.append(legacy_r)
        return await _list_user_ids_by_roles(db, legacy)

    if ttype == "user":
        uid = target.get("userId")
        if not uid or not isinstance(uid, str):
            return []
        # users._id may be stored as ObjectId (legacy) or string (newer
        # registrations). Try both shapes; whichever matches gives us the
        # canonical id (string form) used by the projector and by JWT.sub.
        try:
            from bson import ObjectId
            candidates: List[Any] = [uid]
            try:
                candidates.append(ObjectId(uid))
            except Exception:
                pass
            for cand in candidates:
                u = await db.users.find_one({"_id": cand}, {"_id": 1})
                if u:
                    return [str(u["_id"])]
        except Exception:
            pass
        return []

    return []


# ─────────────────────────────────────────────────────────────────────
# Public — project_event
# ─────────────────────────────────────────────────────────────────────

async def project_event(event: Dict[str, Any]) -> int:
    """
    Project one timeline event into 0..N notification rows.

    `event` is the full timeline_events document (post-insert). Required
    keys: `id`, `kind`. Optional: `inspectorId`, `metadata`, `severity`,
    `title`, `text`, `actorType`, `actorLabel`.

    Returns the number of rows actually inserted (0 means either
    "no recipients" or "all already projected").
    """
    db = get_db()
    kind = event.get("kind")
    source_id = event.get("id") or event.get("_id")
    if not kind or not source_id:
        return 0
    # Sprint Customer-Notify-1 — routing-stage deny. Operational /
    # forensic / internal events must never reach the COPY map or the
    # recipient resolver, regardless of which legacy kind alias they
    # use. This is the same deny-list enforced by the customer kernel
    # in front of every push/email/sms transport.
    if is_forbidden_route(kind):
        logger.info(f"project_event: dropped forbidden-route kind={kind} at routing stage")
        return 0
    if kind not in COPY:
        # Unknown kind — explicit allow-list so we don't accidentally
        # spam users on a new timeline kind without a project rule.
        return 0

    copy = COPY[kind]
    metadata = dict(event.get("metadata") or {})
    severity = event.get("severity") or "info"

    # 1. Build recipient set (de-duped)
    recipients: List[str] = []
    seen = set()

    if kind in INSPECTOR_KINDS:
        ins = event.get("inspectorId")
        if ins and ins not in seen:
            seen.add(ins)
            recipients.append(str(ins))

    if kind in CUSTOMER_KINDS:
        cust = await _resolve_customer_id(db, metadata)
        if cust and cust not in seen:
            seen.add(cust)
            recipients.append(str(cust))

    if kind in ADMIN_FANOUT_KINDS:
        for aid in await _list_admin_user_ids(db):
            if aid not in seen:
                seen.add(aid)
                recipients.append(aid)

    # Sprint A1 — admin_broadcast resolves recipients from metadata.target.
    if kind == "admin_broadcast":
        for rid in await _resolve_broadcast_recipients(db, metadata):
            if rid not in seen:
                seen.add(rid)
                recipients.append(rid)

    if not recipients:
        return 0

    # 2. Idempotent insert per recipient
    now_iso = datetime.now(timezone.utc).isoformat()
    inserted = 0

    # Sprint A1 — for admin broadcasts, title/body come from metadata
    # (admin-supplied) rather than COPY (which is only a fallback label).
    is_broadcast = kind == "admin_broadcast"
    broadcast_title = (metadata.get("title") if is_broadcast else None) or copy["title"]
    broadcast_body = (metadata.get("body") if is_broadcast else None)

    for rid in recipients:
        # Override body with event.title if present (keeps drawer copy
        # contextual — e.g. "Документ «passport» отклонён").
        if is_broadcast:
            body = broadcast_body or copy["body"]
            text = broadcast_body or copy["body"]
            title = broadcast_title
        else:
            body = event.get("title") or copy["body"]
            text = event.get("text") or copy["body"]
            title = copy["title"]
        actor = event.get("actor") or {}
        # Timeline writes use `timestamp`; some legacy paths use `createdAt`.
        created_at = (
            event.get("timestamp")
            or event.get("createdAt")
            or now_iso
        )
        doc = {
            "id": uuid.uuid4().hex,
            "userId": rid,
            "type": copy.get("type") or kind,
            "kind": kind,
            "title": title,
            "body": body,
            "text": text,
            "severity": severity,
            "metadata": metadata,
            "isRead": False,
            "readAt": None,
            "createdAt": created_at,
            "projectedAt": now_iso,
            "sourceTimelineId": str(source_id),
            "actorType": (actor.get("type") if isinstance(actor, dict) else None) or event.get("actorType"),
            "actorLabel": (actor.get("label") if isinstance(actor, dict) else None) or event.get("actorLabel"),
            # actionUrl is a hint — clients may use it or build their own.
            "actionUrl": _action_url_for(kind, metadata),
        }
        try:
            await db.notifications.insert_one(doc)
            inserted += 1
        except DuplicateKeyError:
            # Already projected — exactly what idempotency guarantees.
            continue
        except Exception as e:
            logger.warning(f"project_event insert failed (kind={kind}, rid={rid}): {e}")
    return inserted


def _action_url_for(kind: str, metadata: Dict[str, Any]) -> Optional[str]:
    """Best-effort deep-link. Used by both mobile and admin clients."""
    if kind == "admin_broadcast":
        # Admin-supplied deep link, when present.
        dl = metadata.get("deepLink")
        return dl if isinstance(dl, str) and dl else None
    if kind.startswith("verification_"):
        return "/inspector/verification"
    if kind in ("report_submitted", "report_approved"):
        job_id = metadata.get("jobId")
        return f"/inspector/job/{job_id}" if job_id else None
    if kind in ("report_rejected", "customer_disputed", "customer_accepted"):
        job_id = metadata.get("jobId")
        return f"/inspector/job/{job_id}" if job_id else None
    if kind == "job_assigned":
        job_id = metadata.get("jobId")
        return f"/inspector/job/{job_id}" if job_id else "/inspector/jobs"
    return None


# ─────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/notifications/unread-count")
async def unread_count(payload: dict = Depends(verify_user_token)):
    """
    Cheap counter for the bell badge. Polling clients call this every
    25s; the heavier /api/notifications listing is only hit on demand.
    """
    db = get_db()
    user_id = _user_id_from(payload)
    count = await db.notifications.count_documents(
        {"userId": user_id, "isRead": False}
    )
    return {"unread": count}


@router.get("/api/notifications/since")
async def list_since(
    after: Optional[str] = Query(None, description="ISO timestamp"),
    unread: Optional[bool] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    payload: dict = Depends(verify_user_token),
):
    """
    Polling-optimised listing endpoint.

    `after`  — return only rows with `createdAt > after` (strict, ISO).
    `unread` — when true, restrict to unread.
    `limit`  — page size (default 50, max 200).

    Sorted newest-first. The legacy `/api/notifications` route (in
    chat/router.py) is kept for compatibility — it doesn't accept
    `after` and always returns the most recent 100.
    """
    db = get_db()
    user_id = _user_id_from(payload)
    q: Dict[str, Any] = {"userId": user_id}
    if after:
        q["createdAt"] = {"$gt": after}
    if unread is True:
        q["isRead"] = False
    cursor = (
        db.notifications.find(q, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total_unread = await db.notifications.count_documents(
        {"userId": user_id, "isRead": False}
    )
    return {
        "items": items,
        "unread": total_unread,
        "serverTime": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/api/admin/notifications/backfill")
async def backfill(
    request: Request,
    limit: int = Query(200, ge=1, le=2000),
    kind: Optional[str] = Query(None),
    _: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
):
    """
    Defensive ops repair. Walks the most recent `limit` timeline events
    and re-runs the projector. Idempotent — already-projected rows are
    skipped via the unique index.

    Returns `{scanned, inserted}` so ops can verify drift.
    """
    db = get_db()
    q: Dict[str, Any] = {}
    if kind:
        q["kind"] = kind
    scanned = 0
    inserted = 0
    cursor = (
        db.timeline_events.find(q, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    async for ev in cursor:
        scanned += 1
        inserted += await project_event(ev)
    # P6.B.3 — Attribution.
    try:
        await record_admin_mutation(
            db, ctx_attr,
            action="notifications.backfill",
            domain="other",
            entity_id="backfill_batch",
            extra={"scanned": scanned, "inserted": inserted, "limit": limit, "kind": kind},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[projector] attribution notifications.backfill failed: {_attr_e}")
    return {"scanned": scanned, "inserted": inserted}


# ─────────────────────────────────────────────────────────────────────
# Sprint A1 — admin broadcast send
# ─────────────────────────────────────────────────────────────────────

# Server-side length caps mirror the contract in
# `shared/domain/contracts/notification.ts`.
_BROADCAST_TITLE_MAX = 120
_BROADCAST_BODY_MAX = 1000


def _validate_admin_send_payload(body: Dict[str, Any]) -> Optional[str]:
    """Return None when valid, error message otherwise."""
    if not isinstance(body, dict):
        return "Request body must be a JSON object"
    title = body.get("title")
    bd = body.get("body")
    target = body.get("target")
    if not isinstance(title, str) or not title.strip():
        return "title is required"
    if len(title) > _BROADCAST_TITLE_MAX:
        return f"title exceeds {_BROADCAST_TITLE_MAX} chars"
    if not isinstance(bd, str) or not bd.strip():
        return "body is required"
    if len(bd) > _BROADCAST_BODY_MAX:
        return f"body exceeds {_BROADCAST_BODY_MAX} chars"
    if not isinstance(target, dict):
        return "target is required"
    ttype = target.get("type")
    if ttype == "all":
        return None
    if ttype == "role":
        roles = target.get("roles")
        if not isinstance(roles, list) or not roles:
            return "target.roles must be a non-empty array"
        for r in roles:
            if r not in ALLOWED_BROADCAST_ROLES:
                return f"unknown role '{r}'; allowed: {sorted(ALLOWED_BROADCAST_ROLES)}"
        return None
    if ttype == "user":
        uid = target.get("userId")
        if not isinstance(uid, str) or not uid:
            return "target.userId is required when type='user'"
        return None
    return f"unsupported target.type='{ttype}'; allowed: all|role|user"


@router.post("/api/admin/notifications/send")
async def admin_send(
    request: Request,
    payload: dict = Depends(verify_admin_token),
    ctx_attr: AttributionContext = Depends(get_attribution_context),
):
    """
    Sprint A1 — admin-initiated notification broadcast.

    Contract: `AdminNotificationRequest` in
    `shared/domain/contracts/notification.ts`.

    Path:
        admin_send  →  timeline_events insert  →  project_event  →  notifications

    The admin endpoint NEVER writes directly to `notifications`. The
    projector remains the sole writer. This preserves:
      - dedupe invariants (unique (userId, sourceTimelineId))
      - replay/backfill semantics (re-running backfill is a no-op)
      - provenance (every notification row points back at one timeline event)

    Idempotency:
      - Request-level: rely on `Idempotency-Key` middleware (see
        `prod_readiness.idempotency_lookup`). Two POSTs with the same key
        return the cached response and emit exactly one timeline event.
      - Recipient-level: the projector's unique index makes re-running
        `project_event` on the same event a no-op for every recipient.
      - Without `Idempotency-Key`: two POSTs produce two distinct timeline
        events and two batches of notifications. This is correct — admin
        sends are explicit commands.
    """
    db = get_db()
    body = await request.json()
    err = _validate_admin_send_payload(body)
    if err:
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST", "message": err},
        )

    admin_uid = (payload.get("sub") if isinstance(payload, dict) else None) or "admin"
    admin_email = (payload.get("email") if isinstance(payload, dict) else None) or ""

    now_iso = datetime.now(timezone.utc).isoformat()
    event_id = uuid.uuid4().hex
    metadata = {
        "target": body["target"],
        "title": body["title"].strip(),
        "body": body["body"].strip(),
        "issuedBy": admin_uid,
    }
    if isinstance(body.get("deepLink"), str) and body["deepLink"].strip():
        metadata["deepLink"] = body["deepLink"].strip()

    event_doc = {
        "id": event_id,
        "kind": "admin_broadcast",
        "metadata": metadata,
        "timestamp": now_iso,
        "createdAt": now_iso,
        "actorType": "admin",
        "actorId": admin_uid,
        "actorLabel": admin_email or "admin",
        "severity": "info",
    }

    try:
        await db.timeline_events.insert_one(event_doc)
    except Exception as e:
        logger.exception(f"admin_send: timeline insert failed: {e}")
        return JSONResponse(
            status_code=500,
            content={"error": True, "code": "TIMELINE_INSERT_FAILED",
                     "message": "Failed to record broadcast event"},
        )

    # Recipient set is resolved by the projector via metadata.target.
    # We need the count separately for the response — projector returns
    # only "rows inserted". So we ask the resolver directly here (cheap;
    # same query the projector will run).
    recipients_ids = await _resolve_broadcast_recipients(db, metadata)
    projected = await project_event(event_doc)

    # P6.B.3 — Attribution: admin broadcast send.
    try:
        await record_admin_mutation(
            db, ctx_attr,
            action="notifications.admin_send",
            domain="user",
            entity_id=event_id,
            extra={"targetType": (body.get("target") or {}).get("type"),
                   "recipients": len(recipients_ids),
                   "projected": projected,
                   "titleLen": len(body.get("title") or ""),
                   "bodyLen": len(body.get("body") or "")},
        )
    except Exception as _attr_e:
        import logging as _lg
        _lg.getLogger(__name__).warning(f"[projector] attribution notifications.admin_send failed: {_attr_e}")

    return {
        "ok": True,
        "eventId": event_id,
        "recipients": len(recipients_ids),
        "projected": projected,
    }


# ─────────────────────────────────────────────────────────────────────
# Util
# ─────────────────────────────────────────────────────────────────────

def _user_id_from(payload: Any) -> str:
    """Match chat/router.py convention: payload may be dict or model."""
    if isinstance(payload, dict):
        return str(payload.get("sub") or payload.get("userId") or payload.get("id") or "")
    return str(getattr(payload, "sub", "") or getattr(payload, "userId", "") or "")
