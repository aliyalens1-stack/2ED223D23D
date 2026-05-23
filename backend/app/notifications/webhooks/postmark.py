"""
backend/app/notifications/webhooks/postmark.py — Sprint Bounce-1 + Email-Receipt-1.

Postmark webhook ingress.

Hard invariants (Roman 2026-05-15):
  1. Webhook handler ALWAYS returns 200, no matter what.
     malformed payload, duplicate ingest, unknown RecordType, persistence
     failure — all observed in internal log only, never escalated to
     Postmark's retry queue.
  2. Suppression namespace is APPEND-ONLY. One webhook event → one row.
     `is_blocked()` is a computed query, not mutated state.
  3. Lifecycle namespace is UPDATE-ONLY from this handler. We may
     enrich existing rows by `providerMessageId` but we NEVER insert
     a new lifecycle row from a webhook event. The send path
     (`delivery.py`) is the only inserter.
  4. The two writes happen in different namespaces and never reference
     each other's primary keys: suppression keyed on (provider,
     providerEventId, kind); lifecycle keyed on (channel, providerMessageId).

Auth: URL path secret (Postmark does not sign webhooks). Constant-time
compare with `POSTMARK_WEBHOOK_PATH_SECRET`. Wrong secret → 200 + log.

Per RecordType:
  Bounce              → suppression append (block)  +  lifecycle enrich (bouncedAt)
  SpamComplaint       → suppression append (block)  +  lifecycle enrich (complainedAt)
  SubscriptionChange  → suppression append (block|reactivate)  ONLY
                        (no MessageID typically; nothing to enrich)
  Delivery            → lifecycle enrich (deliveredAt)  ONLY  (no suppression)
  Open, Click         → ACK 200 and ignore (open/click belong to a
                        future engagement namespace, not this freeze).
"""
from __future__ import annotations

import logging
import os
import hmac
from typing import Any, Dict, Optional

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse

from app.core.db import get_db
from app.notifications.suppression import append_suppression_event
from app.notifications import lifecycle_email

logger = logging.getLogger(__name__)

router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Secret comparison — constant-time
# ─────────────────────────────────────────────────────────────────────

def _secret_matches(path_secret: str) -> bool:
    expected = os.environ.get("POSTMARK_WEBHOOK_PATH_SECRET") or ""
    if not expected:
        logger.warning("postmark webhook: POSTMARK_WEBHOOK_PATH_SECRET not set, rejecting all")
        return False
    return hmac.compare_digest(str(path_secret), str(expected))


# ─────────────────────────────────────────────────────────────────────
# Per-RecordType normalizers — provider shape → suppression event shape
# ─────────────────────────────────────────────────────────────────────

