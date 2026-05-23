"""app.admin.router_workers — /api/admin/workers (supervisor visibility).

Phase 4 Sprint A: Q2 trigger fired (first operational debugging surface).
Admin-only endpoint exposing `worker_supervisor.status()`. NO mutation
surface — read-only. Single endpoint = +1 to OpenAPI count.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.security import verify_admin_token
from app.core.worker_supervisor import supervisor

router = APIRouter(
    prefix="/api/admin/workers",
    tags=["admin-workers"],
    dependencies=[Depends(verify_admin_token)],
)


@router.get("/")
async def list_workers():
    """Return live supervisor.status() for all registered workers."""
    workers = supervisor.status()
    return {
        "workers": workers if isinstance(workers, list) else [workers],
        "count": len(workers) if isinstance(workers, list) else 1,
    }
