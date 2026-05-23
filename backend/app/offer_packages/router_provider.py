"""offer_packages — provider router.

Endpoints (provider-scoped, all under /api/provider/car-selection/{rid}):

    POST   .../offer-packages                       create draft
    GET    .../offer-packages                       list MY packages on this request
    GET    .../offer-packages/{pid}                 fetch one (mine + delivered + decisions)
    PATCH  .../offer-packages/{pid}                 edit draft content
    POST   .../offer-packages/{pid}/deliver         draft → delivered

Invariants:

    * The route gate is `require_account_kind("inspector",
      "service_provider", "dealer", "transport_provider")` — same as
      the existing provider router for car_selection.
    * A provider may only see / mutate offer packages on requests
      assigned to them. Foreign requests resolve to 404.
    * A provider may only edit / deliver their OWN packages. Other
      providers' packages on the same request resolve to 404
      (existence privacy — we don't expose competitors' drafts).
    * Once delivered, the content is frozen by the repo; this router
      just calls `apply_transition(target_status="delivered", ...)`.
"""
from __future__ import annotations
from typing import Dict, Any

from fastapi import APIRouter, Depends, HTTPException, Path
from motor.motor_asyncio import AsyncIOMotorDatabase

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.car_selection.repository import CarSelectionRepository
from app.offer_packages.models import (
    CreateDraftIn, UpdateDraftIn, OfferPackageOut, OfferPackageListOut,
)
from app.offer_packages.repository import OfferPackageRepository


router = APIRouter(
    prefix="/api/provider/car-selection",
    tags=["car-selection:offer-packages:provider"],
)


def _provider_gate():
    return require_account_kind(
        "inspector",
        "service_provider",
        "dealer",
        "transport_provider",
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


async def _load_assigned_request_or_404(
    db: AsyncIOMotorDatabase, *, request_id: str, provider_id: str,
) -> Dict[str, Any]:
    """Read the parent request and refuse non-owners with 404."""
    doc = await CarSelectionRepository(db).get_by_id(request_id)
    if doc is None or doc.get("assignedProviderId") != provider_id:
        raise _request_not_found(request_id)
    return doc


# ── Create draft ─────────────────────────────────────────────────────


@router.post(
    "/{rid}/offer-packages",
    response_model=OfferPackageOut,
    status_code=201,
)
async def create_draft(
    rid: str = Path(..., min_length=1, max_length=64),
    body: CreateDraftIn = ...,
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)
    doc = await repo.create_draft(
        request_id=rid,
        provider_id=ctx.user_id,
        initial_content=body.model_dump(exclude_unset=True),
    )
    out = await repo.get_projected(package_id=doc["_id"], surface="provider")
    return out  # repo._project guarantees serialisable dict


# ── List my packages on this request ─────────────────────────────────


@router.get(
    "/{rid}/offer-packages",
    response_model=OfferPackageListOut,
)
async def list_my_packages(
    rid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)
    items = await repo.list_projected(
        request_id=rid,
        surface="provider",
        provider_id=ctx.user_id,
    )
    return {"items": items, "total": len(items)}


# ── Fetch one ────────────────────────────────────────────────────────


@router.get(
    "/{rid}/offer-packages/{pid}",
    response_model=OfferPackageOut,
)
async def get_one(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)
    doc = await repo.get(pid)
    if doc is None or doc.get("requestId") != rid or doc.get("providerId") != ctx.user_id:
        raise _package_not_found(pid)
    return await repo._project(doc, surface="provider")  # type: ignore[arg-type]


# ── Edit draft ───────────────────────────────────────────────────────


@router.patch(
    "/{rid}/offer-packages/{pid}",
    response_model=OfferPackageOut,
)
async def update_draft(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    body: UpdateDraftIn = ...,
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)

    # Pre-check: package belongs to this request + this provider.
    doc = await repo.get(pid)
    if doc is None or doc.get("requestId") != rid or doc.get("providerId") != ctx.user_id:
        raise _package_not_found(pid)

    await repo.update_draft(
        package_id=pid,
        actor_id=ctx.user_id,
        actor_role="provider",
        patch=body,
    )
    return await repo.get_projected(package_id=pid, surface="provider")  # type: ignore[return-value]


# ── Deliver ──────────────────────────────────────────────────────────


@router.post(
    "/{rid}/offer-packages/{pid}/deliver",
    response_model=OfferPackageOut,
)
async def deliver(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)

    doc = await repo.get(pid)
    if doc is None or doc.get("requestId") != rid or doc.get("providerId") != ctx.user_id:
        raise _package_not_found(pid)

    await repo.apply_transition(
        package_id=pid,
        target_status="delivered",
        actor_id=ctx.user_id,
        actor_role="provider",
    )
    return await repo.get_projected(package_id=pid, surface="provider")  # type: ignore[return-value]


# ── Revise (Phase 9 — Offer Package Versioning) ──────────────────────


@router.post(
    "/{rid}/offer-packages/{pid}/revise",
    response_model=OfferPackageOut,
    status_code=201,
)
async def revise(
    rid: str = Path(..., min_length=1, max_length=64),
    pid: str = Path(..., min_length=1, max_length=64),
    db: AsyncIOMotorDatabase = Depends(get_db),
    ctx: IdentityContext = Depends(_provider_gate()),
) -> Dict[str, Any]:
    """Start a v(N+1) draft in an existing chain.

    Pre-conditions are enforced inside `repo.create_revision`:
      * the predecessor `pid` exists, belongs to the current provider,
        is the chain head (status == 'delivered',
        supersededById == None)
      * the parent request is non-terminal

    On success returns 201 + the new draft projection. The link to
    the predecessor is NOT forged at this point — only the chainId
    is inherited and `parentId` is stamped for provenance. The
    backward (`supersedesId`) and forward (`supersededById`) pointers
    are set atomically when the new draft is delivered (decision
    7.2 + 7.9).
    """
    await _load_assigned_request_or_404(db, request_id=rid, provider_id=ctx.user_id)
    repo = OfferPackageRepository(db)

    pred = await repo.get(pid)
    if pred is None or pred.get("requestId") != rid or pred.get("providerId") != ctx.user_id:
        # Existence-privacy: foreign-provider / cross-request 404.
        raise _package_not_found(pid)

    new_doc = await repo.create_revision(
        predecessor_id=pid,
        provider_id=ctx.user_id,
    )
    return await repo.get_projected(package_id=new_doc["_id"], surface="provider")  # type: ignore[return-value]
