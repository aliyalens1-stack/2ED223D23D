"""Credits + payment service (Sprint 3)."""
from __future__ import annotations
import os
import uuid
import logging
from datetime import datetime, timezone
from typing import Optional, List, Literal

from app.core.db import get_db
from app.packages.schemas import (
    PACKAGE_CATALOG, get_package,
    CreditBalanceOut, LedgerEntryOut, PaymentOut,
)

logger = logging.getLogger(__name__)


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _iso(v) -> str:
    if isinstance(v, datetime):
        return v.isoformat()
    return str(v) if v is not None else ""


# ──────────────────────────────────────────────────────────────────────
# balance helpers
# ──────────────────────────────────────────────────────────────────────

async def get_balance(user_id: str) -> CreditBalanceOut:
    db = get_db()
    doc = await db.inspection_credits.find_one({"_id": user_id}, {"_id": 0}) or {}
    balance = int(doc.get("balance", 0))
    reserved = int(doc.get("reserved", 0))
    used = int(doc.get("used", 0))
    return CreditBalanceOut(
        userId=user_id,
        balance=balance,
        reserved=reserved,
        used=used,
        available=balance - reserved,
    )


async def _apply_ledger(user_id: str, type_: str, delta: int, **meta) -> str:
    """Insert ledger entry, return id. Ledger is append-only."""
    db = get_db()
    entry_id = str(uuid.uuid4())
    await db.inspection_credit_ledger.insert_one({
        "_id": entry_id,
        "userId": user_id,
        "type": type_,
        "delta": delta,
        "requestId": meta.get("requestId"),
        "jobId": meta.get("jobId"),
        "paymentId": meta.get("paymentId"),
        "note": meta.get("note"),
        "createdAt": _now(),
    })
    return entry_id


async def reserve_credits(user_id: str, amount: int, request_id: str) -> bool:
    """Reserve N credits for a pending request. Returns False if insufficient."""
    if amount <= 0:
        return True
    db = get_db()
    # atomic conditional update — only decrement if balance-reserved >= amount
    res = await db.inspection_credits.update_one(
        {"_id": user_id, "$expr": {"$gte": [{"$subtract": ["$balance", "$reserved"]}, amount]}},
        {"$inc": {"reserved": amount}, "$set": {"updatedAt": _now()}},
    )
    if res.modified_count != 1:
        return False
    await _apply_ledger(user_id, "reserve", -amount, requestId=request_id,
                        note=f"reserved {amount} for request {request_id}")
    return True


async def release_credits(user_id: str, amount: int, request_id: Optional[str] = None,
                          job_id: Optional[str] = None, reason: str = "released") -> None:
    if amount <= 0 or not user_id:
        return
    db = get_db()
    await db.inspection_credits.update_one(
        {"_id": user_id},
        {"$inc": {"reserved": -amount}, "$set": {"updatedAt": _now()}},
    )
    await _apply_ledger(user_id, "release", +amount, requestId=request_id, jobId=job_id, note=reason)


async def consume_credit(user_id: str, job_id: str, request_id: Optional[str] = None) -> None:
    """Call on inspection_job.complete: reserved -1, used +1, balance -1."""
    if not user_id:
        return
    db = get_db()
    await db.inspection_credits.update_one(
        {"_id": user_id},
        {"$inc": {"reserved": -1, "used": +1, "balance": -1}, "$set": {"updatedAt": _now()}},
    )
    await _apply_ledger(user_id, "consume", -1, jobId=job_id, requestId=request_id,
                        note=f"consumed for job {job_id}")


async def credit_purchase(user_id: str, credits: int, payment_id: str, package_id: str) -> None:
    """Increment balance after confirmed payment."""
    db = get_db()
    await db.inspection_credits.update_one(
        {"_id": user_id},
        {
            "$inc": {"balance": credits},
            "$set": {"updatedAt": _now()},
            "$setOnInsert": {"reserved": 0, "used": 0, "createdAt": _now()},
        },
        upsert=True,
    )
    await _apply_ledger(user_id, "purchase", +credits, paymentId=payment_id,
                        note=f"purchased package {package_id} ({credits} credits)")


