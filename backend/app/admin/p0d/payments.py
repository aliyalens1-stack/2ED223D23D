"""P0.d — Payments admin endpoints (escrow `service_payments`).

Endpoints (all under /api/admin/payments):
    GET   /                       — list with status filter
    GET   /{payment_id}            — detail + audit history
    POST  /{payment_id}/refund     — paid|released → refunded (must record reason)
    POST  /{payment_id}/retry      — failed → pending (clears failureReason; client
                                     can hit /checkout again)

INVARIANT (the P0 acceptance test):
    `paid`, `released`, and `refunded` rows cannot be silently rewritten.
    - refund is allowed ONCE (refunded is terminal — second refund returns 409)
    - retry is allowed only from `failed` (paid/released/refunded reject)
    - every action — accepted OR rejected — appends a row to `money_audit`

Note on Stripe: this endpoint mutates ONLY platform state. Actual Stripe
refund is delegated to the existing `app.integrations.router_connect`
escrow refund flow (admin path) — out of P0.d scope. If integration with
real Stripe refund is wired later, hook it here BEFORE the audit write.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
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

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin/payments", tags=["admin:p0d:payments"])


PAYMENT_STATES = ("pending", "paid", "released", "failed", "refunded")
PAYMENT_TERMINAL_REFUND = "refunded"  # refunded cannot be re-refunded
# Statuses from which refund is allowed.
REFUND_ALLOWED_FROM = {"paid", "released"}
# Statuses from which retry is allowed.
RETRY_ALLOWED_FROM = {"failed"}


class AdminRefundBody(BaseModel):
    reason: str = Field(..., min_length=1, max_length=500, description="why refunding (required)")
    amount: Optional[int] = Field(None, ge=0, description="cents; default = full gross")
    note: Optional[str] = Field(None, max_length=2000)


class AdminRetryBody(BaseModel):
    reason: Optional[str] = Field(None, max_length=500)
    note: Optional[str] = Field(None, max_length=2000)


def _actor_id(payload: Dict[str, Any]) -> str:
    return payload.get("sub") or payload.get("userId") or "unknown-admin"


async def _load_payment(db, payment_id: str) -> Dict[str, Any]:
    doc = await db.service_payments.find_one({"id": payment_id}, {"_id": 0})
    if not doc:
        raise HTTPException(404, "Payment not found")
    return doc


# ──────────────────────────────────────────────────────────────────


@router.get("/admin-list")
async def list_payments(
    status: Optional[str] = Query(None),
    customer_id: Optional[str] = Query(None, alias="customerId"),
    provider_id: Optional[str] = Query(None, alias="providerId"),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    """List service_payments. Path uses /admin-list to avoid clashing
    with the existing /api/admin/payments/platform-status routes from
    app.integrations.router_connect."""
    db = get_db()
    q: Dict[str, Any] = {}
    if status:
        if status not in PAYMENT_STATES:
            raise HTTPException(400, f"unknown status: {status}")
        q["status"] = status
    if customer_id:
        q["customerId"] = customer_id
    if provider_id:
        q["providerId"] = provider_id

    total = await db.service_payments.count_documents(q)
    cursor = db.service_payments.find(q, {"_id": 0}).sort("createdAt", -1).skip(offset).limit(limit)
    items: List[Dict[str, Any]] = await cursor.to_list(limit)
    return {
        "items": items,
        "total": total,
        "limit": limit,
        "offset": offset,
        "filter": {"status": status, "customerId": customer_id, "providerId": provider_id},
    }


@router.get("/{payment_id}/detail")
async def get_payment_detail(
    payment_id: str,
    _: dict = Depends(verify_admin_token),
) -> Dict[str, Any]:
    db = get_db()
    pay = await _load_payment(db, payment_id)
    history_cursor = db.money_audit.find(
        {"entity": "payment", "entityId": payment_id},
        {"_id": 0},
    ).sort("timestamp", -1).limit(100)
    history = await history_cursor.to_list(100)
    return {
        "payment": pay,
        "terminal": pay.get("status") == PAYMENT_TERMINAL_REFUND,
        "history": history,
    }


@router.post("/{payment_id}/refund")
async def refund_payment(
    payment_id: str,
    body: AdminRefundBody,
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    pay = await _load_payment(db, payment_id)
    current = pay.get("status") or "pending"
    actor_id = _actor_id(admin)

    if current not in REFUND_ALLOWED_FROM:
        await write_money_audit(
            db,
            entity="payment",
            entity_id=payment_id,
            action="refund:rejected",
            actor_id=actor_id,
            from_status=current,
            to_status=None,
            meta={"reason": body.reason, "note": body.note, "error": f"cannot refund from {current}"},
        )
        # P0.b.C.g — chronology: admin refund attempt refused (admin-only).
        try:
            from app.payments.chronology.writer import append_payment_event
            await append_payment_event(
                db, payment_id=payment_id, kind="refund.requested:rejected",
                actor_id=actor_id, actor_role="admin",
                meta={"reason": body.reason, "currentStatus": current,
                      "error": f"cannot refund from {current}"},
            )
        except Exception as _e:
            pass  # side-effect only
        if current == PAYMENT_TERMINAL_REFUND:
            raise HTTPException(409, f"Payment already refunded; immutable history.")
        raise HTTPException(409, f"Cannot refund from status={current}; allowed only from {sorted(REFUND_ALLOWED_FROM)}.")

    refund_amount = body.amount if body.amount is not None else int(pay.get("grossAmount", 0) * 100)
    now_iso = datetime.now(timezone.utc).isoformat()

    # TOCTOU guard.
    result = await db.service_payments.update_one(
        {"id": payment_id, "status": current},
        {"$set": {
            "status": "refunded",
            "refundedAt": now_iso,
            "refundedBy": actor_id,
            "refundReason": body.reason,
            "refundNote": body.note,
            "refundAmountCents": refund_amount,
            "updatedAt": now_iso,
        }},
    )
    if result.modified_count == 0:
        # Another mutation slipped between read and write.
        raise HTTPException(409, "Payment status changed concurrently; refresh and retry.")

    audit = await write_money_audit(
        db,
        entity="payment",
        entity_id=payment_id,
        action="refund",
        actor_id=actor_id,
        from_status=current,
        to_status="refunded",
        meta={
            "reason": body.reason,
            "note": body.note,
            "amountCents": refund_amount,
            "grossAmount": pay.get("grossAmount"),
            "currency": pay.get("currency"),
            "requestId": pay.get("requestId"),
            "customerId": pay.get("customerId"),
            "providerId": pay.get("providerId"),
        },
    )
    # P0.b.C.g — chronology: admin initiated a refund.
    # NOTE: this is `refund.requested` not `refund.succeeded` — the latter
    # comes from Stripe webhook `charge.refunded` when the refund actually
    # lands at the customer bank. Platform-side intention vs Stripe-confirmed
    # finality remain two separate facts.
    try:
        from app.payments.chronology.writer import append_payment_event
        await append_payment_event(
            db, payment_id=payment_id, kind="refund.requested",
            actor_id=actor_id, actor_role="admin",
            meta={
                "amount": refund_amount,
                "currency": pay.get("currency", "EUR"),
                "reason": body.reason,
            },
        )
    except Exception as _e:
        pass  # side-effect only

    # P6.B.2 — Attribution: governance trail for refund (money mutation).
    try:
        await record_admin_mutation(
            db, ctx,
            action="payment.refund",
            domain="payment",
            entity_id=payment_id,
            extra={"amountCents": refund_amount,
                   "currency": pay.get("currency"),
                   "reason": body.reason,
                   "fromStatus": current,
                   "providerId": pay.get("providerId"),
                   "customerId": pay.get("customerId"),
                   "requestId": pay.get("requestId")},
        )
    except Exception as _attr_e:
        logger.warning(f"[p0d.payments] attribution refund failed: {_attr_e}")

    updated = await _load_payment(db, payment_id)
    return {"payment": updated, "audit": audit}


@router.post("/{payment_id}/retry")
async def retry_payment(
    payment_id: str,
    body: AdminRetryBody = Body(default_factory=AdminRetryBody),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> Dict[str, Any]:
    db = get_db()
    pay = await _load_payment(db, payment_id)
    current = pay.get("status") or "pending"
    actor_id = _actor_id(admin)

    if current not in RETRY_ALLOWED_FROM:
        await write_money_audit(
            db,
            entity="payment",
            entity_id=payment_id,
            action="retry:rejected",
            actor_id=actor_id,
            from_status=current,
            to_status=None,
            meta={"reason": body.reason, "note": body.note, "error": f"cannot retry from {current}"},
        )
        raise HTTPException(409, f"Cannot retry from status={current}; allowed only from {sorted(RETRY_ALLOWED_FROM)}.")

    now_iso = datetime.now(timezone.utc).isoformat()
    result = await db.service_payments.update_one(
        {"id": payment_id, "status": current},
        {"$set": {
            "status": "pending",
            "failureReason": None,
            "stripeCheckoutUrl": None,        # force fresh checkout session
            "stripeSessionId": None,
            "retriedAt": now_iso,
            "retriedBy": actor_id,
            "retryNote": body.note,
            "updatedAt": now_iso,
        }, "$inc": {"retryCount": 1}},
    )
    if result.modified_count == 0:
        raise HTTPException(409, "Payment status changed concurrently; refresh and retry.")

    audit = await write_money_audit(
        db,
        entity="payment",
        entity_id=payment_id,
        action="retry",
        actor_id=actor_id,
        from_status=current,
        to_status="pending",
        meta={
            "reason": body.reason,
            "note": body.note,
            "previousFailureReason": pay.get("failureReason"),
            "requestId": pay.get("requestId"),
        },
    )

    # P6.B.2 — Attribution: governance trail for retry.
    try:
        await record_admin_mutation(
            db, ctx,
            action="payment.retry",
            domain="payment",
            entity_id=payment_id,
            extra={"fromStatus": current, "previousFailureReason": pay.get("failureReason"),
                   "requestId": pay.get("requestId")},
        )
    except Exception as _attr_e:
        logger.warning(f"[p0d.payments] attribution retry failed: {_attr_e}")

    updated = await _load_payment(db, payment_id)
    return {"payment": updated, "audit": audit}


__all__ = ["router"]
