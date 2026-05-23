"""Append-only artifacts for car_selection_thread.

Car-Selection-5 introduces immutable evidence / offer artifacts that
can be attached to messages — PDF shortlists, screenshots, listing
exports, photos / docs about a found car.

Architectural discipline:

  - Artifact upload is its OWN operation. It does NOT mutate
    lifecycle, does NOT create a fake message, does NOT touch the
    parent request document.

  - Artifacts are forensic-safe: there are NO update / delete paths
    in this module. Metadata + blob are both immutable.

  - Message append (in repository.py) may reference artifactIds.
    Every referenced id is server-side resolved against the SAME
    requestId before the message is persisted; cross-request smuggling
    returns 400.

  - Permissions mirror the thread surface exactly:
        customer → own request
        provider → assigned only
        admin    → all
    Foreign requests return 404 (existence privacy).

Storage:

  - Metadata lives in collection `car_selection_artifacts` and never
    contains the blob itself (keeps the collection cheap to query).
  - Bytes live in GridFS bucket `car_selection_artifacts` (matching
    the platform's "verification" bucket convention from
    inspector/cabinet.py).

Kind / mime gate:
                  image        pdf          file
  size cap        8  MB        20 MB        10 MB
  mime allow      image/png    application/  octet-stream
                  image/jpeg   pdf           text/plain
                  image/webp                 text/csv
                  image/heic                 application/json
                                             application/zip
                                             application/msword
                                             application/vnd.openxmlformats-...
                                             application/vnd.ms-excel
                                             application/vnd.openxmlformats-...spreadsheet

  The `kind` parameter is REQUIRED on upload (declared by client) but
  ALSO cross-checked against the inferred / declared mime — mismatches
  fail with `ARTIFACT_KIND_MIME_MISMATCH` so clients can't sneak a PDF
  past the image cap by lying about kind.
"""
from __future__ import annotations
import io
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Literal, Mapping, Optional

from fastapi import HTTPException, UploadFile
from motor.motor_asyncio import AsyncIOMotorDatabase, AsyncIOMotorGridFSBucket
from pydantic import BaseModel, Field

from app.car_selection_thread.models import AuthorRole


# ── Constants ────────────────────────────────────────────────────────

ArtifactKind = Literal["image", "pdf", "file"]

# Hard caps per spec — see module docstring.
KIND_BYTE_CAP: Dict[str, int] = {
    "image": 8 * 1024 * 1024,
    "pdf":   20 * 1024 * 1024,
    "file":  10 * 1024 * 1024,
}

