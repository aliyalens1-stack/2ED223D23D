"""
backend/app/notifications/customer_pipeline.py — Sprint Customer-Notify-2.

Subscription hook for `inspection_timeline_events` that routes
customer-allowed events through the dry-run audit pipeline:

    timeline event insert
        ↓
    on_customer_event(event)
        ↓
    [allowlist 4 kinds] [forbidden-route guard]
        ↓
    [resolve customer id from jobId → auto_request hop]
        ↓
    [resolve customer lang (Notify-2 default 'de')]
        ↓
    project_and_audit → 3 audit rows (push/email/sms)
        ↓
    NO real send (Notify-3 problem)

The hook is INTENTIONALLY soft-failing: if recipient resolution fails
or any audit insert errors out, we log and move on. The timeline event
remains authoritative — audit is a derived projection layer.

ADMIN ENDPOINTS exposed here:
    GET  /api/admin/customer-notify/audit
    POST /api/admin/customer-notify/preview
    POST /api/admin/customer-notify/project (manual trigger for a single event)
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import JSONResponse

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.notifications.audit import (
    project_and_audit,
    synthesize_preview,
)
from app.notifications.customer_kernel import (
    ALLOWED_NOTIFICATION_KINDS,
    SUPPORTED_CHANNELS,
    SUPPORTED_LANGS,
    is_forbidden_route,
    normalise_lang,
)

logger = logging.getLogger(__name__)
router = APIRouter()

# ─────────────────────────────────────────────────────────────────────
# Recipient + lang resolution
# ─────────────────────────────────────────────────────────────────────

async def _resolve_customer_id(db, metadata: Dict[str, Any]) -> Optional[str]:
    """Resolve customer userId for a notifiable event. Today the event
    carries a `jobId` in metadata; the customer lives on the parent
    auto_request document. Mirror of `_resolve_customer_id` in
    `projector.py` — kept separate so Notify-2 can evolve recipient
    resolution without touching the legacy projector."""
    job_id = (metadata or {}).get("jobId")
    if not job_id:
        # Some events (e.g. inspection.started) may be addressed via
        # an inspection job document directly.
        inspection_id = (metadata or {}).get("inspectionId")
        if not inspection_id:
            return None
        try:
            req = await db.auto_requests.find_one(
                {"inspectionJobs.id": inspection_id},
                {"_id": 0, "customerId": 1, "userId": 1, "ownerId": 1},
            )
            if req:
                return req.get("customerId") or req.get("userId") or req.get("ownerId")
        except Exception:
            return None
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


async def _resolve_lang_for(db, user_id: Optional[str]) -> str:
    """Resolve preferred language for a recipient. Notify-2 uses a
    minimal lookup: user.lang | user.locale | 'de'. Full preference
    plumbing is future work (Notify-3+)."""
    if not user_id:
        return "de"
    try:
        # Try string id first, then ObjectId fallback (legacy users).
        u = await db.users.find_one(
            {"_id": user_id},
            {"_id": 0, "lang": 1, "locale": 1, "preferredLang": 1},
        )
        if not u:
            try:
                from bson import ObjectId
                u = await db.users.find_one(
                    {"_id": ObjectId(user_id)},
                    {"_id": 0, "lang": 1, "locale": 1, "preferredLang": 1},
                )
            except Exception:
                u = None
        if u:
            for key in ("preferredLang", "lang", "locale"):
                v = u.get(key)
                if v:
                    return normalise_lang(v)
    except Exception:
        pass
    return "de"


# ─────────────────────────────────────────────────────────────────────
# Public — pipeline entry point
# ─────────────────────────────────────────────────────────────────────

async def on_customer_event(event: Dict[str, Any]) -> Dict[str, Any]:
    """
    Single entry point for the dry-run audit pipeline. Safe to call
    from any timeline writer; soft-fails on any resolution miss.

    Returns a short summary for logging / admin observability:
        {
          "ok": bool,
          "reason": "<short_code>",
          "auditId": "...",  # absent on skip
          "channels": ["push", "email", "sms"],
          "skipped": [...],
        }
    """
    kind = event.get("kind") or event.get("eventType")
    if not kind:
        return {"ok": False, "reason": "no_kind"}

    # Route-stage guard — operational/forensic kinds never reach
    # recipient resolution or audit write.
    if is_forbidden_route(kind):
        return {"ok": False, "reason": "forbidden_route"}

    if kind not in ALLOWED_NOTIFICATION_KINDS:
        return {"ok": False, "reason": "not_allowlisted"}

    source_id = event.get("id") or event.get("_id")
    if not source_id:
        return {"ok": False, "reason": "no_event_id"}

    db = get_db()
    metadata = dict(event.get("metadata") or {})

    customer_id = await _resolve_customer_id(db, metadata)
    if not customer_id:
        return {"ok": False, "reason": "no_recipient"}

    lang = await _resolve_lang_for(db, customer_id)

    result = await project_and_audit(
        timeline_event_id=str(source_id),
        kind=kind,
        recipient_user_id=str(customer_id),
        lang=lang,
        metadata=metadata,
    )
    return result


# ─────────────────────────────────────────────────────────────────────
# Admin endpoints
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/customer-notify/audit")
async def list_audit(
    after: Optional[str] = Query(None, description="ISO timestamp filter"),
    kind: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    recipient: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _: dict = Depends(verify_admin_token),
):
    """List recent dry-run audit rows. Admin-only."""
    db = get_db()
    q: Dict[str, Any] = {}
    if after:
        q["createdAt"] = {"$gt": after}
    if kind:
        q["kind"] = kind
    if channel:
        if channel not in SUPPORTED_CHANNELS:
            return JSONResponse(
                status_code=400,
                content={
                    "error": True,
                    "code": "BAD_REQUEST",
                    "message": f"channel must be one of {list(SUPPORTED_CHANNELS)}",
                },
            )
        q["channel"] = channel
    if recipient:
        q["recipientUserId"] = recipient

    cursor = (
        db.notification_projection_audit.find(q, {"_id": 0})
        .sort("createdAt", -1)
        .limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total = await db.notification_projection_audit.count_documents(q)
    return {
        "items": items,
        "total": total,
        "serverTime": datetime.now(timezone.utc).isoformat(),
    }


@router.post("/api/admin/customer-notify/preview")
async def preview(
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Synthesize what would be projected for (kind, lang) WITHOUT
    persisting. Used by the admin UI to inspect copy before opting
    in to actual send. Pure read; no audit row created."""
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST",
                     "message": "Request body must be a JSON object"},
        )
    kind = body.get("kind")
    lang = body.get("lang") or "de"
    if not isinstance(kind, str) or not kind:
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST",
                     "message": "kind is required"},
        )
    if not isinstance(lang, str) or normalise_lang(lang) not in SUPPORTED_LANGS:
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST",
                     "message": f"lang must be one of {list(SUPPORTED_LANGS)}"},
        )
    return synthesize_preview(kind, lang)


