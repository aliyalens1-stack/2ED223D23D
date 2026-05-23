"""
backend/app/notifications/audit.py — Sprint Customer-Notify-2.

Dry-run notification projection audit.

ARCHITECTURE (Roman, 2026-05-14):

    inspection_timeline_events
        ↓
    customer_pipeline.on_customer_event()
        ↓
    [allowlist filter + forbidden-route guard]
        ↓
    [recipient + lang resolution]
        ↓
    for channel ∈ {push, email, sms}:
        payload = customer_kernel.project_customer_notification(...)
        insert into notification_projection_audit  ← THIS MODULE
        ↓
    [NO real send — Notify-3 will flip dryRun off after admin sign-off]

The audit collection is the staging surface where every prospective
customer notification is recorded BEFORE it ever reaches a real
transport. Admin can inspect every projected (event, channel, lang,
recipient) tuple and decide when to flip the kill switch.

Hard invariants (Notify-2):
    1. dryRun: bool = True  — baked in; no override path in Notify-2.
    2. sentAt:  None        — never set in this sprint.
    3. Unique (sourceTimelineId, recipientUserId, channel) →
       re-projecting the same event is a no-op.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from pymongo.errors import DuplicateKeyError

from app.core.db import get_db
from app.notifications.customer_kernel import (
    ALLOWED_NOTIFICATION_KINDS,
    SUPPORTED_CHANNELS,
    is_forbidden_route,
    normalise_lang,
    project_customer_notification,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Indexes
# ─────────────────────────────────────────────────────────────────────

async def ensure_audit_indexes(db) -> None:
    """Idempotent. The unique (sourceTimelineId, recipientUserId, channel)
    index makes `project_and_audit` safe to call repeatedly on the same
    event — duplicate rows are dropped at insert time. Without this
    index, an admin running backfill would multiply audit rows."""
    try:
        await db.notification_projection_audit.create_index(
            [("createdAt", -1)],
            background=True,
            name="cnotify_audit_createdAt_desc",
        )
        await db.notification_projection_audit.create_index(
            [("recipientUserId", 1), ("createdAt", -1)],
            background=True,
            name="cnotify_audit_recipient_createdAt",
        )
        await db.notification_projection_audit.create_index(
            [("kind", 1), ("channel", 1), ("createdAt", -1)],
            background=True,
            name="cnotify_audit_kind_channel_createdAt",
        )
        await db.notification_projection_audit.create_index(
            [("sourceTimelineId", 1), ("recipientUserId", 1), ("channel", 1)],
            unique=True,
            background=True,
            name="cnotify_audit_unique",
            partialFilterExpression={"sourceTimelineId": {"$exists": True}},
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"cnotify audit ensure_indexes (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Public — project_and_audit
# ─────────────────────────────────────────────────────────────────────

async def project_and_audit(
    *,
    timeline_event_id: str,
    kind: str,
    recipient_user_id: str,
    lang: str = "de",
    metadata: Optional[Dict[str, Any]] = None,
) -> Dict[str, Any]:
    """
    Project ONE timeline event into 3 audit rows (push / email / sms)
    for ONE recipient. Returns a summary dict.

    Hard contract:
      • forbidden-route kinds (ocr.*, correlation.*, …) → no rows, no exception.
      • kinds outside ALLOWED_NOTIFICATION_KINDS → no rows.
      • missing copy on a channel → that channel is skipped (no fallback).
      • duplicate (sourceTimelineId, recipientUserId, channel) → skipped.

    Notify-2: every produced row has `dryRun: true` and `sentAt: null`.
    Notify-3 will introduce a separate writer to flip those.
    """
    metadata = metadata or {}

    if is_forbidden_route(kind):
        logger.info(
            f"cnotify audit: dropped forbidden-route kind={kind} "
            f"event={timeline_event_id} (route-stage guard)"
        )
        return {
            "ok": False,
            "reason": "forbidden_route",
            "inserted": 0,
            "channels": [],
        }
    if kind not in ALLOWED_NOTIFICATION_KINDS:
        return {
            "ok": False,
            "reason": "not_allowlisted",
            "inserted": 0,
            "channels": [],
        }
    if not recipient_user_id:
        return {
            "ok": False,
            "reason": "no_recipient",
            "inserted": 0,
            "channels": [],
        }

    db = get_db()
    lang_n = normalise_lang(lang)
    now_iso = datetime.now(timezone.utc).isoformat()
    inserted = 0
    channels_produced: List[str] = []
    channels_skipped: List[str] = []

    # Sprint Customer-Deep-Link-1 — resolve transport-independent
    # landing surface once per audit batch. Locale-invariant; same
    # payload is stored on every channel row.
    from app.notifications.customer_kernel import resolve_deep_link
    deep_link = resolve_deep_link(kind, metadata)

    for channel in SUPPORTED_CHANNELS:
        payload = project_customer_notification(kind, lang_n, channel)
        if payload is None:
            channels_skipped.append(channel)
            continue

        doc = {
            "id": uuid.uuid4().hex,
            "sourceTimelineId": str(timeline_event_id),
            "kind": kind,
            "channel": channel,
            "lang": lang_n,
            "recipientUserId": str(recipient_user_id),
            # Rendered payload — frozen snapshot at projection time.
            # If copy is edited later, the audit still shows what WOULD
            # have been sent at the moment of the event.
            "title": payload["title"],
            "body": payload["body"],
            "deepLinkKind": payload["deepLink"],
            # Sprint Customer-Deep-Link-1 — full transport-independent
            # destination payload. Locale-invariant; same for all
            # three channels on this event.
            "deepLink": deep_link,
            # Hard Notify-2 invariants.
            "dryRun": True,
            "sentAt": None,
            # Event metadata is preserved for forensic correlation.
            # Surfaces MUST NOT read this for rendering (kernel did that).
            "eventMetadata": dict(metadata),
            "createdAt": now_iso,
        }
        try:
            await db.notification_projection_audit.insert_one(doc)
            inserted += 1
            channels_produced.append(channel)
            # Sprint Customer-Notify-3A — delivery hook. Soft-fail by
            # design: audit row remains authoritative even if delivery
            # adapter raises. Channels with liveEnabled=False return
            # `dry_run_only` and write no lifecycle row.
            try:
                from app.notifications.delivery import deliver_audit_row
                await deliver_audit_row(doc)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    f"cnotify delivery hook failed (kind={kind}, "
                    f"channel={channel}, recipient={recipient_user_id}): {exc}"
                )
        except DuplicateKeyError:
            # Idempotent re-projection — already audited for this
            # (sourceTimelineId, recipientUserId, channel) tuple.
            channels_skipped.append(channel)
        except Exception as e:
            logger.warning(
                f"cnotify audit insert failed "
                f"(kind={kind}, channel={channel}, recipient={recipient_user_id}): {e}"
            )

    return {
        "ok": True,
        "inserted": inserted,
        "channels": channels_produced,
        "skipped": channels_skipped,
        "lang": lang_n,
    }


# ─────────────────────────────────────────────────────────────────────
# Public — preview (synthesize without persist)
# ─────────────────────────────────────────────────────────────────────

def synthesize_preview(kind: str, lang: str = "de") -> Dict[str, Any]:
    """
    Pure synthesizer — projects (kind, lang) into all 3 channel payloads
    WITHOUT touching the database. Used by the admin preview endpoint
    so reviewers can see exactly what would be projected for any event
    type before allowing it through the pipeline.

    Returns:
        {
          "kind": "...",
          "lang": "en|de|ru",
          "forbiddenRoute": bool,
          "allowed": bool,
          "channels": {
            "push":  { ... payload | None },
            "email": { ... payload | None },
            "sms":   { ... payload | None },
          }
        }
    """
    lang_n = normalise_lang(lang)
    forbidden = is_forbidden_route(kind)
    allowed = kind in ALLOWED_NOTIFICATION_KINDS
    # Sprint Customer-Deep-Link-1 — preview always uses a synthetic
    # `jobId=preview-job` so admin can see how routes resolve. itemId
    # is bound only for timeline-bound events to demonstrate the
    # `?focus=` token resolution.
    from app.notifications.customer_kernel import resolve_deep_link
    preview_metadata = {"jobId": "preview-job"}
    if kind in {"item.flagged_critical", "item.flagged_warning"}:
        preview_metadata["itemId"] = "preview-item"
    deep_link = (
        resolve_deep_link(kind, preview_metadata)
        if (not forbidden and allowed)
        else None
    )
    channels: Dict[str, Optional[Dict[str, Any]]] = {}
    for ch in SUPPORTED_CHANNELS:
        if forbidden or not allowed:
            channels[ch] = None
        else:
            channels[ch] = project_customer_notification(kind, lang_n, ch)
    return {
        "kind": kind,
        "lang": lang_n,
        "forbiddenRoute": forbidden,
        "allowed": allowed,
        "channels": channels,
        "deepLink": deep_link,
    }


__all__ = [
    "ensure_audit_indexes",
    "project_and_audit",
    "synthesize_preview",
]
