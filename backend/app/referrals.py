"""app.referrals — Sprint 29: Growth loop.

Invite friend → ₴500 wallet credit flow (customer).
Invite master → 7 days × 1.5 free boost (provider).

Collections
-----------
* `referrals`       — owner's share code `{code, ownerUserId, ownerSlug, ownerType, uses, createdAt}`
* `referral_uses`   — a single invite consumption `{code, invitedUserId|invitedSlug, status,
                      rewardGranted, ip, deviceId, createdAt, completedAt}`
* `wallet_credits`  — customer credit ledger `{userId, amountUAH, source, createdAt}`
                      (balance = sum of amountUAH)

Integration points
------------------
* `auth_register` accepts optional `referralCode` body field → apply() immediately.
* `booking complete` hook (`app/provider/router.py` status=completed) calls
    - `complete_customer_referral(invited_user_id)` on FIRST completed booking
    - `complete_provider_referral(invited_provider_slug)` on THIRD completed booking

Reward values
-------------
* Inviter customer  → ₴200 wallet credit
* Invited customer  → ₴300 wallet credit (granted on first booking complete, not at register)
* Inviter provider  → +7 days × 1.5 boost (added to organizations.boostMultiplier / boostEndsAt)
"""
from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.db import db
from app.core.security import verify_admin_token
from app.core.config import JWT_SECRET, JWT_ALGO
from app.core.utils import now_utc, uid
import jwt as _jwt


router = APIRouter(tags=["referrals"])
logger = logging.getLogger("referrals")

# Reward config
CUSTOMER_INVITER_REWARD = 200   # UAH
CUSTOMER_INVITED_REWARD = 300   # UAH
PROVIDER_INVITER_BOOST_DAYS = 7
PROVIDER_INVITER_BOOST_MULT = 1.5
PROVIDER_COMPLETES_REQUIRED = 3   # invited provider must complete 3 bookings

URGENCY_DAYS_LEFT = 7  # "Осталось N дней акции" banner copy


def _gen_code() -> str:
    """6-char uppercase alphanumeric code (no lookalikes)."""
    alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
    return "".join(secrets.choice(alphabet) for _ in range(6))


async def ensure_referral_code(user_id: str, user_doc: Optional[dict] = None) -> str:
    """Return or create the user's referral code."""
    existing = await db.referrals.find_one({"ownerUserId": user_id}, {"_id": 0})
    if existing and existing.get("code"):
        return existing["code"]
    # Generate a unique one
    for _ in range(10):
        code = _gen_code()
        clash = await db.referrals.find_one({"code": code})
        if not clash:
            break
    else:
        code = _gen_code() + secrets.token_hex(2).upper()

    owner_type = (user_doc or {}).get("role") or "customer"
    slug = (user_doc or {}).get("providerSlug")
    await db.referrals.insert_one({
        "id": uid(),
        "code": code,
        "ownerUserId": user_id,
        "ownerSlug": slug,
        "ownerType": "provider" if owner_type.startswith("provider") else "customer",
        "uses": 0,
        "createdAt": now_utc().isoformat(),
    })
    return code


async def apply_referral_code(
    code: str,
    invited_user_id: Optional[str],
    invited_slug: Optional[str] = None,
    ip: Optional[str] = None,
    device_id: Optional[str] = None,
) -> dict:
    """Register a pending referral_use. Idempotent per invited_user_id."""
    if not code:
        return {"ok": False, "reason": "no_code"}
    code = code.upper().strip()
    ref = await db.referrals.find_one({"code": code}, {"_id": 0})
    if not ref:
        return {"ok": False, "reason": "invalid_code"}
    # Anti-abuse
    if invited_user_id and ref.get("ownerUserId") == invited_user_id:
        return {"ok": False, "reason": "self_referral"}
    if invited_slug and ref.get("ownerSlug") and ref["ownerSlug"] == invited_slug:
        return {"ok": False, "reason": "self_referral"}
    # Already applied?
    key = {"code": code}
    if invited_user_id:
        key["invitedUserId"] = invited_user_id
    elif invited_slug:
        key["invitedSlug"] = invited_slug
    else:
        return {"ok": False, "reason": "no_invitee"}
    existing_use = await db.referral_uses.find_one(key, {"_id": 0})
    if existing_use:
        return {"ok": True, "status": existing_use.get("status"), "reason": "already_applied"}

    now = now_utc().isoformat()
    use_doc = {
        "id": uid(),
        "code": code,
        "ownerUserId": ref.get("ownerUserId"),
        "ownerSlug": ref.get("ownerSlug"),
        "ownerType": ref.get("ownerType"),
        "invitedUserId": invited_user_id,
        "invitedSlug": invited_slug,
        "status": "pending",
        "rewardGranted": False,
        "ip": ip,
        "deviceId": device_id,
        "createdAt": now,
    }
    # Flag same-IP/same-device abuse (non-blocking, just mark)
    if ip or device_id:
        dup = await db.referral_uses.find_one({
            "$or": [
                {"code": code, "ip": ip} if ip else {"_impossible": True},
                {"code": code, "deviceId": device_id} if device_id else {"_impossible": True},
            ]
        })
        if dup:
            use_doc["flaggedSuspicious"] = True

    await db.referral_uses.insert_one(use_doc)
    await db.referrals.update_one({"code": code}, {"$inc": {"uses": 1}})
    return {"ok": True, "status": "pending", "code": code, "reward": {
        "inviter": CUSTOMER_INVITER_REWARD if ref.get("ownerType") == "customer" else f"{PROVIDER_INVITER_BOOST_DAYS}d×{PROVIDER_INVITER_BOOST_MULT} boost",
        "invited": CUSTOMER_INVITED_REWARD if ref.get("ownerType") == "customer" else "0",
    }}


