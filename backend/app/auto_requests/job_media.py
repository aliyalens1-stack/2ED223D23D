"""Job-scoped media (Sprint 2 Step 3 rewrite).

Storage:
  Bytes:    MongoDB GridFS bucket `media` (via MediaRepository)
  Metadata: `inspection_media` collection (canonical Step 3 shape)

Endpoints:
  POST   /api/inspector/jobs/{job_id}/media          (legacy JSON+base64)
  POST   /api/inspector/jobs/{job_id}/media/upload   (multipart OR base64; canonical)
  GET    /api/inspector/jobs/{job_id}/media          (list, merges legacy collection)
  GET    /api/inspector/jobs/{job_id}/media/{mid}    (file bytes — GridFS first, base64 fallback)
  DELETE /api/inspector/jobs/{job_id}/media/{mid}

Per-spec required fields: `sectionKey`, `itemKey`, `severity`. Kept optional
to avoid breaking older mobile clients; new runtime should always pass them.
"""
from __future__ import annotations

import base64
import json
from datetime import datetime
from typing import Literal, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.auto_requests.auth import get_user_id_required
from app.core.db import get_db
from app.media.repository import get_media_repository, make_media_doc


CATEGORIES = {
    "exterior", "interior", "engine", "documents", "damage",
    "odometer", "vin", "test_drive", "other",
}

# Phase D Pass 1C — closed-enum mapping from operational uploader
# categories to canonical `EvidenceSegment` values. Categories not
# present here (damage, odometer, vin, other) are NOT continuity
# boundaries — they may co-occur within any segment and are
# intentionally invisible to the ledger. Adding a row is a doctrine
# decision; renaming/removing is forbidden (ledger is append-only).
_CATEGORY_TO_CONTINUITY_SEGMENT = {
    "exterior":   "exterior",
    "interior":   "cabin",
    "engine":     "mechanical",
    "test_drive": "roadtest",
    "documents":  "documentation",
}
ALLOWED_PHOTO_MIME = {"image/jpeg", "image/png", "image/webp", "image/heic"}
ALLOWED_VIDEO_MIME = {"video/mp4", "video/quicktime", "video/webm"}
PHOTO_MAX_BYTES = 8 * 1024 * 1024
VIDEO_MAX_BYTES = 25 * 1024 * 1024
ACTIVE_JOB_STATUSES = {"claimed", "on_route", "arrived", "inspecting"}


def _meta(doc: dict) -> dict:
    """Canonical response shape — never leaks raw bytes / base64."""
    mid = str(doc.get("id") or doc.get("_id"))
    job_id = doc.get("jobId")
    created = doc.get("createdAt")
    if isinstance(created, datetime):
        created = created.isoformat()
    return {
        "id": mid,
        "jobId": job_id,
        "reportId": doc.get("reportId"),
        "sectionKey": doc.get("sectionKey"),
        "itemKey": doc.get("itemKey"),
        "inspectorId": doc.get("inspectorId"),
        "customerId": doc.get("customerId"),
        "vehicleId": doc.get("vehicleId"),
        "mime": doc.get("mime") or doc.get("mimeType"),
        "mimeType": doc.get("mimeType") or doc.get("mime"),  # legacy alias
        "type": doc.get("type", "photo"),
        "category": doc.get("category"),
        "sizeBytes": int(doc.get("sizeBytes", 0)),
        "width": doc.get("width"),
        "height": doc.get("height"),
        "storage": doc.get("storage") or {"provider": "legacy_base64"},
        "status": doc.get("status", "uploaded"),
        "severity": doc.get("severity", "info"),
        "note": doc.get("note"),
        "url": f"/api/inspector/jobs/{job_id}/media/{mid}",
        "createdAt": created,
        "uploadedAt": (
            doc.get("uploadedAt").isoformat()
            if isinstance(doc.get("uploadedAt"), datetime) else doc.get("uploadedAt")
        ),
    }


router = APIRouter(prefix="/api/inspector/jobs", tags=["media:inspector_jobs"])
public_router = APIRouter(prefix="/api/inspector/jobs", tags=["media:inspector_jobs"])


# ─────────────────────────────────────────────────────────────────────
# Validators / helpers
# ─────────────────────────────────────────────────────────────────────
async def _load_job_and_check(db, job_id: str, uid: str) -> dict:
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    # Ownership: inspectorAccountId first, legacy inspectorId fallback
    acc = job.get("inspectorAccountId")
    legacy = job.get("inspectorId")
    if (acc and str(acc) != str(uid)) and (legacy and str(legacy) != str(uid)):
        raise HTTPException(403, "not your job")
    if not acc and not legacy:
        raise HTTPException(403, "job not claimed yet")
    if job.get("status") not in ACTIVE_JOB_STATUSES:
        raise HTTPException(409, f"job not in active lifecycle (status: {job.get('status')})")
    return job