@router.post("/api/admin/customer-notify/project")
async def manual_project(
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Manually trigger the dry-run pipeline for one timeline event.
    Useful for backfill or replay testing. Idempotent — the unique
    (sourceTimelineId, recipientUserId, channel) index ensures
    re-running on the same event is a no-op."""
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST",
                     "message": "Request body must be a JSON object"},
        )
    event = body.get("event")
    if not isinstance(event, dict):
        return JSONResponse(
            status_code=400,
            content={"error": True, "code": "BAD_REQUEST",
                     "message": "event object is required"},
        )
    result = await on_customer_event(event)
    return result


_META_CACHE: Optional[Dict[str, Any]] = None


def _compute_projection_version() -> Dict[str, Any]:
    """Lightweight policy snapshot. Restored after Notify-3A cleanup
    pass. Returns a stable structural fingerprint of the live
    notification policy so the admin UI can detect drift across
    deploys without us having to bump a constant by hand."""
    try:
        from app.notifications.customer_kernel import (
            EVENT_TO_SURFACE, ROUTES_TABLE,
        )
        return {
            "version": "notify-3b-2026-05-15",
            "eventCount": len(EVENT_TO_SURFACE),
            "routesCount": len(ROUTES_TABLE),
        }
    except Exception:
        return {"version": "unknown", "eventCount": 0, "routesCount": 0}


@router.get("/api/admin/customer-notify/meta")
async def meta(_: dict = Depends(verify_admin_token)):
    """Structural metadata for the Notify-2.5+ admin preview UI."""
    global _META_CACHE
    if _META_CACHE is None:
        from app.notifications.customer_kernel import (
            FORBIDDEN_ROUTE_PREFIXES,
            NOTIFICATION_DEEP_LINK,
            SURFACES,
            EVENT_TO_SURFACE,
            ROUTES_TABLE,
            PARAMS_REQUIRED,
            PARAMS_OPTIONAL,
        )
        from app.notifications.channel_state import CHANNEL_STATE
        _META_CACHE = {
            "allowedKinds": sorted(ALLOWED_NOTIFICATION_KINDS),
            "forbiddenRoutePrefixes": list(FORBIDDEN_ROUTE_PREFIXES),
            "supportedLangs": list(SUPPORTED_LANGS),
            "supportedChannels": list(SUPPORTED_CHANNELS),
            "deepLinkMap": NOTIFICATION_DEEP_LINK,
            "channelState": CHANNEL_STATE,
            "deepLink": {
                "surfaces": list(SURFACES),
                "eventToSurface": EVENT_TO_SURFACE,
                "paramsRequired": PARAMS_REQUIRED,
                "paramsOptional": PARAMS_OPTIONAL,
                "routes": ROUTES_TABLE,
            },
            "projection": _compute_projection_version(),
            "policyDoc": "memory/customer_notify_3a_2026_05_15.md",
            "dryRunOnly": False,  # push is live; dryRun coexists.
        }
    return _META_CACHE


__all__ = ["router", "on_customer_event"]


# ─────────────────────────────────────────────────────────────────────
# Sprint Customer-Notify-3A — channel state, lifecycle, push tokens
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/customer-notify/channel-state")
async def channel_state_endpoint(_: dict = Depends(verify_admin_token)):
    """Return the current channel flip matrix (dryRun + liveEnabled +
    provider per channel). Admin reads this to know which channels
    are sending. Source of truth: `channel_state.CHANNEL_STATE`."""
    from app.notifications.channel_state import CHANNEL_STATE
    return {"channels": CHANNEL_STATE, "dryRunAlwaysOn": True}


@router.get("/api/admin/customer-notify/lifecycle")
async def list_lifecycle(
    after: Optional[str] = Query(None),
    channel: Optional[str] = Query(None),
    recipient: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=500),
    _: dict = Depends(verify_admin_token),
):
    """List recent delivery lifecycle rows (Notify-3A: only push has
    rows here; email/sms remain dry-run-only)."""
    db = get_db()
    q: Dict[str, Any] = {}
    if after:
        q["createdAt"] = {"$gt": after}
    if channel:
        if channel not in SUPPORTED_CHANNELS:
            return JSONResponse(
                status_code=400,
                content={"error": True, "code": "BAD_REQUEST",
                         "message": f"channel must be one of {list(SUPPORTED_CHANNELS)}"},
            )
        q["channel"] = channel
    if recipient:
        q["recipientUserId"] = recipient

    cursor = (
        db.notification_delivery_lifecycle.find(q, {"_id": 0})
        .sort("createdAt", -1).limit(limit)
    )
    items = await cursor.to_list(length=limit)
    total = await db.notification_delivery_lifecycle.count_documents(q)
    return {"items": items, "total": total,
            "serverTime": datetime.now(timezone.utc).isoformat()}


@router.post("/api/customer/push-tokens/register")
async def register_push_token(
    request: Request,
    auth: dict = Depends(__import__(
        "app.core.security", fromlist=["verify_user_token"]
    ).verify_user_token),
):
    """Register an Expo push token for the authenticated user.
    Body: { token: "ExponentPushToken[...]", platform: "ios"|"android" }
    Idempotent on (userId, token) — re-registering bumps lastSeenAt."""
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "JSON body required"})
    token = body.get("token")
    platform = body.get("platform")
    if not isinstance(token, str) or not token:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "token is required"})
    if platform not in {"ios", "android", "web"}:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST",
                            "message": "platform must be ios|android|web"})

    user_id = str(auth.get("sub") or auth.get("userId") or auth.get("id") or "")
    if not user_id:
        return JSONResponse(status_code=401, content={"error": True,
                            "code": "UNAUTHORIZED", "message": "no user id in token"})

    db = get_db()
    now_iso = datetime.now(timezone.utc).isoformat()
    await db.push_device_tokens.update_one(
        {"userId": user_id, "token": token},
        {"$set": {"platform": platform, "lastSeenAt": now_iso},
         "$setOnInsert": {"registeredAt": now_iso}},
        upsert=True,
    )
    try:
        await db.push_device_tokens.create_index(
            [("userId", 1), ("token", 1)], unique=True, background=True,
            name="cnotify_pushtok_unique",
        )
    except Exception:  # pragma: no cover
        pass
    return {"ok": True}


@router.post("/api/admin/customer-notify/test-send")
async def admin_test_send(
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Admin smoke endpoint for verifying provider integration end-to-
    end. Bypasses recipient resolution; sends ONE push to the supplied
    token using a fully-resolved synthetic payload. Lifecycle row is
    NOT written (this is provider sanity, not audit)."""
    body = await request.json()
    token = (body or {}).get("token") if isinstance(body, dict) else None
    if not isinstance(token, str) or not token:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "token is required"})
    from app.notifications.providers import expo_push
    result = await expo_push.send_push(
        push_token=token,
        title="Auto Search — test",
        body="Provider integration probe. (Notify-3A test-send)",
        data={"kind": "test.probe", "surface": "continuity"},
    )
    return result


