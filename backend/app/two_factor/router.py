"""app.two_factor.router — /api/auth/2fa/* endpoints.

Setup, confirm, disable, verify (second-step login), status, regenerate.
"""
from __future__ import annotations
import logging
from datetime import datetime, timedelta, timezone

from bson import ObjectId
from fastapi import APIRouter, HTTPException, Request

from app.core.db import get_db
from app.core.security import verify_pw, verify_user_token
from app.core.identity_runtime import (
    ensure_account_for_user,
    get_user_accounts,
    get_active_account,
    issue_account_jwt,
)
from app.two_factor.service import (
    generate_secret,
    build_provisioning_uri,
    qr_code_base64,
    encrypt_secret,
    verify_code,
    verify_recovery_code,
    generate_recovery_code_batch,
    generate_challenge_token,
)

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/auth/2fa", tags=["2fa"])

# how long a challenge is valid (login second-step window)
CHALLENGE_TTL_SECONDS = 300  # 5 min
MAX_VERIFY_ATTEMPTS = 5


def _to_object_id(uid: str):
    try:
        return ObjectId(uid)
    except Exception:
        return uid


async def _get_user(db, user_id: str):
    oid = _to_object_id(user_id)
    user = await db.users.find_one({"_id": oid})
    if not user and isinstance(oid, ObjectId):
        user = await db.users.find_one({"_id": user_id})
    return user


async def _current_user(request: Request):
    payload = await verify_user_token(request)
    user_id = payload.get("sub") or payload.get("userId")
    if not user_id:
        raise HTTPException(401, "Unauthorized")
    db = get_db()
    user = await _get_user(db, user_id)
    if not user:
        raise HTTPException(401, "User not found")
    return user


def _public_view(user_doc: dict) -> dict:
    return {
        "id": str(user_doc["_id"]),
        "email": user_doc["email"],
        "firstName": user_doc.get("firstName", ""),
        "lastName": user_doc.get("lastName", ""),
        "role": user_doc.get("role", "customer"),
    }


# ─── GET /status ────────────────────────────────────────────────────────
@router.get("/status")
async def status(request: Request):
    user = await _current_user(request)
    cfg = user.get("totp") or {}
    rc = cfg.get("recoveryCodes") or []
    return {
        "enabled": bool(cfg.get("enabled")),
        "createdAt": cfg.get("createdAt").isoformat() if cfg.get("createdAt") else None,
        "lastVerifiedAt": cfg.get("lastVerifiedAt").isoformat() if cfg.get("lastVerifiedAt") else None,
        "recoveryCodesRemaining": sum(1 for c in rc if not c.get("used")),
    }


# ─── POST /setup/start ──────────────────────────────────────────────────
@router.post("/setup/start")
async def setup_start(request: Request):
    user = await _current_user(request)
    if (user.get("totp") or {}).get("enabled"):
        raise HTTPException(400, "2FA already enabled — disable it first to re-setup")

    secret = generate_secret()
    uri = build_provisioning_uri(secret, account_label=user["email"])
    qr = qr_code_base64(uri)

    db = get_db()
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {
            "totpSetup": {
                "secretEncrypted": encrypt_secret(secret),
                "createdAt": datetime.now(timezone.utc),
            }
        }},
    )

    return {
        "secret": secret,         # shown ONCE for manual entry fallback
        "otpauthUri": uri,
        "qrPngBase64": qr,
        "issuer": "Auto Search",
        "account": user["email"],
        "digits": 6,
        "period": 30,
    }


