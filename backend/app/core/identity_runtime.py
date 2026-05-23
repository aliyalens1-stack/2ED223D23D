"""app.core.identity_runtime — Sprint 1C identity runtime.

ONE service. ONE source of truth for "who is the caller, what account are they
acting as, what can that account do". Every business endpoint that needs an
authorization check MUST go through this module — no exceptions, no
ad-hoc role checks scattered across `provider.py` / `repair.py` / `wash.py`.

Public contract (stable across 1C/1D/1E):
    get_user_accounts(user_id)       → list[Account]
    get_account(account_id)          → Account | None
    resolve_capabilities(account_id) → list[CapabilityVerb]
    get_active_account(user, requested_account_id=None) → Account
    issue_account_jwt(user, account) → str
    decode_and_resolve(request)      → IdentityContext  (used by middleware)

Sprint 1C runs in DUAL-READ mode:
  - PRIMARY:  read from new collections (accounts / account_capabilities)
  - FALLBACK: when no account row exists yet for a legacy user, synthesize one
              on the fly from `users.role`. This means EVERY caller works
              regardless of whether the migration script has run yet.

The fallback is what makes the migration script optional — code that goes
through this module never breaks.
"""
from __future__ import annotations
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Optional

import jwt
from bson import ObjectId
from fastapi import HTTPException, Request

from app.core.config import JWT_SECRET, JWT_ALGO
from app.core.db import get_db
from app.core.capability import (
    KNOWN_CAPABILITIES,
    ACCOUNT_KINDS,
    derive_capabilities_from_legacy,
    derive_account_kind_from_legacy,
)


# ─────────────────────────────────────────────────────────────────────────────
# In-memory shapes — what callers see
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class AccountView:
    """Shape returned to callers. Same fields whether the row came from the
    `accounts` collection or was synthesized from legacy users.role."""
    id: str
    userId: str
    kind: str                       # one of ACCOUNT_KINDS
    status: str = "active"
    displayName: str = ""
    avatar: Optional[str] = None
    publicSlug: Optional[str] = None
    organizationId: Optional[str] = None
    legacyRole: Optional[str] = None
    isPrimary: bool = True
    isLegacyShim: bool = False      # true when synthesized from users.role
    stats: dict = field(default_factory=dict)
    capabilities: list[str] = field(default_factory=list)

    def to_json(self) -> dict:
        return {
            "id": self.id,
            "userId": self.userId,
            "kind": self.kind,
            "status": self.status,
            "displayName": self.displayName,
            "avatar": self.avatar,
            "publicSlug": self.publicSlug,
            "organizationId": self.organizationId,
            "legacyRole": self.legacyRole,
            "isPrimary": self.isPrimary,
            "isLegacy": self.isLegacyShim,   # frontend hint: "compat mode"
            "stats": self.stats,
            "capabilities": self.capabilities,
        }


@dataclass
class IdentityContext:
    """Resolved request identity — what middleware passes downstream."""
    user_id: str
    user_email: str
    legacy_role: str                # for backwards compat ONLY
    account: AccountView            # currently active account
    capabilities: set[str]          # frozen set of action verbs
    is_legacy_shim: bool            # whether the account was synthesized

    def has(self, capability: str) -> bool:
        return capability in self.capabilities

    def has_any(self, *capabilities: str) -> bool:
        return any(c in self.capabilities for c in capabilities)


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers — collection access (no FastAPI imports below this line)
# ─────────────────────────────────────────────────────────────────────────────

def _user_doc_to_legacy_account(user_doc: dict) -> AccountView:
    """Synthesize an AccountView for users that haven't been migrated yet.
    The id is the user._id stringified — the same value 1A's /auth/me has been
    returning, so frontend continues to work transparently."""
    uid = str(user_doc["_id"])
    kind = derive_account_kind_from_legacy(user_doc)
    caps = derive_capabilities_from_legacy(user_doc)
    return AccountView(
        id=uid,                        # legacy shim: account id == user id
        userId=uid,
        kind=kind,
        status="active",
        displayName=(
            f"{user_doc.get('firstName', '')} {user_doc.get('lastName', '')}".strip()
            or user_doc.get("email", "")
        ),
        avatar=user_doc.get("avatar"),
        legacyRole=user_doc.get("role"),
        isPrimary=True,
        isLegacyShim=True,
        capabilities=caps,
    )


