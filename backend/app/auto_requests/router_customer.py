"""Customer API: create + list + get own car requests.

Sprint 1D.2 — gates moved from anonymous-or-any-authenticated to
`require_account_kind("customer")` for the my/reports endpoints.

`POST /api/customer/requests` STAYS guest-friendly (anonymous create allowed).
The "list my requests" / "view my reports" endpoints are customer-gated:
  - 401 for anonymous
  - 403 for provider/admin tokens (their own data isn't here)
  - 200 for customer tokens — reads are scoped to ctx.user_id

Dual-write `customerAccountId` happens in the create endpoint via a thin
overlay update — service.py is intentionally untouched (same scope discipline
as Sprint 1D.1).
"""
from __future__ import annotations
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request

from app.auto_requests.schemas import CreateCarRequest, CarRequestOut
from app.auto_requests import service as svc
from app.auto_requests.auth import get_user_id_optional
from app.packages import service as credits_svc
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.core.db import get_db


def _iso_now() -> str:
    return datetime.now(timezone.utc).isoformat()


router = APIRouter(prefix="/api/customer/requests", tags=["auto_requests:customer"])

# Customer principal gate — for "my" reads / report views below.
_customer_required = require_account_kind("customer")


@router.post("", response_model=CarRequestOut)
async def create_endpoint(data: CreateCarRequest, request: Request):
    """Create a car selection request.

    INTENTIONALLY guest-friendly — anonymous creation is part of the public
    landing flow ("post a request, then sign up to track it"). When a token
    IS present we still derive the user_id, but we DO NOT enforce
    `account.kind == "customer"` because:
      - admin tokens helping a customer create a request shouldn't be 403'd
      - provider tokens may legitimately self-request inspections of their
        own purchase candidates

    Sprint 1D.2 dual-write: when authenticated, also persist
    `customerAccountId` so future joins can go through accounts._id.
    """
    uid = get_user_id_optional(request)
    cities_count = len(data.cities)

    out = await svc.create_request(data, user_id=uid)

    # Dual-write customerAccountId for authenticated requests.
    if uid:
        try:
            db = get_db()
            user = await db.users.find_one({"_id": uid}, {"_id": 0})
            if user is None:
                # Try ObjectId form
                from bson import ObjectId
                try:
                    user = await db.users.find_one({"_id": ObjectId(uid)}, {"_id": 0})
                except Exception:
                    user = None
            # Look up the customer account for this user (idempotent)
            acc = await db.accounts.find_one(
                {"userId": uid, "kind": "customer"}, {"_id": 1},
            )
            if acc:
                await db.car_requests.update_one(
                    {"_id": out.id},
                    {"$set": {"customerAccountId": str(acc["_id"])}},
                )
        except Exception:
            # Dual-write is best-effort — never block the create flow.
            pass

    # Best-effort credit reservation for legacy authenticated users with packages.
    if uid and cities_count > 0:
        try:
            balance = await credits_svc.get_balance(uid)
            if balance.available >= cities_count:
                await credits_svc.reserve_credits(uid, cities_count, request_id=out.id)
        except Exception:
            pass

    return out


# ─────────────────────────────────────────────────────────────────
# Sprint R1 — Simulated checkout (Stripe-bypass demo path)
# ─────────────────────────────────────────────────────────────────
#
# Stripe is intentionally out of scope at this stage of the product.
# The functional inspection flow MUST be exercisable end-to-end
# without any external payment provider. This endpoint creates the
# canonical car_request + inspection_jobs + inspector_exposures fan-out
# (same as the regular create path), then stamps the resulting request
# with `paymentStatus="simulated_paid"` so downstream code that wants
# to gate on payment can treat it as paid.
#
# Auth IS required here — the user's complaint was specifically that
# "Заказать подбор" should route guests through login first. The
# `_customer_required` gate enforces that (401 anon, 403 non-customer).

