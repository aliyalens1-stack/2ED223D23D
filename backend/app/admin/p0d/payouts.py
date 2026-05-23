"""P0.d — Payouts admin endpoints.

Endpoints (all under /api/admin/payouts):
    GET   /                          — list with status filter
    GET   /{payout_id}                — detail + audit history
    POST  /{payout_id}/approve        — pending|hold → approved
    POST  /{payout_id}/hold           — pending|approved|processing → hold
    POST  /{payout_id}/process        — approved → processing

All mutating endpoints require admin role and write to `money_audit`.
"""
from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

from fastapi import APIRouter, Body, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

from .audit import write_money_audit
from .payout_fsm import (
    PAYOUT_STATES,
    PAYOUT_TERMINAL,
    PayoutTransitionError,
    assert_transition,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/payouts", tags=["admin:p0d:payouts"])


# ──────────────────────────────────────────────────────────────────
# Bodies
# ──────────────────────────────────────────────────────────────────


class AdminPayoutAction(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


# ──────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────


async def _load_payout(db, payout_id: str) -> Dict[str, Any]:
    doc = await db.payouts.find_one({"id": payout_id}, {"_id": 0})
    if not doc:
        # Back-compat: some legacy rows use Mongo _id only.
        doc = await db.payouts.find_one({"_id": payout_id})
        if doc:
            doc["id"] = str(doc.pop("_id"))
    if not doc:
        raise HTTPException(404, "Payout not found")
    return doc


def _actor_id(payload: Dict[str, Any]) -> str:
    return payload.get("sub") or payload.get("userId") or "unknown-admin"


async def _apply_transition(
    db,
    payout: Dict[str, Any],
    action: str,
    actor_id: str,
    body: AdminPayoutAction,
    ctx: Optional[AttributionContext] = None,
) -> Dict[str, Any]:
    """Validate FSM → mutate `payouts` doc → write `money_audit` row.

    Returns the updated payout doc.
    """
    current = payout.get("status") or "pending"
    try:
        _, target = assert_transition(current, action)
    except PayoutTransitionError as e:
        # Always write a rejected-action audit row so attempted mutations
        # of terminal money are visible in the timeline.
        await write_money_audit(
            db,
            entity="payout",
            entity_id=payout["id"],
            action=f"{action}:rejected",
            actor_id=actor_id,
            from_status=current,
            to_status=None,
            meta={
                "reason": body.reason,
                "note": body.note,
                "error": str(e),
            },
        )
        raise HTTPException(e.status_code, str(e))

    from datetime import datetime, timezone
    now_iso = datetime.now(timezone.utc).isoformat()
    set_fields: Dict[str, Any] = {
        "status": target,
        "updatedAt": now_iso,
    }
    # Append actor-stamp on the entity for each transition (immutable history
    # on the doc itself, so a rogue $set on `status` is still detectable).
    if action == "approve":
        set_fields["approvedAt"] = now_iso
        set_fields["approvedBy"] = actor_id
    elif action == "hold":
        set_fields["heldAt"] = now_iso
        set_fields["heldBy"] = actor_id
        set_fields["holdReason"] = body.reason
    elif action == "process":
        set_fields["processingStartedAt"] = now_iso
        set_fields["processingBy"] = actor_id

    await db.payouts.update_one(
        # Hard-guard against TOCTOU: only update if status hasn't changed.
        {"id": payout["id"], "status": current},
        {"$set": set_fields},
    )

    audit = await write_money_audit(
        db,
        entity="payout",
        entity_id=payout["id"],
        action=action,
        actor_id=actor_id,
        from_status=current,
        to_status=target,
        meta={
            "reason": body.reason,
            "note": body.note,
            "amount": payout.get("amount"),
            "currency": payout.get("currency"),
            "inspectorId": payout.get("inspectorId"),
            "providerId": payout.get("providerId"),
        },
    )

    # P6.B.2 — Attribution: governance trail for payout FSM transition.
    if ctx is not None:
        try:
            await record_admin_mutation(
                db, ctx,
                action=f"payout.{action}",
                domain="payment",
                entity_id=payout["id"],
                extra={"fromStatus": current, "toStatus": target,
                       "amount": payout.get("amount"),
                       "currency": payout.get("currency"),
                       "inspectorId": payout.get("inspectorId"),
                       "providerId": payout.get("providerId"),
                       "reason": body.reason},
            )
        except Exception as _attr_e:
            logger.warning(f"[p0d.payouts] attribution {action} failed: {_attr_e}")

    updated = await _load_payout(db, payout["id"])
    return {"payout": updated, "audit": audit}


# ──────────────────────────────────────────────────────────────────
# Endpoints
# ──────────────────────────────────────────────────────────────────


@router.get("")
async def list_payouts(
    status: Optional[str] = Query(None, description=f"one of {list(PAYOUT_STATES)}"),
    inspector_id: Optional[str] = Query(None, alias="inspectorId"),
    provider_id: Optional[str] = Query(None, alias="providerId"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    q: Dict[str, Any] = {}
    if status:
        if status not in PAYOUT_STATES:
            raise HTTPException(400, f"unknown status: {status}")
        q["status"] = status
    if inspector_id:
        q["inspectorId"] = inspector_id
    if provider_id:
        q["providerId"] = provider_id

    total = await db.payouts.count_documents(q)
    cursor = db.payouts.find(q, {"_id": 0}).sort("createdAt", -1).skip(offset).limit(limit)
    items: List[Dict[str, Any]] = await cursor.to_list(limit)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "filter": {"status": status, "inspectorId": inspector_id, "providerId": provider_id},
    }


@router.get("/{payout_id}")
async def get_payout(
    payout_id: str,
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    payout = await _load_payout(db, payout_id)
    history_cursor = db.money_audit.find(
        {"entity": "payout", "entityId": payout_id},
        {"_id": 0},
    ).sort("timestamp", -1).limit(100)
    history = await history_cursor.to_list(100)
    return {
        "payout": payout,
        "terminal": payout.get("status") in PAYOUT_TERMINAL,
        "history": history,
    }


@router.post("/{payout_id}/approve")
async def approve_payout(
    payout_id: str,
    body: AdminPayoutAction = Body(default_factory=AdminPayoutAction),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    payout = await _load_payout(db, payout_id)
    return await _apply_transition(db, payout, "approve", _actor_id(admin), body, ctx=ctx)


@router.post("/{payout_id}/hold")
async def hold_payout(
    payout_id: str,
    body: AdminPayoutAction = Body(default_factory=AdminPayoutAction),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    payout = await _load_payout(db, payout_id)
    return await _apply_transition(db, payout, "hold", _actor_id(admin), body, ctx=ctx)


@router.post("/{payout_id}/process")
async def process_payout(
    payout_id: str,
    body: AdminPayoutAction = Body(default_factory=AdminPayoutAction),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    payout = await _load_payout(db, payout_id)
    return await _apply_transition(db, payout, "process", _actor_id(admin), body, ctx=ctx)


__all__ = ["router"]
