"""Sprint 5 · Inspection Media (photos/videos for reports).

Storage: base64 in Mongo (v1). Acceptable for preview/MVP (limits: 8 MB photo,
20 MB video). Upgrade path to S3/presigned URL later — service interface stays.

Authorization:
  • Inspector who owns the report can upload/delete media (only while report.status='submitted').
  • Customer who owns parent request can read media of approved/submitted reports.
  • Admin reads everything.
"""
from __future__ import annotations
import base64
import logging
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Tuple

from app.core.db import get_db

logger = logging.getLogger(__name__)

PHOTO_MAX_BYTES = 8 * 1024 * 1024     # 8 MB
VIDEO_MAX_BYTES = 25 * 1024 * 1024    # 25 MB
ALLOWED_PHOTO_MIME = {"image/jpeg", "image/png", "image/webp", "image/heic"}
ALLOWED_VIDEO_MIME = {"video/mp4", "video/quicktime", "video/webm"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _media_to_meta(doc: dict) -> dict:
    """Public metadata (no base64 payload)."""
    return {
        "id": str(doc["_id"]),
        "reportId": doc.get("reportId"),
        "type": doc.get("type"),
        "mimeType": doc.get("mimeType"),
        "sizeBytes": int(doc.get("sizeBytes", 0)),
        "url": f"/api/media/{doc['_id']}",
        "createdAt": (doc.get("createdAt").isoformat()
                      if isinstance(doc.get("createdAt"), datetime) else doc.get("createdAt")),
    }


# ─────────────────────────────────────────────────────────────────────
# Upload
# ─────────────────────────────────────────────────────────────────────

async def upload_media(
    report_id: str,
    inspector_id: str,
    media_type: str,
    data_base64: str,
    mime_type: str,
) -> Tuple[Optional[dict], Optional[str]]:
    """Upload one photo/video tied to a report. Returns (meta, error)."""
    if media_type not in ("photo", "video"):
        return None, "invalid_type"
    if media_type == "photo" and mime_type not in ALLOWED_PHOTO_MIME:
        return None, f"invalid_mime:{mime_type}"
    if media_type == "video" and mime_type not in ALLOWED_VIDEO_MIME:
        return None, f"invalid_mime:{mime_type}"

    db = get_db()
    rep = await db.inspection_reports.find_one({"_id": report_id})
    if not rep:
        return None, "report_not_found"
    if rep.get("inspectorId") != inspector_id:
        return None, "not_your_report"
    if rep.get("status") not in ("submitted",):
        # Approved/rejected reports are frozen for the inspector.
        return None, f"report_locked:{rep.get('status')}"

    # Decode/validate size
    payload = data_base64.split(",", 1)[1] if data_base64.startswith("data:") else data_base64
    try:
        raw = base64.b64decode(payload, validate=False)
    except Exception:
        return None, "invalid_base64"
    size = len(raw)
    cap = PHOTO_MAX_BYTES if media_type == "photo" else VIDEO_MAX_BYTES
    if size > cap:
        return None, f"too_large:{size}>{cap}"

    media_id = str(uuid.uuid4())
    doc = {
        "_id": media_id,
        "reportId": report_id,
        "inspectorId": inspector_id,
        "type": media_type,
        "mimeType": mime_type,
        "sizeBytes": size,
        "dataBase64": payload,            # without data: prefix
        "createdAt": _now(),
    }
    await db.inspection_media.insert_one(doc)
    return _media_to_meta(doc), None


# ─────────────────────────────────────────────────────────────────────
# List / Get / Delete
# ─────────────────────────────────────────────────────────────────────

async def list_for_report(report_id: str) -> List[dict]:
    db = get_db()
    cursor = db.inspection_media.find(
        {"reportId": report_id},
        {"dataBase64": 0},  # never include payload in listings
    ).sort("createdAt", 1)
    docs = await cursor.to_list(200)
    return [_media_to_meta(d) for d in docs]


async def fetch_payload(media_id: str) -> Optional[Tuple[bytes, str]]:
    """Return (raw_bytes, mime_type) for inline serving."""
    db = get_db()
    doc = await db.inspection_media.find_one({"_id": media_id}, {"dataBase64": 1, "mimeType": 1})
    if not doc:
        return None
    try:
        raw = base64.b64decode(doc["dataBase64"])
    except Exception:
        return None
    return raw, doc.get("mimeType", "application/octet-stream")


async def delete_media(media_id: str, inspector_id: str) -> Tuple[bool, Optional[str]]:
    db = get_db()
    doc = await db.inspection_media.find_one({"_id": media_id}, {"reportId": 1, "inspectorId": 1})
    if not doc:
        return False, "media_not_found"
    if doc.get("inspectorId") != inspector_id:
        return False, "not_your_media"
    rep = await db.inspection_reports.find_one({"_id": doc["reportId"]}, {"status": 1})
    if rep and rep.get("status") not in ("submitted",):
        return False, f"report_locked:{rep.get('status')}"
    await db.inspection_media.delete_one({"_id": media_id})
    return True, None


# ─────────────────────────────────────────────────────────────────────
# Authorization helpers
# ─────────────────────────────────────────────────────────────────────

async def can_user_view_media(media_id: str, user_id: str, is_admin: bool = False) -> bool:
    if is_admin:
        return True
    db = get_db()
    doc = await db.inspection_media.find_one({"_id": media_id}, {"reportId": 1, "inspectorId": 1})
    if not doc:
        return False
    if doc.get("inspectorId") == user_id:
        return True
    rep = await db.inspection_reports.find_one({"_id": doc["reportId"]}, {"requestId": 1})
    if not rep:
        return False
    req = await db.car_requests.find_one({"_id": rep["requestId"]}, {"userId": 1})
    return bool(req and req.get("userId") == user_id)