# ─── POST /setup/confirm ────────────────────────────────────────────────
@router.post("/setup/confirm")
async def setup_confirm(request: Request):
    user = await _current_user(request)
    body = await request.json()
    code = (body.get("code") or "").strip()
    if not code:
        raise HTTPException(400, "code is required")

    setup = user.get("totpSetup")
    if not setup or not setup.get("secretEncrypted"):
        raise HTTPException(400, "no setup in progress — call /setup/start first")

    if not verify_code(setup["secretEncrypted"], code):
        raise HTTPException(400, "Invalid code — make sure the time on your phone is correct")

    plain_codes, stored = generate_recovery_code_batch()
    now = datetime.now(timezone.utc)
    db = get_db()
    await db.users.update_one(
        {"_id": user["_id"]},
        {
            "$set": {
                "totp": {
                    "enabled": True,
                    "secretEncrypted": setup["secretEncrypted"],
                    "createdAt": now,
                    "lastVerifiedAt": now,
                    "recoveryCodes": stored,
                }
            },
            "$unset": {"totpSetup": ""},
        },
    )
    return {
        "enabled": True,
        "recoveryCodes": plain_codes,  # SHOWN ONCE — store securely!
        "createdAt": now.isoformat(),
    }


# ─── POST /disable ──────────────────────────────────────────────────────
@router.post("/disable")
async def disable(request: Request):
    user = await _current_user(request)
    body = await request.json()
    password = (body.get("password") or "")
    code = (body.get("code") or "").strip()
    recovery = (body.get("recoveryCode") or "").strip()

    # Sprint 2FA enforce — admins MUST keep 2FA on. To remove 2FA from an
    # admin account a different admin must downgrade the role first.
    if (user.get("role") or "").lower() == "admin":
        raise HTTPException(
            403,
            "Admin accounts must keep 2FA enabled. Contact another admin to change role first.",
        )

    if not password:
        raise HTTPException(400, "password is required")
    if not verify_pw(password, user.get("passwordHash", "")):
        raise HTTPException(401, "Invalid password")
    if not code and not recovery:
        raise HTTPException(400, "TOTP code or recovery code is required")

    cfg = user.get("totp") or {}
    if not cfg.get("enabled"):
        return {"enabled": False, "alreadyDisabled": True}

    if code and not verify_code(cfg.get("secretEncrypted", ""), code):
        raise HTTPException(401, "Invalid TOTP code")
    if recovery and not any(
        not c.get("used") and verify_recovery_code(recovery, c.get("codeHash", ""))
        for c in (cfg.get("recoveryCodes") or [])
    ):
        raise HTTPException(401, "Invalid recovery code")

    db = get_db()
    await db.users.update_one(
        {"_id": user["_id"]},
        {
            "$set": {"totp.enabled": False},
            "$unset": {"totp.secretEncrypted": "", "totp.recoveryCodes": ""},
        },
    )
    return {"enabled": False}


# ─── POST /recovery/regenerate ──────────────────────────────────────────
@router.post("/recovery/regenerate")
async def recovery_regenerate(request: Request):
    user = await _current_user(request)
    body = await request.json()
    code = (body.get("code") or "").strip()
    cfg = user.get("totp") or {}
    if not cfg.get("enabled"):
        raise HTTPException(400, "2FA not enabled")
    if not verify_code(cfg.get("secretEncrypted", ""), code):
        raise HTTPException(401, "Invalid TOTP code")

    plain, stored = generate_recovery_code_batch()
    db = get_db()
    await db.users.update_one(
        {"_id": user["_id"]},
        {"$set": {"totp.recoveryCodes": stored}},
    )
    return {"recoveryCodes": plain}


