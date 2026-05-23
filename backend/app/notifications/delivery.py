"""
backend/app/notifications/delivery.py — Sprint Customer-Notify-3A + 3B.

Delivery lifecycle namespace. SEPARATE from audit.

  audit              — projected narrative + destination (forensic asset)
  delivery_lifecycle — provider mechanics (sent/delivered/failed/suppressed)
  suppression        — provider-truth event log (append-only)

These three NEVER share a row. Grammar layer is policy-controlled;
delivery layer is operational; suppression is provider truth.

Notify-3A: push channel live via Expo.
Notify-3B: email channel live via Postmark (sandbox).
Notify-3C: sms channel deferred.

Send-time gate ordering (Bounce-1, Roman 2026-05-15):
  1. preferences  → recipient intent (STUB until Notify-Pref-1)
  2. suppressions → provider-imposed transport block
  3. provider send

Cross-namespace invariants:
  - suppression NEVER mutates preferences (preferences is recipient intent)
  - preferences NEVER deletes suppression history (append-only)
  - lifecycle row is written for BOTH allowed-and-attempted AND
    suppressed cases. Reason: forensic "we decided not to send" is a
    transport-truth event with no provider call. Distinguished by
    `providerStatus == "suppressed"` AND `sentAt is None AND failedAt is None`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.core.db import get_db
from app.notifications.channel_state import is_live, provider_for
from app.notifications.providers import expo_push
from app.notifications.providers import postmark_email
from app.notifications.suppression import is_blocked as suppression_is_blocked
from app.notifications.preferences import is_opted_out as preferences_is_opted_out

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Preferences gate (Notify-Pref-1, 2026-05-15)
# ─────────────────────────────────────────────────────────────────────

async def _preference_opted_out(db, *, channel: str, kind: str, user_id: str) -> bool:
    """Recipient-intent gate. Reads `notification_preferences` namespace
    via `preferences.is_opted_out`. Precedence (kind-specific overrides
    channel-wide) is enforced inside `is_opted_out`.

    Scope locks (Notify-Pref-1):
      • READ-ONLY. This function NEVER writes a preference row, NEVER
        touches `notification_suppressions`, NEVER touches
        `notification_delivery_lifecycle`.
      • Fail-open. Any infrastructure error returns False — the
        provider transport will run, and the suppression gate (next in
        the chain) is the second line of defence. Recipient agency
        must never be silently inverted by an outage.

    Boundary discipline (Roman 2026-05-15):
      • preferences = recipient intent       (user says no)
      • suppression = provider transport     (provider says no)
      Even when outcomes match, the truths are distinct. Each
      namespace is independent, each row is append-only."""
    try:
        opted_out, _row = await preferences_is_opted_out(
            db, user_id=user_id, channel=channel,
            kind=kind if isinstance(kind, str) and kind else None,
        )
        return bool(opted_out)
    except Exception as e:
        logger.warning(f"cnotify preference gate failed (fail-open): {e}")
        return False


async def ensure_lifecycle_indexes(db) -> None:
    """Idempotent. The unique (auditRowId, deviceToken) index makes
    `deliver_audit_row` safe to call repeatedly — duplicate sends to
    the same device for the same audit row are dropped at insert."""
    try:
        await db.notification_delivery_lifecycle.create_index(
            [("createdAt", -1)],
            background=True, name="cnotify_lc_createdAt_desc",
        )
        await db.notification_delivery_lifecycle.create_index(
            [("recipientUserId", 1), ("createdAt", -1)],
            background=True, name="cnotify_lc_recipient_createdAt",
        )
        await db.notification_delivery_lifecycle.create_index(
            [("channel", 1), ("createdAt", -1)],
            background=True, name="cnotify_lc_channel_createdAt",
        )
        await db.notification_delivery_lifecycle.create_index(
            [("auditRowId", 1), ("deviceToken", 1)],
            unique=True, background=True, name="cnotify_lc_unique",
            partialFilterExpression={"auditRowId": {"$exists": True}},
        )
    except Exception as e:  # pragma: no cover
        logger.warning(f"cnotify lifecycle ensure_indexes (non-fatal): {e}")


# ─────────────────────────────────────────────────────────────────────
# Token resolution — adapter-agnostic
# ─────────────────────────────────────────────────────────────────────

async def _resolve_push_tokens(db, user_id: str) -> List[Dict[str, str]]:
    """Return list of {token, platform} dicts for a user. Reads from
    `push_device_tokens`. Notify-3A scope: any token registered to the
    user; no opt-out / preference filtering (that is Notify-Preference
    work, deliberately out of scope per Roman 2026-05-14)."""
    if not user_id:
        return []
    try:
        cursor = db.push_device_tokens.find(
            {"userId": str(user_id)},
            {"_id": 0, "token": 1, "platform": 1},
        )
        rows = await cursor.to_list(length=20)
        return [r for r in rows if isinstance(r.get("token"), str) and r["token"]]
    except Exception as e:
        logger.warning(f"cnotify token resolution failed for {user_id}: {e}")
        return []


# ─────────────────────────────────────────────────────────────────────
# Public — deliver_audit_row
# ─────────────────────────────────────────────────────────────────────

async def _resolve_email_addresses(db, user_id: str) -> List[Dict[str, str]]:
    """Return `[{address, kind}]` for a user. Currently a single
    primary email from `users.email`. Future: secondary addresses.

    Address case-folded (RFC-safe). Empty list if user not found or
    has no email. Read-only.

    Notify-3B scope: no opt-out filtering here — that is the
    preferences gate (`_preference_opted_out`), not address resolution."""
    if not user_id:
        return []
    try:
        from bson import ObjectId
        try:
            _id = ObjectId(user_id)
        except Exception:
            _id = None
        q: Dict[str, Any] = {"_id": _id} if _id else {"id": str(user_id)}
        row = await db.users.find_one(q, {"_id": 0, "email": 1})
        if not row:
            return []
        email = row.get("email")
        if not isinstance(email, str) or "@" not in email:
            return []
        return [{"address": email.strip().lower(), "kind": "primary"}]
    except Exception as e:
        logger.warning(f"cnotify email resolution failed for {user_id}: {e}")
        return []


# ─────────────────────────────────────────────────────────────────────
# Public — deliver_audit_row
# ─────────────────────────────────────────────────────────────────────

async def deliver_audit_row(audit_row: Dict[str, Any]) -> Dict[str, Any]:
    """
    Take ONE audit row and run the full send-time gate.

    Gate ordering (locked, Roman 2026-05-15):
      a) channel must be live (channel_state.is_live)
      b) preferences.opted_out  → no lifecycle row (recipient intent)
      c) suppression.is_blocked → ONE lifecycle row, providerStatus="suppressed",
                                   provider NEVER called
      d) provider send          → ONE lifecycle row per attempted destination

    The dumb provider adapter receives a pre-resolved payload; it has
    no access to grammar, channel state, preferences, or suppression.
    """
    channel = audit_row.get("channel")
    if not channel:
        return {"ok": False, "reason": "no_channel"}

    if not is_live(channel):
        return {"ok": True, "reason": "dry_run_only", "sent": 0, "failed": 0}

    provider = provider_for(channel)
    db = get_db()
    recipient_user_id = str(audit_row.get("recipientUserId") or "")

    # ── gate (b): preferences (recipient intent) ──
    try:
        if await _preference_opted_out(
            db, channel=channel, kind=str(audit_row.get("kind") or ""), user_id=recipient_user_id,
        ):
            return {"ok": True, "reason": "preference_opted_out",
                    "sent": 0, "failed": 0, "suppressed": 0}
    except Exception as e:
        logger.warning(f"cnotify preference gate failed (fail-open): {e}")

    # ── resolve destinations (channel-specific) ──
    if channel == "push" and provider == "expo":
        destinations = await _resolve_push_tokens(db, recipient_user_id)
        if not destinations:
            return {"ok": True, "reason": "no_devices", "sent": 0, "failed": 0}
        return await _dispatch_push(db, audit_row, destinations, provider)

    if channel == "email" and provider == "postmark":
        destinations = await _resolve_email_addresses(db, recipient_user_id)
        if not destinations:
            return {"ok": True, "reason": "no_addresses", "sent": 0, "failed": 0}
        return await _dispatch_email(db, audit_row, destinations, provider)

    return {"ok": False, "reason": f"provider_not_wired:{channel}:{provider}"}


# ─────────────────────────────────────────────────────────────────────
# Per-channel dispatchers — DUMB provider call + lifecycle write
# ─────────────────────────────────────────────────────────────────────

def _make_lifecycle_doc(audit_row: Dict[str, Any], *, channel: str, provider: str,
                       destination: str, destination_kind: Optional[str],
                       result: Dict[str, Any], suppressed: bool = False,
                       suppression_reason: Optional[str] = None) -> Dict[str, Any]:
    """Build ONE lifecycle row from a delivery attempt OR a suppression decision.
    Hard invariant: one lifecycle row = one delivery attempt-or-decision."""
    now_iso = datetime.now(timezone.utc).isoformat()
    return {
        "id": uuid.uuid4().hex,
        "auditRowId": audit_row.get("id"),
        "sourceTimelineId": audit_row.get("sourceTimelineId"),
        "kind": audit_row.get("kind"),
        "channel": channel,
        "lang": audit_row.get("lang"),
        "recipientUserId": str(audit_row.get("recipientUserId") or ""),
        "deviceToken": destination if channel == "push" else None,
        "devicePlatform": destination_kind if channel == "push" else None,
        "recipientAddress": destination if channel != "push" else None,
        "addressKind": destination_kind if channel != "push" else None,
        "provider": provider,
        "providerMessageId": None if suppressed else result.get("providerMessageId"),
        "providerStatus": "suppressed" if suppressed else result.get("providerStatus"),
        "providerError": suppression_reason if suppressed else result.get("providerError"),
        "projectedAt": audit_row.get("createdAt"),
        # Suppression decision: NO provider call, so no sentAt/failedAt.
        "sentAt": None if suppressed else (now_iso if result.get("ok") else None),
        "failedAt": None if suppressed else (None if result.get("ok") else now_iso),
        "deliveredAt": None,  # receipts may enrich this later
        "suppressedAt": now_iso if suppressed else None,
        "createdAt": now_iso,
    }


async def _dispatch_push(db, audit_row: Dict[str, Any],
                         destinations: List[Dict[str, str]],
                         provider: str) -> Dict[str, Any]:
    deep_link = audit_row.get("deepLink") or {}
    sent = failed = suppressed = 0
    for tok_doc in destinations:
        token = tok_doc["token"]
        # Push channel: suppression by token would require a separate
        # device-token suppression namespace (rare for push, mostly
        # DeviceNotRegistered captured by Expo receipts already). Skip
        # suppression gate for push in Notify-3B scope.
        result = await expo_push.send_push(
            push_token=token,
            title=audit_row.get("title"),
            body=audit_row.get("body") or "",
            data={
                "surface": deep_link.get("surface"),
                "params": deep_link.get("params") or {},
                "route": (deep_link.get("routes") or {}).get("mobile"),
                "kind": audit_row.get("kind"),
                "sourceTimelineId": audit_row.get("sourceTimelineId"),
            },
        )
        doc = _make_lifecycle_doc(
            audit_row, channel="push", provider=provider,
            destination=token, destination_kind=tok_doc.get("platform"),
            result=result,
        )
        try:
            await db.notification_delivery_lifecycle.insert_one(doc)
        except Exception as e:
            logger.info(f"cnotify lifecycle skip (likely duplicate): {e}")
            continue
        sent += 1 if result.get("ok") else 0
        failed += 0 if result.get("ok") else 1
    return {"ok": True, "reason": "delivered", "sent": sent,
            "failed": failed, "suppressed": suppressed,
            "tokens": len(destinations)}


async def _dispatch_email(db, audit_row: Dict[str, Any],
                          destinations: List[Dict[str, str]],
                          provider: str) -> Dict[str, Any]:
    deep_link = audit_row.get("deepLink") or {}
    # Pull web route as deep-link href for email CTA (mobile route is
    # not clickable from inbox). Falls back to None — adapter then
    # renders an HTML wrapper WITHOUT a CTA button.
    web_route = (deep_link.get("routes") or {}).get("web")
    deep_link_href = None
    if isinstance(web_route, str) and (web_route.startswith("http") or web_route.startswith("/")):
        # Synthesize an absolute URL only if we have a base; otherwise
        # send relative — recipient client may not resolve, that's fine.
        from os import environ as _env
        base = _env.get("WEB_APP_BASE_URL") or ""
        deep_link_href = web_route if web_route.startswith("http") else (base.rstrip("/") + web_route if base else web_route)

    sent = failed = suppressed = 0
    for addr_doc in destinations:
        address = addr_doc["address"]
        # ── gate (c): suppression (provider-imposed transport block) ──
        try:
            blocked, latest = await suppression_is_blocked(
                db, channel="email", recipient_address=address,
            )
        except Exception as e:
            logger.warning(f"cnotify suppression gate failed (fail-open): {e}")
            blocked, latest = False, None
        if blocked:
            reason = f"{(latest or {}).get('kind') or 'blocked'}:{(latest or {}).get('reason') or ''}"
            doc = _make_lifecycle_doc(
                audit_row, channel="email", provider=provider,
                destination=address, destination_kind=addr_doc.get("kind"),
                result={}, suppressed=True, suppression_reason=reason[:256],
            )
            try:
                await db.notification_delivery_lifecycle.insert_one(doc)
            except Exception as e:
                logger.info(f"cnotify lifecycle suppressed skip: {e}")
                continue
            suppressed += 1
            continue
        # ── allowed: dumb provider call ──
        result = await postmark_email.send_email(
            to_address=address,
            subject=str(audit_row.get("title") or audit_row.get("kind") or "Notification"),
            body=str(audit_row.get("body") or ""),
            lang=str(audit_row.get("lang") or "en"),
            deep_link_href=deep_link_href,
            cta_text="Open",
            metadata={
                "auditRowId": str(audit_row.get("id") or "")[:80],
                "kind": str(audit_row.get("kind") or "")[:80],
                "recipientId": str(audit_row.get("recipientUserId") or "")[:80],
                "lang": str(audit_row.get("lang") or "")[:80],
            },
        )
        doc = _make_lifecycle_doc(
            audit_row, channel="email", provider=provider,
            destination=address, destination_kind=addr_doc.get("kind"),
            result=result,
        )
        try:
            await db.notification_delivery_lifecycle.insert_one(doc)
        except Exception as e:
            logger.info(f"cnotify lifecycle email skip: {e}")
            continue
        sent += 1 if result.get("ok") else 0
        failed += 0 if result.get("ok") else 1
    return {"ok": True, "reason": "delivered", "sent": sent,
            "failed": failed, "suppressed": suppressed,
            "addresses": len(destinations)}


__all__ = ["ensure_lifecycle_indexes", "deliver_audit_row"]