def _account_doc_to_view(acc_doc: dict, capabilities: list[str]) -> AccountView:
    return AccountView(
        id=str(acc_doc["_id"]),
        userId=str(acc_doc["userId"]),
        kind=acc_doc.get("kind", "customer"),
        status=acc_doc.get("status", "active"),
        displayName=acc_doc.get("displayName", ""),
        avatar=acc_doc.get("avatar"),
        publicSlug=acc_doc.get("publicSlug"),
        organizationId=acc_doc.get("organizationId"),
        legacyRole=acc_doc.get("legacyRole"),
        isPrimary=bool(acc_doc.get("isPrimary", True)),
        isLegacyShim=False,
        stats=acc_doc.get("stats") or {},
        capabilities=capabilities,
    )


async def _capabilities_for_account_id(account_id: str) -> list[str]:
    """Read account_capabilities for an account id. Returns sorted unique verbs."""
    db = get_db()
    cur = db.account_capabilities.find(
        {"accountId": account_id, "status": {"$in": ["verified", "pending"]}},
        {"_id": 0, "capability": 1, "status": 1},
    )
    caps: set[str] = set()
    async for row in cur:
        verb = row.get("capability")
        if verb in KNOWN_CAPABILITIES:
            caps.add(verb)
    return sorted(caps)


async def _user_doc_by_id(user_id: str) -> Optional[dict]:
    db = get_db()
    # users._id may be ObjectId or string — try both
    doc = None
    try:
        doc = await db.users.find_one({"_id": ObjectId(user_id)})
    except Exception:
        pass
    if doc is None:
        doc = await db.users.find_one({"_id": user_id})
    return doc


# ─────────────────────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────────────────────

async def ensure_account_for_user(user_doc: dict) -> AccountView:
    """Sprint 1C: idempotent — given a legacy `users` doc, make sure a real
    `accounts` row (and matching `account_capabilities` rows for professional
    kinds) exist. Returns the AccountView of the primary account.

    Used by:
      - `/auth/register` — right after creating a `users` row
      - any future code that ingests a user from an external source

    Same upsert logic as `scripts/migrate_users_to_accounts.py`. Keeping it
    here means the migration script and the live runtime never drift.
    """
    db = get_db()
    user_id = str(user_doc["_id"])
    legacy_role = (user_doc.get("role") or "customer").strip().lower()
    kind = derive_account_kind_from_legacy(user_doc)
    capabilities = derive_capabilities_from_legacy(user_doc)
    display_name = (
        f"{user_doc.get('firstName', '')} {user_doc.get('lastName', '')}".strip()
        or user_doc.get("email", "")
    )
    now = datetime.now(timezone.utc)

    result = await db.accounts.update_one(
        {"userId": user_id, "kind": kind},
        {
            "$setOnInsert": {
                "userId": user_id,
                "kind": kind,
                "status": "active",
                "displayName": display_name,
                "avatar": user_doc.get("avatar"),
                "legacyRole": legacy_role,
                "isPrimary": True,
                "stats": {
                    "rating": 0.0,
                    "reviewsCount": 0,
                    "completedJobs": 0,
                    "cancelledJobs": 0,
                    "earningsTotalCents": 0,
                },
                "createdAt": now,
            },
            "$set": {"updatedAt": now},
        },
        upsert=True,
    )
    if result.upserted_id is not None:
        account_id = str(result.upserted_id)
    else:
        existing = await db.accounts.find_one({"userId": user_id, "kind": kind}, {"_id": 1})
        account_id = str(existing["_id"])

    for verb in capabilities:
        await db.account_capabilities.update_one(
            {"accountId": account_id, "capability": verb},
            {
                "$setOnInsert": {
                    "accountId": account_id,
                    "capability": verb,
                    "status": "verified",
                    "specializations": [],
                    "verifiedAt": now,
                    "verifiedBy": "system:auth-register",
                    "createdAt": now,
                },
                "$set": {"updatedAt": now},
            },
            upsert=True,
        )

    acc = await get_account(account_id)
    if acc is None:
        # Defensive — should never happen after upsert
        raise RuntimeError(f"ensure_account_for_user: account {account_id} not retrievable")
    return acc


async def get_user_accounts(user_id: str) -> list[AccountView]:
    """All accounts owned by a user. Reads new `accounts` collection FIRST,
    falls back to legacy users.role synthesis when no account row exists.

    A single user may hold multiple accounts (customer + inspector + dealer
    on the same person). Returned in stable order: primary first, then by
    creation date."""
    db = get_db()
    cursor = db.accounts.find({"userId": user_id}).sort([("isPrimary", -1), ("createdAt", 1)])
    rows = [d async for d in cursor]
    if rows:
        # Real accounts exist — load capabilities for each.
        out: list[AccountView] = []
        for d in rows:
            caps = await _capabilities_for_account_id(str(d["_id"]))
            out.append(_account_doc_to_view(d, caps))
        return out
    # Fallback: synthesize a single legacy-shim account from users.role.
    udoc = await _user_doc_by_id(user_id)
    if not udoc:
        return []
    return [_user_doc_to_legacy_account(udoc)]


