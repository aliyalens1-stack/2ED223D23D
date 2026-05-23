"""app.workers.receipts_poll.loop — Sprint Customer-Notify-3A Phase B.

PR-01 (Phase 3D) move-only extraction from `app/notifications/receipts.py`.
Function bodies, logger names, log wording, and Mongo writes are
literally identical to the previous location.

Receipt poller. Closes lifecycle semantics for the `push` channel by
turning Expo delivery receipts into in-place enrichment of the
EXISTING `notification_delivery_lifecycle` rows.

HARD INVARIANT (Roman, 2026-05-15):
    one lifecycle row = one delivery attempt

Receipts are NOT events. They are enrichment of an existing attempt.
This module therefore:
  • NEVER inserts a new lifecycle row
  • NEVER deletes one
  • ONLY updates existing rows in place, keyed by `providerMessageId`

Anti-scope (deliberately out):
  • retries / dead letters / resend
  • bounce handling (post Notify-3B)
  • orchestrator-style scheduling
  • exponential backoff per token (poll is global, time-windowed)

Reference: https://docs.expo.dev/push-notifications/sending-notifications/#push-receipts

Status mapping (Expo → our lifecycle):
    receipt.status == "ok"             → deliveredAt = nowUtc
                                         providerReceiptStatus = "ok"
    receipt.status == "error"          → providerReceiptStatus  = "error"
                                         providerReceiptError   = receipt.message
                                         (deliveredAt stays null;
                                          NOT failedAt — that field
                                          belongs to the SEND attempt)
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, Iterable, List

import httpx

from .contracts import (
    EXPO_RECEIPTS_URL,
    PROVIDER,
    CHANNEL,
    RECEIPT_MIN_AGE_SECONDS,
    RECEIPT_MAX_AGE_SECONDS,
    RECEIPT_RECHECK_BACKOFF_SECONDS,
    BATCH_SIZE,
    DEFAULT_INTERVAL_S,
)

logger = logging.getLogger(__name__)


# ─────────────────────────────────────────────────────────────────────
# Candidate selection
# ─────────────────────────────────────────────────────────────────────

async def _select_candidates(db) -> List[Dict[str, Any]]:
    """Pick lifecycle rows that need a receipt check.

    Criteria (ALL must hold):
      • channel = push  (Phase B scope; 3B/3C will widen)
      • provider = expo
      • sentAt is not null AND failedAt is null
      • providerMessageId is not null
      • deliveredAt is null AND providerReceiptStatus != "ok"
      • createdAt within [RECEIPT_MIN_AGE, RECEIPT_MAX_AGE]
      • receiptCheckedAt absent OR older than RECEIPT_RECHECK_BACKOFF

    Sorted by createdAt asc so the oldest tickets are reconciled first
    before they age out of Expo's 24h window.
    """
    now = datetime.now(timezone.utc)
    min_age_iso = (now - timedelta(seconds=RECEIPT_MIN_AGE_SECONDS)).isoformat()
    max_age_iso = (now - timedelta(seconds=RECEIPT_MAX_AGE_SECONDS)).isoformat()
    backoff_iso = (now - timedelta(seconds=RECEIPT_RECHECK_BACKOFF_SECONDS)).isoformat()

    q: Dict[str, Any] = {
        "channel": CHANNEL,
        "provider": PROVIDER,
        "sentAt": {"$ne": None, "$exists": True},
        "failedAt": None,
        "providerMessageId": {"$ne": None, "$exists": True},
        "deliveredAt": None,
        # Don't re-check rows whose receipt already came back "ok" (defensive).
        "$or": [
            {"providerReceiptStatus": {"$exists": False}},
            {"providerReceiptStatus": None},
            {"providerReceiptStatus": {"$nin": ["ok"]}},
        ],
        "createdAt": {"$lte": min_age_iso, "$gte": max_age_iso},
    }

    # Backoff: either receiptCheckedAt absent, or older than the window.
    # We do this as a $and to avoid mangling the outer $or above.
    candidates_cursor = db.notification_delivery_lifecycle.find(
        {"$and": [
            q,
            {"$or": [
                {"receiptCheckedAt": {"$exists": False}},
                {"receiptCheckedAt": None},
                {"receiptCheckedAt": {"$lt": backoff_iso}},
            ]},
        ]},
        {"_id": 0, "providerMessageId": 1, "id": 1},
    ).sort("createdAt", 1).limit(BATCH_SIZE)

    return await candidates_cursor.to_list(length=BATCH_SIZE)


# ─────────────────────────────────────────────────────────────────────
# Provider call (DUMB: ids in → status map out)
# ─────────────────────────────────────────────────────────────────────

async def _fetch_receipts(message_ids: Iterable[str], timeout_s: float = 10.0) -> Dict[str, Any]:
    """POST to Expo getReceipts. Returns `data` dict (id → receipt) or
    {} on transport failure. Never raises.

    Adapter has NO knowledge of channel state or grammar. Pure transport."""
    ids = [m for m in message_ids if isinstance(m, str) and m]
    if not ids:
        return {}

    headers = {
        "Accept": "application/json",
        "Accept-Encoding": "gzip, deflate",
        "Content-Type": "application/json",
    }
    token = os.environ.get("EXPO_ACCESS_TOKEN")
    if token:
        headers["Authorization"] = f"Bearer {token}"

    try:
        async with httpx.AsyncClient(timeout=timeout_s) as c:
            r = await c.post(EXPO_RECEIPTS_URL, json={"ids": ids}, headers=headers)
    except httpx.HTTPError as e:
        logger.warning(f"cnotify receipts transport_error: {e}")
        return {}

    if r.status_code // 100 != 2:
        logger.warning(f"cnotify receipts http_{r.status_code}: {r.text[:256]}")
        return {}

    try:
        body = r.json() or {}
    except Exception as e:  # noqa: BLE001
        logger.warning(f"cnotify receipts bad_response: {e}")
        return {}

    data = body.get("data")
    return data if isinstance(data, dict) else {}


# ─────────────────────────────────────────────────────────────────────
# In-place enrichment
# ─────────────────────────────────────────────────────────────────────

async def _enrich_row(
    db,
    *,
    provider_message_id: str,
    receipt: Dict[str, Any] | None,
    checked_at_iso: str,
) -> str:
    """Update the single lifecycle row whose `providerMessageId` matches.

    Returns the enrichment verdict for logging:
      "delivered" | "errored" | "still_pending" | "no_row"

    INVARIANT: this function performs ONLY `update_one`. It never
    inserts, never deletes, never modifies any other collection.
    """
    set_doc: Dict[str, Any] = {"receiptCheckedAt": checked_at_iso}
    verdict = "still_pending"

    if isinstance(receipt, dict):
        rs = receipt.get("status")
        if rs == "ok":
            set_doc["deliveredAt"] = checked_at_iso
            set_doc["providerReceiptStatus"] = "ok"
            set_doc["providerReceiptError"] = None
            verdict = "delivered"
        elif rs == "error":
            set_doc["providerReceiptStatus"] = "error"
            # Expo packs the failure reason in `message`, sometimes also
            # `details.error` for DeviceNotRegistered / MessageTooBig etc.
            details = receipt.get("details") or {}
            details_error = details.get("error") if isinstance(details, dict) else None
            err_msg = receipt.get("message") or details_error or "receipt error"
            set_doc["providerReceiptError"] = str(err_msg)[:512]
            verdict = "errored"
        else:
            # Expo returned an unrecognised status; record it but stay
            # pending so we will re-poll until age-out or success.
            set_doc["providerReceiptStatus"] = str(rs) if rs else "unknown"
            verdict = "still_pending"
    else:
        # No receipt available yet — Expo can return absent ids for not-
        # yet-processed tickets. Still write checkedAt so backoff applies.
        set_doc["providerReceiptStatus"] = "not_yet_available"
        verdict = "still_pending"

    res = await db.notification_delivery_lifecycle.update_one(
        # channel/provider scope keeps this immune to drift if email/sms
        # later acquire receipt semantics with different shape.
        {"providerMessageId": provider_message_id,
         "channel": CHANNEL, "provider": PROVIDER},
        {"$set": set_doc},
    )
    if res.matched_count == 0:
        return "no_row"
    return verdict


# ─────────────────────────────────────────────────────────────────────
# Public — poll_receipts_once
# ─────────────────────────────────────────────────────────────────────

async def poll_receipts_once(db) -> Dict[str, Any]:
    """One reconciliation pass. Returns a summary for observability
    (logging / admin manual-trigger endpoint).

    {
      "checked":   <int>,
      "delivered": <int>,
      "errored":   <int>,
      "stillPending": <int>,
      "noRow":     <int>,
      "tookMs":    <int>,
    }
    """
    started = datetime.now(timezone.utc)
    summary = {"checked": 0, "delivered": 0, "errored": 0,
               "stillPending": 0, "noRow": 0, "tookMs": 0}

    candidates = await _select_candidates(db)
    if not candidates:
        summary["tookMs"] = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
        return summary

    ids = [c["providerMessageId"] for c in candidates
           if isinstance(c.get("providerMessageId"), str)]
    receipts = await _fetch_receipts(ids)
    checked_at_iso = datetime.now(timezone.utc).isoformat()

    for cand in candidates:
        msg_id = cand.get("providerMessageId")
        if not isinstance(msg_id, str) or not msg_id:
            continue
        receipt = receipts.get(msg_id)
        try:
            verdict = await _enrich_row(
                db,
                provider_message_id=msg_id,
                receipt=receipt if isinstance(receipt, dict) else None,
                checked_at_iso=checked_at_iso,
            )
        except Exception as e:  # noqa: BLE001
            logger.warning(f"cnotify receipts enrich failed for {msg_id}: {e}")
            continue
        summary["checked"] += 1
        if verdict == "delivered":
            summary["delivered"] += 1
        elif verdict == "errored":
            summary["errored"] += 1
        elif verdict == "no_row":
            summary["noRow"] += 1
        else:
            summary["stillPending"] += 1

    summary["tookMs"] = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)
    if summary["checked"]:
        logger.info(
            f"cnotify receipts poll: checked={summary['checked']} "
            f"delivered={summary['delivered']} errored={summary['errored']} "
            f"still={summary['stillPending']} took={summary['tookMs']}ms"
        )
    return summary


# ─────────────────────────────────────────────────────────────────────
# Worker startup / cancel log hooks
# ─────────────────────────────────────────────────────────────────────
# C-3: previously the `receipts_poll_loop` function (now removed) emitted
# these two lines from inside its while+sleep envelope. Supervisor now
# owns the envelope; these helpers preserve the exact log wording and
# are wired through `WorkerSpec.on_start` / `on_cancel`.

def emit_startup_log() -> None:
    """One-time startup log emission. Called by supervisor before first tick."""
    logger.info(
        f"cnotify receipts loop started (interval={int(DEFAULT_INTERVAL_S)}s)"
    )


def emit_cancel_log() -> None:
    """Cancel log emission. Called by supervisor in CancelledError handler
    BEFORE re-raise. Preserves the wording previously emitted from inside
    the loop body's `except asyncio.CancelledError` arm."""
    logger.info("cnotify receipts loop cancelled")


__all__ = ["poll_receipts_once", "emit_startup_log", "emit_cancel_log"]
