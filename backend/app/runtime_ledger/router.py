"""runtime_ledger/router.py — admin inspection endpoint.

Tiny read-only HTTP surface for operators / engineers to inspect the
ledger. NOT a public API, NOT a customer-facing surface, NOT a
dashboard. Pass 1 scope is debug visibility only.

NO POST endpoint — events enter the ledger via `runtime_ledger.emit()`
from inside business-logic code paths, not from external clients.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.identity_runtime import require_admin

from .events import EventType, Continuity, canonical_types
from .service import get_events, get_events_for_subject

router = APIRouter(prefix="/api/runtime-ledger", tags=["runtime-ledger"])


@router.get("/types")
async def list_canonical_types(_=Depends(require_admin())) -> dict:
    """Return the bounded list of canonical event-type values."""
    return {"types": canonical_types(), "count": len(canonical_types())}


@router.get("/events")
async def list_events(
    type: str | None = Query(default=None, description="filter by event type"),
    continuity: str | None = Query(default=None, description="filter by continuity branch"),
    subject_id: str | None = Query(default=None, description="filter by subject id"),
    limit: int = Query(default=100, ge=1, le=500),
    skip: int = Query(default=0, ge=0),
    _=Depends(require_admin()),
) -> dict:
    """Recent-first slice of the ledger, optionally filtered."""
    et: EventType | None = None
    if type is not None:
        try:
            et = EventType(type)
        except ValueError:
            raise HTTPException(
                status_code=400,
                detail=f"unknown type {type!r}. Allowed: {canonical_types()}",
            )
    if continuity is not None and continuity not in {c.value for c in Continuity}:
        raise HTTPException(
            status_code=400,
            detail=f"unknown continuity {continuity!r}",
        )
    events = await get_events(
        event_type=et,
        continuity=continuity,
        subject_id=subject_id,
        limit=limit,
        skip=skip,
    )
    return {"events": events, "count": len(events)}


@router.get("/events/by-subject/{subject_id}")
async def list_events_for_subject(
    subject_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    _=Depends(require_admin()),
) -> dict:
    """All events for one subject (request / job / report / verification)."""
    events = await get_events_for_subject(subject_id, limit=limit)
    return {"subjectId": subject_id, "events": events, "count": len(events)}
