"""offer_packages — admin router.

Endpoints (admin-scoped, all under /api/admin/car-selection/{rid}):

    GET   .../offer-packages                       list ALL packages on this request
    GET   .../offer-packages/{pid}                 fetch one (any status)
    POST  .../offer-packages/{pid}/revoke          any non-terminal → revoked

Admin governance discipline:

    * Admin sees ALL packages — including drafts. This is the only
      surface that can see a provider's draft, by design.
    * `revoke` is a terminal recovery action. It does NOT undo an
      `accepted` or `declined` decision — those are commercially
      binding. Trying to revoke a terminal package returns
      OFFER_PACKAGE_INVALID_TRANSITION.
    * No edit / delete. Admin operates on the lifecycle only.
"""
from __future__ import annotations
from typing import Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Path
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_admin
from app.car_selection.repository import CarSelectionRepository
from app.offer_packages.models import (
    DecisionIn, OfferPackageOut, OfferPackageListOut,
)
from app.offer_packages.repository import OfferPackageRepository


router = APIRouter(
    prefix="/api/admin/car-selection",
    tags=["car-selection:offer-packages:admin"],
)


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


async def _assert_request_exists(db: AsyncIOMotorDatabase, rid: str) -> Dict[str, Any]:
    doc = await CarSelectionRepository(db).get_by_id(rid)
    if doc is None:
        raise _request_not_found(rid)
    return doc


# ── List ─────────────────────────────────────────────────────────────


@router.get(
    "/{rid}/offer-packages",
    response_model=OfferPackageListOut,
)
async def list_all(
    rid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(require_admin()),
) -> Dict[str, Any]:
    await _assert_request_exists(db, rid)
    repo = OfferPackageRepository(db)
    items = await repo.list_projected(request_id=rid, surface="admin")
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
    ctx: IdentityContext = Depends(require_admin()),
) -> Dict[str, Any]:
    await _assert_request_exists(db, rid)
    repo = OfferPackageRepository(db)
    doc = await repo.get(pid)
    if doc is None or doc.get("requestId") != rid:
        raise _package_not_found(pid)
    return await repo._project(doc, surface="admin")  # type: ignore[arg-type]


# ── Revoke ───────────────────────────────────────────────────────────


@router.post(
    "/{rid}/offer-packages/{pid}/revoke",
    response_model=OfferPackageOut,
)
async def revoke(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    body: DecisionIn = DecisionIn(),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(require_admin()),
) -> Dict[str, Any]:
    await _assert_request_exists(db, rid)
    repo = OfferPackageRepository(db)
    doc = await repo.get(pid)
    if doc is None or doc.get("requestId") != rid:
        raise _package_not_found(pid)

    await repo.apply_transition(
        package_id=pid,
        target_status="revoked",
        actor_id=ctx.user_id,
        actor_role="admin",
        note=body.note,
    )
    return await repo.get_projected(package_id=pid, surface="admin")  # type: ignore[return-value]
