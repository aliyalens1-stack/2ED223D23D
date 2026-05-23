"""car_selection admin router.

Endpoints (admin-only):

  GET  /api/admin/car-selection
  GET  /api/admin/car-selection/{id}
  POST /api/admin/car-selection/{id}/assign
  POST /api/admin/car-selection/{id}/status

The admin reads/writes look intentionally distinct from the customer
side — admin can SEE any request, can change status to any reachable
target, and can assign workers. The customer side cannot.
"""
from __future__ import annotations
from typing import Annotated, Any, Dict, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_admin
from app.car_selection.lifecycle import STATUSES, SERVICE_TYPES
from app.car_selection.models import AdminAssignIn, AdminStatusIn
from app.car_selection.repository import (
    CarSelectionRepository,
    InvalidTransitionError,
    RequestNotFoundError,
)
# Car-Selection-4 — projection hook (notification = projection, not
# source of truth; failures are swallowed so they NEVER block lifecycle).
from app.car_selection_thread.repository import project_lifecycle_event  # noqa: E402
import logging  # noqa: E402
_cs_log = logging.getLogger(__name__)


async def _emit_lifecycle(db, doc, new_status: str, actor_role: str) -> None:
    try:
        await project_lifecycle_event(db, doc, new_status=new_status, actor_role=actor_role)
    except Exception as exc:  # noqa: BLE001
        _cs_log.warning("car_selection lifecycle projection failed: %s", exc)


router = APIRouter(
    prefix="/api/admin/car-selection",
    tags=["car-selection:admin"],
)


def _admin_gate():
    return require_admin()


def _err(status: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={
            "error": True, "code": code, "message": message,
            "details": details or {},
        },
    )


def _serialize(doc: Dict[str, Any]) -> Dict[str, Any]:
    out = dict(doc)
    out["id"] = out.pop("_id")
    return out


# ── Queue / list ──────────────────────────────────────────────────────


@router.get("")
async def list_admin_queue(
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
    status: Annotated[Optional[str], Query()] = None,
    serviceType: Annotated[Optional[str], Query()] = None,
    assignedAdminId: Annotated[Optional[str], Query()] = None,
    assignedProviderId: Annotated[Optional[str], Query()] = None,
    countryCode: Annotated[Optional[str], Query()] = None,
    cityId: Annotated[Optional[str], Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> Dict[str, Any]:
    """Admin queue projection. Filters AND-combine.

    Returns:
      {
        "items": [...],
        "total": int,                # length of items (post-limit)
        "filters": {...},            # echo of applied filters
        "counts": {"submitted": N, "reviewing": N, ...}  # whole-DB
      }
    """
    if status is not None and status not in STATUSES:
        raise _err(422, "INVALID_FILTER", f"unknown status {status!r}",
                   allowed=sorted(STATUSES))
    if serviceType is not None and serviceType not in SERVICE_TYPES:
        raise _err(422, "INVALID_FILTER",
                   f"unknown serviceType {serviceType!r}",
                   allowed=sorted(SERVICE_TYPES))

    db = get_db()
    repo = CarSelectionRepository(db)
    docs = await repo.list_for_admin(
        status=status,
        service_type=serviceType,
        assigned_admin_id=assignedAdminId,
        assigned_provider_id=assignedProviderId,
        country_code=countryCode,
        city_id=cityId,
        limit=limit,
    )

    # Per-status counts across the whole collection — useful for the
    # admin dashboard chips ("12 submitted · 3 reviewing · 7 in_progress").
    pipeline = [{"$group": {"_id": "$status", "n": {"$sum": 1}}}]
    counts: Dict[str, int] = {s: 0 for s in STATUSES}
    async for row in db.car_selection_requests.aggregate(pipeline):
        counts[row["_id"]] = int(row["n"])

    return {
        "items": [_serialize(d) for d in docs],
        "total": len(docs),
        "filters": {
            "status": status, "serviceType": serviceType,
            "assignedAdminId": assignedAdminId,
            "assignedProviderId": assignedProviderId,
            "countryCode": countryCode, "cityId": cityId,
            "limit": limit,
        },
        "counts": counts,
    }


@router.get("/{request_id}")
async def get_admin_request(
    request_id: str,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    doc = await repo.get_by_id(request_id)
    if doc is None:
        raise _err(404, "CAR_SELECTION_NOT_FOUND",
                   f"request {request_id!r} not found",
                   requestId=request_id)
    return _serialize(doc)


# ── Assign worker ─────────────────────────────────────────────────────


@router.post("/{request_id}/assign")
async def admin_assign(
    request_id: str,
    body: AdminAssignIn,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
) -> Dict[str, Any]:
    if not body.providerId and not body.adminId:
        raise _err(
            422, "ASSIGN_MISSING_TARGET",
            "at least one of providerId / adminId is required",
        )
    repo = CarSelectionRepository(get_db())
    try:
        updated = await repo.assign(
            request_id,
            admin_id=body.adminId,
            provider_id=body.providerId,
            actor_id=ctx.user_id,
            actor_role="admin",
            note=body.note,
        )
    except RequestNotFoundError:
        raise _err(404, "CAR_SELECTION_NOT_FOUND",
                   f"request {request_id!r} not found",
                   requestId=request_id)
    except InvalidTransitionError as e:
        raise _err(409, "INVALID_TRANSITION", str(e),
                   currentStatus=e.current, targetStatus=e.target)
    await _emit_lifecycle(get_db(), updated, updated.get("status"), "admin")
    return _serialize(updated)


# ── Status change ─────────────────────────────────────────────────────


@router.post("/{request_id}/status")
async def admin_status(
    request_id: str,
    body: AdminStatusIn,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    try:
        updated = await repo.transition_status(
            request_id,
            target_status=body.status,
            actor_id=ctx.user_id,
            actor_role="admin",
            note=body.note,
        )
    except RequestNotFoundError:
        raise _err(404, "CAR_SELECTION_NOT_FOUND",
                   f"request {request_id!r} not found",
                   requestId=request_id)
    except InvalidTransitionError as e:
        raise _err(409, "INVALID_TRANSITION", str(e),
                   currentStatus=e.current, targetStatus=e.target)
    await _emit_lifecycle(get_db(), updated, body.status, "admin")
    return _serialize(updated)


__all__ = ["router"]
