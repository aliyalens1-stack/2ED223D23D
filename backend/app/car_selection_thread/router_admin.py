"""car_selection_thread — admin router (thread + artifacts).

  Thread (Car-Selection-4):
    GET  /api/admin/car-selection/{id}/thread
    POST /api/admin/car-selection/{id}/thread

  Artifacts (Car-Selection-5):
    POST /api/admin/car-selection/{id}/artifacts
    GET  /api/admin/car-selection/{id}/artifacts/{artifact_id}

Admin has unrestricted access to every thread but their messages
still ride the same append-only collection and the same notification
projection rules (customer + provider receive admin messages).
"""
from __future__ import annotations
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from app.core.db import get_db
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.car_selection_thread.models import MessageIn
from app.car_selection_thread.repository import ThreadRepository
from app.car_selection_thread.artifacts import (
    ArtifactRepository,
    resolve_attachment_ids,
)


router = APIRouter(
    prefix="/api/admin/car-selection",
    tags=["car-selection:thread:admin"],
)

SURFACE = "admin"


def _admin_gate():
    return require_account_kind("admin")


# ── Observability ─────────────────────────────────────────────────────
#
# Static path REGISTERED FIRST so FastAPI matches `/artifacts/stats`
# before falling through to the `/{request_id}/...` patterns below.
# (Order of route registration matters; literal segments beat path
# params, but ordering also keeps the intent obvious.)


@router.get("/artifacts/stats")
async def admin_artifact_stats(
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
):
    """Cheap aggregate over `car_selection_artifacts` metadata.

    Shape is locked — every declared kind is always present, even
    when its row count is zero. This keeps the admin panel from
    having to special-case empty buckets.
    """
    artifacts = ArtifactRepository(get_db())
    return await artifacts.stats()


# ── Thread ────────────────────────────────────────────────────────────


@router.get("/{request_id}/thread")
async def admin_list_thread(
    request_id: str,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
):
    repo = ThreadRepository(get_db())
    await repo.fetch_for(request_id, actor_id=ctx.user_id, actor_role="admin")
    items = await repo.list_messages(request_id)
    return {"items": items, "total": len(items)}


@router.post("/{request_id}/thread")
async def admin_append_thread(
    request_id: str,
    body: MessageIn,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
):
    db = get_db()
    repo = ThreadRepository(db)
    req = await repo.fetch_for(request_id, actor_id=ctx.user_id, actor_role="admin")
    artifacts = ArtifactRepository(db)
    resolved = await resolve_attachment_ids(
        artifacts, request_id=request_id, ids=body.attachmentIds, surface=SURFACE,
    )
    return await repo.append_message(
        req, body=body, author_id=ctx.user_id, author_role="admin",
        resolved_attachments=resolved,
    )


# ── Artifacts ─────────────────────────────────────────────────────────


@router.post("/{request_id}/artifacts")
async def admin_upload_artifact(
    request_id: str,
    kind: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
):
    db = get_db()
    threads = ThreadRepository(db)
    await threads.fetch_for(request_id, actor_id=ctx.user_id, actor_role="admin")
    artifacts = ArtifactRepository(db)
    return await artifacts.create(
        request_id=request_id, kind=kind, upload=file,
        author_id=ctx.user_id, author_role="admin", surface=SURFACE,
    )


@router.get("/{request_id}/artifacts/{artifact_id}")
async def admin_get_artifact(
    request_id: str,
    artifact_id: str,
    ctx: IdentityContext = Depends(_admin_gate()),  # noqa: B008
):
    db = get_db()
    threads = ThreadRepository(db)
    await threads.fetch_for(request_id, actor_id=ctx.user_id, actor_role="admin")
    artifacts = ArtifactRepository(db)
    meta = await artifacts.get_for_request(artifact_id, request_id)
    if not meta:
        raise HTTPException(
            404, detail={
                "error": True, "code": "ARTIFACT_NOT_FOUND",
                "message": f"artifact {artifact_id!r} not found",
                "details": {"artifactId": artifact_id, "requestId": request_id},
            },
        )
    _, stream = await artifacts.open_stream(artifact_id)
    return StreamingResponse(
        stream,
        media_type=meta["mimeType"],
        headers={"Content-Disposition": f'inline; filename="{meta["filename"]}"'},
    )


__all__ = ["router"]