# ─── POST /verify (second-step login) ───────────────────────────────────
@router.post("/verify")
async def verify(request: Request):
    """Complete a 2FA login challenge.

    Body: { challengeToken, code? OR recoveryCode? }
    Returns: full login payload (accessToken/user/accounts/activeAccount)
    """
    body = await request.json()
    token = (body.get("challengeToken") or "").strip()
    code = (body.get("code") or "").strip()
    recovery = (body.get("recoveryCode") or "").strip()
    if not token:
        raise HTTPException(400, "challengeToken is required")
    if not code and not recovery:
        raise HTTPException(400, "code or recoveryCode is required")

    db = get_db()
    ch = await db.totp_challenges.find_one({"challengeToken": token})
    if not ch:
        raise HTTPException(400, "Invalid or expired challenge")
    if ch.get("completed"):
        raise HTTPException(400, "Challenge already used")
    if ch.get("expiresAt"):
        exp = ch["expiresAt"]
        if exp.tzinfo is None:
            exp = exp.replace(tzinfo=timezone.utc)
        if exp < datetime.now(timezone.utc):
            raise HTTPException(400, "Challenge expired")
    if (ch.get("attempts") or 0) >= MAX_VERIFY_ATTEMPTS:
        raise HTTPException(429, "Too many failed attempts — request a new challenge")

    user = await _get_user(db, ch["userId"])
    if not user:
        raise HTTPException(400, "User not found")

    cfg = user.get("totp") or {}
    if not cfg.get("enabled") or not cfg.get("secretEncrypted"):
        raise HTTPException(400, "2FA not enabled for this user")

    used_recovery_idx = None
    ok = False
    if code:
        ok = verify_code(cfg["secretEncrypted"], code)
    elif recovery:
        for i, rc in enumerate(cfg.get("recoveryCodes") or []):
            if not rc.get("used") and verify_recovery_code(recovery, rc.get("codeHash", "")):
                used_recovery_idx = i
                ok = True
                break

    if not ok:
        await db.totp_challenges.update_one(
            {"_id": ch["_id"]},
            {"$inc": {"attempts": 1}},
        )
        raise HTTPException(401, "Invalid code")

    now = datetime.now(timezone.utc)
    update: dict = {"totp.lastVerifiedAt": now}
    if used_recovery_idx is not None:
        update[f"totp.recoveryCodes.{used_recovery_idx}.used"] = True
        update[f"totp.recoveryCodes.{used_recovery_idx}.usedAt"] = now
    await db.users.update_one({"_id": user["_id"]}, {"$set": update})
    await db.totp_challenges.update_one(
        {"_id": ch["_id"]},
        {"$set": {"completed": True, "completedAt": now}},
    )

    # Issue the real JWT — identical to /auth/login success path.
    user_id = str(user["_id"])
    await ensure_account_for_user(user)
    accounts = await get_user_accounts(user_id)
    active = await get_active_account(user_id, requested_account_id=None)
    if active is None:
        raise HTTPException(500, "Failed to resolve active account")
    access_token = issue_account_jwt(
        user_id=user_id,
        user_email=user["email"],
        legacy_role=user.get("role", "customer"),
        account=active,
    )
    return {
        "accessToken": access_token,
        "user": _public_view(user),
        "accounts": [a.to_json() for a in accounts],
        "activeAccount": active.to_json(),
        "usedRecoveryCode": used_recovery_idx is not None,
    }


# ─── helper used by /api/auth/login ─────────────────────────────────────
async def create_challenge(db, user_doc: dict) -> dict:
    """Create a fresh challenge for a user with 2FA enabled.

    Called from the legacy /api/auth/login when totp.enabled is true.
    """
    token = generate_challenge_token()
    expires = datetime.now(timezone.utc) + timedelta(seconds=CHALLENGE_TTL_SECONDS)
    await db.totp_challenges.insert_one({
        "challengeToken": token,
        "userId": str(user_doc["_id"]),
        "type": "login",
        "createdAt": datetime.now(timezone.utc),
        "expiresAt": expires,
        "completed": False,
        "attempts": 0,
    })
    return {
        "requires2FA": True,
        "challengeToken": token,
        "expiresAt": expires.isoformat(),
        "method": "totp",
    }


async def ensure_indexes():
    """Idempotent — TTL index for auto-cleanup of expired challenges."""
    db = get_db()
    try:
        await db.totp_challenges.create_index("challengeToken", unique=True)
        await db.totp_challenges.create_index("expiresAt", expireAfterSeconds=0)
        logger.info("two_factor: indexes ready on totp_challenges")
    except Exception as e:
        logger.warning(f"two_factor.ensure_indexes failed: {e}")
