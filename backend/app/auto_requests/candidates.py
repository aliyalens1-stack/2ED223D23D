"""Phase C.3 — Provider Workspace: candidate cars attached to selection requests.

Data model:
  auto_request_candidates: {
    _id, requestId, providerId, listingUrl, source,
    preview: {title, image, price, currency, year, mileage, fuel, make, model},
    providerComment, score (0..10), risk ('low'|'medium'|'high'),
    recommended (bool), createdAt, updatedAt, status ('active'|'archived')
  }

Concept:
- Provider (inspector / concierge) opens a Selection request and attaches found cars
  one by one. Each candidate carries a preview snapshot + provider verdict.
- Customer reads the candidate list as a comparison table (Score / Risk / Verdict).
- Inspections later book against candidate.listingUrl directly.

We do NOT store entire HTML or duplicate marketplace data — only a lightweight
preview snapshot. The original listing remains the source of truth.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import List, Optional, Literal

from pydantic import BaseModel, Field, field_validator
from app.core.db import get_db


class CandidatePreview(BaseModel):
    title: Optional[str] = None
    image: Optional[str] = None
    price: Optional[int] = None
    currency: str = "EUR"
    year: Optional[int] = None
    mileage: Optional[int] = None
    fuel: Optional[str] = None
    make: Optional[str] = None
    model: Optional[str] = None


class CandidateIn(BaseModel):
    """Payload to create / update a candidate."""
    listingUrl: str = Field(..., min_length=8, max_length=2048)
    source: Optional[str] = Field(default=None, max_length=60)
    preview: CandidatePreview = Field(default_factory=CandidatePreview)
    providerComment: Optional[str] = Field(default=None, max_length=2000)
    score: Optional[float] = Field(default=None, ge=0, le=10)
    risk: Optional[Literal["low", "medium", "high"]] = None
    recommended: bool = False

    @field_validator("listingUrl")
    @classmethod
    def _trim(cls, v: str) -> str:
        v = (v or "").strip()
        if not v.lower().startswith(("http://", "https://")):
            v = "https://" + v
        return v


class CandidateOut(BaseModel):
    id: str
    requestId: str
    providerId: Optional[str] = None
    listingUrl: str
    source: Optional[str] = None
    preview: CandidatePreview
    providerComment: Optional[str] = None
    score: Optional[float] = None
    risk: Optional[Literal["low", "medium", "high"]] = None
    recommended: bool = False
    status: str = "active"
    createdAt: str
    updatedAt: str


def _doc_to_out(doc: dict) -> CandidateOut:
    return CandidateOut(
        id=str(doc["_id"]),
        requestId=str(doc["requestId"]),
        providerId=doc.get("providerId"),
        listingUrl=doc["listingUrl"],
        source=doc.get("source"),
        preview=CandidatePreview(**(doc.get("preview") or {})),
        providerComment=doc.get("providerComment"),
        score=doc.get("score"),
        risk=doc.get("risk"),
        recommended=bool(doc.get("recommended", False)),
        status=doc.get("status", "active"),
        createdAt=doc.get("createdAt") or "",
        updatedAt=doc.get("updatedAt") or "",
    )


async def create_candidate(request_id: str, provider_id: Optional[str], data: CandidateIn) -> CandidateOut:
    """Attach a new candidate to a Selection request."""
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    cid = str(uuid.uuid4())
    doc = {
        "_id": cid,
        "requestId": request_id,
        "providerId": provider_id,
        "listingUrl": data.listingUrl,
        "source": data.source,
        "preview": data.preview.model_dump(),
        "providerComment": data.providerComment,
        "score": data.score,
        "risk": data.risk,
        "recommended": data.recommended,
        "status": "active",
        "createdAt": now,
        "updatedAt": now,
    }
    await db.auto_request_candidates.insert_one(doc)
    return _doc_to_out(doc)


async def list_candidates(request_id: str, *, include_archived: bool = False) -> List[CandidateOut]:
    db = get_db()
    q: dict = {"requestId": request_id}
    if not include_archived:
        q["status"] = "active"
    cur = db.auto_request_candidates.find(q).sort("createdAt", -1)
    return [_doc_to_out(d) async for d in cur]


async def get_candidate(candidate_id: str) -> Optional[CandidateOut]:
    db = get_db()
    doc = await db.auto_request_candidates.find_one({"_id": candidate_id})
    return _doc_to_out(doc) if doc else None


async def update_candidate(candidate_id: str, data: CandidateIn) -> Optional[CandidateOut]:
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    upd = {
        "listingUrl": data.listingUrl,
        "source": data.source,
        "preview": data.preview.model_dump(),
        "providerComment": data.providerComment,
        "score": data.score,
        "risk": data.risk,
        "recommended": data.recommended,
        "updatedAt": now,
    }
    res = await db.auto_request_candidates.find_one_and_update(
        {"_id": candidate_id},
        {"$set": upd},
        return_document=True,
    )
    return _doc_to_out(res) if res else None


async def archive_candidate(candidate_id: str) -> bool:
    """Soft-delete: status='archived' (keeps the audit trail)."""
    db = get_db()
    now = datetime.now(timezone.utc).isoformat()
    res = await db.auto_request_candidates.update_one(
        {"_id": candidate_id},
        {"$set": {"status": "archived", "updatedAt": now}},
    )
    return res.modified_count > 0