def _validate_mime_and_size(media_type: str, mime: str, size: int) -> None:
    mime = mime.lower().strip()
    if media_type == "photo" and mime not in ALLOWED_PHOTO_MIME:
        raise HTTPException(400, f"photo mime not allowed: {mime}")
    if media_type == "video" and mime not in ALLOWED_VIDEO_MIME:
        raise HTTPException(400, f"video mime not allowed: {mime}")
    cap = PHOTO_MAX_BYTES if media_type == "photo" else VIDEO_MAX_BYTES
    if size > cap:
        raise HTTPException(413, f"file too large: {size} > {cap}")


async def _persist_and_emit(
    *,
    job: dict,
    inspector_id: str,
    data: bytes,
    mime: str,
    media_type: str,
    section_key: Optional[str],
    item_key: Optional[str],
    severity: str,
    category: Optional[str],
    note: Optional[str],
    width: Optional[int],
    height: Optional[int],
    customer_id: Optional[str],
) -> dict:
    """Single write path: build doc → save to repository → emit timeline."""
    meta = make_media_doc(
        job_id=str(job.get("_id")),
        inspector_id=inspector_id,
        mime=mime,
        size_bytes=len(data),
        section_key=section_key,
        item_key=item_key,
        severity=severity,
        media_type=media_type,
        category=category,
        note=note,
        width=width,
        height=height,
        request_id=job.get("requestId"),
        vehicle_id=job.get("vehicleId"),
        customer_id=customer_id,
    )

    repo = get_media_repository()
    saved = await repo.save(data=data, meta=meta)

    # Timeline fan-in (durable + idempotent via evt_media_<mediaId>)
    try:
        from app.inspector.timeline import append_event
        await append_event(
            kind="media_uploaded",
            job_id=str(job.get("_id")),
            vehicle_id=job.get("vehicleId"),
            inspector_id=inspector_id,
            customer_id=customer_id,
            actor_type="inspector",
            actor_id=inspector_id,
            severity=severity if severity != "info" else "info",
            text=f"{media_type} · {section_key or category or 'media'}/{item_key or '-'} · {round(len(data) / 1024)} KB",
            metadata={
                "mediaId": saved.get("id"),
                "sectionKey": section_key,
                "itemKey": item_key,
                "category": category,
                "type": media_type,
                "mime": mime,
                "sizeBytes": len(data),
                "requestId": job.get("requestId"),
            },
        )
    except Exception:
        pass

    # Phase D Pass 1C — evidence continuity widening.
    # Closed-enum mapping: only canonical continuity segments produce a
    # ledger event. Operational categories outside this map (damage,
    # odometer, vin, other, None) are NOT continuity boundaries — they
    # may co-occur within any segment and are intentionally invisible
    # to the ledger. Coalesce on (job_id, segment) → ONE event per
    # canonical segment, ever. 14 photo uploads in `exterior` → 1
    # event. Re-uploads / retries / deletes-then-reuploads do not
    # widen — the segment was already crossed.
    seg = _CATEGORY_TO_CONTINUITY_SEGMENT.get((category or "").lower().strip())
    if seg is not None:
        try:
            from app.runtime_ledger import emit, EventType
            await emit(
                EventType.EVIDENCE_CONTINUITY_WIDENED,
                subject_id=str(job.get("_id")),
                segment=seg,
                payload={},
                emitted_by=inspector_id,
            )
        except Exception as exc:
            import logging
            logging.getLogger(__name__).warning(
                f"runtime_ledger emit (evidence_widened, seg={seg}) failed "
                f"for job {job.get('_id')}: {exc}"
            )

    return saved


# ─────────────────────────────────────────────────────────────────────
# 1. Legacy JSON-base64 endpoint (kept for back-compat with old mobile)
# ─────────────────────────────────────────────────────────────────────
class JobMediaUpload(BaseModel):
    type: Literal["photo", "video"] = "photo"
    mimeType: str = Field(min_length=4, max_length=64)
    dataBase64: str = Field(min_length=10)
    category: Optional[str] = Field(default=None, min_length=2, max_length=24)
    # Canonical Step 3 fields — optional for legacy clients
    sectionKey: Optional[str] = Field(default=None, max_length=64)
    itemKey: Optional[str] = Field(default=None, max_length=64)
    severity: Optional[Literal["info", "warning", "critical"]] = "info"
    width: Optional[int] = None
    height: Optional[int] = None
    note: Optional[str] = Field(default=None, max_length=400)


