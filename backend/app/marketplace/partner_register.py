"""
Partner self-registration: public endpoint that lets a workshop / inspector /
dealer / carwash apply to be listed on the marketplace + map.

Flow:
  1. Partner fills the form (name, email, password, kind, city, lat/lng, phone)
  2. POST /api/marketplace/partner/register
  3. We create:
       • a `users` row with role='provider'
       • an `organizations` row with status='pending_verification' and
         partnerType=kind + GeoJSON location
       • a `verification_queue` row (consumed by admin/verification_queue.py)
  4. After admin approves (POST /api/admin/verification-queue/{id}/approve),
     org.status flips to 'active' and the marker shows up on the public map
     (the /api/marketplace/providers query already filters by status=active).

The point of pending_verification status is precisely the user's requirement:
"метка ставится на карте только после верификации".
"""
from datetime import datetime, timezone
from typing import Optional
import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, EmailStr, Field
from passlib.context import CryptContext

from server import db

router = APIRouter(prefix="/api/marketplace/partner", tags=["marketplace-partner"])
pwd_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")

ALLOWED_KINDS = {"workshop", "inspector", "dealer", "carwash"}


class PartnerRegisterPayload(BaseModel):
    name: str = Field(..., min_length=2, max_length=120)
    email: EmailStr
    password: str = Field(..., min_length=6, max_length=128)
    phone: Optional[str] = Field(None, max_length=40)
    kind: str
    city: str = Field(..., min_length=2, max_length=64)
    address: Optional[str] = Field(None, max_length=240)
    lat: float
    lng: float


def _now() -> str:
    return datetime.now(timezone.utc).isoformat()


@router.post("/register")
async def partner_register(payload: PartnerRegisterPayload) -> dict:
    if payload.kind not in ALLOWED_KINDS:
        raise HTTPException(status_code=400, detail=f"kind must be one of {sorted(ALLOWED_KINDS)}")
    if not (-90 <= payload.lat <= 90) or not (-180 <= payload.lng <= 180):
        raise HTTPException(status_code=400, detail="invalid coordinates")

    email_norm = payload.email.lower().strip()

    # Reject duplicate emails fast.
    existing = await db.users.find_one({"email": email_norm}, {"_id": 1})
    if existing:
        raise HTTPException(status_code=409, detail="email already registered")

    user_id = str(uuid.uuid4())
    org_id = str(uuid.uuid4())
    slug = f"partner-{payload.kind}-{org_id[:8]}"

    user_doc = {
        "id": user_id,
        "email": email_norm,
        "passwordHash": pwd_ctx.hash(payload.password),
        "firstName": payload.name.split()[0],
        "lastName": " ".join(payload.name.split()[1:]) or "",
        "role": "provider",
        "phone": payload.phone or "",
        "organizationId": org_id,
        "createdAt": _now(),
    }
    org_doc = {
        "id": org_id,
        "slug": slug,
        "name": payload.name,
        "city": payload.city.lower().strip(),
        "address": payload.address or f"{payload.city}",
        "location": {"type": "Point", "coordinates": [payload.lng, payload.lat]},
        "ratingAvg": 0.0,
        "reviewsCount": 0,
        "isOnline": True,
        "isVerified": False,
        "isPromoted": False,
        "isPartner": True,
        "status": "pending_verification",  # → 'active' on admin approve
        "kind": payload.kind,
        "partnerType": payload.kind,
        "ownerId": user_id,
        "serviceIds": [],
        "completedBookingsCount": 0,
        "createdAt": _now(),
    }
    queue_doc = {
        "id": str(uuid.uuid4()),
        "organizationId": org_id,
        "userId": user_id,
        "kind": payload.kind,
        "city": org_doc["city"],
        "status": "pending",  # admin approve flips to 'approved'
        "submittedAt": _now(),
        "documents": [],
        "location": org_doc["location"],
    }

    await db.users.insert_one(user_doc)
    await db.organizations.insert_one(org_doc)
    await db.verification_queue.insert_one(queue_doc)

    return {
        "ok": True,
        "organizationId": org_id,
        "queueId": queue_doc["id"],
        "status": "pending_verification",
        "message": "Заявка отправлена на верификацию. После одобрения администратором метка появится на карте.",
    }


@router.get("/me/status")
async def partner_status(organizationId: str) -> dict:
    """Frontend can poll this to see when admin approves the application."""
    org = await db.organizations.find_one({"id": organizationId}, {"_id": 0, "status": 1, "kind": 1, "name": 1, "city": 1})
    if not org:
        raise HTTPException(status_code=404, detail="organization not found")
    return {"organizationId": organizationId, **org}