async def complete_customer_referral(invited_user_id: str) -> dict:
    """Called on the invited customer's FIRST completed booking."""
    if not invited_user_id:
        return {"ok": False, "reason": "no_user"}
    use = await db.referral_uses.find_one({
        "invitedUserId": invited_user_id,
        "status": "pending",
        "rewardGranted": False,
        "ownerType": "customer",
    }, {"_id": 0})
    if not use:
        return {"ok": False, "reason": "no_pending_referral"}
    if use.get("flaggedSuspicious"):
        logger.warning(f"[referrals] skipping reward for flagged use {use.get('id')}")
        return {"ok": False, "reason": "flagged"}
    now = now_utc().isoformat()
    # Inviter credit
    await db.wallet_credits.insert_one({
        "id": uid(), "userId": use["ownerUserId"], "amountUAH": CUSTOMER_INVITER_REWARD,
        "source": "referral_inviter", "refUseId": use["id"], "createdAt": now,
    })
    # Invited credit
    await db.wallet_credits.insert_one({
        "id": uid(), "userId": invited_user_id, "amountUAH": CUSTOMER_INVITED_REWARD,
        "source": "referral_invited", "refUseId": use["id"], "createdAt": now,
    })
    await db.referral_uses.update_one(
        {"id": use["id"]},
        {"$set": {"status": "completed", "rewardGranted": True, "completedAt": now}},
    )
    return {"ok": True, "inviterCredit": CUSTOMER_INVITER_REWARD, "invitedCredit": CUSTOMER_INVITED_REWARD}


async def complete_provider_referral(invited_provider_slug: str) -> dict:
    """Called on EVERY completed booking for an invited provider.
    Grants the inviter boost ONLY when invited provider reached 3 completed bookings.
    """
    if not invited_provider_slug:
        return {"ok": False, "reason": "no_slug"}
    use = await db.referral_uses.find_one({
        "invitedSlug": invited_provider_slug,
        "status": "pending",
        "rewardGranted": False,
        "ownerType": "provider",
    }, {"_id": 0})
    if not use:
        return {"ok": False, "reason": "no_pending_referral"}
    # Check completed bookings count for invited provider
    completes = await db.bookings.count_documents({
        "providerSlug": invited_provider_slug,
        "status": "completed",
    })
    if completes < PROVIDER_COMPLETES_REQUIRED:
        return {"ok": False, "reason": "not_enough_completes", "completes": completes, "required": PROVIDER_COMPLETES_REQUIRED}
    inviter_slug = use.get("ownerSlug")
    if not inviter_slug:
        return {"ok": False, "reason": "no_inviter_slug"}
    now = now_utc()
    # Extend or start boost on inviter's organization
    org = await db.organizations.find_one({"slug": inviter_slug}, {"_id": 0, "boostEndsAt": 1, "boostMultiplier": 1})
    starts = now
    current_ends = (org or {}).get("boostEndsAt")
    if current_ends:
        try:
            current_dt = datetime.fromisoformat(current_ends.replace("Z", "+00:00"))
            if current_dt > now:
                starts = current_dt  # extend from existing end
        except Exception:
            pass
    ends = starts + timedelta(days=PROVIDER_INVITER_BOOST_DAYS)
    mult = max(PROVIDER_INVITER_BOOST_MULT, float((org or {}).get("boostMultiplier", 1.0) or 1.0))
    await db.organizations.update_one(
        {"slug": inviter_slug},
        {"$set": {"boostLevel": "referral_reward", "boostMultiplier": mult, "boostEndsAt": ends.isoformat()}},
    )
    await db.provider_entitlements.update_one(
        {"providerSlug": inviter_slug},
        {"$set": {
            "providerSlug": inviter_slug, "boostActive": True,
            "boostLevel": "referral_reward", "boostMultiplier": mult,
            "boostEndsAt": ends.isoformat(), "updatedAt": now.isoformat(),
        }},
        upsert=True,
    )
    await db.referral_uses.update_one(
        {"id": use["id"]},
        {"$set": {
            "status": "completed", "rewardGranted": True,
            "completedAt": now.isoformat(), "rewardKind": "boost_7d_x1.5",
        }},
    )
    return {"ok": True, "inviter": inviter_slug, "boostDays": PROVIDER_INVITER_BOOST_DAYS,
            "multiplier": PROVIDER_INVITER_BOOST_MULT, "endsAt": ends.isoformat()}


