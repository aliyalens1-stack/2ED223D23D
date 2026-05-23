"""car_selection_thread — customer router (thread + artifacts).

  Thread (Car-Selection-4):
    GET  /api/car-selection/requests/{id}/thread
    POST /api/car-selection/requests/{id}/thread

  Artifacts (Car-Selection-5):
    POST /api/car-selection/requests/{id}/artifacts
    GET  /api/car-selection/requests/{id}/artifacts/{artifact_id}

Same access discipline as the customer-side parent router:
404 on requests that don't belong to the caller. This is the
single chokepoint that prevents customers from enumerating
other customers' threads via thread-id guessing — the thread
collection itself never has a direct route by message id.
"""
from __future__ import annotations
from typing import Annotated

from fastapi import APIRouter, Depends, File, Form, UploadFile
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
    prefix="/api/car-selection/requests",
    tags=["car-selection:thread:customer"],
)

SURFACE = "customer"


def _customer_gate():
    return require_account_kind("customer")


# ── Thread ────────────────────────────────────────────────────────────


@router.get("/{request_id}/thread")
async def customer_list_thread(
    request_id: str,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
):
    repo = ThreadRepository(get_db())
    await repo.fetch_for(request_id, actor_id=ctx.user_id, actor_role="customer")
    items = await repo.list_messages(request_id)
    return {"items": items, "total": len(items)}


@router.post("/{request_id}/thread")
async def customer_append_thread(
    request_id: str,
    body: MessageIn,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
):
    db = get_db()
    repo = ThreadRepository(db)
    req = await repo.fetch_for(request_id, actor_id=ctx.user_id, actor_role="customer")
    # Resolve attachment ids server-side. Refuses cross-request smuggling.
    artifacts = ArtifactRepository(db)
    resolved = await resolve_attachment_ids(
        artifacts, request_id=request_id, ids=body.attachmentIds, surface=SURFACE,
    )
    return await repo.append_message(
        req, body=body, author_id=ctx.user_id, author_role="customer",
        resolved_attachments=resolved,
    )


# ── Artifacts ─────────────────────────────────────────────────────────


@router.post("/{request_id}/artifacts")
async def customer_upload_artifact(
    request_id: str,
    kind: Annotated[str, Form()],
    file: Annotated[UploadFile, File()],
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
):
    db = get_db()
    # Access gate FIRST — never accept bytes for a request the caller
    # has no business uploading to.
    threads = ThreadRepository(db)
    await threads.fetch_for(request_id, actor_id=ctx.user_id, actor_role="customer")
    artifacts = ArtifactRepository(db)
    return await artifacts.create(
        request_id=request_id, kind=kind, upload=file,
        author_id=ctx.user_id, author_role="customer", surface=SURFACE,
    )


@router.get("/{request_id}/artifacts/{artifact_id}")
async def customer_get_artifact(
    request_id: str,
    artifact_id: str,
    ctx: IdentityContext = Depends(_customer_gate()),  # noqa: B008
):
    db = get_db()
    threads = ThreadRepository(db)
    await threads.fetch_for(request_id, actor_id=ctx.user_id, actor_role="customer")
    artifacts = ArtifactRepository(db)
    meta = await artifacts.get_for_request(artifact_id, request_id)
    if not meta:
        from fastapi import HTTPException
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
