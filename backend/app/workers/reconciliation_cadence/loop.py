"""app.workers.reconciliation_cadence.loop — the single-pass tick.

Mirrors the `POST /api/admin/reconciliation/report` handler closely, with
two differences:

  1. **`triggeredBy.actorRole = "system:scheduler"`** instead of the
     captured admin AttributionContext. This is the marker operators use
     to distinguish scheduled cadence rows from human-triggered ones.

  2. **Idempotency guard**: if the youngest existing snapshot is younger
     than `IDEMPOTENCY_WINDOW_S`, the tick returns early with
     `{"skipped": True, "reason": "idempotency_window"}`. This prevents
     double-runs from a hot-reload restart producing duplicate evidence.

Nothing else. The worker does NOT:
  • decide whether divergence is acceptable
  • trigger remediation
  • notify operators
  • modify `service_payments` or any source-of-truth collection

It produces ONE row in `reconciliation_snapshots`, append-only, with the
same schema operators already consume in `GET /api/admin/reconciliation/history`.
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict

from app.payments.reconciliation import generate_report

from .contracts import (
    DEFAULT_INTERVAL_S,
    IDEMPOTENCY_WINDOW_S,
    MIN_DIVERGENCE_FOR_LOG,
    SYSTEM_ACTOR,
)

logger = logging.getLogger(__name__)


async def _last_scheduled_snapshot_age_seconds(db) -> float:
    """Returns the age in seconds of the most recent SCHEDULED snapshot.

    Only considers `triggeredBy.actorRole == "system:scheduler"` rows.
    Human-triggered snapshots do NOT reset the worker's idempotency
    window — a manual snapshot doesn't satisfy the platform's evidence
    cadence guarantee (operators may not act regularly).

    Returns +inf when no scheduled snapshot exists yet (cold start).
    """
    row = await db.reconciliation_snapshots.find_one(
        {"triggeredBy.actorRole": "system:scheduler"},
        {"_id": 0, "persistedAt": 1},
        sort=[("persistedAt", -1)],
    )
    if not row or not row.get("persistedAt"):
        return float("inf")
    try:
        persisted_at = datetime.fromisoformat(row["persistedAt"])
    except (TypeError, ValueError):
        return float("inf")
    now = datetime.now(timezone.utc)
    if persisted_at.tzinfo is None:
        persisted_at = persisted_at.replace(tzinfo=timezone.utc)
    return (now - persisted_at).total_seconds()


async def run_reconciliation_once(db) -> Dict[str, Any]:
    """Single-pass entry. Returns a summary for observability.

    {
      "skipped":          <bool>,
      "reason":           <str | None>,
      "snapshotId":       <str | None>,
      "divergenceCount":  <int | None>,
      "totalDocs":        <int | None>,
      "tookMs":           <int>,
    }
    """
    started = datetime.now(timezone.utc)

    # Idempotency guard. Cheap query — single index lookup on persistedAt.
    try:
        age = await _last_scheduled_snapshot_age_seconds(db)
    except Exception as e:
        logger.warning(f"reconciliation_cadence: idempotency check failed: {e}")
        age = float("inf")  # fail open — prefer evidence to silence

    if age < IDEMPOTENCY_WINDOW_S:
        return {
            "skipped":         True,
            "reason":          "idempotency_window",
            "snapshotId":      None,
            "divergenceCount": None,
            "totalDocs":       None,
            "tookMs":          int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        }

    # Generate the report. `limit=None` = full scan; safe for the cadence
    # because we run it at most every IDEMPOTENCY_WINDOW_S seconds.
    try:
        report = await generate_report(db, limit=None)
    except Exception as e:
        logger.warning(f"reconciliation_cadence: generate_report failed: {e}")
        # The supervisor restart_policy will retry on next tick. No
        # snapshot is persisted on transport failure.
        return {
            "skipped":         True,
            "reason":          f"generate_failed: {e}",
            "snapshotId":      None,
            "divergenceCount": None,
            "totalDocs":       None,
            "tookMs":          int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        }

    snapshot_id = uuid.uuid4().hex
    divergence_count = sum(report.get("divergenceCountsByCode", {}).values())
    snapshot: Dict[str, Any] = {
        "id":               snapshot_id,
        "generatedAt":      report.get("generatedAt"),
        "scope":            report.get("scope"),
        "totalDocs":        report.get("totalDocs"),
        "limit":            report.get("limit"),
        "divergenceCount":  divergence_count,
        "report":           report,
        # Synthetic system actor — see contracts.SYSTEM_ACTOR.
        "triggeredBy":      dict(SYSTEM_ACTOR),
        "persistedAt":      datetime.now(timezone.utc).isoformat(),
        "schemaVersion":    1,
    }
    try:
        await db.reconciliation_snapshots.insert_one(dict(snapshot))
    except Exception as e:
        # If the write fails we do NOT raise — we report it and let the
        # supervisor retry on the next cadence tick. This matches the
        # discipline established for receipts_poll: per-tick errors are
        # logged-and-counted, not propagated.
        logger.warning(f"reconciliation_cadence: snapshot insert failed: {e}")
        return {
            "skipped":         True,
            "reason":          f"insert_failed: {e}",
            "snapshotId":      None,
            "divergenceCount": None,
            "totalDocs":       None,
            "tookMs":          int((datetime.now(timezone.utc) - started).total_seconds() * 1000),
        }

    took_ms = int((datetime.now(timezone.utc) - started).total_seconds() * 1000)

    if divergence_count >= MIN_DIVERGENCE_FOR_LOG:
        logger.info(
            f"reconciliation_cadence: snapshot persisted id={snapshot_id[:12]} "
            f"divergence={divergence_count} totalDocs={report.get('totalDocs')} "
            f"took={took_ms}ms"
        )

    return {
        "skipped":         False,
        "reason":          None,
        "snapshotId":      snapshot_id,
        "divergenceCount": divergence_count,
        "totalDocs":       report.get("totalDocs"),
        "tookMs":          took_ms,
    }


# ── Worker lifecycle log hooks (called by supervisor) ──

def emit_startup_log() -> None:
    logger.info(
        f"reconciliation_cadence worker started (interval={int(DEFAULT_INTERVAL_S)}s, "
        f"idempotency_window={int(IDEMPOTENCY_WINDOW_S)}s)"
    )


def emit_cancel_log() -> None:
    logger.info("reconciliation_cadence worker cancelled")


__all__ = [
    "run_reconciliation_once",
    "emit_startup_log",
    "emit_cancel_log",
]
