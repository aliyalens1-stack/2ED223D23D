"""Sprint 5 · Inspection Media — HTTP endpoints.

POST   /api/inspector/reports/{id}/upload      multipart or base64 JSON
GET    /api/inspector/reports/{id}/media        list (inspector only)
DELETE /api/inspector/media/{id}                inspector deletes own media
GET    /api/customer/reports/{id}/media         customer list (own request only)
GET    /api/media/{id}                          serve raw bytes (auth-aware)
"""
from __future__ import annotations
from typing import Optional, Literal

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
import base64

from app.auto_requests import media as media_svc
from app.auto_requests.auth import (
    get_user_id_required,
    get_user_id_optional,
    get_user_kind_optional,
)
from app.core.security import verify_admin_token
from app.core.db import get_db


# ─────────────────────────────────────────────────────────────────────
# Inspector endpoints
# ─────────────────────────────────────────────────────────────────────

inspector_media_router = APIRouter(prefix="/api/inspector", tags=["media:inspector"])


class UploadBase64(BaseModel):
    type: Literal["photo", "video"]
    mimeType: str = Field(min_length=4, max_length=64)
    dataBase64: str = Field(min_length=10)


@inspector_media_router.post("/reports/{report_id}/upload")
async def upload_media_endpoint(
    report_id: str,
    request: Request,
    uid: str = Depends(get_user_id_required),
):
    """Accepts either multipart/form-data (file=...) OR JSON {type,mimeType,dataBase64}."""
    ct = (request.headers.get("content-type") or "").lower()
    media_type: Optional[str] = None
    mime: Optional[str] = None
    data_b64: Optional[str] = None

    if ct.startswith("multipart/form-data"):
        form = await request.form()
        upload: Optional[UploadFile] = form.get("file")  # type: ignore
        if not upload:
            raise HTTPException(400, "file field required")
        # type: photo|video — derive from form or mime
        form_type = (form.get("type") or "").strip()
        mime = (upload.content_type or form.get("mimeType") or "").lower()
        if form_type in ("photo", "video"):
            media_type = form_type
        elif mime.startswith("image/"):
            media_type = "photo"
        elif mime.startswith("video/"):
            media_type = "video"
        else:
            raise HTTPException(400, "unable to determine media type")
        raw = await upload.read()
        data_b64 = base64.b64encode(raw).decode("ascii")
    else:
        try:
            payload = await request.json()
            body = UploadBase64(**payload)
            media_type, mime, data_b64 = body.type, body.mimeType.lower(), body.dataBase64
        except Exception as exc:
            raise HTTPException(400, f"invalid body: {exc}")

    meta, err = await media_svc.upload_media(
        report_id=report_id, inspector_id=uid,
        media_type=media_type, data_base64=data_b64, mime_type=mime,
    )
    if err == "report_not_found":
        raise HTTPException(404, "report not found")
    if err == "not_your_report":
        raise HTTPException(403, "not your report")
    if err and err.startswith("report_locked"):
        raise HTTPException(409, f"report is {err.split(':',1)[1]} — media locked")
    if err and err.startswith("invalid_mime"):
        raise HTTPException(400, f"unsupported mime type: {err.split(':',1)[1]}")
    if err == "invalid_type":
        raise HTTPException(400, "type must be photo or video")
    if err == "invalid_base64":
        raise HTTPException(400, "invalid base64 payload")
    if err and err.startswith("too_large"):
        raise HTTPException(413, f"file too large: {err}")
    if err:
        raise HTTPException(400, err)
    return {"status": "ok", "media": meta}


@inspector_media_router.get("/reports/{report_id}/media")
async def inspector_list_media(report_id: str, uid: str = Depends(get_user_id_required)):
    db = get_db()
    rep = await db.inspection_reports.find_one({"_id": report_id}, {"inspectorId": 1})
    if not rep:
        raise HTTPException(404, "report not found")
    if rep.get("inspectorId") != uid:
        raise HTTPException(403, "not your report")
    items = await media_svc.list_for_report(report_id)
    return {"items": items, "count": len(items)}


@inspector_media_router.delete("/media/{media_id}")
async def inspector_delete_media(media_id: str, uid: str = Depends(get_user_id_required)):
    ok, err = await media_svc.delete_media(media_id, uid)
    if err == "media_not_found":
        raise HTTPException(404, "media not found")
    if err == "not_your_media":
        raise HTTPException(403, "not your media")
    if err and err.startswith("report_locked"):
        raise HTTPException(409, err)
    return {"status": "ok"}


# ─────────────────────────────────────────────────────────────────────
# Customer media listing
# ─────────────────────────────────────────────────────────────────────

customer_media_router = APIRouter(prefix="/api/customer", tags=["media:customer"])


@customer_media_router.get("/reports/{report_id}/media")
async def customer_list_media(report_id: str, uid: str = Depends(get_user_id_required)):
    db = get_db()
    rep = await db.inspection_reports.find_one({"_id": report_id}, {"requestId": 1})
    if not rep:
        raise HTTPException(404, "report not found")
    req = await db.car_requests.find_one({"_id": rep["requestId"]}, {"userId": 1})
    if not req or req.get("userId") != uid:
        raise HTTPException(403, "not your report")
    items = await media_svc.list_for_report(report_id)
    return {"items": items, "count": len(items)}


# ─────────────────────────────────────────────────────────────────────
# Public bytes serving (auth-aware via header OR media token)
# ─────────────────────────────────────────────────────────────────────

public_media_router = APIRouter(prefix="/api/media", tags=["media"])


@public_media_router.get("/{media_id}")
async def serve_media(
    media_id: str,
    uid: Optional[str] = Depends(get_user_id_optional),
    kind: Optional[str] = Depends(get_user_kind_optional),
):
    """Serve raw bytes. Authorize: must be admin, owning inspector, or owning customer.

    For the v1 image gallery in mobile/web, clients pass JWT Authorization header
    via fetch+blob. Browser <img> tags can't easily attach a header, so we also
    accept calls when running inside our authenticated origin via cookies (TODO v2).
    """
    if not uid:
        raise HTTPException(401, "auth required")
    # Sprint 1D.3: admin-check moved off `users.role` lookup → JWT `kind`
    # claim (set by 1C `issue_account_jwt`). Single source of truth, and
    # respects account-switching once 1E ships.
    is_admin = (kind == "admin")
    if not await media_svc.can_user_view_media(media_id, uid, is_admin=is_admin):
        raise HTTPException(403, "forbidden")
    res = await media_svc.fetch_payload(media_id)
    if not res:
        raise HTTPException(404, "media not found")
    raw, mime = res
    return Response(content=raw, media_type=mime, headers={"Cache-Control": "private, max-age=3600"})
