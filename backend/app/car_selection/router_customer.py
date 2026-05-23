"""car_selection customer router.

Endpoints (customer-scoped):

  POST /api/car-selection/requests          → create a new advisory request
  GET  /api/car-selection/requests/me       → list caller's own requests
  GET  /api/car-selection/requests/{id}     → fetch one (caller MUST own it)
  POST /api/car-selection/requests/{id}/cancel
                                            → customer-initiated cancellation

All routes are gated to `customer` accounts (admin operates via the
admin router so audit fields stay clean — admin reads/writes look
different from customer reads/writes).
"""
from __future__ import annotations
from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from typing import Annotated, Optional

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.car_selection.models import CarSelectionCreateIn
from app.car_selection.repository import (
    CarSelectionRepository,
    InvalidTransitionError,
    RequestNotFoundError,
)
from app.offer_packages.repository import OfferPackageRepository


router = APIRouter(prefix="/api/car-selection", tags=["car-selection:customer"])


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


def _serialize(doc: Dict[str, Any]) -> Dict[str, Any]:
    """Normalise `_id` → `id` and return a fresh dict so we don't leak
    the mutable Mongo doc reference."""
    out = dict(doc)
    out["id"] = out.pop("_id")
    return out


# ── Create ────────────────────────────────────────────────────────────


@router.post("/requests")
async def create_request(
    body: CarSelectionCreateIn,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
) -> Dict[str, Any]:
    """Customer creates an advisory request. Listing-review requires a
    sourceLink — enforced at the service-type level here, not in the
    pydantic schema, because the constraint is per-type."""
    if body.serviceType == "listing_review" and not body.sourceLink:
        raise _err(
            422,
            "LISTING_LINK_REQUIRED",
            "listing_review requires a sourceLink (mobile.de URL)",
        )

    repo = CarSelectionRepository(get_db())
    doc = await repo.create(
        customer_id=ctx.user_id,
        service_type=body.serviceType,
        country_code=body.countryCode,
        city_id=body.cityId,
        description=body.description,
        source_link=str(body.sourceLink) if body.sourceLink else None,
        budget=body.budget.dict(exclude_none=True) if body.budget else None,
    )
    return _serialize(doc)


# ── Read (caller's own) ───────────────────────────────────────────────


@router.get("/requests/me")
async def list_my_requests(
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    docs = await repo.list_for_customer(ctx.user_id, limit=limit)
    items = [_serialize(d) for d in docs]
    # Project commercial awareness onto each row — count of delivered
    # (non-terminal, customer-visible) offer packages. Server-side
    # only; UI never owns this number. See Step 2 discipline:
    #   * count means: delivered packages awaiting the customer's
    #     decision. Drafts/terminal states are NOT counted.
    #   * no preview, no provider hint, no urgency — pure scalar.
    if items:
        op_repo = OfferPackageRepository(get_db())
        counts = await op_repo.count_delivered_by_request_ids([it["id"] for it in items])
        for it in items:
            it["deliveredOffersCount"] = counts.get(it["id"], 0)
    return {"items": items, "total": len(items)}


@router.get("/requests/{request_id}")
async def get_request(
    request_id: str,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    doc = await repo.get_by_id(request_id)
    if doc is None:
        raise _err(
            404, "CAR_SELECTION_NOT_FOUND",
            f"request {request_id!r} not found",
            requestId=request_id,
        )
    # Authorization — customers can only read their OWN requests.
    if doc.get("customerId") != ctx.user_id:
        # We deliberately return 404 (not 403) so the existence of
        # other-customer requests cannot be probed.
        raise _err(
            404, "CAR_SELECTION_NOT_FOUND",
            f"request {request_id!r} not found",
            requestId=request_id,
        )
    return _serialize(doc)


# ── Customer-initiated cancellation ───────────────────────────────────


class CancelIn(BaseModel):
    reason: Optional[Annotated[str, Field(max_length=500)]] = None


@router.post("/requests/{request_id}/cancel")
async def cancel_request(
    request_id: str,
    body: CancelIn,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    doc = await repo.get_by_id(request_id)
    if doc is None or doc.get("customerId") != ctx.user_id:
        raise _err(
            404, "CAR_SELECTION_NOT_FOUND",
            f"request {request_id!r} not found",
            requestId=request_id,
        )
    try:
        updated = await repo.transition_status(
            request_id,
            target_status="cancelled",
            actor_id=ctx.user_id,
            actor_role="customer",
            note=body.reason,
        )
    except InvalidTransitionError as e:
        raise _err(
            409, "INVALID_TRANSITION",
            str(e),
            currentStatus=e.current,
            targetStatus=e.target,
        )
    except RequestNotFoundError:
        # Race — admin/system deleted between fetch and update.
        raise _err(
            404, "CAR_SELECTION_NOT_FOUND",
            f"request {request_id!r} disappeared mid-update",
            requestId=request_id,
        )
    return _serialize(updated)


__all__ = ["router"]
