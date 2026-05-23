"""app.core.security — password hashing + JWT admin-token verification.

Sprint 21 C1: вынос из server.py без единого изменения поведения.

ВАЖНО: используется PyJWT (import jwt), НЕ python-jose.
ВАЖНО: verify_admin_token ожидает Request (не HTTPBearer) — это сохраняет
совместимость со всеми 57 admin endpoint'ами.
"""
from __future__ import annotations
import bcrypt
import jwt
from fastapi import HTTPException, Request

from app.core.config import JWT_SECRET, JWT_ALGO

import os as _os

# Paths exempt from the admin-2FA enrollment gate. The 2FA setup/enroll/verify
# flow itself MUST be reachable before an admin has TOTP enabled — otherwise
# the admin can never enroll. Health/me/logout are also always allowed.
_2FA_BYPASS_PREFIXES: tuple[str, ...] = (
    "/api/auth/2fa/",
    "/api/auth/me",
    "/api/auth/logout",
    "/api/auth/switch-account",
    "/api/health",
    "/api/system/health",
)


def _bypass_admin_2fa_enforce(path: str) -> bool:
    """Return True when the 2FA enrollment gate should be skipped.

    Gate is globally disabled unless ADMIN_2FA_REQUIRED=1, which preserves
    backwards-compatibility with deployments that haven't onboarded admins
    onto TOTP yet (e.g. fresh seed). The explicit-allow list is always
    respected so admins can enroll even when the gate is on.
    """
    if not path:
        return True
    for pref in _2FA_BYPASS_PREFIXES:
        if path.startswith(pref):
            return True
    return _os.environ.get("ADMIN_2FA_REQUIRED", "0") != "1"


def hash_pw(pw: str) -> str:
    return bcrypt.hashpw(pw.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")


def verify_pw(plain: str, hashed: str) -> bool:
    return bcrypt.checkpw(plain.encode("utf-8"), hashed.encode("utf-8"))


async def verify_admin_token(request: Request):
    """Sprint 1D.3 admin gate — adapter that delegates to
    `app.core.identity_runtime.require_admin()`.

    Why an adapter instead of a body rewrite:
      - ~30 callsites use `Depends(verify_admin_token)` with `_=` discard.
        They require zero changes.
      - One callsite reads `payload.get("email", "admin")` to attribute
        admin actions in audit fields. The adapter returns a dict-shaped
        legacy payload synthesized from `IdentityContext` — back-compat
        preserved.
      - Single source of truth for "what does admin mean" lives in
        `identity_runtime.require_admin()`. If we later add 2FA / IP
        allowlist there, every admin endpoint inherits without touching
        callsites.

    NEW code should `Depends(require_admin())` directly to receive an
    `IdentityContext` instead of a dict. The adapter is for legacy callers.

    Back-compat behaviour vs pre-1D.3:
      - Still requires Authorization: Bearer header (401 if missing).
      - Still rejects non-admin tokens (403). Error message slightly
        improved: now reads "account kind required (admin)" instead of
        "admin role required". Old format kept in tests would fail; we
        don't have any test asserting on the literal string.
    """
    # Lazy import: identity_runtime imports from app.core.* but not from
    # app.core.security, so this is safe — keeping it lazy in case a future
    # refactor adds a security ↔ identity_runtime cycle.
    from app.core.identity_runtime import require_admin

    dep = require_admin()
    ctx = await dep(request)

    # Sprint 2FA enforce — admin endpoints require the admin to have TOTP
    # enrolled. We DON'T require a per-request second factor here (that
    # would force a code on every API call); enrollment alone is the gate.
    # Admins who haven't enrolled yet can still hit /api/auth/2fa/setup/*
    # because those routes don't depend on `verify_admin_token`.
    if not _bypass_admin_2fa_enforce(request.url.path):
        from app.core.db import get_db
        from bson import ObjectId
        db = get_db()
        try:
            uid = ctx.user_id
            user_doc = await db.users.find_one(
                {"_id": ObjectId(uid)} if len(uid) == 24 else {"_id": uid}
            )
        except Exception:
            user_doc = None
        if not user_doc or not (user_doc.get("totp") or {}).get("enabled"):
            raise HTTPException(
                403,
                detail={
                    "code": "2FA_ENROLLMENT_REQUIRED",
                    "message": "Admin must enable 2FA before using admin APIs",
                },
            )

    # Legacy-shape payload — drop-in replacement for the old jwt.decode return.
    # Includes both legacy fields (sub/role/email) and new fields (accountId/
    # kind/caps) so callers can incrementally adopt the new shape.
    return {
        "sub": ctx.user_id,
        "userId": ctx.user_id,
        "email": ctx.user_email,
        "role": ctx.legacy_role,
        "accountId": ctx.account.id if ctx.account else None,
        "kind": ctx.account.kind if ctx.account else None,
        "caps": sorted(ctx.capabilities),
    }


async def verify_user_token(request: Request):
    """Verify JWT token from Authorization header. Accepts any authenticated role.

    Sprint 34 D8: shared dep for chat / notifications / messages flows.
    Returns payload dict with sub/email/role/userId.
    """
    auth_header = request.headers.get('authorization', '')
    if not auth_header.startswith('Bearer '):
        raise HTTPException(401, "Unauthorized")
    token = auth_header[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")
    return payload