@router.post("/{job_id}/media")
async def upload_job_media_json(
    job_id: str,
    payload: JobMediaUpload,
    uid: str = Depends(get_user_id_required),
):
    """Legacy JSON-base64 upload (back-compat). New clients should use /upload."""
    db = get_db()
    job = await _load_job_and_check(db, job_id, uid)

    cat = (payload.category or "").lower().strip() or None
    if cat and cat not in CATEGORIES:
        raise HTTPException(400, f"invalid category. allowed: {sorted(CATEGORIES)}")

    try:
        raw = base64.b64decode(payload.dataBase64, validate=True)
    except Exception:
        raise HTTPException(400, "invalid base64")

    mime = payload.mimeType
    _validate_mime_and_size(payload.type, mime, len(raw))

    customer_id = None
    if job.get("requestId"):
        try:
            req = await db.car_requests.find_one(
                {"_id": job["requestId"]}, {"_id": 0, "userId": 1}
            )
            customer_id = (req or {}).get("userId")
        except Exception:
            pass

    saved = await _persist_and_emit(
        job=job,
        inspector_id=uid,
        data=raw,
        mime=mime,
        media_type=payload.type,
        section_key=payload.sectionKey,
        item_key=payload.itemKey,
        severity=payload.severity or "info",
        category=cat,
        note=payload.note,
        width=payload.width,
        height=payload.height,
        customer_id=customer_id,
    )
    return {"status": "ok", "media": _meta(saved)}


# ─────────────────────────────────────────────────────────────────────
# 2. Canonical multipart endpoint (Step 3)
# ─────────────────────────────────────────────────────────────────────
@router.post("/{job_id}/media/upload")
async def upload_job_media_multipart(
    job_id: str,
    uid: str = Depends(get_user_id_required),
    file: Optional[UploadFile] = File(default=None),
    # Optional base64 fallback (multipart with no file but `dataBase64` field)
    dataBase64: Optional[str] = Form(default=None),
    mimeType: Optional[str] = Form(default=None),
    type: Literal["photo", "video"] = Form(default="photo"),
    sectionKey: Optional[str] = Form(default=None),
    itemKey: Optional[str] = Form(default=None),
    severity: Literal["info", "warning", "critical"] = Form(default="info"),
    category: Optional[str] = Form(default=None),
    note: Optional[str] = Form(default=None),
    width: Optional[int] = Form(default=None),
    height: Optional[int] = Form(default=None),
    metadata: Optional[str] = Form(default=None, description="JSON-encoded extra fields"),
):
    """Canonical Step 3 upload: multipart file OR base64 fallback.

    Required fields per spec: `sectionKey`, `itemKey`, `severity`. Severity has
    a default; sectionKey/itemKey are still optional here for forward-compat
    with non-item-bound uploads (e.g. VIN photo, odometer) but RECOMMENDED.
    """
    db = get_db()
    job = await _load_job_and_check(db, job_id, uid)

    # Resolve raw bytes + mime from either multipart or base64
    if file is not None:
        raw = await file.read()
        mime = (mimeType or file.content_type or "").lower()
        if not mime:
            raise HTTPException(400, "mimeType is required when content_type is missing")
    elif dataBase64:
        if not mimeType:
            raise HTTPException(400, "mimeType is required for base64 path")
        try:
            raw = base64.b64decode(dataBase64, validate=True)
        except Exception:
            raise HTTPException(400, "invalid base64")
        mime = mimeType.lower()
    else:
        raise HTTPException(400, "either `file` (multipart) or `dataBase64` is required")

    _validate_mime_and_size(type, mime, len(raw))

    cat = (category or "").lower().strip() or None
    if cat and cat not in CATEGORIES:
        raise HTTPException(400, f"invalid category. allowed: {sorted(CATEGORIES)}")

    try:
        extra_meta = json.loads(metadata) if metadata else {}
        if not isinstance(extra_meta, dict):
            raise ValueError
    except Exception:
        raise HTTPException(400, "metadata must be a JSON object string")

    customer_id = None
    if job.get("requestId"):
        try:
            req = await db.car_requests.find_one(
                {"_id": job["requestId"]}, {"_id": 0, "userId": 1}
            )
            customer_id = (req or {}).get("userId")
        except Exception:
            pass

    saved = await _persist_and_emit(
        job=job,
        inspector_id=uid,
        data=raw,
        mime=mime,
        media_type=type,
        section_key=sectionKey,
        item_key=itemKey,
        severity=severity,
        category=cat,
        note=note,
        width=width,
        height=height,
        customer_id=customer_id,
    )
    if extra_meta:
        saved["metadata"] = {**(saved.get("metadata") or {}), **extra_meta}
    return {"status": "ok", "media": _meta(saved)}


