"""Unified notifications inbox for car_selection_thread.

Single endpoint group serves all three roles. The recipient identity
is derived from the caller's account kind:

  - admin  → reads notifications addressed to the admin sentinel
             (`__admin__`) — a flat backlog of every fan-out for any
             request, since admins don't have a 1:1 user/request map.
  - others → reads notifications where `recipientId == ctx.user_id`.

Endpoints:

  GET  /api/car-selection/notifications/me
  POST /api/car-selection/notifications/me/read
"""
from __future__ import annotations
from typing import Annotated

from fastapi import APIRouter, Depends, Query, HTTPException
from pydantic import BaseModel

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, decode_and_resolve
from app.car_selection_thread.models import MarkReadIn
from app.car_selection_thread.repository import ThreadRepository, ADMIN_SENTINEL


router = APIRouter(
    prefix="/api/car-selection/notifications",
    tags=["car-selection:thread:inbox"],
)


def _resolve_recipient(ctx: IdentityContext) -> str:
    """Map ctx → inbox key. Admins read a shared sentinel queue."""
    primary_kind = ctx.account.kind if ctx.account else None
    if primary_kind == "admin":
        return ADMIN_SENTINEL
    return ctx.user_id


@router.get("/me")
async def list_my_notifications(
    ctx: IdentityContext = Depends(decode_and_resolve),
    limit: Annotated[int, Query(ge=1, le=200)] = 50,
    unread_only: bool = False,
):
    rid = _resolve_recipient(ctx)
    repo = ThreadRepository(get_db())
    return await repo.list_notifications(rid, limit=limit, unread_only=unread_only)


@router.post("/me/read")
async def mark_my_notifications_read(
    body: MarkReadIn,
    ctx: IdentityContext = Depends(decode_and_resolve),
):
    if not body.all and not body.ids:
        raise HTTPException(
            status_code=400,
            detail={
                "error": True,
                "code": "BAD_REQUEST",
                "message": "either `ids` or `all=true` must be provided",
                "details": {},
            },
        )
    rid = _resolve_recipient(ctx)
    repo = ThreadRepository(get_db())
    modified = await repo.mark_read(rid, ids=body.ids, all_unread=body.all)
    return {"modified": modified}


__all__ = ["router"]
