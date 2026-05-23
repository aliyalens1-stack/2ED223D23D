"""car_selection provider router.

Endpoints (provider-scoped):

  GET  /api/provider/car-selection/me          → list caller's assignments
  GET  /api/provider/car-selection/{id}        → fetch one (must be assigned to me)
  POST /api/provider/car-selection/{id}/status → move lifecycle (restricted set)

Car-Selection-3 hard invariants:

  1. Provider sees ONLY requests where `assignedProviderId == ctx.user_id`.
     Listing is filtered server-side — there is no way to ask the API for
     unassigned or foreign requests.

  2. Existence privacy. A request that belongs to another provider returns
     404 (not 403). Mirrors the same discipline used by the customer router
     so provider clients can't enumerate the queue by id.

  3. Restricted lifecycle. Provider may ONLY traverse the execution
     sub-graph. Cancel, re-assign, and submitted/reviewing transitions
     remain admin-only.

         Current               Allowed (provider)
         ─────────────────     ──────────────────
         assigned              → in_progress, waiting_customer
         in_progress           → waiting_customer, completed
         waiting_customer      → in_progress, completed
         (anything else)       → forbidden

     Any other target — even one the generic lifecycle would accept — is
     rejected here. The router enforces this BEFORE calling the repo so
     the rejection code is PROVIDER_TRANSITION_FORBIDDEN, not the generic
     INVALID_TRANSITION.

  4. Timeline discipline. All provider-driven events record
     `actorRole = "provider"`. Audit trail keeps customer / admin / provider
     actors cleanly separated.

  5. Frozen brief. There is no endpoint for editing the customer
     description — only status transitions with an optional `note`.
     Provider notes ride the timeline; they do not overwrite the brief.
"""
from __future__ import annotations
from typing import Annotated, Any, Dict, FrozenSet, Mapping, Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.car_selection.lifecycle import STATUSES, CarSelectionStatus
from app.car_selection.repository import (
    CarSelectionRepository,
    InvalidTransitionError,
    RequestNotFoundError,
)


router = APIRouter(
    prefix="/api/provider/car-selection",
    tags=["car-selection:provider"],
)


# Gate to any professional account kind. Customers / admins go through
# their own routers; allowing them here would muddy actorRole audit
# values.
def _provider_gate():
    return require_account_kind(
        "inspector",
        "service_provider",
        "dealer",
        "transport_provider",
    )


# Provider-only lifecycle adjacency. Strict subset of the canonical
# table — see lifecycle.py for the full graph and the rationale.
PROVIDER_ALLOWED_TRANSITIONS: Mapping[str, FrozenSet[str]] = {
    "assigned":         frozenset({"in_progress", "waiting_customer"}),
    "in_progress":      frozenset({"waiting_customer", "completed"}),
    "waiting_customer": frozenset({"in_progress", "completed"}),
    # Provider may not touch:
    #   submitted, reviewing → admin triage gate
    #   completed, cancelled → terminal
    "submitted":        frozenset(),
    "reviewing":        frozenset(),
    "completed":        frozenset(),
    "cancelled":        frozenset(),
}


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


def _not_found_for_privacy(request_id: str) -> HTTPException:
    """Existence privacy — same envelope as customer router."""
    return _err(
        404, "CAR_SELECTION_NOT_FOUND",
        f"request {request_id!r} not found",
        requestId=request_id,
    )


class ProviderStatusIn(BaseModel):
    """Body for `POST /api/provider/car-selection/{id}/status`.

    `status` is validated against the generic lifecycle alphabet here;
    the route then runs the provider-specific adjacency check before
    touching the repository.
    """
    status: CarSelectionStatus
    note: Optional[Annotated[str, Field(max_length=500)]] = None

    @field_validator("status")
    @classmethod
    def _status_locked(cls, v: str) -> str:
        if v not in STATUSES:
            raise ValueError(f"status must be one of {sorted(STATUSES)}")
        return v

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) and v.strip() else None


# ── List ──────────────────────────────────────────────────────────────


