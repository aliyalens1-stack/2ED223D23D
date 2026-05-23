"""Sprint 5 · Block 3 — PayPal endpoints (credit packs).

POST /api/payments/paypal/create-order   {packageId, origin?}
   → creates internal package_payments doc + PayPal order; returns approveUrl

POST /api/payments/paypal/capture-order  {orderId, paymentId}
   → captures PayPal order; idempotently grants credits + writes ledger entry

Same credit/ledger flow as Stripe via packages.service.mark_payment_paid().
"""
from __future__ import annotations
import os
import logging
from typing import Optional

from fastapi import APIRouter, HTTPException, Request, Depends
from pydantic import BaseModel, Field

from app.payments import paypal as paypal_client
from app.packages import service as credits_svc
from app.packages.schemas import get_package
from app.auto_requests.auth import get_user_id_optional

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/payments/paypal", tags=["payments:paypal"])

DEFAULT_RETURN_BASE = os.environ.get("PAYPAL_RETURN_BASE", "/packages/paypal-return")
DEFAULT_CANCEL_BASE = os.environ.get("PAYPAL_CANCEL_BASE", "/packages/paypal-cancel")


class CreateOrderBody(BaseModel):
    packageId: str = Field(..., min_length=1, max_length=64)
    origin: Optional[str] = Field(default=None, description="Frontend origin for return URLs")


class CaptureOrderBody(BaseModel):
    orderId: str = Field(..., min_length=4, max_length=128)
    paymentId: str = Field(..., min_length=4, max_length=128)


@router.post("/create-order")
async def create_order(
    body: CreateOrderBody,
    request: Request,
    uid: Optional[str] = Depends(get_user_id_optional),
):
    """Create a credit-pack purchase via PayPal. Returns approveUrl for redirect."""
    pkg = get_package(body.packageId)
    if not pkg:
        raise HTTPException(404, "Unknown package")

    # 1. Internal pending payment (single source of truth for crediting)
    pending = await credits_svc.create_pending_payment(
        user_id=uid, package_id=body.packageId, provider="paypal",
    )
    payment_id = str(pending["_id"])

    # 2. Build return / cancel URLs from frontend origin (or request base_url fallback)
    origin = (body.origin or "").rstrip("/")
    if not origin:
        origin = str(request.base_url).rstrip("/")
    return_url = f"{origin}{DEFAULT_RETURN_BASE}?paymentId={payment_id}"
    cancel_url = f"{origin}{DEFAULT_CANCEL_BASE}?paymentId={payment_id}"

    # 3. Create PayPal order (or mock if creds are placeholders)
    res = await paypal_client.create_order(
        amount_eur=int(pkg["price"]),
        currency=pkg.get("currency", "EUR"),
        payment_id=payment_id,
        return_url=return_url,
        cancel_url=cancel_url,
    )

    # 4. Persist orderId on the payment doc
    from app.core.db import get_db
    db = get_db()
    await db.package_payments.update_one(
        {"_id": payment_id},
        {"$set": {"sessionId": res["order_id"], "providerMock": bool(res.get("mock"))}},
    )

    return {
        "paymentId": payment_id,
        "orderId": res["order_id"],
        "approveUrl": res["approve_url"],
        "amount": pkg["price"],
        "credits": pkg["credits"],
        "currency": pkg.get("currency", "EUR"),
        "mock": bool(res.get("mock")),
        "status": "initiated",
    }


@router.post("/capture-order")
async def capture_order(body: CaptureOrderBody):
    """Capture an approved PayPal order → grant credits idempotently."""
    pending = await credits_svc.get_payment(body.paymentId)
    if not pending:
        raise HTTPException(404, "Payment not found")
    if pending.get("provider") != "paypal":
        raise HTTPException(409, "Payment is not a PayPal payment")
    expected_order = pending.get("sessionId")
    if expected_order and expected_order != body.orderId:
        raise HTTPException(409, "Order id does not match payment record")

    # Idempotent — already paid?
    if pending.get("status") == "paid":
        return {
            "status": "paid",
            "paymentId": body.paymentId,
            "credits": int(pending.get("credits", 0)),
            "idempotent": True,
        }

    res = await paypal_client.capture_order(body.orderId)
    if not res.get("captured"):
        raise HTTPException(409, f"PayPal capture failed: {res.get('status')}")

    # Single abstraction: grant credits + ledger entry (same as Stripe)
    paid_doc = await credits_svc.mark_payment_paid(body.paymentId, session_id=body.orderId)
    if not paid_doc:
        raise HTTPException(500, "Failed to mark payment paid")

    return {
        "status": "paid",
        "paymentId": body.paymentId,
        "orderId": body.orderId,
        "credits": int(paid_doc.get("credits", 0)),
        "amount": int(paid_doc.get("amount", 0)),
        "currency": paid_doc.get("currency", "EUR"),
        "mock": bool(res.get("mock") or pending.get("providerMock")),
    }


@router.get("/status/{payment_id}")
async def order_status(payment_id: str):
    """Lightweight status poll (used by /packages/paypal-return UI)."""
    doc = await credits_svc.get_payment(payment_id)
    if not doc:
        raise HTTPException(404, "Payment not found")
    return {
        "paymentId": payment_id,
        "status": doc.get("status"),
        "orderId": doc.get("sessionId"),
        "credits": int(doc.get("credits", 0)),
        "amount": int(doc.get("amount", 0)),
        "currency": doc.get("currency", "EUR"),
        "mock": bool(doc.get("providerMock")),
    }