@router.post("/api/admin/customer-notify/receipts/poll-now")
async def admin_receipts_poll_now(_: dict = Depends(verify_admin_token)):
    """Manually trigger ONE reconciliation pass over pending receipts
    (Notify-3A Phase B). Background loop runs every 180s; this endpoint
    is for forensic / observability use — speeds up "did my receipt
    land?" investigations.

    Scope guard: reconciler only. Does NOT resend, retry, or create
    new lifecycle rows. Updates existing rows in place by
    `providerMessageId`. See backend/app/notifications/receipts.py."""
    from app.notifications.receipts import poll_receipts_once
    db = get_db()
    summary = await poll_receipts_once(db)
    return summary


# ─────────────────────────────────────────────────────────────────────
# Sprint Bounce-1 — suppression observability
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/customer-notify/suppressions")
async def admin_list_suppressions(
    channel: Optional[str] = None,
    recipient: Optional[str] = None,
    limit: int = 100,
    _: dict = Depends(verify_admin_token),
):
    """List suppression event rows (append-only). Sorted by createdAt desc.

    Scope: observability ONLY. Append (block / reactivate) happens
    through provider webhooks or `manual-append`. This endpoint never
    mutates."""
    from app.notifications.suppression import list_suppressions
    db = get_db()
    rows = await list_suppressions(
        db, channel=channel, recipient_address=recipient, limit=limit,
    )
    return {"items": rows, "total": len(rows),
            "serverTime": datetime.now(timezone.utc).isoformat()}


