"""MediaRepository abstraction (Sprint 2 Step 3).

v1 backing store: MongoDB GridFS.
v2 (planned): S3 / Cloudflare R2.

All callers (job_media, report_media, vehicle_media) MUST go through this
repository — never write `dataBase64` into BSON documents from runtime paths.

Metadata lives in `inspection_media` (canonical collection per Step 3 spec).
We keep the legacy `inspection_job_media` collection for backward-compat
reads via `JobMediaRepository.list_legacy`.
"""
from __future__ import annotations

import uuid
from abc import ABC, abstractmethod
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Tuple

from motor.motor_asyncio import AsyncIOMotorGridFSBucket

from app.core.db import get_db


# ─────────────────────────────────────────────────────────────────────
# Doc shape (canonical per Step 3 spec)
# ─────────────────────────────────────────────────────────────────────
def make_media_doc(
    *,
    job_id: str,
    inspector_id: str,
    mime: str,
    size_bytes: int,
    section_key: Optional[str] = None,
    item_key: Optional[str] = None,
    severity: str = "info",
    width: Optional[int] = None,
    height: Optional[int] = None,
    storage_provider: str = "gridfs",
    storage_file_id: Optional[str] = None,
    report_id: Optional[str] = None,
    customer_id: Optional[str] = None,
    vehicle_id: Optional[str] = None,
    metadata: Optional[Dict[str, Any]] = None,
    category: Optional[str] = None,
    note: Optional[str] = None,
    media_type: str = "photo",  # photo | video
    request_id: Optional[str] = None,
) -> Dict[str, Any]:
    """Build the canonical inspection_media document.

    `category` is kept for legacy compatibility (Sprint 6 shape). New
    runtime should use `sectionKey + itemKey`. We populate both so old
    consumers keep working during the transition window.
    """
    mid = f"med_{uuid.uuid4().hex[:24]}"
    now = datetime.now(timezone.utc)
    sev = severity if severity in {"info", "warning", "critical"} else "info"
    return {
        "_id": mid,
        "id": mid,
        "jobId": job_id,
        "reportId": report_id,
        "requestId": request_id,
        "sectionKey": section_key,
        "itemKey": item_key,
        "inspectorId": inspector_id,
        "customerId": customer_id,
        "vehicleId": vehicle_id,
        "mime": mime.lower(),
        "mimeType": mime.lower(),  # legacy alias kept
        "type": media_type,        # legacy alias kept
        "category": category,      # legacy alias kept
        "sizeBytes": int(size_bytes),
        "width": width,
        "height": height,
        "storage": {
            "provider": storage_provider,
            "fileId": storage_file_id,
        },
        "status": "uploaded",
        "severity": sev,
        "note": note,
        "createdAt": now,
        "uploadedAt": now,
        "metadata": metadata or {},
    }


# ─────────────────────────────────────────────────────────────────────
# Abstract interface
# ─────────────────────────────────────────────────────────────────────
class MediaRepository(ABC):
    """Storage-agnostic media interface."""

    @abstractmethod
    async def save(
        self,
        *,
        data: bytes,
        meta: Dict[str, Any],
    ) -> Dict[str, Any]:
        """Persist bytes + metadata. Returns the meta doc (with storage info)."""

    @abstractmethod
    async def get(self, media_id: str) -> Tuple[Optional[bytes], Optional[Dict[str, Any]]]:
        """Return (bytes, meta) or (None, None) if not found."""

    @abstractmethod
    async def delete(self, media_id: str) -> bool:
        """Delete bytes + metadata. Returns True iff something was deleted."""

    @abstractmethod
    async def list_for_job(self, job_id: str) -> List[Dict[str, Any]]:
        """Return all meta docs for a job, newest first."""