async def admin_adjust(user_id: str, delta: int, note: Optional[str] = None) -> CreditBalanceOut:
    db = get_db()
    await db.inspection_credits.update_one(
        {"_id": user_id},
        {
            "$inc": {"balance": delta},
            "$set": {"updatedAt": _now()},
            "$setOnInsert": {"reserved": 0, "used": 0, "createdAt": _now()},
        },
        upsert=True,
    )
    await _apply_ledger(user_id, "admin_adjust", delta, note=note or "admin manual adjust")
    return await get_balance(user_id)


async def list_ledger(user_id: str, limit: int = 100) -> List[LedgerEntryOut]:
    db = get_db()
    cursor = db.inspection_credit_ledger.find({"userId": user_id}).sort("createdAt", -1).limit(limit)
    docs = await cursor.to_list(limit)
    out = []
    for d in docs:
        out.append(LedgerEntryOut(
            id=str(d["_id"]),
            userId=d.get("userId"),
            type=d.get("type", ""),
            delta=int(d.get("delta", 0)),
            requestId=d.get("requestId"),
            jobId=d.get("jobId"),
            paymentId=d.get("paymentId"),
            note=d.get("note"),
            createdAt=_iso(d.get("createdAt")),
        ))
    return out


# ──────────────────────────────────────────────────────────────────────
# payments
# ──────────────────────────────────────────────────────────────────────

async def create_pending_payment(user_id: Optional[str], package_id: str, provider: str) -> dict:
    pkg = get_package(package_id)
    if not pkg:
        raise ValueError("unknown package")
    db = get_db()
    pid = str(uuid.uuid4())
    doc = {
        "_id": pid,
        "userId": user_id,
        "packageId": package_id,
        "credits": pkg["credits"],
        "amount": pkg["price"],
        "currency": pkg["currency"],
        "provider": provider,
        "status": "pending",
        "sessionId": None,
        "createdAt": _now(),
        "paidAt": None,
    }
    await db.package_payments.insert_one(doc)
    return doc


async def get_payment(payment_id: str) -> Optional[dict]:
    db = get_db()
    return await db.package_payments.find_one({"_id": payment_id})


async def mark_payment_paid(payment_id: str, session_id: Optional[str] = None) -> Optional[dict]:
    """Idempotent: if already paid, do nothing extra."""
    db = get_db()
    doc = await db.package_payments.find_one({"_id": payment_id})
    if not doc:
        return None
    if doc.get("status") == "paid":
        return doc
    await db.package_payments.update_one(
        {"_id": payment_id},
        {"$set": {"status": "paid", "paidAt": _now(), "sessionId": session_id or doc.get("sessionId")}},
    )
    # credit the user
    await credit_purchase(
        user_id=doc.get("userId") or "guest",
        credits=int(doc.get("credits", 0)),
        payment_id=payment_id,
        package_id=doc.get("packageId", ""),
    )
    doc["status"] = "paid"
    doc["paidAt"] = _now()
    return doc


async def list_payments(status: Optional[str] = None, limit: int = 200) -> List[dict]:
    db = get_db()
    q: dict = {}
    if status:
        q["status"] = status
    cursor = db.package_payments.find(q).sort("createdAt", -1).limit(limit)
    return await cursor.to_list(limit)


def payment_to_out(doc: dict) -> PaymentOut:
    return PaymentOut(
        id=str(doc["_id"]),
        userId=doc.get("userId"),
        packageId=doc.get("packageId", ""),
        credits=int(doc.get("credits", 0)),
        amount=int(doc.get("amount", 0)),
        currency=doc.get("currency", "EUR"),
        provider=doc.get("provider", ""),
        status=doc.get("status", "pending"),
        sessionId=doc.get("sessionId"),
        createdAt=_iso(doc.get("createdAt")),
        paidAt=_iso(doc.get("paidAt")) if doc.get("paidAt") else None,
    )
