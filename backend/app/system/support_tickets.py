"""Support ticket endpoint — Sprint UX-1 (post-deploy customer feedback fix).

Why: frontend `/support` previously used a `mailto:` fallback that opened the
OS email client and never confirmed delivery. Users complained that "ничего не
происходит когда жмёшь отправить". This module persists tickets in Mongo,
optionally CC's `support@autoservice.com` via email integration (left as TODO
until SendGrid/Resend credentials arrive), and returns a real ticket id the
frontend can display.

Endpoints:
  POST /api/support/tickets        — create a ticket  (open to authed + guest)
  GET  /api/support/tickets/mine   — current user's tickets
  GET  /api/admin/support/tickets  — admin list (verify_admin_token)
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Optional, List
import logging
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, EmailStr

from app.core.db import db
from app.core.utils import now_utc

logger = logging.getLogger("server")
router = APIRouter()


def _new_ticket_id() -> str:
    """Short, human-shareable ticket id, e.g. T-A3F9-B1C2."""
    raw = secrets.token_hex(4).upper()
    return f"T-{raw[:4]}-{raw[4:]}"


class TicketCreateBody(BaseModel):
    subject: Optional[str] = Field(default=None, max_length=200)
    message: str = Field(min_length=1, max_length=5000)
    email: Optional[EmailStr] = None
    phone: Optional[str] = Field(default=None, max_length=40)
    category: Optional[str] = Field(default=None, max_length=40)
    locale: Optional[str] = Field(default=None, max_length=10)


class TicketView(BaseModel):
    id: str
    subject: str
    message: str
    status: str
    createdAt: str
    category: Optional[str] = None
    response: Optional[str] = None


@router.post("/api/support/tickets")
async def create_ticket(body: TicketCreateBody, request: Request):
    """Create a new support ticket. Works for authed users AND guests.

    Auth is optional — guests can submit if they include their email so the
    support team can reply. Authed users get the ticket linked to their
    userId automatically.
    """
    user_id = None
    user_email = body.email
    try:
        auth = request.headers.get("Authorization", "")
        if auth.startswith("Bearer "):
            from app.core.config import JWT_SECRET, JWT_ALGO
            from jose import jwt as jose_jwt
            payload = jose_jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
            user_id = payload.get("sub")
            if not user_email:
                user_email = payload.get("email")
    except Exception:
        pass  # guest

    if not user_email and not user_id:
        raise HTTPException(
            status_code=400,
            detail="Email is required for guest submissions so we can reply.",
        )

    ticket_id = _new_ticket_id()
    subject = (body.subject or "").strip() or "Support request"
    doc = {
        "id": ticket_id,
        "userId": user_id,
        "email": user_email,
        "phone": (body.phone or "").strip() or None,
        "subject": subject[:200],
        "message": body.message.strip()[:5000],
        "category": (body.category or "general").strip()[:40],
        "locale": (body.locale or "en").strip()[:10],
        "status": "open",
        "response": None,
        "respondedAt": None,
        "createdAt": now_utc().isoformat(),
        "updatedAt": now_utc().isoformat(),
        "source": "mobile",
    }
    await db.support_tickets.insert_one(doc)
    # Drop the auto-added _id before returning
    doc.pop("_id", None)
    logger.info(f"[support] new ticket {ticket_id} from {user_email or user_id}")
    return {
        "ok": True,
        "ticket": {
            "id": doc["id"],
            "subject": doc["subject"],
            "status": doc["status"],
            "createdAt": doc["createdAt"],
            "etaHours": 24,
        },
    }


@router.get("/api/support/tickets/mine")
async def list_my_tickets(request: Request):
    """Return tickets the calling user created (authed)."""
    try:
        from app.core.config import JWT_SECRET, JWT_ALGO
        from jose import jwt as jose_jwt
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(401, "Unauthorized")
        payload = jose_jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
        user_id = payload.get("sub")
        user_email = payload.get("email")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Unauthorized")

    q = {"$or": [{"userId": user_id}]}
    if user_email:
        q["$or"].append({"email": user_email})
    cursor = db.support_tickets.find(q, {"_id": 0}).sort("createdAt", -1).limit(50)
    items = await cursor.to_list(50)
    return {"items": items, "count": len(items)}


@router.get("/api/admin/support/tickets")
async def admin_list_tickets(request: Request, status: Optional[str] = None, limit: int = 100):
    """Admin: list all support tickets, newest first."""
    from app.core.config import JWT_SECRET, JWT_ALGO
    from jose import jwt as jose_jwt
    try:
        auth = request.headers.get("Authorization", "")
        if not auth.startswith("Bearer "):
            raise HTTPException(401, "Unauthorized")
        payload = jose_jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
        role = payload.get("role")
        if role != "admin":
            raise HTTPException(403, "Admin only")
    except HTTPException:
        raise
    except Exception:
        raise HTTPException(401, "Unauthorized")

    q = {}
    if status:
        q["status"] = status
    cursor = db.support_tickets.find(q, {"_id": 0}).sort("createdAt", -1).limit(min(limit, 500))
    items = await cursor.to_list(min(limit, 500))
    return {"items": items, "count": len(items)}