def _normalize_bounce(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Map Postmark Bounce payload → append_suppression_event args.
    Returns None if payload missing core fields."""
    email = payload.get("Email")
    if not isinstance(email, str) or not email:
        return None
    bounce_type = str(payload.get("Type") or "").strip()
    type_code = payload.get("TypeCode")
    # Hard-bounce-class (final) vs soft-bounce-class (transient).
    # Postmark codes: HardBounce(1), Transient(2), Unknown(3), SoftBounce(4-class).
    # We block hard bounces & ISP block; soft bounces we ALSO append a
    # row, but with kind=soft_bounce — `is_blocked` will still treat it
    # as block (effect=block). Roman invariant: any provider-rejection
    # blocks the next send attempt. Reactivation requires explicit
    # SubscriptionChange or manual_reactivate row.
    if bounce_type in {"HardBounce", "ISPBlock", "Blocked", "Unknown",
                       "DnsError", "Undeliverable", "BadEmailAddress",
                       "SpamNotification"}:
        kind = "hard_bounce"
    elif bounce_type in {"SoftBounce", "Transient", "DMARCPolicy",
                         "VirusNotification", "SMTPApiError"}:
        kind = "soft_bounce"
    elif bounce_type == "Subscribe":
        # Already opt-in, not a suppression event.
        return None
    elif bounce_type == "Unsubscribe":
        # Treat as subscription change in case Postmark routes here.
        kind = "subscription_unsubscribe"
    else:
        kind = "hard_bounce"  # unknown bounce type, fail-safe to block

    return {
        "channel": "email",
        "recipient_address": email,
        "kind": kind,
        "effect": "block",
        "provider": "postmark",
        "provider_event_id": str(payload.get("ID") or "") or None,
        "provider_message_id": payload.get("MessageID"),
        "reason": f"{bounce_type}/{type_code}" if type_code is not None else bounce_type,
        "detail_raw": payload.get("Details") or payload.get("Description"),
        "metadata": {
            "Type": bounce_type, "TypeCode": type_code,
            "Inactive": payload.get("Inactive"),
            "CanActivate": payload.get("CanActivate"),
            "Subject": payload.get("Subject"),
            "Tag": payload.get("Tag"),
            "MessageStream": payload.get("MessageStream"),
        },
        "provider_event_at": payload.get("BouncedAt"),
    }


def _normalize_spam_complaint(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    email = payload.get("Email")
    if not isinstance(email, str) or not email:
        return None
    return {
        "channel": "email",
        "recipient_address": email,
        "kind": "spam_complaint",
        "effect": "block",
        "provider": "postmark",
        "provider_event_id": str(payload.get("ID") or "") or None,
        "provider_message_id": payload.get("MessageID"),
        "reason": "SpamComplaint",
        "detail_raw": payload.get("Details") or payload.get("Description"),
        "metadata": {
            "Subject": payload.get("Subject"),
            "Tag": payload.get("Tag"),
            "MessageStream": payload.get("MessageStream"),
        },
        "provider_event_at": payload.get("BouncedAt"),
    }


def _normalize_subscription_change(payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """SubscriptionChange covers both unsubscribe AND reactivate. The
    `SuppressSending` boolean determines which way."""
    email = payload.get("Recipient")
    if not isinstance(email, str) or not email:
        return None
    suppress = bool(payload.get("SuppressSending"))
    return {
        "channel": "email",
        "recipient_address": email,
        "kind": "subscription_unsubscribe" if suppress else "subscription_reactivate",
        "effect": "block" if suppress else "reactivate",
        "provider": "postmark",
        # SubscriptionChange may not carry a stable id; fall back to
        # ChangedAt+Recipient hash so retry idempotency still works.
        "provider_event_id": (
            f"sc:{payload.get('ChangedAt')}:{email}".lower()
            if not payload.get("ID") else str(payload["ID"])
        ),
        "provider_message_id": payload.get("MessageID"),
        "reason": str(payload.get("SuppressionReason") or payload.get("Origin") or "SubscriptionChange"),
        "detail_raw": None,
        "metadata": {
            "Origin": payload.get("Origin"),
            "SuppressionReason": payload.get("SuppressionReason"),
            "MessageStream": payload.get("MessageStream"),
            "Tag": payload.get("Tag"),
        },
        "provider_event_at": payload.get("ChangedAt"),
    }


_DISPATCH = {
    "Bounce": _normalize_bounce,
    "SpamComplaint": _normalize_spam_complaint,
    "SubscriptionChange": _normalize_subscription_change,
}

# RecordTypes accepted-and-ignored. Open / Click belong to a future
# engagement-tracking namespace, not lifecycle. Delivery is handled
# separately (it enriches lifecycle ONLY, no suppression append).
_IGNORED_RECORD_TYPES = frozenset({
    "Open", "Click",
})


# ─────────────────────────────────────────────────────────────────────
# Lifecycle enrichment side-effect for Bounce / SpamComplaint
# ─────────────────────────────────────────────────────────────────────

async def _enrich_lifecycle_for_event(db, record_type: str,
                                      payload: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """If the event carries `MessageID`, enrich the corresponding
    email lifecycle row in place. Returns the enrichment verdict (for
    log only). Always swallows exceptions — webhook handler must
    return 200 regardless."""
    mid = payload.get("MessageID")
    if not isinstance(mid, str) or not mid:
        return None
    try:
        if record_type == "Bounce":
            bounce_type = str(payload.get("Type") or "").strip()
            soft_types = {"SoftBounce", "Transient", "DMARCPolicy",
                          "VirusNotification", "SMTPApiError"}
            kind = "soft_bounce" if bounce_type in soft_types else "hard_bounce"
            return await lifecycle_email.enrich_bounce(
                db,
                provider_message_id=mid,
                bounce_kind=kind,
                bounced_at=payload.get("BouncedAt"),
                reason=f"{bounce_type}/{payload.get('TypeCode')}" if payload.get("TypeCode") is not None else bounce_type,
                detail_raw=payload.get("Details") or payload.get("Description"),
            )
        if record_type == "SpamComplaint":
            return await lifecycle_email.enrich_complaint(
                db,
                provider_message_id=mid,
                complained_at=payload.get("BouncedAt"),
                detail_raw=payload.get("Details") or payload.get("Description"),
            )
    except Exception as e:
        logger.warning(f"postmark webhook: lifecycle enrich {record_type} failed: {e}")
    return None


# ─────────────────────────────────────────────────────────────────────
# Single endpoint — handles all Postmark events via RecordType dispatch
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/notifications/webhooks/postmark/{path_secret}",
             include_in_schema=False)
async def postmark_webhook(path_secret: str, request: Request):
    """Always returns 200. ALWAYS. See module docstring."""
    # 1) Secret gate. Wrong secret → log + 200 (so attackers can't
    #    enumerate by latency / status code).
    if not _secret_matches(path_secret):
        logger.warning("postmark webhook: invalid path secret (200-suppressed)")
        return JSONResponse(status_code=200, content={"accepted": False, "reason": "bad_secret"})

    # 2) Body parse. Postmark always sends JSON. Anything else → 200.
    try:
        payload = await request.json()
    except Exception as e:
        logger.warning(f"postmark webhook: bad json (200-suppressed): {e}")
        return JSONResponse(status_code=200, content={"accepted": False, "reason": "bad_json"})

    if not isinstance(payload, dict):
        logger.warning("postmark webhook: payload not object (200-suppressed)")
        return JSONResponse(status_code=200, content={"accepted": False, "reason": "bad_shape"})

    record_type = str(payload.get("RecordType") or "").strip()

    # 3a) Delivery webhook → lifecycle enrich ONLY (no suppression).
    #     This is Email-Receipt-1: deliveredAt populated on the same
    #     row that was written at send time. Never inserts new row.
    if record_type == "Delivery":
        db = get_db()
        mid = payload.get("MessageID")
        if not isinstance(mid, str) or not mid:
            return JSONResponse(status_code=200, content={"accepted": True, "reason": "no_message_id"})
        try:
            result = await lifecycle_email.enrich_delivery(
                db, provider_message_id=mid,
                delivered_at=payload.get("DeliveredAt"),
                detail_raw=payload.get("Details"),
            )
        except Exception as e:
            logger.warning(f"postmark webhook: Delivery enrich failed (200-suppressed): {e}")
            return JSONResponse(status_code=200, content={"accepted": False, "reason": "enrich_failed"})
        logger.info(f"postmark webhook: Delivery enrich {result.get('reason')} (mid={mid[:12]}…)")
        return JSONResponse(status_code=200, content={"accepted": True, **result})

    # 3b) Ignored types — Open/Click are engagement, not lifecycle.
    if record_type in _IGNORED_RECORD_TYPES:
        logger.info(f"postmark webhook: ignored RecordType={record_type}")
        return JSONResponse(status_code=200, content={"accepted": True, "reason": f"ignored:{record_type}"})

    # 4) Dispatch + normalize. Unknown types accepted with 200 + log.
    normalizer = _DISPATCH.get(record_type)
    if normalizer is None:
        logger.warning(f"postmark webhook: unknown RecordType={record_type} (200-suppressed)")
        return JSONResponse(status_code=200, content={"accepted": True, "reason": f"unknown:{record_type}"})

    try:
        kwargs = normalizer(payload)
    except Exception as e:
        logger.warning(f"postmark webhook: normalize {record_type} failed (200-suppressed): {e}")
        return JSONResponse(status_code=200, content={"accepted": False, "reason": "normalize_failed"})

    if kwargs is None:
        logger.info(f"postmark webhook: {record_type} missing core fields, no-op")
        return JSONResponse(status_code=200, content={"accepted": True, "reason": "no_op"})

    # 5) Append suppression event. Idempotent — duplicate webhooks are
    #    silently absorbed by the unique (provider, providerEventId, kind)
    #    index. We pull recipientUserId by email if we can resolve it
    #    cheaply (best-effort, not authoritative).
    db = get_db()
    try:
        email_lower = (kwargs.get("recipient_address") or "").lower()
        if email_lower:
            user_doc = await db.users.find_one(
                {"email": email_lower}, {"_id": 1}
            )
            if user_doc and user_doc.get("_id"):
                kwargs["recipient_user_id"] = str(user_doc["_id"])
    except Exception as e:
        logger.debug(f"postmark webhook: user lookup non-fatal: {e}")

    try:
        result = await append_suppression_event(db, **kwargs)
    except Exception as e:
        logger.warning(f"postmark webhook: append failed (200-suppressed): {e}")
        return JSONResponse(status_code=200, content={"accepted": False, "reason": "append_failed"})

    if result.get("ok"):
        logger.info(
            f"postmark webhook: {record_type} appended "
            f"(kind={kwargs['kind']} effect={kwargs['effect']} "
            f"reason={result.get('reason')})"
        )
        # Email-Receipt-1 side-effect: enrich lifecycle row by MessageID
        # IF this event is a delivery-time provider truth (Bounce or
        # SpamComplaint). SubscriptionChange typically carries no
        # MessageID and is recipient-initiated — no lifecycle row to
        # enrich. Different namespace, different write.
        enrich_result = await _enrich_lifecycle_for_event(db, record_type, payload)
        if enrich_result is not None:
            logger.info(f"postmark webhook: {record_type} lifecycle enrich {enrich_result.get('reason')}")
        return JSONResponse(status_code=200, content={"accepted": True, **result,
                                                       "lifecycle": enrich_result})

    logger.warning(f"postmark webhook: {record_type} not appended: {result.get('reason')}")
    return JSONResponse(status_code=200, content={"accepted": False, **result})


__all__ = ["router"]
