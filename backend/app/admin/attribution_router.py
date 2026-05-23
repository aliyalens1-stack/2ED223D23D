"""P5.1 — Attribution Read Router.

READ-ONLY endpoints for the admin_audit_log evidence collection populated
by `app.core.attribution.record_admin_mutation`. The write side lives in
that module; this router only exposes queries.

Endpoints (all admin-only):
  GET /api/admin/attribution/by-actor/{actor_id}     — actor timeline
  GET /api/admin/attribution/by-entity/{entity_id}   — entity timeline
  GET /api/admin/attribution/recent                  — last N rows
"""
from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, Query

from app.core.db import get_db
from app.core.security import verify_admin_token


router = APIRouter(
    prefix="/api/admin/attribution",
    tags=["admin.attribution"],
    dependencies=[Depends(verify_admin_token)],
)


def _strip_id(doc):
    if doc:
        doc.pop("_id", None)
    return doc


@router.get("/by-actor/{actor_id}")
async def by_actor(
    actor_id: str,
    limit: int = Query(default=50, ge=1, le=500),
    db=Depends(get_db),
):
    """All audited mutations performed by the given actor, newest first."""
    cursor = db.admin_audit_log.find(
        {"actor.id": actor_id},
        {"_id": 0},
    ).sort([("at", -1)]).limit(limit)
    return {"actorId": actor_id, "rows": [doc async for doc in cursor]}


@router.get("/by-entity/{entity_id}")
async def by_entity(
    entity_id: str,
    limit: int = Query(default=100, ge=1, le=500),
    db=Depends(get_db),
):
    """All audited mutations targeting the given entity, newest first."""
    cursor = db.admin_audit_log.find(
        {"entityId": entity_id},
        {"_id": 0},
    ).sort([("at", -1)]).limit(limit)
    return {"entityId": entity_id, "rows": [doc async for doc in cursor]}


@router.get("/recent")
async def recent(
    domain: Optional[str] = Query(default=None),
    limit:  int           = Query(default=50, ge=1, le=500),
    db=Depends(get_db),
):
    """Most recent audited mutations, optionally filtered by domain."""
    q = {"domain": domain} if domain else {}
    cursor = db.admin_audit_log.find(q, {"_id": 0}).sort([("at", -1)]).limit(limit)
    return {"rows": [doc async for doc in cursor]}