async def get_account(account_id: str) -> Optional[AccountView]:
    """Fetch a single account by id. Falls back to interpreting `account_id`
    as a legacy user-id when the new `accounts` collection has nothing yet."""
    db = get_db()
    # Try `accounts` collection first.
    doc = None
    try:
        doc = await db.accounts.find_one({"_id": ObjectId(account_id)})
    except Exception:
        pass
    if doc is None:
        doc = await db.accounts.find_one({"_id": account_id})
    if doc is not None:
        caps = await _capabilities_for_account_id(str(doc["_id"]))
        return _account_doc_to_view(doc, caps)
    # Fallback: maybe `account_id` is actually a legacy user_id (1A/1B JWTs).
    udoc = await _user_doc_by_id(account_id)
    if udoc is None:
        return None
    return _user_doc_to_legacy_account(udoc)


async def resolve_capabilities(account_id: str) -> list[str]:
    """SINGLE ENTRY POINT for capability resolution.
    Every business endpoint that needs to gate access by capability MUST call
    this — never hand-roll role/cap checks in feature modules.
    """
    acc = await get_account(account_id)
    if acc is None:
        return []
    return acc.capabilities


async def get_active_account(
    user_id: str,
    requested_account_id: Optional[str] = None,
) -> Optional[AccountView]:
    """Pick the user's active account.

    Priority:
      1. `requested_account_id` — if it exists AND belongs to the user.
      2. The user's primary account (isPrimary=True).
      3. The first account in the list.
      4. None — if the user has no accounts at all (defensive — should never
         happen because legacy fallback always synthesizes one).
    """
    accounts = await get_user_accounts(user_id)
    if not accounts:
        return None
    if requested_account_id:
        for a in accounts:
            if a.id == requested_account_id and a.userId == user_id:
                return a
        # fall through — requested account doesn't belong to user
    # primary first
    for a in accounts:
        if a.isPrimary:
            return a
    return accounts[0]


# ─────────────────────────────────────────────────────────────────────────────
# JWT issuance & decoding
# ─────────────────────────────────────────────────────────────────────────────