# ─────────────────────────────────────────────────────────────────────
# 3. List / get / delete
# ─────────────────────────────────────────────────────────────────────
@router.get("/{job_id}/media")
async def list_job_media(
    job_id: str,
    uid: str = Depends(get_user_id_required),
):
    """List all media for a job. Merges canonical (`inspection_media`) and
    legacy (`inspection_job_media`) collections during the transition."""
    db = get_db()
    job = await db.inspection_jobs.find_one({"_id": job_id})
    if not job:
        raise HTTPException(404, "job not found")
    acc = job.get("inspectorAccountId")
    legacy = job.get("inspectorId")
    if (acc and str(acc) != str(uid)) and (legacy and str(legacy) != str(uid)):
        raise HTTPException(403, "not your job")

    items = []
    by_category: dict[str, int] = {}
    by_item: dict[str, int] = {}
    by_section: dict[str, int] = {}
    photos = videos = 0

    # Canonical store
    repo = get_media_repository()
    canonical = await repo.list_for_job(job_id)
    for doc in canonical:
        items.append(_meta(doc))
        if doc.get("category"):
            by_category[doc["category"]] = by_category.get(doc["category"], 0) + 1
        if doc.get("sectionKey"):
            by_section[doc["sectionKey"]] = by_section.get(doc["sectionKey"], 0) + 1
        if doc.get("sectionKey") and doc.get("itemKey"):
            key = f"{doc['sectionKey']}/{doc['itemKey']}"
            by_item[key] = by_item.get(key, 0) + 1
        if doc.get("type") == "photo":
            photos += 1
        elif doc.get("type") == "video":
            videos += 1

    # Legacy back-compat (Sprint 6 collection)
    seen_ids = {it["id"] for it in items}
    legacy_cur = db.inspection_job_media.find(
        {"jobId": job_id},
        {"dataBase64": 0},
    ).sort("createdAt", -1)
    async for doc in legacy_cur:
        mid = str(doc.get("_id"))
        if mid in seen_ids:
            continue
        items.append(_meta({**doc, "id": mid}))
        if doc.get("category"):
            by_category[doc["category"]] = by_category.get(doc["category"], 0) + 1
        if doc.get("type") == "photo":
            photos += 1
        elif doc.get("type") == "video":
            videos += 1

    # Sort merged result by createdAt desc (best-effort; both branches arrive
    # pre-sorted so this only re-sorts the merged tail).
    items.sort(key=lambda x: x.get("createdAt") or "", reverse=True)

    return {
        "items": items,
        "stats": {
            "total": len(items),
            "photos": photos,
            "videos": videos,
            "byCategory": by_category,
            "bySection": by_section,
            "byItem": by_item,
        },
    }


@router.delete("/{job_id}/media/{media_id}")
async def delete_job_media(
    job_id: str,
    media_id: str,
    uid: str = Depends(get_user_id_required),
):
    db = get_db()
    job = await db.inspection_jobs.find_one(
        {"_id": job_id}, {"inspectorAccountId": 1, "inspectorId": 1}
    )
    if not job:
        raise HTTPException(404, "job not found")
    if (job.get("inspectorAccountId") and str(job["inspectorAccountId"]) != str(uid)) \
       and (job.get("inspectorId") and str(job["inspectorId"]) != str(uid)):
        raise HTTPException(403, "not your job")

    # Try canonical store first
    repo = get_media_repository()
    canonical_meta = await db.inspection_media.find_one(
        {"_id": media_id, "jobId": job_id}, {"_id": 1}
    )
    if canonical_meta:
        ok = await repo.delete(media_id)
        if ok:
            return {"status": "ok"}

    # Legacy collection
    res = await db.inspection_job_media.delete_one(
        {"_id": media_id, "jobId": job_id, "inspectorId": uid}
    )
    if res.deleted_count == 0:
        raise HTTPException(404, "media not found or not yours")
    return {"status": "ok"}


@public_router.get("/{job_id}/media/{media_id}")
async def get_job_media_blob(job_id: str, media_id: str):
    """Serve media bytes — GridFS first, base64 legacy fallback."""
    # Canonical via repository (handles GridFS + legacy base64)
    repo = get_media_repository()
    data, meta = await repo.get(media_id)
    if data and meta and meta.get("jobId") == job_id:
        mime = meta.get("mime") or meta.get("mimeType") or "application/octet-stream"
        return Response(content=data, media_type=mime)

    # Legacy `inspection_job_media` collection
    db = get_db()
    doc = await db.inspection_job_media.find_one({"_id": media_id, "jobId": job_id})
    if doc and doc.get("dataBase64"):
        raw = base64.b64decode(doc["dataBase64"])
        return Response(
            content=raw,
            media_type=doc.get("mimeType", "application/octet-stream"),
        )

    raise HTTPException(404, "not found")


__all__ = ["router", "public_router"]