# ── Endpoints ────────────────────────────────────────────────────────────


async def _user_from_token(request: Request) -> dict:
    auth = request.headers.get("authorization", "")
    if not auth.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    try:
        payload = _jwt.decode(auth[7:], JWT_SECRET, algorithms=[JWT_ALGO])
    except Exception:
        raise HTTPException(401, "Invalid token")
    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, "Unauthorized")
    user = await db.users.find_one({"_id": __to_oid(user_id)}, {"password": 0, "passwordHash": 0})
    if not user:
        raise HTTPException(401, "User not found")
    user["id"] = str(user.pop("_id"))
    return user


def __to_oid(s: str):
    from bson import ObjectId
    try:
        return ObjectId(s)
    except Exception:
        return s


@router.get("/api/referrals/my")
async def my_referral(request: Request):
    """Return my code + share URL + uses + reward stats."""
    user = await _user_from_token(request)
    code = await ensure_referral_code(user["id"], user)
    uses = await db.referral_uses.find({"code": code}, {"_id": 0}).sort("createdAt", -1).to_list(50)
    total_pending = sum(1 for u in uses if u.get("status") == "pending")
    total_completed = sum(1 for u in uses if u.get("status") == "completed")
    # Earned
    wallet_total = 0
    if user.get("role") == "customer" or not str(user.get("role", "")).startswith("provider"):
        credits = await db.wallet_credits.find({"userId": user["id"]}, {"_id": 0}).to_list(200)
        wallet_total = sum(int(c.get("amountUAH", 0) or 0) for c in credits)

    share_url = f"https://autosearch.app/invite/{code}"
    owner_type = "provider" if str(user.get("role", "")).startswith("provider") else "customer"
    reward_copy = (
        f"Приведи мастера → 7 дней × 1.5 буста бесплатно"
        if owner_type == "provider"
        else f"Пригласи друга → он получит ₴{CUSTOMER_INVITED_REWARD}, ты ₴{CUSTOMER_INVITER_REWARD} после его первого заказа"
    )
    return {
        "code": code,
        "shareUrl": share_url,
        "ownerType": owner_type,
        "totalUses": len(uses),
        "pending": total_pending,
        "completed": total_completed,
        "walletBalanceUAH": wallet_total,
        "rewardCopy": reward_copy,
        "urgencyDaysLeft": URGENCY_DAYS_LEFT,
        "recentUses": uses[:10],
    }


@router.post("/api/referrals/apply")
async def apply_my_code(request: Request):
    """Accept a referral code for the logged-in user (one-time)."""
    user = await _user_from_token(request)
    body = await request.json()
    code = (body.get("code") or "").strip().upper()
    if not code:
        raise HTTPException(400, "code required")
    ip = (request.headers.get("x-forwarded-for") or request.client.host if request.client else None) if request else None
    device = request.headers.get("x-device-id")
    owner_type = "provider" if str(user.get("role", "")).startswith("provider") else "customer"
    slug = user.get("providerSlug") if owner_type == "provider" else None
    res = await apply_referral_code(
        code=code,
        invited_user_id=user["id"] if owner_type == "customer" else None,
        invited_slug=slug,
        ip=ip,
        device_id=device,
    )
    return res


@router.get("/api/referrals/stats")
async def public_stats():
    """Public growth counters (for urgency banner)."""
    total_codes = await db.referrals.count_documents({})
    total_uses = await db.referral_uses.count_documents({})
    completed = await db.referral_uses.count_documents({"status": "completed"})
    return {
        "totalReferrers": total_codes,
        "totalInvites": total_uses,
        "completedInvites": completed,
        "urgencyDaysLeft": URGENCY_DAYS_LEFT,
        "campaignName": "Growth x10",
    }


@router.get("/api/admin/referrals", dependencies=[Depends(verify_admin_token)])
async def admin_referrals():
    """Admin dashboard — totals + top inviters + conversion rate."""
    total_users = await db.users.count_documents({})
    invited_users = await db.referral_uses.count_documents({})
    completed_users = await db.referral_uses.count_documents({"status": "completed"})
    total_credits = 0
    agg = await db.wallet_credits.aggregate([{"$group": {"_id": None, "sum": {"$sum": "$amountUAH"}}}]).to_list(1)
    if agg:
        total_credits = int(agg[0].get("sum", 0) or 0)
    conversion = (completed_users / invited_users) if invited_users else 0
    # Top inviters (sort by uses desc)
    top = await db.referrals.find({}, {"_id": 0}).sort("uses", -1).to_list(10)
    return {
        "totalUsers": total_users,
        "invitedUsers": invited_users,
        "completedInvites": completed_users,
        "conversionRate": round(conversion, 3),
        "creditsGrantedUAH": total_credits,
        "topInviters": top,
    }
