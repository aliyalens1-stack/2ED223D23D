"""Sprint 6 — Disputes HTTP surface.

User endpoints:
    POST   /api/disputes                  — open a dispute
    GET    /api/disputes/my               — list current user's disputes
    GET    /api/disputes/{id}             — dispute detail (party or admin)

Admin endpoints:
    GET    /api/admin/disputes            — list with filters
    GET    /api/admin/disputes/{id}       — admin detail (timeline + chat preview + reputation)
    POST   /api/admin/disputes/{id}/resolve — release_to_provider | partial_refund | full_refund

Side effects on open:
    request.status = 'disputed'
    payment.status = 'disputed'
    timeline event 'dispute_opened' emitted (chat freeze marker)
    notifications fanned out to counterparty + admins
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Optional

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.core.db import get_db
from app.core.security import verify_admin_token, verify_user_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

logger = logging.getLogger(__name__)
router = APIRouter()


# ─────────────────────────────────────────────────────────────────────
# Constants — dispute is allowed only when escrow is locked but not released
# ─────────────────────────────────────────────────────────────────────

# Request statuses where a dispute CAN be opened (escrow already held).
DISPUTABLE_REQUEST_STATUSES = {"paid", "in_progress", "completed", "awaiting_release"}

# Payment statuses where dispute is allowed (money in escrow).
DISPUTABLE_PAYMENT_STATUSES = {"paid", "completed", "awaiting_release"}

DISPUTE_REASONS = {
    "not_completed",       # provider didn't deliver
    "quality_issue",       # work below expected quality
    "no_show",             # provider/customer didn't show up
    "overcharge",          # extra costs not agreed
    "damage",              # damage to vehicle / property
    "wrong_service",       # different from agreed
    "communication",       # provider unresponsive
    "other",
}

ResolutionKind = Literal["release_to_provider", "partial_refund", "full_refund"]


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def now_iso() -> str:
    return now_utc().isoformat()


def _uid() -> str:
    return uuid.uuid4().hex


# ─────────────────────────────────────────────────────────────────────
# Pydantic schemas
# ─────────────────────────────────────────────────────────────────────

class OpenDisputeBody(BaseModel):
    requestId: str = Field(..., min_length=1)
    reason: str = Field(..., min_length=2, max_length=64)
    description: Optional[str] = Field(None, max_length=2000)


class ResolveDisputeBody(BaseModel):
    action: Literal["release_to_provider", "partial_refund", "full_refund"]
    # For partial_refund: percentage of escrow refunded to customer (1-99).
    partialRefundPercent: Optional[int] = Field(None, ge=1, le=99)
    adminNote: Optional[str] = Field(None, max_length=1000)


# ─────────────────────────────────────────────────────────────────────
# Helpers
# ─────────────────────────────────────────────────────────────────────

async def _load_request(db, request_id: str) -> dict:
    req = await db.service_requests.find_one({"id": request_id}, {"_id": 0})
    if not req:
        raise HTTPException(404, "Service request not found")
    return req


async def _load_payment(db, request_id: str) -> Optional[dict]:
    """Find the active payment for a request (latest by createdAt)."""
    payments = (
        await db.service_payments.find({"requestId": request_id}, {"_id": 0})
        .sort("createdAt", -1)
        .limit(1)
        .to_list(length=1)
    )
    return payments[0] if payments else None


async def _emit_timeline(db, request_id: str, kind: str, actor_role: str, actor_id: Optional[str], meta: dict):
    """Best-effort timeline event (idempotent for dispute_opened via dedup)."""
    try:
        from app.service_chat.timeline import append_event
        await append_event(
            request_id=request_id,
            kind=kind,
            actor_role=actor_role,
            actor_id=actor_id,
            meta=meta,
            db=db,
        )
    except Exception as e:
        logger.warning(f"[disputes] timeline append failed kind={kind}: {e}")


async def _notify(db, user_id: Optional[str], **kwargs):
    if not user_id:
        return
    try:
        from app.notifications.emit import emit_notification
        await emit_notification(db=db, user_id=user_id, **kwargs)
    except Exception as e:
        logger.warning(f"[disputes] notify failed user={user_id}: {e}")


def _public_dispute(doc: dict) -> dict:
    """Strip _id + non-JSON-safe types (legacy ObjectId fields) before returning."""
    try:
        from bson import ObjectId
    except Exception:
        ObjectId = None  # type: ignore
    out: Dict[str, Any] = {}
    for k, v in doc.items():
        if k == "_id":
            continue
        if ObjectId is not None and isinstance(v, ObjectId):
            out[k] = str(v)
        else:
            out[k] = v
    return out


def _public_list(docs: List[dict]) -> List[dict]:
    return [_public_dispute(d) for d in docs]


# ─────────────────────────────────────────────────────────────────────
# POST /api/disputes — open a dispute
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/disputes")
async def open_dispute(body: OpenDisputeBody, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    if not user_id:
        raise HTTPException(401, "Unauthorized")

    if body.reason not in DISPUTE_REASONS:
        raise HTTPException(400, f"Invalid reason. Allowed: {sorted(DISPUTE_REASONS)}")

    db = get_db()
    req = await _load_request(db, body.requestId)

    customer_id = req.get("customerId")
    provider_id = req.get("providerId")
    if user_id not in (customer_id, provider_id):
        raise HTTPException(403, "Not a party of this request")

    opened_by_role = "customer" if user_id == customer_id else "provider"

    # Idempotency: one open dispute per request at a time. Check FIRST so
    # repeated calls (e.g. user double-tap) don't fail the state-window check
    # after the first open already flipped status to 'disputed'.
    existing = await db.disputes.find_one(
        {"requestId": body.requestId, "status": {"$in": ["open", "in_review"]}},
        {"_id": 0},
    )
    if existing:
        return {"dispute": existing, "alreadyOpen": True}

    # Validate state windows: must have escrow locked but NOT released.
    if req.get("status") not in DISPUTABLE_REQUEST_STATUSES:
        raise HTTPException(
            400,
            f"Cannot dispute in state '{req.get('status')}'. "
            f"Allowed: {sorted(DISPUTABLE_REQUEST_STATUSES)}",
        )
    if req.get("status") == "released":
        raise HTTPException(400, "Escrow already released — dispute window closed")

    pay = await _load_payment(db, body.requestId)
    if not pay:
        raise HTTPException(400, "No payment found for this request — nothing to dispute")
    if pay.get("status") not in DISPUTABLE_PAYMENT_STATUSES and pay.get("status") != "disputed":
        raise HTTPException(400, f"Payment status '{pay.get('status')}' not disputable")

    dispute = {
        "id": _uid(),
        "requestId": body.requestId,
        "paymentId": pay["id"],
        "customerId": customer_id,
        "providerId": provider_id,
        "openedBy": user_id,
        "openedByRole": opened_by_role,
        "reason": body.reason,
        "description": (body.description or "").strip()[:2000] or None,
        "status": "open",
        "amount": pay.get("amount") or req.get("amount"),
        "currency": pay.get("currency", "EUR"),
        "openedAt": now_iso(),
        "resolvedAt": None,
        "resolverId": None,
        "resolution": None,
        "partialRefundPercent": None,
        "adminNote": None,
    }
    await db.disputes.insert_one(dispute)
    dispute.pop("_id", None)
    # Sprint 9 — structured envelope.
    try:
        from app.core.structured_log import sl
        sl(
            "dispute.opened",
            dispute_id=dispute["id"],
            request_id=body.requestId,
            payment_id=pay["id"],
            provider_id=provider_id,
            customer_id=customer_id,
            actor_id=user_id,
            meta={"reason": body.reason, "openedByRole": opened_by_role},
        )
    except Exception:
        pass

    # Freeze request + payment.
    # Sprint B4.3-A.2 — CAS-guarded payment status flip. Payment may
    # legitimately be in any of DISPUTABLE_PAYMENT_STATUSES OR already
    # 'disputed' (idempotent re-open). The earlier validation gate at
    # line 205 already filtered out illegal entry states; this CAS
    # closes the read→write window.
    await db.service_requests.update_one(
        {"id": body.requestId},
        {"$set": {"status": "disputed", "disputedAt": now_iso(), "updatedAt": now_iso()}},
    )
    from app.payments.status_cas import cas_set_payment_status
    _outcome, _current = await cas_set_payment_status(
        db,
        payment_id=pay["id"],
        expected_from=list(DISPUTABLE_PAYMENT_STATUSES),
        next_status="disputed",
        extra_fields={"disputedAt": now_iso()},
    )
    if _outcome == "forbidden":
        # The dispute row was just inserted, but the payment moved
        # underneath us. Log loudly — the dispute is created but the
        # payment is not frozen; ops must reconcile. We deliberately
        # do NOT raise: the dispute IS open and the customer/provider
        # have evidence in `disputes`. Admin resolution will re-CAS.
        logger.error(
            f"[disputes] open: payment {pay['id']} status drifted to "
            f"'{_current}' between read and write — dispute {dispute['id']} "
            f"created but payment not frozen. Reconcile manually."
        )

    # Timeline chat marker (visible in service_chat as system event).
    await _emit_timeline(
        db, body.requestId,
        kind="dispute_opened",
        actor_role=opened_by_role,
        actor_id=user_id,
        meta={
            "disputeId": dispute["id"],
            "reason": body.reason,
            "openedByRole": opened_by_role,
        },
    )

    # P0.b.B+ — observe canonical lifecycle transition on `booking_timeline`.
    # Local, explicit, best-effort. No registry, no auto-observation.
    # Customer + provider projections both surface `open_dispute` (alert tone).
    try:
        from app.booking.attach import observe_transition
        await observe_transition(
            db,
            booking_id=body.requestId,
            booking_scope="service_request",
            action="open_dispute",
            from_status=req.get("status"),
            to_status="disputed",
            actor_id=user_id,
            actor_role=opened_by_role,
            source="disputes.open",
            source_request_id=request.headers.get("X-Request-Id"),
            accepted=True,
            meta={
                "disputeId": dispute["id"],
                "reason": body.reason,
            },
        )
    except Exception as _e:
        # observe_transition is itself best-effort; this guard is paranoia
        # — never let observability sabotage the dispute flow.
        logger.warning(f"[disputes] booking_timeline attach failed (open): {_e}")

    # Notify counterparty + provider's admin pool (light fanout).
    counter_id = provider_id if opened_by_role == "customer" else customer_id
    await _notify(
        db, counter_id,
        kind="dispute_opened",
        title="⚠️ Спор открыт",
        body="Эскроу временно заморожен. Решение примет администратор.",
        severity="warning",
        metadata={"requestId": body.requestId, "disputeId": dispute["id"]},
        action_url=f"/disputes/{dispute['id']}",
    )
    await _notify(
        db, user_id,
        kind="dispute_opened_ack",
        title="Спор зарегистрирован",
        body="Мы рассмотрим обращение и свяжемся с вами.",
        severity="info",
        metadata={"requestId": body.requestId, "disputeId": dispute["id"]},
        action_url=f"/disputes/{dispute['id']}",
    )

    logger.info(
        f"[disputes] opened {dispute['id']} req={body.requestId} by={opened_by_role} reason={body.reason}"
    )
    return {"dispute": dispute, "alreadyOpen": False}


# ─────────────────────────────────────────────────────────────────────
# GET /api/disputes/my
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/disputes/my")
async def list_my_disputes(request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    if not user_id:
        raise HTTPException(401, "Unauthorized")

    db = get_db()
    cursor = db.disputes.find(
        {"$or": [{"customerId": user_id}, {"providerId": user_id}]},
        {"_id": 0},
    ).sort("openedAt", -1).limit(100)
    items = await cursor.to_list(length=100)
    return items


# ─────────────────────────────────────────────────────────────────────
# GET /api/disputes/{id}
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/disputes/{dispute_id}")
async def get_dispute(dispute_id: str, request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    role = payload.get("role") or payload.get("kind")

    db = get_db()
    d = await db.disputes.find_one({"id": dispute_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Dispute not found")
    if role != "admin" and user_id not in (d.get("customerId"), d.get("providerId")):
        raise HTTPException(403, "Forbidden")
    return d


# ─────────────────────────────────────────────────────────────────────
# Admin — GET /api/admin/disputes
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/disputes")
async def admin_list_disputes(
    _: dict = Depends(verify_admin_token),
    status: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0),
):
    db = get_db()
    q: Dict[str, Any] = {}
    if status:
        q["status"] = status
    cursor = db.disputes.find(q, {"_id": 0}).sort("openedAt", -1).skip(offset).limit(limit)
    items = await cursor.to_list(length=limit)
    items = _public_list(items)
    total = await db.disputes.count_documents(q)
    # Stats summary for the queue header.
    open_count = await db.disputes.count_documents({"status": "open"})
    in_review_count = await db.disputes.count_documents({"status": "in_review"})
    resolved_count = await db.disputes.count_documents({"status": "resolved"})
    return {
        "items": items,
        "total": total,
        "stats": {"open": open_count, "in_review": in_review_count, "resolved": resolved_count},
    }


# ─────────────────────────────────────────────────────────────────────
# Admin — GET /api/admin/disputes/{id}
# ─────────────────────────────────────────────────────────────────────

@router.get("/api/admin/disputes/{dispute_id}")
async def admin_get_dispute(dispute_id: str, _: dict = Depends(verify_admin_token)):
    db = get_db()
    d = await db.disputes.find_one({"id": dispute_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Dispute not found")

    req = await db.service_requests.find_one({"id": d["requestId"]}, {"_id": 0})
    pay = await db.service_payments.find_one({"id": d["paymentId"]}, {"_id": 0})

    # Timeline events (last 30).
    timeline = await db.service_timeline_events.find(
        {"requestId": d["requestId"]}, {"_id": 0}
    ).sort("createdAt", -1).limit(30).to_list(length=30)
    timeline.reverse()

    # Chat preview (last 10 messages).
    chat = await db.service_chat_messages.find(
        {"requestId": d["requestId"]}, {"_id": 0}
    ).sort("createdAt", -1).limit(10).to_list(length=10)
    chat.reverse()

    # Reputation snapshots for both parties (read-only summary).
    provider_rep = await db.provider_reputation.find_one(
        {"providerId": d["providerId"]}, {"_id": 0}
    )

    # Provider dispute history — how many disputes have they had.
    provider_disputes = await db.disputes.count_documents({"providerId": d["providerId"]})
    provider_lost = await db.disputes.count_documents({
        "providerId": d["providerId"],
        "status": "resolved",
        "resolution": {"$in": ["full_refund", "partial_refund"]},
    })

    return {
        "dispute": d,
        "request": req,
        "payment": pay,
        "timeline": timeline,
        "chatPreview": chat,
        "providerReputation": provider_rep or {"providerId": d["providerId"]},
        "providerDisputeHistory": {"total": provider_disputes, "lost": provider_lost},
    }


# ─────────────────────────────────────────────────────────────────────
# Admin — POST /api/admin/disputes/{id}/resolve
# ─────────────────────────────────────────────────────────────────────

@router.post("/api/admin/disputes/{dispute_id}/resolve")
async def admin_resolve_dispute(
    dispute_id: str,
    body: ResolveDisputeBody,
    request: Request,
    _: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
):
    payload = await verify_user_token(request)
    admin_id = payload.get("sub") or payload.get("userId")

    db = get_db()
    d = await db.disputes.find_one({"id": dispute_id}, {"_id": 0})
    if not d:
        raise HTTPException(404, "Dispute not found")
    if d["status"] == "resolved":
        raise HTTPException(400, "Dispute already resolved")

    if body.action == "partial_refund" and not body.partialRefundPercent:
        raise HTTPException(400, "partialRefundPercent required for partial_refund (1-99)")

    pay = await db.service_payments.find_one({"id": d["paymentId"]}, {"_id": 0})
    req = await db.service_requests.find_one({"id": d["requestId"]}, {"_id": 0})
    if not pay or not req:
        raise HTTPException(409, "Payment or request missing — cannot resolve")

    now = now_iso()
    amount = float(pay.get("amount") or req.get("amount") or 0)
    currency = pay.get("currency", "EUR")

    # ── Apply action ──────────────────────────────────────────────────
    # Sprint B4.3-A.2 — CAS-guarded resolution. All three branches must
    # only transition from `disputed`. Concurrent resolution attempts
    # (two admins racing) get the second one a `forbidden` outcome and
    # we abort cleanly.
    from app.payments.status_cas import cas_set_payment_status

    if body.action == "release_to_provider":
        # Provider wins — full payout, request released.
        outcome, current = await cas_set_payment_status(
            db,
            payment_id=pay["id"],
            expected_from=["disputed"],
            next_status="released",
            extra_fields={
                "releasedAt": now,
                "releasedBy": admin_id,
                "releaseNote": f"Dispute resolved in favor of provider. {body.adminNote or ''}".strip(),
            },
        )
        if outcome != "modified":
            raise HTTPException(
                409,
                f"Cannot resolve: payment status is '{current}', expected 'disputed'. "
                f"Another resolution may have already completed.",
            )
        await db.service_requests.update_one(
            {"id": req["id"]},
            {"$set": {"status": "released", "updatedAt": now}},
        )
        timeline_kind = "dispute_resolved_release"
        customer_msg = "Спор разрешён в пользу исполнителя. Выплата произведена."
        provider_msg = "Спор разрешён в вашу пользу. Выплата готова."
        payout_amount = amount
        refund_amount = 0.0

    elif body.action == "full_refund":
        outcome, current = await cas_set_payment_status(
            db,
            payment_id=pay["id"],
            expected_from=["disputed"],
            next_status="refunded",
            extra_fields={
                "refundedAt": now,
                "refundedBy": admin_id,
                "refundAmount": amount,
                "refundNote": body.adminNote,
            },
        )
        if outcome != "modified":
            raise HTTPException(
                409,
                f"Cannot resolve: payment status is '{current}', expected 'disputed'. "
                f"Another resolution may have already completed.",
            )
        await db.service_requests.update_one(
            {"id": req["id"]},
            {"$set": {"status": "cancelled", "updatedAt": now, "cancelReason": "dispute_full_refund"}},
        )
        timeline_kind = "dispute_resolved_refund"
        customer_msg = f"Спор разрешён в вашу пользу. Полный возврат €{amount}."
        provider_msg = "Спор разрешён в пользу клиента. Выплата не будет произведена."
        payout_amount = 0.0
        refund_amount = amount

    else:  # partial_refund
        pct = body.partialRefundPercent
        refund_amount = round(amount * pct / 100, 2)
        payout_amount = round(amount - refund_amount, 2)
        outcome, current = await cas_set_payment_status(
            db,
            payment_id=pay["id"],
            expected_from=["disputed"],
            next_status="resolved_partial",
            extra_fields={
                "releasedAt": now,
                "releasedBy": admin_id,
                "partialPayoutAmount": payout_amount,
                "refundAmount": refund_amount,
                "refundPercent": pct,
                "releaseNote": f"Partial split: {100-pct}% provider / {pct}% refund. {body.adminNote or ''}".strip(),
            },
        )
        if outcome != "modified":
            raise HTTPException(
                409,
                f"Cannot resolve: payment status is '{current}', expected 'disputed'. "
                f"Another resolution may have already completed.",
            )
        await db.service_requests.update_one(
            {"id": req["id"]},
            {"$set": {"status": "released", "updatedAt": now}},
        )
        timeline_kind = "dispute_resolved_partial"
        customer_msg = f"Частичное решение: возврат €{refund_amount} ({pct}%)."
        provider_msg = f"Частичное решение: выплата €{payout_amount} ({100-pct}%)."

    # Update dispute doc.
    await db.disputes.update_one(
        {"id": dispute_id},
        {"$set": {
            "status": "resolved",
            "resolution": body.action,
            "partialRefundPercent": body.partialRefundPercent,
            "adminNote": body.adminNote,
            "resolverId": admin_id,
            "resolvedAt": now,
            "payoutAmount": payout_amount,
            "refundAmount": refund_amount,
        }},
    )

    # Timeline event.
    await _emit_timeline(
        db, d["requestId"], kind=timeline_kind, actor_role="admin", actor_id=admin_id,
        meta={
            "disputeId": dispute_id,
            "resolution": body.action,
            "payoutAmount": payout_amount,
            "refundAmount": refund_amount,
            "adminNote": body.adminNote,
        },
    )

    # P0.b.B+ — observe canonical lifecycle transition on `booking_timeline`.
    # Customer projection surfaces "Спор закрыт"; provider surfaces
    # "Спор разрешён" (neutral). Admin note + outcome NEVER leak — only
    # whitelisted meta keys (`payoutAmount`, `reason`) survive sanitisation
    # in either projection.
    try:
        from app.booking.attach import observe_transition
        await observe_transition(
            db,
            booking_id=d["requestId"],
            booking_scope="service_request",
            action="resolve_dispute",
            from_status="disputed",
            to_status="resolved",
            actor_id=admin_id,
            actor_role="admin",
            source="disputes.resolve",
            source_request_id=request.headers.get("X-Request-Id"),
            accepted=True,
            meta={
                "disputeId": dispute_id,
                "resolution": body.action,
                "payoutAmount": payout_amount,
                "refundAmount": refund_amount,
                # adminNote intentionally NOT propagated — it is a
                # moderation internal. Reaches no actor surface.
            },
        )
    except Exception as _e:
        logger.warning(f"[disputes] booking_timeline attach failed (resolve): {_e}")

    # Notifications.
    await _notify(
        db, d["customerId"],
        kind="dispute_resolved",
        title="✅ Спор разрешён",
        body=customer_msg,
        severity="success" if body.action != "release_to_provider" else "info",
        metadata={"disputeId": dispute_id, "requestId": d["requestId"]},
        action_url=f"/disputes/{dispute_id}",
    )
    await _notify(
        db, d["providerId"],
        kind="dispute_resolved",
        title="✅ Спор разрешён",
        body=provider_msg,
        severity="success" if body.action == "release_to_provider" else "warning",
        metadata={"disputeId": dispute_id, "requestId": d["requestId"]},
        action_url=f"/disputes/{dispute_id}",
    )

    # Recompute provider reputation (resolved dispute is now in history).
    try:
        from app.provider_trust.engine import recompute_provider_reputation
        await recompute_provider_reputation(db, d["providerId"])
    except Exception as e:
        logger.warning(f"[disputes] reputation recompute failed: {e}")

    # Sprint 7 — wire real Stripe Refund / Transfer based on resolution.
    pi_id = pay.get("stripePaymentIntentId")
    try:
        from app.integrations import stripe_connect_service as scs
        if body.action == "full_refund" and pi_id:
            r = await scs.create_refund(
                db, payment_intent_id=pi_id, payment_id=pay["id"],
                amount_cents=None, reason="requested_by_customer",
            )
            await db.service_payments.update_one(
                {"id": pay["id"]},
                {"$push": {"stripeRefunds": {
                    "refundId": r["refundId"], "amount": refund_amount,
                    "status": r["status"], "createdAt": now,
                    "sandbox": r.get("sandbox", True),
                }}},
            )
        elif body.action == "partial_refund" and pi_id and refund_amount:
            r = await scs.create_refund(
                db, payment_intent_id=pi_id, payment_id=pay["id"],
                amount_cents=int(refund_amount * 100),
                reason="requested_by_customer",
            )
            await db.service_payments.update_one(
                {"id": pay["id"]},
                {"$push": {"stripeRefunds": {
                    "refundId": r["refundId"], "amount": refund_amount,
                    "status": r["status"], "createdAt": now,
                    "sandbox": r.get("sandbox", True),
                }}},
            )
        elif body.action == "release_to_provider":
            # If provider onboarded → create Transfer; else mark for manual payout.
            provider_user = await db.users.find_one(
                {"_id": d["providerId"]},
                {"_id": 0, "stripeAccountId": 1, "stripePayoutsEnabled": 1},
            ) or {}
            if provider_user.get("stripeAccountId"):
                t = await scs.create_release_transfer(
                    db,
                    request_id=d["requestId"],
                    payment_id=pay["id"],
                    provider_account_id=provider_user["stripeAccountId"],
                    amount_cents=int(payout_amount * 100),
                    currency=(pay.get("currency") or "eur").lower(),
                    fee_percent=0.0,  # platform fee already accounted; dispute payout is gross
                )
                await db.service_payments.update_one(
                    {"id": pay["id"]},
                    {"$set": {
                        "stripeTransferId": t["transferId"],
                        "stripeTransferSandbox": t.get("sandbox", True),
                    }},
                )
    except Exception as e:
        logger.warning(f"[disputes] stripe action {body.action} failed: {e}")

    logger.info(
        f"[disputes] resolved {dispute_id} action={body.action} payout={payout_amount} refund={refund_amount}"
    )
    # Sprint 9 — structured envelope.
    try:
        from app.core.structured_log import sl
        sl(
            "dispute.resolved",
            dispute_id=dispute_id,
            request_id=d["requestId"],
            payment_id=d["paymentId"],
            provider_id=d["providerId"],
            customer_id=d["customerId"],
            actor_id=admin_id,
            meta={
                "resolution": body.action,
                "payoutAmount": payout_amount,
                "refundAmount": refund_amount,
                "partialRefundPercent": body.partialRefundPercent,
            },
        )
    except Exception:
        pass

    # P6.B — Attribution saturation: record this resolution in
    # admin_audit_log for the governance/operator-indexed trail. The
    # chronology-indexed trail is already written above via
    # observe_transition; this is the second view (per
    # core/attribution.py docstring: "Two writes, two audiences").
    try:
        await record_admin_mutation(
            db,
            ctx,
            action="dispute.resolve",
            domain="dispute",
            entity_id=dispute_id,
            causal_entity={"kind": "payment", "id": d["paymentId"]},
            extra={
                "resolution": body.action,
                "payoutAmount": payout_amount,
                "refundAmount": refund_amount,
                "partialRefundPercent": body.partialRefundPercent,
                "requestId": d["requestId"],
                "providerId": d["providerId"],
                "customerId": d["customerId"],
            },
        )
    except Exception as _attr_e:
        logger.warning(f"[disputes] attribution record failed: {_attr_e}")

    return {
        "dispute": await db.disputes.find_one({"id": dispute_id}, {"_id": 0}),
        "payoutAmount": payout_amount,
        "refundAmount": refund_amount,
    }


# ─────────────────────────────────────────────────────────────────────
# Index management
# ─────────────────────────────────────────────────────────────────────

async def ensure_indexes(db) -> None:
    """Idempotent index setup."""
    await db.disputes.create_index([("requestId", 1)])
    await db.disputes.create_index([("status", 1), ("openedAt", -1)])
    await db.disputes.create_index([("customerId", 1)])
    await db.disputes.create_index([("providerId", 1)])
    logger.info("[disputes] indexes ensured")