@router.post("/api/admin/customer-notify/suppressions/manual-append")
async def admin_manual_suppression_append(
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Append ONE manual suppression event (admin override).

    Body: {channel, recipientAddress, effect: "block"|"reactivate", reason?}

    Use cases:
      • admin-driven test block (engineering forensic)
      • emergency reactivation when a webhook was missed and provider
        has since cleared the address
      • bootstrap of a known-bad address before any webhook fires

    Roman invariant: this is still an APPEND. We never delete prior
    rows; the latest createdAt wins in `is_blocked`."""
    from app.notifications.suppression import append_suppression_event
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "expected JSON object"})
    channel = body.get("channel")
    address = body.get("recipientAddress")
    effect = body.get("effect")
    reason = body.get("reason") or "admin_manual"
    if effect not in {"block", "reactivate"}:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_EFFECT", "message": "effect must be block|reactivate"})
    kind = "manual_suppress" if effect == "block" else "manual_reactivate"
    import uuid as _uuid
    db = get_db()
    result = await append_suppression_event(
        db,
        channel=str(channel or ""),
        recipient_address=str(address or ""),
        kind=kind, effect=effect,
        provider="admin",
        provider_event_id=f"admin:{_uuid.uuid4().hex}",
        reason=str(reason)[:128],
    )
    return result


# ─────────────────────────────────────────────────────────────────────
# Sprint Notify-Pref-1 (2026-05-15) — recipient-intent endpoints
#
# Two surfaces:
#   1. Customer self-service   — GET/POST /api/customer/notification-preferences
#   2. Admin observability     — GET/POST /api/admin/customer-notify/preferences
#
# Cross-namespace lock (Roman 2026-05-15):
#   • These endpoints touch ONLY `notification_preferences`.
#   • They NEVER read or write `notification_suppressions`.
#   • They NEVER read or write `notification_delivery_lifecycle`.
#   • A customer opt-out does NOT create a suppression row, and a
#     suppression event does NOT create a preference row — even
#     though the delivery outcome may be identical.
# ─────────────────────────────────────────────────────────────────────

from app.core.security import verify_user_token  # noqa: E402

_PREF_VALID_EFFECTS = {"opt_out", "opt_in"}


@router.get("/api/customer/notification-preferences")
async def customer_get_preferences(
    auth: dict = Depends(verify_user_token),
):
    """Return the calling user's current preference snapshot.

    Projection (derived, never persisted):
        {
          "channels": {
            "push":  {"effect": "opt_in", "kindOverrides": {...}},
            "email": {"effect": "opt_in", "kindOverrides": {...}},
            "sms":   {"effect": "opt_in", "kindOverrides": {...}}
          },
          "asOf": "<iso>"
        }

    Read-only; the underlying event log is append-only and unchanged."""
    from app.notifications.preferences import current_preferences
    user_id = str(auth.get("sub") or auth.get("userId") or auth.get("id") or "")
    if not user_id:
        return JSONResponse(status_code=401, content={"error": True,
                            "code": "UNAUTHORIZED", "message": "no user id in token"})
    db = get_db()
    snap = await current_preferences(db, user_id=user_id)
    return snap


@router.post("/api/customer/notification-preferences")
async def customer_toggle_preference(
    request: Request,
    auth: dict = Depends(verify_user_token),
):
    """Append ONE preference event for the calling user.

    Body:
        { "channel": "push"|"email"|"sms",
          "effect":  "opt_out"|"opt_in",
          "kind":    "<notification kind>" | null,   # null = channel-wide
          "reason":  "<short tag>"          (optional)
        }

    Semantics:
      • Each call is an APPEND. We never mutate or merge prior rows.
        The latest row by createdAt wins at read time. Reactivation
        is just another row (effect="opt_in").
      • `source` is forced to "self" — only `manual-append` (admin
        endpoint below) may set source="admin"|"system".

    Returns the standard `{ok, reason, rowId}` shape from
    `append_preference_event`."""
    from app.notifications.preferences import append_preference_event
    user_id = str(auth.get("sub") or auth.get("userId") or auth.get("id") or "")
    if not user_id:
        return JSONResponse(status_code=401, content={"error": True,
                            "code": "UNAUTHORIZED", "message": "no user id in token"})
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "expected JSON object"})
    channel = body.get("channel")
    effect = body.get("effect")
    kind = body.get("kind")
    reason = body.get("reason")
    if channel not in SUPPORTED_CHANNELS:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_CHANNEL",
                            "message": f"channel must be one of {list(SUPPORTED_CHANNELS)}"})
    if effect not in _PREF_VALID_EFFECTS:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_EFFECT",
                            "message": "effect must be opt_out|opt_in"})
    if kind is not None and (not isinstance(kind, str) or not kind.strip()):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_KIND",
                            "message": "kind must be null or non-empty string"})
    db = get_db()
    result = await append_preference_event(
        db,
        recipient_user_id=user_id,
        channel=channel,
        effect=effect,
        kind=kind,
        source="self",
        reason=str(reason)[:128] if isinstance(reason, str) else None,
    )
    return result


@router.get("/api/admin/customer-notify/preferences")
async def admin_list_preferences(
    recipient: Optional[str] = Query(None, description="Filter by recipientUserId"),
    channel: Optional[str] = Query(None),
    limit: int = Query(100, ge=1, le=1000),
    _: dict = Depends(verify_admin_token),
):
    """List preference event rows (append-only).

    Scope: observability ONLY. This endpoint never mutates. Toggles
    happen through `POST /api/customer/notification-preferences`
    (recipient self-service) or `manual-append` (admin override)."""
    from app.notifications.preferences import list_preference_events
    if channel and channel not in SUPPORTED_CHANNELS:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_CHANNEL",
                            "message": f"channel must be one of {list(SUPPORTED_CHANNELS)}"})
    db = get_db()
    rows = await list_preference_events(
        db, user_id=recipient, channel=channel, limit=limit,
    )
    return {"items": rows, "total": len(rows),
            "serverTime": datetime.now(timezone.utc).isoformat()}


@router.get("/api/admin/customer-notify/preferences/snapshot")
async def admin_preference_snapshot(
    recipient: str = Query(..., description="recipientUserId (required)"),
    _: dict = Depends(verify_admin_token),
):
    """Return the projected current-state snapshot for ONE recipient.
    Same shape as `/api/customer/notification-preferences` but for any
    user (admin-gated). Useful for support tickets ("why didn't this
    user receive X?")."""
    from app.notifications.preferences import current_preferences
    db = get_db()
    snap = await current_preferences(db, user_id=recipient)
    return snap


@router.post("/api/admin/customer-notify/preferences/manual-append")
async def admin_manual_preference_append(
    request: Request,
    _: dict = Depends(verify_admin_token),
):
    """Append ONE preference row on behalf of a recipient (admin override).

    Body:
        { "recipientUserId": "<id>",
          "channel": "push"|"email"|"sms",
          "effect":  "opt_out"|"opt_in",
          "kind":    "<notification kind>" | null,
          "source":  "admin"|"system"                 (default "admin")
          "reason":  "<short tag>"                    (optional)
        }

    Use cases:
      • GDPR DSAR-driven opt-out where the recipient cannot reach the
        self-service surface
      • system-driven re-opt-in after an account merge / restore
      • support escalation: "user called and asked to stop emails"

    Roman invariant: this is still an APPEND. We never delete prior
    rows. We do NOT touch suppression — preference and suppression
    remain parallel-and-independent."""
    from app.notifications.preferences import append_preference_event, VALID_SOURCES
    body = await request.json()
    if not isinstance(body, dict):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST", "message": "expected JSON object"})
    user_id = body.get("recipientUserId")
    channel = body.get("channel")
    effect = body.get("effect")
    kind = body.get("kind")
    source = body.get("source") or "admin"
    reason = body.get("reason") or "admin_manual"
    if not isinstance(user_id, str) or not user_id.strip():
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_REQUEST",
                            "message": "recipientUserId is required"})
    if channel not in SUPPORTED_CHANNELS:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_CHANNEL",
                            "message": f"channel must be one of {list(SUPPORTED_CHANNELS)}"})
    if effect not in _PREF_VALID_EFFECTS:
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_EFFECT",
                            "message": "effect must be opt_out|opt_in"})
    if source not in VALID_SOURCES or source == "self":
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_SOURCE",
                            "message": "source must be admin|system"})
    if kind is not None and (not isinstance(kind, str) or not kind.strip()):
        return JSONResponse(status_code=400, content={"error": True,
                            "code": "BAD_KIND",
                            "message": "kind must be null or non-empty string"})
    db = get_db()
    result = await append_preference_event(
        db,
        recipient_user_id=user_id,
        channel=channel,
        effect=effect,
        kind=kind,
        source=source,
        reason=str(reason)[:128],
    )
    return result
