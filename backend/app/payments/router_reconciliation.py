"""P3.3 + P5.2 — Reconciliation router (READ-ONLY consistency observer
with history persistence).

P3.3 doctrine (preserved verbatim):
  This router is a THIN FastAPI surface over the existing pure-function
  reconciliation module (`app.payments.reconciliation.generate_report`).
  Per P3 brief:
    "НЕ single source of truth. А cross-truth divergence detector."

P5.2 addition:
  Add APPEND-ONLY persistence of report snapshots so divergence evolution
  is reconstructable over time. Per P5 brief:
    "callable snapshot → historical divergence evolution
     НО: append-only / no auto-fix / no remediation engine / no ledger rewrite.
     Просто: time-indexed evidence."

  Three new endpoints:
    POST /report          → generate AND persist a snapshot
    GET  /history         → list past snapshots (paginated)
    GET  /history/{id}    → fetch one historical snapshot

  The original `GET /report` keeps its on-demand, NON-persisting behaviour.
  Persistence is opt-in via POST.
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any, Dict, Optional

from fastapi import APIRouter, Depends, Query, HTTPException, Path

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)
from app.payments.reconciliation import (
    generate_report,
    STATUS_BUCKETS,
    KNOWN_STATUSES,
)


router = APIRouter(
    prefix="/api/admin/reconciliation",
    tags=["admin.reconciliation"],
    dependencies=[Depends(verify_admin_token)],
)


def _strip_id(doc: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    if doc:
        doc.pop("_id", None)
    return doc


@router.get("/report")
async def get_reconciliation_report(
    limit: Optional[int] = Query(
        default=None,
        ge=1,
        le=100_000,
        description="Cap on rows scanned. None = scan entire service_payments collection.",
    ),
    db=Depends(get_db),
):
    """On-demand, NON-persisting report. Returns the same shape as
    `app.payments.reconciliation.generate_report()`.
    """
    return await generate_report(db, limit=limit)


@router.post("/report")
async def post_reconciliation_report(
    limit: Optional[int] = Query(default=None, ge=1, le=100_000),
    db=Depends(get_db),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    """P5.2 — Generate a report AND persist it as an append-only snapshot.

    The snapshot is written to `reconciliation_snapshots` with the full
    attribution context (which operator triggered the snapshot, from
    which route, with what reason). Audit row also lands in
    `admin_audit_log` via `record_admin_mutation`.

    Why distinct from GET:
      * GET is idempotent and free (just compute).
      * POST is a mutation of the evidence collection — must be
        explicitly opted into and recorded with attribution.
    """
    report = await generate_report(db, limit=limit)

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
        "triggeredBy":      {
            "actorId":         ctx.actor_id,
            "actorRole":       ctx.actor_role,
            "sourceRoute":     ctx.source_route,
            "sourceRequestId": ctx.source_request_id,
            "operatorReason":  ctx.operator_reason,
        },
        "persistedAt":      datetime.now(timezone.utc).isoformat(),
        "schemaVersion":    1,
    }
    to_insert = dict(snapshot)
    await db.reconciliation_snapshots.insert_one(to_insert)

    # Governance audit row (does NOT touch payment_events — reconciliation
    # is not payment-specific; it's a fleet-wide observability action).
    await record_admin_mutation(
        db, ctx,
        action     = "reconciliation.snapshot",
        domain     = "other",
        entity_id  = snapshot_id,
        extra      = {"divergenceCount": divergence_count, "totalDocs": report.get("totalDocs")},
    )

    snapshot.pop("_id", None)
    return snapshot


@router.get("/history")
async def get_reconciliation_history(
    limit: int = Query(default=20, ge=1, le=100),
    skip:  int = Query(default=0,  ge=0),
    db=Depends(get_db),
):
    """List persisted snapshots, newest first. Returns a summary view
    (no full report body) for cheap paging.
    """
    cursor = (
        db.reconciliation_snapshots
        .find({}, {"_id": 0, "report": 0})
        .sort([("persistedAt", -1)])
        .skip(skip).limit(limit)
    )
    rows = [doc async for doc in cursor]
    total = await db.reconciliation_snapshots.count_documents({})
    return {"total": total, "limit": limit, "skip": skip, "rows": rows}


@router.get("/history/{snapshot_id}")
async def get_reconciliation_snapshot(
    snapshot_id: str = Path(..., min_length=1, max_length=64),
    db=Depends(get_db),
):
    """Fetch a single historical snapshot, full report body included."""
    doc = await db.reconciliation_snapshots.find_one({"id": snapshot_id}, {"_id": 0})
    if doc is None:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return doc


@router.get("/taxonomy")
async def get_reconciliation_taxonomy():
    """Surface the status taxonomy + bucket mapping used by the divergence
    detector. Useful for admin UIs that want to render a legend.

    Pure metadata — no DB access.
    """
    return {
        "buckets": {
            bucket: sorted(list(statuses))
            for bucket, statuses in STATUS_BUCKETS.items()
        },
        "knownStatuses": sorted(list(KNOWN_STATUSES)),
        "doctrine": (
            "READ-ONLY snapshot. No auto-fix, no backfill, no ledger. "
            "New statuses appear in the `unknown` bucket — they are not "
            "silently absorbed."
        ),
    }