@router.get("/me")
async def list_my_assignments(
    ctx: IdentityContext = Depends(_provider_gate()),  # noqa: B008
    limit: Annotated[int, Query(ge=1, le=200)] = 100,
) -> Dict[str, Any]:
    """List requests assigned to the calling provider.

    Server-side filter on `assignedProviderId`. There is intentionally
    no `status` filter — the provider workbench groups locally by
    `status`, and we don't want to leak filter shape into the API.

    Includes per-status counts across the caller's own assignments
    only — useful for the mobile workbench KPIs without exposing
    queue-wide totals.
    """
    db = get_db()
    repo = CarSelectionRepository(db)
    docs = await repo.list_for_admin(
        assigned_provider_id=ctx.user_id,
        limit=limit,
    )

    counts: Dict[str, int] = {s: 0 for s in STATUSES}
    pipeline = [
        {"$match": {"assignedProviderId": ctx.user_id}},
        {"$group": {"_id": "$status", "n": {"$sum": 1}}},
    ]
    async for row in db.car_selection_requests.aggregate(pipeline):
        counts[row["_id"]] = int(row["n"])

    return {
        "items": [_serialize(d) for d in docs],
        "total": len(docs),
        "counts": counts,
    }


# ── Read one ──────────────────────────────────────────────────────────


@router.get("/{request_id}")
async def get_my_assignment(
    request_id: str,
    ctx: IdentityContext = Depends(_provider_gate()),  # noqa: B008
) -> Dict[str, Any]:
    repo = CarSelectionRepository(get_db())
    doc = await repo.get_by_id(request_id)
    if doc is None:
        raise _not_found_for_privacy(request_id)
    if doc.get("assignedProviderId") != ctx.user_id:
        # Deliberate 404 — never reveal existence of foreign requests.
        raise _not_found_for_privacy(request_id)
    return _serialize(doc)


# ── Status transition (restricted) ────────────────────────────────────


@router.post("/{request_id}/status")
async def provider_transition(
    request_id: str,
    body: ProviderStatusIn,
    ctx: IdentityContext = Depends(_provider_gate()),  # noqa: B008
) -> Dict[str, Any]:
    """Provider-driven lifecycle move.

    Validation order matters — we hit each gate before the next so
    error codes carry meaningful intent:

      1. Request exists                         → 404 CAR_SELECTION_NOT_FOUND
      2. Request is assigned to *this* caller   → 404 (existence privacy)
      3. Provider may move from current → target
                                                → 409 PROVIDER_TRANSITION_FORBIDDEN
      4. Generic lifecycle accepts it
                                                → 409 INVALID_TRANSITION
                                                  (defence in depth; should
                                                  never fire because the
                                                  provider subset is a strict
                                                  subset of the canonical
                                                  adjacency table)
    """
    db = get_db()
    repo = CarSelectionRepository(db)

    doc = await repo.get_by_id(request_id)
    if doc is None or doc.get("assignedProviderId") != ctx.user_id:
        raise _not_found_for_privacy(request_id)

    current = doc.get("status")
    allowed = PROVIDER_ALLOWED_TRANSITIONS.get(current, frozenset())
    if body.status not in allowed:
        raise _err(
            409, "PROVIDER_TRANSITION_FORBIDDEN",
            f"provider may not move {current!r} → {body.status!r}",
            currentStatus=current,
            targetStatus=body.status,
            allowedForProvider=sorted(allowed),
        )

    try:
        updated = await repo.transition_status(
            request_id,
            target_status=body.status,
            actor_id=ctx.user_id,
            actor_role="provider",
            note=body.note,
        )
    except InvalidTransitionError as e:
        # Should be unreachable given the subset check above.
        raise _err(
            409, "INVALID_TRANSITION",
            str(e),
            currentStatus=e.current,
            targetStatus=e.target,
        )
    except RequestNotFoundError:
        # Race — admin/system deleted between fetch and update.
        raise _not_found_for_privacy(request_id)

    # Car-Selection-4 — projection hook. Failure NEVER blocks the
    # lifecycle transition; we just log and continue.
    try:
        from app.car_selection_thread.repository import project_lifecycle_event
        await project_lifecycle_event(
            db, updated, new_status=body.status, actor_role="provider",
        )
    except Exception as _exc:  # noqa: BLE001
        import logging
        logging.getLogger(__name__).warning(
            "car_selection lifecycle projection failed: %s", _exc,
        )

    return _serialize(updated)


__all__ = ["router", "PROVIDER_ALLOWED_TRANSITIONS"]
