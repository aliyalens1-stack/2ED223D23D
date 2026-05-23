"""
Admin endpoints for partner verification queue.

Routes (all under /api/admin/partner-verifications, JWT-admin-protected):
  GET    /                       — list pending / approved / rejected items
  GET    /{id}                   — single application with org details
  POST   /{id}/approve           — flip org.status='active' + queue.status='approved'
  POST   /{id}/reject            — flip queue.status='rejected' (org left pending)

This module is intentionally separate from `app/admin/verification_queue.py`
(which targets `inspector_verifications` collection — KYC documents). Here we
work on the `verification_queue` collection produced by
`app/marketplace/partner_register.py` — partner business applications.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field

from server import db
from app.core.security import verify_admin_token
from app.core.attribution import (
    AttributionContext,
    get_attribution_context,
    record_admin_mutation,
)

router = APIRouter(prefix="/api/admin/partner-verifications", tags=["admin-partner-verifications"])


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


class DecisionBody(BaseModel):
    note: Optional[str] = Field(None, max_length=600)


@router.get("/")
async def list_partner_applications(
    status: Optional[str] = Query(None, regex="^(pending|approved|rejected|all)?$"),
    kind: Optional[str] = Query(None),
    limit: int = Query(50, ge=1, le=200),
    skip: int = Query(0, ge=0),
    _admin: dict = Depends(verify_admin_token),
) -> dict:
    q: dict = {}
    if not status or status == "pending":
        q["status"] = "pending"
    elif status != "all":
        q["status"] = status
    if kind:
        q["kind"] = kind

    cursor = db.verification_queue.find(q, {"_id": 0}).sort("submittedAt", -1).skip(skip).limit(limit)
    rows = await cursor.to_list(limit)

    # Hydrate each row with a slim org snapshot for display.
    out = []
    for row in rows:
        org = await db.organizations.find_one(
            {"id": row.get("organizationId")},
            {"_id": 0, "name": 1, "city": 1, "address": 1, "status": 1, "location": 1, "kind": 1},
        )
        out.append({**row, "organization": org or None})

    total = await db.verification_queue.count_documents(q)
    return {"applications": out, "total": total, "limit": limit, "skip": skip}


@router.get("/{queue_id}")
async def get_partner_application(queue_id: str, _admin: dict = Depends(verify_admin_token)) -> dict:
    row = await db.verification_queue.find_one({"id": queue_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="application not found")
    org = await db.organizations.find_one({"id": row["organizationId"]}, {"_id": 0})
    user = await db.users.find_one({"id": row["userId"]}, {"_id": 0, "passwordHash": 0})
    return {"application": row, "organization": org, "user": user}


@router.post("/{queue_id}/approve")
async def approve_partner_application(
    queue_id: str,
    body: DecisionBody = DecisionBody(),
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> dict:
    row = await db.verification_queue.find_one({"id": queue_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="application not found")
    if row.get("status") not in (None, "pending"):
        raise HTTPException(status_code=400, detail=f"already {row.get('status')}")

    org_id = row["organizationId"]
    now = _now()
    admin_id = admin.get("id") or admin.get("sub") or "admin"

    await db.organizations.update_one(
        {"id": org_id},
        {"$set": {"status": "active", "isVerified": True, "approvedAt": now, "approvedBy": admin_id}},
    )
    await db.verification_queue.update_one(
        {"id": queue_id},
        {"$set": {"status": "approved", "decidedAt": now, "decidedBy": admin_id, "note": body.note or ""}},
    )
    # P6.B.2 — Attribution: partner onboarding governance event.
    try:
        await record_admin_mutation(
            db, ctx,
            action="partner.approve",
            domain="user",
            entity_id=org_id,
            causal_entity={"kind": "verification_queue", "id": queue_id},
            extra={"userId": row.get("userId"), "kind": row.get("kind"), "note": body.note or ""},
        )
    except Exception:
        pass
    return {"ok": True, "queueId": queue_id, "organizationId": org_id, "status": "approved"}


@router.post("/{queue_id}/reject")
async def reject_partner_application(
    queue_id: str,
    body: DecisionBody,
    admin: dict = Depends(verify_admin_token),
    ctx: AttributionContext = Depends(get_attribution_context),
) -> dict:
    if not body.note:
        raise HTTPException(status_code=400, detail="reject requires a note")
    row = await db.verification_queue.find_one({"id": queue_id}, {"_id": 0})
    if not row:
        raise HTTPException(status_code=404, detail="application not found")
    if row.get("status") not in (None, "pending"):
        raise HTTPException(status_code=400, detail=f"already {row.get('status')}")

    now = _now()
    admin_id = admin.get("id") or admin.get("sub") or "admin"
    await db.verification_queue.update_one(
        {"id": queue_id},
        {"$set": {"status": "rejected", "decidedAt": now, "decidedBy": admin_id, "note": body.note}},
    )
    # P6.B.2 — Attribution: partner rejection event.
    try:
        await record_admin_mutation(
            db, ctx,
            action="partner.reject",
            domain="user",
            entity_id=row.get("organizationId") or queue_id,
            causal_entity={"kind": "verification_queue", "id": queue_id},
            extra={"userId": row.get("userId"), "note": body.note},
        )
    except Exception:
        pass
    # The organization stays in 'pending_verification' so the partner can
    # re-submit if needed. Status is NOT flipped to 'active' on reject.
    return {"ok": True, "queueId": queue_id, "status": "rejected"}
