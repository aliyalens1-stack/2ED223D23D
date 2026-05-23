"""Sprint 9 — Structured logging utility for production debuggability.

Emits a single JSON envelope per business event:

    {
        "ts":         "2026-05-19T22:00:00+00:00",
        "level":      "INFO" | "WARN" | "ERROR",
        "event":      "escrow.release.started",
        "traceId":    "uuid-or-passthrough",
        "requestId":  "...",
        "paymentId":  "...",
        "providerId": "...",
        "customerId": "...",
        "meta":       {...}
    }

Usage:
    from app.core.structured_log import sl
    sl("escrow.release.started", request_id=..., payment_id=..., meta={...})
    sl("escrow.release.failed", level="ERROR", payment_id=..., error=str(e))

Design contract:
    - Never raises (logging must not break the request flow).
    - Output goes through stdlib logger (captured by supervisor → /var/log/supervisor/backend.*.log).
    - Envelope ALWAYS json.dumps-able — non-serializable values get repr'd.
    - traceId auto-generated if absent (UUID4 hex16).
"""
from __future__ import annotations

import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

# Single logger instance — all structured events route here.
_logger = logging.getLogger("audit")


# ─────────────────────────────────────────────────────────────────────
# Whitelisted event names — single source of truth for production grep.
# Add a new event here BEFORE using it. Keeps the audit surface bounded.
# ─────────────────────────────────────────────────────────────────────

EVENTS = {
    # Money
    "escrow.intent.created",
    "escrow.paid",
    "escrow.release.started",
    "escrow.release.succeeded",
    "escrow.release.failed",
    "escrow.release.blocked.dispute",
    "escrow.release.blocked.platform_frozen",
    "escrow.release.blocked.provider_frozen",
    "escrow.release.blocked.delay",
    "refund.requested",
    "refund.succeeded",
    "refund.failed",
    "transfer.created",
    "transfer.failed",
    "transfer.reversed",
    "payout.queued",
    # Trust
    "review.submitted",
    "review.revealed",
    "reputation.recomputed",
    # Arbitration
    "dispute.opened",
    "dispute.resolved",
    "platform.frozen",
    "platform.unfrozen",
    "provider.frozen",
    "provider.unfrozen",
    # Connect
    "connect.account.created",
    "connect.account.updated",
    "connect.onboarding.started",
    # Notifications
    "push.sent",
    "push.failed",
    "webhook.received",
    "webhook.duplicate",
    "webhook.invalid_signature",
}


def _safe(value: Any) -> Any:
    """Convert any value to a JSON-serializable form."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    if isinstance(value, dict):
        return {k: _safe(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [_safe(v) for v in value]
    return repr(value)


def sl(
    event: str,
    *,
    level: str = "INFO",
    trace_id: Optional[str] = None,
    request_id: Optional[str] = None,
    payment_id: Optional[str] = None,
    provider_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    dispute_id: Optional[str] = None,
    actor_id: Optional[str] = None,
    error: Optional[str] = None,
    meta: Optional[Dict[str, Any]] = None,
) -> None:
    """Emit a structured log envelope. NEVER raises."""
    try:
        envelope: Dict[str, Any] = {
            "ts": datetime.now(timezone.utc).isoformat(),
            "level": level.upper(),
            "event": event,
            "traceId": trace_id or uuid.uuid4().hex[:16],
        }
        if request_id:
            envelope["requestId"] = request_id
        if payment_id:
            envelope["paymentId"] = payment_id
        if provider_id:
            envelope["providerId"] = provider_id
        if customer_id:
            envelope["customerId"] = customer_id
        if dispute_id:
            envelope["disputeId"] = dispute_id
        if actor_id:
            envelope["actorId"] = actor_id
        if error:
            envelope["error"] = error[:500]
        if meta:
            envelope["meta"] = _safe(meta)

        # Sanity: warn (don't fail) if event not in whitelist.
        if event not in EVENTS:
            envelope["_unknown_event"] = True

        line = json.dumps(envelope, ensure_ascii=False, default=str)
        log_method = {
            "ERROR": _logger.error,
            "WARN": _logger.warning,
            "WARNING": _logger.warning,
            "DEBUG": _logger.debug,
        }.get(level.upper(), _logger.info)
        log_method(line)
    except Exception as e:
        # Last-resort: write to root logger so we know structured log failed.
        logging.getLogger(__name__).warning(f"[sl] envelope failed event={event}: {e}")


__all__ = ["sl", "EVENTS"]
