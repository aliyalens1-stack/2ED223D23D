"""Public + customer package/credits API.

Sprint 1D.2 — credits/ledger endpoints now require `account.kind == "customer"`.
The public `/api/packages` listing and `/api/payments/packages/checkout`
remain anonymous-friendly (guest checkout is the standard SaaS pattern).
"""
from __future__ import annotations
import os
from fastapi import APIRouter, Depends, HTTPException, Request

from app.packages.schemas import (
    PACKAGE_CATALOG, PackageOut, CreateCheckout, CheckoutResponse,
    CreditBalanceOut, get_package,
)
from app.packages import service as svc
from app.auto_requests.auth import get_user_id_optional
from app.core.identity_runtime import IdentityContext, require_account_kind

router = APIRouter(tags=["packages"])

# Customer-only gate for "my credits / my ledger". Provider/admin tokens get
# a clean 403 — they don't have customer credits.
_customer_required = require_account_kind("customer")


@router.get("/api/packages", response_model=list[PackageOut])
async def list_packages():
    return [PackageOut(**p) for p in PACKAGE_CATALOG]


@router.get("/api/customer/credits", response_model=CreditBalanceOut)
async def get_my_credits(ctx_: IdentityContext = Depends(_customer_required)):  # noqa: B008
    return await svc.get_balance(ctx_.user_id)


@router.get("/api/customer/credits/ledger")
async def get_my_ledger(ctx_: IdentityContext = Depends(_customer_required)):  # noqa: B008
    return {"items": await svc.list_ledger(ctx_.user_id, limit=100)}


# ── Checkout ──────────────────────────────────────────────────────────
@router.post("/api/payments/packages/checkout", response_model=CheckoutResponse)
async def create_checkout(data: CreateCheckout, request: Request):
    uid = get_user_id_optional(request) or "guest"
    pkg = get_package(data.packageId)
    if not pkg:
        raise HTTPException(404, "unknown package")

    # 1. Create pending payment doc
    payment = await svc.create_pending_payment(uid, data.packageId, data.provider)
    payment_id = payment["_id"]

    # Build return URLs (use request origin if not explicitly provided)
    origin = (data.origin or "").rstrip("/")
    if not origin:
        # derive from request headers
        host = request.headers.get("x-forwarded-host") or request.headers.get("host", "")
        proto = request.headers.get("x-forwarded-proto", "https")
        origin = f"{proto}://{host}"
    success_url = f"{origin}/api/web-app/packages/success?paymentId={payment_id}"
    cancel_url = f"{origin}/api/web-app/packages?canceled=1&paymentId={payment_id}"

    if data.provider == "stripe":
        checkout_url = await _create_stripe_session(payment, success_url, cancel_url)
    elif data.provider == "paypal":
        # Mock dev-mode PayPal per Sprint 3 spec
        checkout_url = f"{origin}/api/web-app/packages/paypal-mock?paymentId={payment_id}"
    else:
        raise HTTPException(400, "unsupported provider")

    return CheckoutResponse(paymentId=payment_id, checkoutUrl=checkout_url, provider=data.provider)


@router.get("/api/payments/packages/status/{payment_id}")
async def get_status(payment_id: str):
    """Poll from frontend: if stripe session is paid, mark paid & credit user."""
    doc = await svc.get_payment(payment_id)
    if not doc:
        raise HTTPException(404, "payment not found")

    # If already paid — return
    if doc.get("status") == "paid":
        return {"status": "paid", "payment": svc.payment_to_out(doc)}

    # If Stripe, poll session
    if doc.get("provider") == "stripe" and doc.get("sessionId"):
        try:
            status = await _check_stripe_session(doc["sessionId"])
            if status == "paid":
                await svc.mark_payment_paid(payment_id, doc["sessionId"])
                doc = await svc.get_payment(payment_id)
                return {"status": "paid", "payment": svc.payment_to_out(doc)}
        except Exception:
            pass

    return {"status": doc.get("status", "pending"), "payment": svc.payment_to_out(doc)}


@router.post("/api/payments/packages/mock-complete/{payment_id}")
async def mock_complete(payment_id: str):
    """DEV endpoint: simulate successful PayPal / Stripe return.
    Completes payment and credits user atomically."""
    doc = await svc.get_payment(payment_id)
    if not doc:
        raise HTTPException(404, "payment not found")
    updated = await svc.mark_payment_paid(payment_id, session_id=doc.get("sessionId"))
    return {"status": "ok", "payment": svc.payment_to_out(updated)}


# ── Stripe helpers via emergentintegrations ──────────────────────────
def _get_stripe_key() -> str:
    return os.environ.get("STRIPE_API_KEY") or "sk_test_emergent"


async def _create_stripe_session(payment: dict, success_url: str, cancel_url: str) -> str:
    from emergentintegrations.payments.stripe.checkout import StripeCheckout, CheckoutSessionRequest
    sc = StripeCheckout(api_key=_get_stripe_key(), webhook_url="")
    req = CheckoutSessionRequest(
        amount=float(payment["amount"]),
        currency=payment.get("currency", "EUR").lower(),
        success_url=f"{success_url}&session_id={{CHECKOUT_SESSION_ID}}",
        cancel_url=cancel_url,
        metadata={
            "paymentId": payment["_id"],
            "packageId": payment["packageId"],
            "userId": payment.get("userId") or "guest",
        },
    )
    session = await sc.create_checkout_session(req)
    # persist sessionId on our payment doc
    from app.core.db import get_db
    await get_db().package_payments.update_one({"_id": payment["_id"]}, {"$set": {"sessionId": session.session_id}})
    return session.url


async def _check_stripe_session(session_id: str) -> str:
    from emergentintegrations.payments.stripe.checkout import StripeCheckout
    sc = StripeCheckout(api_key=_get_stripe_key(), webhook_url="")
    status = await sc.get_checkout_status(session_id)
    # emergentintegrations returns a dict-ish status
    ps = getattr(status, "payment_status", None) or (status.get("payment_status") if isinstance(status, dict) else "")
    return "paid" if ps == "paid" else (ps or "pending")