@router.post("/simulated-checkout", response_model=CarRequestOut)
async def simulated_checkout(
    data: CreateCarRequest,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Demo/dev one-shot checkout. No Stripe round-trip.

    Behaviour:
      * Calls the same `svc.create_request` as the public endpoint, so
        the inspection_jobs fan-out + marketplace exposure creation
        runs exactly as in production.
      * Stamps `paymentStatus="simulated_paid"` + `paid=True` so the
        request is immediately considered "active" by every downstream
        projection. This is the explicit doctrine of R1: payment is
        no longer a gate on demonstrating the inspection lifecycle.
      * Auth-required: customer kind only. Anonymous attempts → 401;
        provider/admin tokens → 403. This matches the front-end gate.

    Returns the same `CarRequestOut` shape as the public POST so the
    client doesn't have to branch on response shape.
    """
    out = await svc.create_request(data, user_id=ctx_.user_id)

    # Best-effort payment-status stamp. We DO NOT roll back the
    # request on update failure — the service is the source of truth
    # for "request exists", payment status is a decoration.
    try:
        db = get_db()
        await db.car_requests.update_one(
            {"_id": out.id},
            {"$set": {
                "paymentStatus": "simulated_paid",
                "paid": True,
                "paymentSimulatedAt": _iso_now(),
            }},
        )
    except Exception:
        pass

    return out


@router.get("/my")
@router.get("")
async def my_requests(ctx_: IdentityContext = Depends(_customer_required)):  # noqa: B008
    return await svc.list_my_requests(ctx_.user_id)


@router.get("/{request_id}", response_model=CarRequestOut)
async def get_one(request_id: str):
    """Public read of a single request — owner check happens at the report
    level. Kept open so the public landing can show "your request status"
    without forcing a login first."""
    doc = await svc.get_request(request_id)
    if not doc:
        raise HTTPException(404, "request not found")
    return doc


@router.get("/{request_id}/jobs")
async def get_request_jobs(request_id: str):
    """Public — see comment on `get_one`."""
    doc = await svc.get_request(request_id)
    if not doc:
        raise HTTPException(404, "request not found")
    jobs = await svc.get_jobs_for_request(request_id)
    return {"request": doc, "jobs": jobs}


# ─────────────────────────────────────────────────────────────────────
# Sprint 4 — Customer-facing inspection reports (kind-gated)
# ─────────────────────────────────────────────────────────────────────

reports_router = APIRouter(prefix="/api/customer", tags=["auto_requests:customer"])


@reports_router.get("/reports")
async def my_reports(ctx_: IdentityContext = Depends(_customer_required)):  # noqa: B008
    """List all inspection reports across the customer's car_requests."""
    from app.auto_requests import reports as rsvc
    items = await rsvc.list_reports_for_customer(ctx_.user_id)
    return {"reports": items, "count": len(items)}


@reports_router.get("/reports/{report_id}")
async def my_report_detail(
    report_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Detail of a single report — owner-scoped."""
    from app.auto_requests import reports as rsvc
    rep = await rsvc.get_report(report_id)
    if not rep:
        raise HTTPException(404, "report not found")
    db = get_db()
    req = await db.car_requests.find_one({"_id": rep["requestId"]}, {"userId": 1})
    if not req or req.get("userId") != ctx_.user_id:
        raise HTTPException(403, "not your report")
    return {"report": rep}


@reports_router.get("/requests/{request_id}/reports")
async def reports_for_request(
    request_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """All reports for one of the customer's requests."""
    from app.auto_requests import reports as rsvc
    db = get_db()
    req = await db.car_requests.find_one({"_id": request_id}, {"userId": 1})
    if not req:
        raise HTTPException(404, "request not found")
    if req.get("userId") != ctx_.user_id:
        raise HTTPException(403, "not your request")
    items = await rsvc.list_reports_for_request(request_id)
    return {"reports": items, "count": len(items)}


# Slice 1 — Customer acceptance (quality confirmation, non-financial)
#
# The credit was already consumed at /api/inspector/jobs/:id/report. This
# endpoint is the customer's "I received this report" signal. It does not
# move money, it moves trust:
#   - flips report.customerAcceptedAt
#   - powers inspector quality score (deviation from auto-verdict, dispute rate)
#   - unlocks future post-sale recommendations surface
#
# Idempotent — re-calling on an already-accepted report returns 200 with
# the unchanged report doc.
@reports_router.post("/reports/{report_id}/accept")
async def customer_accept_report_endpoint(
    report_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    from app.auto_requests import reports as rsvc
    rep, err = await rsvc.customer_accept_report(report_id, ctx_.user_id)
    if err == "not_found":
        raise HTTPException(404, "report not found")
    if err == "not_yours":
        raise HTTPException(403, "not your report")
    if err == "not_approved":
        raise HTTPException(
            409,
            "report is not approved yet — wait for admin review",
        )
    return {"status": "ok", "report": rep}