# Allow-list. Conservative on purpose — generic uploaders should
# declare kind="file" and we accept a small set of office /text mimes.
KIND_MIME_ALLOW: Dict[str, frozenset[str]] = {
    "image": frozenset({
        "image/png", "image/jpeg", "image/webp", "image/heic",
        "image/heif", "image/gif",
    }),
    "pdf": frozenset({"application/pdf"}),
    "file": frozenset({
        "application/octet-stream",
        "text/plain", "text/csv", "text/markdown",
        "application/json",
        "application/zip",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
}

# Filename safety — strip control chars, cap length, keep extension.
_FILENAME_MAX = 200


def _safe_filename(raw: Optional[str]) -> str:
    name = (raw or "upload").strip()
    if not name:
        name = "upload"
    # Drop control characters / path separators.
    name = "".join(ch for ch in name if ch.isprintable() and ch not in "/\\")
    if len(name) > _FILENAME_MAX:
        # Keep the last 4-char suffix area in case it's an extension.
        head = name[: _FILENAME_MAX - 5]
        tail = name[-4:] if "." in name[-5:] else ""
        name = head + tail
    return name or "upload"


ARTIFACTS = "car_selection_artifacts"
ARTIFACT_BUCKET = "car_selection_artifacts"


# ── Errors ───────────────────────────────────────────────────────────


def _err(status: int, code: str, message: str, **details) -> HTTPException:
    return HTTPException(
        status_code=status,
        detail={
            "error": True, "code": code, "message": message,
            "details": details or {},
        },
    )


# ── Public output shape ──────────────────────────────────────────────


class ArtifactOut(BaseModel):
    id: str
    requestId: str
    uploadedBy: str
    uploadedByRole: AuthorRole
    kind: ArtifactKind
    filename: str
    mimeType: str
    sizeBytes: int
    url: str
    createdAt: str


# ── Helpers ──────────────────────────────────────────────────────────


def _iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _validate_kind_mime(kind: str, mime: str) -> None:
    if kind not in KIND_BYTE_CAP:
        raise _err(
            400, "ARTIFACT_INVALID_KIND",
            f"kind must be one of {sorted(KIND_BYTE_CAP)}",
            kind=kind,
        )
    allow = KIND_MIME_ALLOW[kind]
    if mime not in allow:
        raise _err(
            415, "ARTIFACT_KIND_MIME_MISMATCH",
            f"mime {mime!r} not allowed for kind {kind!r}",
            kind=kind, mimeType=mime, allowed=sorted(allow),
        )


def _url_for(surface: str, request_id: str, artifact_id: str) -> str:
    """Synthetic URL used by clients to download via the same surface
    they uploaded through. The artifact is still readable by ANY role
    that can read the request (admin always, customer/provider per
    assignment) — the URL prefix just keeps role context obvious.
    """
    if surface == "admin":
        return f"/api/admin/car-selection/{request_id}/artifacts/{artifact_id}"
    if surface == "provider":
        return f"/api/provider/car-selection/{request_id}/artifacts/{artifact_id}"
    return f"/api/car-selection/requests/{request_id}/artifacts/{artifact_id}"


# ── Repository ───────────────────────────────────────────────────────


class ArtifactRepository:
    def __init__(self, db: AsyncIOMotorDatabase):
        self.db = db
        self.col = db[ARTIFACTS]
        self.bucket = AsyncIOMotorGridFSBucket(db, bucket_name=ARTIFACT_BUCKET)

    async def ensure_indices(self) -> None:
        await self.col.create_index([("requestId", 1), ("createdAt", 1)])
        await self.col.create_index([("id", 1)], unique=True)

    # ── upload ────────────────────────────────────────────────────

    async def create(
        self,
        *,
        request_id: str,
        kind: str,
        upload: UploadFile,
        author_id: str,
        author_role: AuthorRole,
        surface: str,
    ) -> Dict[str, Any]:
        # Read with explicit cap — abort on overflow so a malicious
        # client can't pump a 4 GB stream into memory.
        cap = KIND_BYTE_CAP.get(kind)
        if cap is None:
            raise _err(400, "ARTIFACT_INVALID_KIND",
                       f"kind must be one of {sorted(KIND_BYTE_CAP)}",
                       kind=kind)

        # Read up to cap+1 then check.
        data = await upload.read(cap + 1)
        size = len(data)
        if size == 0:
            raise _err(400, "ARTIFACT_EMPTY", "empty upload")
        if size > cap:
            raise _err(
                413, "ARTIFACT_TOO_LARGE",
                f"upload exceeds cap for kind {kind!r}",
                kind=kind, sizeBytes=size, capBytes=cap,
            )

        mime = (upload.content_type or "application/octet-stream").lower()
        _validate_kind_mime(kind, mime)

        artifact_id = uuid.uuid4().hex
        filename = _safe_filename(upload.filename)

        # 1. Persist bytes in GridFS first. If THIS fails, no orphan
        #    metadata is left behind.
        gridfs_id = await self.bucket.upload_from_stream(
            f"car-selection/{request_id}/{artifact_id}",
            io.BytesIO(data),
            metadata={
                "artifactId": artifact_id,
                "requestId": request_id,
                "kind": kind,
                "mimeType": mime,
                "filename": filename,
            },
        )

        # 2. Persist metadata. If THIS fails (unlikely, ordered writes),
        #    we leak a GridFS blob — harmless because nothing references
        #    it. We accept the trade-off in exchange for "if metadata
        #    exists, the blob exists".
        doc = {
            "id": artifact_id,
            "requestId": request_id,
            "uploadedBy": author_id,
            "uploadedByRole": author_role,
            "kind": kind,
            "filename": filename,
            "mimeType": mime,
            "sizeBytes": size,
            "gridfsId": gridfs_id,
            "createdAt": _iso(_now()),
        }
        await self.col.insert_one(dict(doc))
        return self.to_out(doc, surface=surface)

    # ── read ──────────────────────────────────────────────────────

    async def get(self, artifact_id: str) -> Optional[Dict[str, Any]]:
        return await self.col.find_one({"id": artifact_id}, {"_id": 0})

    async def get_for_request(
        self, artifact_id: str, request_id: str,
    ) -> Optional[Dict[str, Any]]:
        return await self.col.find_one(
            {"id": artifact_id, "requestId": request_id},
            {"_id": 0},
        )

    async def open_stream(self, artifact_id: str):
        """Stream artifact bytes. Returns (metadata, gridfs_stream)."""
        meta = await self.get(artifact_id)
        if not meta:
            raise _err(404, "ARTIFACT_NOT_FOUND",
                       f"artifact {artifact_id!r} not found",
                       artifactId=artifact_id)
        stream = await self.bucket.open_download_stream(meta["gridfsId"])
        return meta, stream

    # ── stats (admin observability) ───────────────────────────────

    async def stats(self) -> Dict[str, Any]:
        """Aggregate counts + bytes-on-disk per kind.

        Returns a stable shape — every declared kind is always
        present (zero rows when empty) so the admin UI doesn't have
        to special-case missing buckets.

        Cheap: groups the existing `(requestId, createdAt)` collection
        by kind. Does NOT touch GridFS bytes — `sizeBytes` is mirrored
        into the metadata row at upload time, so the read is a single
        aggregation pass.
        """
        pipeline = [
            {"$group": {
                "_id": "$kind",
                "count": {"$sum": 1},
                "bytes": {"$sum": "$sizeBytes"},
            }},
        ]
        by_kind: Dict[str, Dict[str, int]] = {
            k: {"count": 0, "bytes": 0} for k in KIND_BYTE_CAP
        }
        total_count = 0
        total_bytes = 0
        async for row in self.col.aggregate(pipeline):
            kind = row.get("_id")
            if kind in by_kind:
                by_kind[kind] = {
                    "count": int(row.get("count", 0)),
                    "bytes": int(row.get("bytes", 0)),
                }
            # Tally even if kind is unknown — should never happen but
            # we count it so storage truth-table never lies.
            total_count += int(row.get("count", 0))
            total_bytes += int(row.get("bytes", 0))
        return {
            "totalArtifacts": total_count,
            "totalBytes": total_bytes,
            "byKind": by_kind,
        }

    # ── helpers ───────────────────────────────────────────────────

    @staticmethod
    def to_out(doc: Mapping[str, Any], *, surface: str) -> Dict[str, Any]:
        """Project storage doc → ArtifactOut shape (no gridfsId / no _id)."""
        return {
            "id": doc["id"],
            "requestId": doc["requestId"],
            "uploadedBy": doc["uploadedBy"],
            "uploadedByRole": doc["uploadedByRole"],
            "kind": doc["kind"],
            "filename": doc["filename"],
            "mimeType": doc["mimeType"],
            "sizeBytes": doc["sizeBytes"],
            "url": _url_for(surface, doc["requestId"], doc["id"]),
            "createdAt": doc["createdAt"],
        }


# ── Message-time resolution ──────────────────────────────────────────


async def resolve_attachment_ids(
    repo: "ArtifactRepository",
    *,
    request_id: str,
    ids: List[str],
    surface: str,
) -> List[Dict[str, Any]]:
    """Resolve a list of artifactIds attached to a message-in.

    Discipline:
      - Empty list → empty list. (No-op).
      - Unknown id           → 400 ARTIFACT_NOT_FOUND.
      - Cross-request id     → 400 ARTIFACT_CROSS_REQUEST. The route
        already gated access to the parent request, so this catches
        callers trying to staple an artifact uploaded for a different
        car-selection request.
      - Returns the projected ArtifactOut shape for embedding into the
        message's `attachments` field.

    The route layer never sees the request's ownership again — by the
    time we reach this function, fetch_for() has already authorized
    the caller for the requestId.
    """
    if not ids:
        return []
    # Dedup while preserving order
    seen: set[str] = set()
    ordered = [x for x in ids if not (x in seen or seen.add(x))]
    if len(ordered) > 10:
        raise _err(400, "ARTIFACT_TOO_MANY",
                   "at most 10 attachments per message",
                   attachmentIds=ordered)

    resolved: List[Dict[str, Any]] = []
    for aid in ordered:
        doc = await repo.get(aid)
        if not doc:
            raise _err(400, "ARTIFACT_NOT_FOUND",
                       f"artifact {aid!r} not found",
                       artifactId=aid)
        if doc["requestId"] != request_id:
            # Cross-request smuggling — refuse loudly.
            raise _err(400, "ARTIFACT_CROSS_REQUEST",
                       "attached artifact does not belong to this request",
                       artifactId=aid)
        resolved.append(repo.to_out(doc, surface=surface))
    return resolved


__all__ = [
    "ArtifactRepository", "ArtifactOut", "ArtifactKind",
    "KIND_BYTE_CAP", "KIND_MIME_ALLOW",
    "resolve_attachment_ids",
    "ARTIFACTS", "ARTIFACT_BUCKET",
]