# ─────────────────────────────────────────────────────────────────────
# v1 — GridFS implementation
# ─────────────────────────────────────────────────────────────────────
class GridFSMediaRepository(MediaRepository):
    """MongoDB GridFS backing store.

    - Bytes:    `media.files` / `media.chunks` (GridFS bucket name = "media")
    - Metadata: `inspection_media`
    """

    _bucket_name = "media"
    _collection = "inspection_media"

    def _bucket(self) -> AsyncIOMotorGridFSBucket:
        db = get_db()
        return AsyncIOMotorGridFSBucket(db, bucket_name=self._bucket_name)

    def _meta_collection(self):
        return get_db()[self._collection]

    async def save(self, *, data: bytes, meta: Dict[str, Any]) -> Dict[str, Any]:
        """Upload bytes to GridFS, store metadata."""
        bucket = self._bucket()
        media_id = meta["_id"]
        # Upload to GridFS — use media_id as the GridFS file metadata key
        file_id = await bucket.upload_from_stream(
            filename=media_id,
            source=data,
            metadata={
                "mediaId": media_id,
                "jobId": meta.get("jobId"),
                "mime": meta.get("mime"),
            },
        )
        meta["storage"] = {
            "provider": "gridfs",
            "fileId": str(file_id),
            "bucket": self._bucket_name,
        }
        meta["sizeBytes"] = int(len(data))
        await self._meta_collection().insert_one(meta)
        # Build a return doc without _id and without dataBase64 keys
        out = {k: v for k, v in meta.items() if k not in {"_id"}}
        return out

    async def get(self, media_id: str) -> Tuple[Optional[bytes], Optional[Dict[str, Any]]]:
        doc = await self._meta_collection().find_one({"_id": media_id})
        if not doc:
            return None, None

        # Try GridFS first
        file_id_str = (doc.get("storage") or {}).get("fileId")
        if file_id_str:
            try:
                from bson import ObjectId
                file_id = ObjectId(file_id_str)
                bucket = self._bucket()
                stream = await bucket.open_download_stream(file_id)
                data = await stream.read()
                doc.pop("_id", None)
                return data, doc
            except Exception:
                pass  # fall through to legacy

        # Legacy fallback — older docs persisted base64 inline
        b64 = doc.get("dataBase64")
        if b64:
            import base64 as _b64
            try:
                data = _b64.b64decode(b64)
                doc.pop("_id", None)
                doc.pop("dataBase64", None)
                return data, doc
            except Exception:
                return None, None

        return None, None

    async def delete(self, media_id: str) -> bool:
        doc = await self._meta_collection().find_one({"_id": media_id})
        if not doc:
            return False
        # Best-effort GridFS delete
        file_id_str = (doc.get("storage") or {}).get("fileId")
        if file_id_str:
            try:
                from bson import ObjectId
                await self._bucket().delete(ObjectId(file_id_str))
            except Exception:
                pass
        res = await self._meta_collection().delete_one({"_id": media_id})
        return res.deleted_count > 0

    async def list_for_job(self, job_id: str) -> List[Dict[str, Any]]:
        cur = (
            self._meta_collection()
            .find({"jobId": job_id, "status": "uploaded"})
            .sort("createdAt", -1)
        )
        out: List[Dict[str, Any]] = []
        async for d in cur:
            d.pop("_id", None)
            d.pop("dataBase64", None)  # never leak base64 in lists
            out.append(d)
        return out


# ─────────────────────────────────────────────────────────────────────
# Process-wide singleton (cheap to recreate but avoid extra GridFSBucket churn)
# ─────────────────────────────────────────────────────────────────────
_repository: Optional[MediaRepository] = None


def get_media_repository() -> MediaRepository:
    global _repository
    if _repository is None:
        _repository = GridFSMediaRepository()
    return _repository


async def ensure_media_indexes() -> None:
    """Idempotent indexes for the canonical metadata collection."""
    db = get_db()
    try:
        await db.inspection_media.create_index([("jobId", 1), ("createdAt", -1)])
        await db.inspection_media.create_index([("jobId", 1), ("sectionKey", 1), ("itemKey", 1)])
        await db.inspection_media.create_index([("inspectorId", 1), ("createdAt", -1)])
        await db.inspection_media.create_index([("reportId", 1), ("createdAt", -1)], sparse=True)
        await db.inspection_media.create_index([("vehicleId", 1), ("createdAt", -1)], sparse=True)
        await db.inspection_media.create_index([("status", 1)])
    except Exception:
        import logging
        logging.getLogger("server").warning("media indexes ensure failed", exc_info=True)


__all__ = [
    "MediaRepository",
    "GridFSMediaRepository",
    "get_media_repository",
    "make_media_doc",
    "ensure_media_indexes",
]
