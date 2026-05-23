"""observatory.router — Operator Cognition Observatory endpoints.

V1 (manual refresh, admin-gated):
  GET /api/operator/observatory
    Returns canonical interpretation. Side-effect: persists a snapshot iff
    the canonical-interpretation hash differs from the latest stored one.

V2 (continuity memory):
  GET /api/operator/observatory/history
    Snapshot list (newest first), summary-only — no full interpretation.

  GET /api/operator/observatory/history/{snapshot_id}/diff
    Structural topology diff between snapshot and its immediate predecessor.
    Returns empty list (`events: []`) when no structural change occurred OR
    when this is the first snapshot in the chain (no predecessor).

NO websocket. NO polling. NO LLM. Manual operator gesture only.
"""
from __future__ import annotations
from fastapi import APIRouter, Depends, HTTPException

from app.core.security import verify_admin_token
from app.core.db import get_db
from .aggregator import gather_substrate, is_substrate_sufficient
from .interpreter import interpret, now_iso
from .snapshots import (
    compute_hash,
    deterministic_summary,
    find_snapshot,
    latest_snapshot,
    list_snapshots,
    maybe_persist,
    predecessor_of,
    structural_diff,
)

router = APIRouter(prefix="/api/operator", tags=["operator:observatory"])


@router.get("/observatory")
async def get_observatory(_admin: dict = Depends(verify_admin_token)):
    """Manual interpretive read. Persists a continuity snapshot on change."""
    db = get_db()
    substrate = await gather_substrate(db)

    if not is_substrate_sufficient(substrate):
        return {"ok": False, "reason": "insufficient_decision_context"}

    interpretation = interpret(substrate)

    # Continuity memory: persist iff canonical interpretation hash changed.
    persisted, current_snap, prev_snap = await maybe_persist(db, interpretation)

    # Structural transition since previous snapshot (empty if first or unchanged).
    prev_interp = (prev_snap or {}).get("interpretation") if prev_snap else None
    # If we did NOT persist (unchanged), there is no new event to surface.
    # If we DID persist, diff is between newly-inserted snapshot and its predecessor.
    if persisted and current_snap and current_snap.get("id") != (prev_snap or {}).get("id"):
        change_events = structural_diff(prev_interp, interpretation)
        summary = current_snap.get("summary")
    else:
        change_events = []
        summary = (current_snap or {}).get("summary") if current_snap else None

    return {
        "ok": True,
        "generatedAt": now_iso(),
        **interpretation,
        "continuity": {
            "snapshotId": (current_snap or {}).get("id"),
            "takenAt": (current_snap or {}).get("takenAt"),
            "persisted": persisted,
            "summary": summary,
            "events": change_events,
        },
    }


@router.get("/observatory/history")
async def get_history(_admin: dict = Depends(verify_admin_token), limit: int = 50):
    """List of snapshot summaries. Newest first. No interpretation payloads."""
    db = get_db()
    snaps = await list_snapshots(db, limit=limit)
    return {"ok": True, "count": len(snaps), "snapshots": snaps}


@router.get("/observatory/history/{snapshot_id}")
async def get_history_detail(snapshot_id: str, _admin: dict = Depends(verify_admin_token)):
    """Full snapshot (includes interpretation). Used by detail view."""
    db = get_db()
    snap = await find_snapshot(db, snapshot_id)
    if not snap:
        raise HTTPException(status_code=404, detail="snapshot not found")
    return {"ok": True, "snapshot": snap}


@router.get("/observatory/history/{snapshot_id}/diff")
async def get_history_diff(snapshot_id: str, _admin: dict = Depends(verify_admin_token)):
    """Structural diff vs immediate predecessor. Topology only."""
    db = get_db()
    snap = await find_snapshot(db, snapshot_id)
    if not snap:
        raise HTTPException(status_code=404, detail="snapshot not found")

    prev = await predecessor_of(db, snap)
    prev_interp = (prev or {}).get("interpretation") if prev else None
    curr_interp = snap.get("interpretation") or {}

    events = structural_diff(prev_interp, curr_interp)
    summary = snap.get("summary") or deterministic_summary(prev_interp, curr_interp)

    return {
        "ok": True,
        "snapshotId": snap.get("id"),
        "takenAt": snap.get("takenAt"),
        "predecessorId": (prev or {}).get("id"),
        "predecessorTakenAt": (prev or {}).get("takenAt"),
        "summary": summary,
        "events": events,
    }