def issue_account_jwt(
    user_id: str,
    user_email: str,
    legacy_role: str,
    account: AccountView,
    days_valid: int = 7,
) -> str:
    """Mint a JWT bound to a (user, account) pair.

    Claims:
      sub        = user_id
      email      = user_email
      role       = legacy_role          (legacy compat — kept ≥3 releases)
      caps       = account.capabilities (forward — what this account can DO)
      accountId  = account.id           (forward — which account is active)
      kind       = account.kind         (forward — UI branching hint)

    Old clients that ignore caps/accountId/kind continue to work because role
    is still present. New code should consume caps/accountId.
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": user_id,
        "email": user_email,
        "role": legacy_role,
        "caps": account.capabilities,
        "accountId": account.id,
        "kind": account.kind,
        "iat": int(now.timestamp()),
        "exp": int((now + timedelta(days=days_valid)).timestamp()),
    }
    return jwt.encode(payload, JWT_SECRET, algorithm=JWT_ALGO)


async def decode_and_resolve(request: Request) -> IdentityContext:
    """Read JWT from Authorization header, decode it, and resolve the active
    account + capabilities ONCE per request.
    Use as a FastAPI dependency:
        async def endpoint(ctx = Depends(decode_and_resolve)):
            if not ctx.has('inspect'): raise HTTPException(403)
    """
    auth_header = request.headers.get("authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(401, "Unauthorized")
    token = auth_header[7:]
    try:
        payload = jwt.decode(token, JWT_SECRET, algorithms=[JWT_ALGO])
    except jwt.ExpiredSignatureError:
        raise HTTPException(401, "Token expired")
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Invalid token")

    user_id = payload.get("sub")
    if not user_id:
        raise HTTPException(401, "Invalid token (no sub)")

    requested_account_id = payload.get("accountId")
    account = await get_active_account(user_id, requested_account_id)
    if account is None:
        # Last-resort defensive path — shouldn't trigger because fallback
        # always synthesizes from users.role. Means the user record was
        # deleted between login and this request.
        raise HTTPException(401, "User has no resolvable account")

    return IdentityContext(
        user_id=user_id,
        user_email=payload.get("email", ""),
        legacy_role=(payload.get("role") or "").strip().lower(),
        account=account,
        capabilities=set(account.capabilities),
        is_legacy_shim=account.isLegacyShim,
    )


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI dependency that wraps decode_and_resolve + capability gate.
# Replaces the simpler `require_capability` from `core.capability`.
# ─────────────────────────────────────────────────────────────────────────────

def require_capability_v2(*capabilities: str):
    """Sprint 1C capability gate. Reads ALL caps from account_capabilities
    (with legacy fallback) — not just from the JWT — so caps granted AFTER
    the token was issued are honored without forcing a re-login.
    """
    if not capabilities:
        raise ValueError("require_capability_v2 needs at least one capability")
    required = set(capabilities)

    async def _dep(request: Request) -> IdentityContext:
        ctx = await decode_and_resolve(request)
        if not (required & ctx.capabilities):
            raise HTTPException(
                403,
                f"Forbidden: capability required ({', '.join(sorted(required))}). "
                f"Active caps: {sorted(ctx.capabilities) or 'none'}",
            )
        return ctx

    return _dep


def require_account_kind(*kinds: str):
    """Sprint 1D.2 principal gate.

    Use this when an endpoint is restricted to a particular *identity class*
    (customer, admin) rather than a *professional capability* (inspect, repair,
    wash, tow, sell). Capabilities ARE NOT what someone IS — they are what an
    account can DO professionally.

    Wrong:
        @router.get("/customer/credits")
        async def credits(... = Depends(require_capability_v2("buy"))):
            ...                # ← turns capabilities table into ACL trash

    Right:
        @router.get("/customer/credits")
        async def credits(ctx = Depends(require_account_kind("customer"))):
            ...

    Multiple kinds are OR-combined: `require_account_kind("customer", "admin")`
    lets either through. `require_admin()` is a thin sugar wrapper kept
    separate (defined below) so admin gates can later add stricter checks
    (2FA, IP allowlist, etc.) in one place.

    Returns the same `IdentityContext` as `require_capability_v2` so endpoint
    code reads `ctx.user_id` / `ctx.account.id` uniformly regardless of gate
    type.
    """
    if not kinds:
        raise ValueError("require_account_kind needs at least one kind")
    accepted = set(kinds)
    # Drift trap: surface a typo at boot, not at request time.
    unknown = accepted - set(ACCOUNT_KINDS)
    if unknown:
        raise ValueError(
            f"require_account_kind: unknown kinds {sorted(unknown)}; "
            f"valid kinds: {sorted(ACCOUNT_KINDS)}"
        )

    async def _dep(request: Request) -> IdentityContext:
        ctx = await decode_and_resolve(request)
        active_kind = ctx.account.kind if ctx.account else None
        if active_kind not in accepted:
            raise HTTPException(
                403,
                f"Forbidden: account kind required ({', '.join(sorted(accepted))}). "
                f"Active kind: {active_kind or 'none'}",
            )
        return ctx

    return _dep


def require_admin():
    """Sprint 1D.3 admin governance gate — sugar over `require_account_kind("admin")`.

    Why a separate helper instead of just calling `require_account_kind("admin")`:
      - Admin is *governance identity*, not a marketplace actor. A separate
        symbol expresses intent: "this endpoint is for platform operators".
      - Future stricter checks (2FA, IP allowlist, audit log on every call,
        time-bounded sessions) belong here in ONE place. We add them once,
        and every admin endpoint inherits.
      - Distinct from professional capability gates — `require_capability_v2`
        is for `inspect`/`repair`/etc; `require_admin()` is for governance.
        Capability table never grows an `admin` row.

    Returns an `IdentityContext` (same shape as the other gates) so endpoint
    handlers read `ctx.user_id` / `ctx.user_email` consistently.

    Usage:
        @router.get("/admin/zones")
        async def admin_zones(ctx = Depends(require_admin())):
            ...
    """
    inner = require_account_kind("admin")

    async def _dep(request: Request) -> IdentityContext:
        ctx = await inner(request)
        # Reserved hook — future stricter admin checks land here:
        #   if not _admin_2fa_ok(request): raise HTTPException(403, "2FA required")
        #   if not _admin_ip_allowed(request): raise HTTPException(403, "IP blocked")
        #   await _audit_admin_call(ctx, request)
        return ctx

    return _dep


__all__ = [
    "AccountView",
    "IdentityContext",
    "ensure_account_for_user",
    "get_user_accounts",
    "get_account",
    "resolve_capabilities",
    "get_active_account",
    "issue_account_jwt",
    "decode_and_resolve",
    "require_capability_v2",
    "require_account_kind",
    "require_admin",
]
