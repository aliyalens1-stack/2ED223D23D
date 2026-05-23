"""offer_packages — customer router.

Endpoints (customer-scoped, all under /api/car-selection/requests/{rid}):

    GET   .../offer-packages                       list packages the customer can see
    GET   .../offer-packages/{pid}                 fetch one
    POST  .../offer-packages/{pid}/accept          delivered → accepted
    POST  .../offer-packages/{pid}/decline         delivered → declined

Discipline:

    * Customer can see ONLY packages with status in
      {delivered, accepted, declined, revoked}. Drafts are invisible
      and resolve to 404 — same existence-privacy rule as elsewhere
      in the Car-Selection subsystem.
    * Customer can only act (accept/decline) on packages they
      logically own (i.e. attached to a request where
      customerId == ctx.user_id). Foreign requests resolve to 404.
    * Multiple delivered packages may coexist on a single request —
      we do NOT cascade an `accept` into auto-decline of others.
      Accepting one package is a commercial commitment to that
      package; other delivered offers stay around as-is so the
      audit log is honest.
"""
from __future__ import annotations
from typing import Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Path
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.car_selection.repository import CarSelectionRepository
from app.offer_packages.models import (
    DecisionIn, OfferPackageOut, OfferPackageListOut,
)
from app.offer_packages.repository import OfferPackageRepository


router = APIRouter(
    prefix="/api/car-selection/requests",
    tags=["car-selection:offer-packages:customer"],
)


def _customer_gate():
    return require_account_kind("customer")


def _err(status: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={
            "error": True, "code": code, "message": message,
            "details": details or {},
        },
    )


def _request_not_found(rid: str) -> HTTPException:
    return _err(
        404, "CAR_SELECTION_NOT_FOUND",
        f"request {rid!r} not found",
        requestId=rid,
    )


def _package_not_found(pid: str) -> HTTPException:
    return _err(
        404, "OFFER_PACKAGE_NOT_FOUND",
        f"offer package {pid!r} not found",
        packageId=pid,
    )


CUSTOMER_VISIBLE_STATUSES = ["delivered", "accepted", "declined", "revoked"]


async def _load_my_request_or_404(
    db: AsyncIOMotorDatabase, *, request_id: str, customer_id: str,
) -> Dict[str, Any]:
    doc = await CarSelectionRepository(db).get_by_id(request_id)
    if doc is None or doc.get("customerId") != customer_id:
        raise _request_not_found(request_id)
    return doc


# ── List ─────────────────────────────────────────────────────────────


@router.get(
    "/{rid}/offer-packages",
    response_model=OfferPackageListOut,
)
async def list_visible(
    rid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_customer_gate()),
) -> Dict[str, Any]:
    await _load_my_request_or_404(db, request_id=rid, customer_id=ctx.user_id)
    repo = OfferPackageRepository(db)
    items = await repo.list_projected(
        request_id=rid,
        surface="customer",
        statuses=CUSTOMER_VISIBLE_STATUSES,
    )
    return {"items": items, "total": len(items)}


# ── Get one ──────────────────────────────────────────────────────────


@router.get(
    "/{rid}/offer-packages/{pid}",
    response_model=OfferPackageOut,
)
async def get_one(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_customer_gate()),
) -> Dict[str, Any]:
    await _load_my_request_or_404(db, request_id=rid, customer_id=ctx.user_id)
    repo = OfferPackageRepository(db)
    doc = await repo.get(pid)
    if (
        doc is None
        or doc.get("requestId") != rid
        or doc.get("status") not in CUSTOMER_VISIBLE_STATUSES
    ):
        raise _package_not_found(pid)
    return await repo._project(doc, surface="customer")  # type: ignore[arg-type]


# ── Accept / Decline ─────────────────────────────────────────────────


async def _decide(
    db: AsyncIOMotorDatabase,
    *,
    rid: str,
    pid: str,
    customer_id: str,
    note: str | None,
    target: str,
) -> Dict[str, Any]:
    await _load_my_request_or_404(db, request_id=rid, customer_id=customer_id)
    repo = OfferPackageRepository(db)
    doc = await repo.get(pid)
    # Hide drafts and cross-request packages behind a 404.
    if (
        doc is None
        or doc.get("requestId") != rid
        or doc.get("status") not in CUSTOMER_VISIBLE_STATUSES
    ):
        raise _package_not_found(pid)

    # Only `delivered` packages can transition to accepted / declined.
    # We let the repo raise OFFER_PACKAGE_INVALID_TRANSITION rather
    # than fronting it here, so the error envelope is uniform.
    await repo.apply_transition(
        package_id=pid,
        target_status=target,
        actor_id=customer_id,
        actor_role="customer",
        note=note,
    )
    return await repo.get_projected(package_id=pid, surface="customer")  # type: ignore[return-value]


@router.post(
    "/{rid}/offer-packages/{pid}/accept",
    response_model=OfferPackageOut,
)
async def accept(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    body: DecisionIn = DecisionIn(),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_customer_gate()),
) -> Dict[str, Any]:
    return await _decide(
        db, rid=rid, pid=pid, customer_id=ctx.user_id,
        note=body.note, target="accepted",
    )


@router.post(
    "/{rid}/offer-packages/{pid}/decline",
    response_model=OfferPackageOut,
)
async def decline(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    body: DecisionIn = DecisionIn(),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_customer_gate()),
) -> Dict[str, Any]:
    return await _decide(
        db, rid=rid, pid=pid, customer_id=ctx.user_id,
        note=body.note, target="declined",
    )
