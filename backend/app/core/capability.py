"""app.core.capability — Sprint 1A compatibility abstraction layer.

Goal of Sprint 1A: introduce capability-aware helpers and middleware WITHOUT
changing existing data, JWT format (other than additive `caps`/`accountId`
fields), or breaking any current `users.role`-based endpoint.

Architecture being prepared (Sprint 1B onward):
    PERSON   → users         (identity)
    ACCOUNT  → accounts      (operational context — kind: inspector|service_provider|dealer|transport_provider)
    PERMISSION → account_capabilities  (capability: inspect|repair|wash|tow|transport|sell — verbs, domain-agnostic)
    ORG     → organizations  (teams)

Naming rule (1B refinement):
  - Account.kind = the BUSINESS PERSONA (a noun: who you are)
  - Capability.capability = the ACTION VERB (what you can DO)
This keeps capabilities reusable across vehicle / motorcycle / truck / marine
verticals — `inspect` works for all of them, `vehicle_inspector` would not.

In Sprint 1A `accounts`/`account_capabilities`/`organizations` collections do NOT
exist yet. Helpers below DERIVE caps and an "active account" snapshot from the
legacy `users.role` field. When 1B/1C land, the same helpers will read from the
new collections — call sites will not change.

All public helpers MUST be safe to call with legacy-only data. Never raise
because new collections are missing — fall back to legacy.
"""
from __future__ import annotations
from typing import Iterable, Optional

import jwt
from fastapi import HTTPException, Request

from app.core.config import JWT_SECRET, JWT_ALGO


# ─────────────────────────────────────────────────────────────────────────────
# Vocabulary (single source of truth)
# ─────────────────────────────────────────────────────────────────────────────

# Capability = ACTION VERB. What an account can do. Domain-agnostic on purpose
# so future verticals (motorcycle / truck / marine) can reuse the same set.
KNOWN_CAPABILITIES: tuple[str, ...] = (
    "inspect",     # buying advisor / pre-purchase inspection
    "repair",      # mechanic / workshop / service
    "wash",        # detailing / cleaning
    "tow",         # roadside assistance / evacuation
    "transport",   # delivery / import / long-haul logistics
    "sell",        # dealer / showroom
)

# Account.kind = BUSINESS PERSONA (who you are). Plus 2 synthetic principals.
ACCOUNT_KINDS: tuple[str, ...] = (
    # principals — not professional accounts, used for /auth/me UI branching
    "customer",
    "admin",
    # professional account kinds
    "inspector",
    "service_provider",
    "dealer",
    "transport_provider",
)

# Backwards-compat alias retained for any 1A callers that already imported it.
KNOWN_CAPABILITY_KINDS: tuple[str, ...] = KNOWN_CAPABILITIES
SYNTHETIC_PRINCIPALS: tuple[str, ...] = ("customer", "admin")


# ─────────────────────────────────────────────────────────────────────────────
# Legacy → capabilities derivation (Sprint 1A core)
# ─────────────────────────────────────────────────────────────────────────────

# Map legacy users.role values to ACTION VERB capabilities.
# Rule of thumb: every existing 'provider*' user can `inspect` until 1C
# migration proves otherwise (matches the current single-product reality).
_LEGACY_ROLE_TO_CAPS: dict[str, tuple[str, ...]] = {
    "provider": ("inspect",),
    "provider_owner": ("inspect",),
    "inspector": ("inspect",),
    "service_provider": ("repair",),
    "dealer": ("sell",),
    "transport": ("transport",),
    "transport_provider": ("transport",),
    # customer / admin → no capability (they are principals, not professionals)
    "customer": (),
    "admin": (),
}

# Map legacy users.role → account.kind (the business persona). Used only to
# build the activeAccount snapshot in 1A; 1C migration will set this on real
# accounts collection.
_LEGACY_ROLE_TO_ACCOUNT_KIND: dict[str, str] = {
    "provider": "inspector",
    "provider_owner": "inspector",
    "inspector": "inspector",
    "service_provider": "service_provider",
    "dealer": "dealer",
    "transport": "transport_provider",
    "transport_provider": "transport_provider",
    "customer": "customer",
    "admin": "admin",
}


def derive_capabilities_from_legacy(user_doc: Optional[dict]) -> list[str]:
    """Given a legacy users document, return capability ACTION VERBS it grants."""
    if not user_doc:
        return []
    role = (user_doc.get("role") or "").strip().lower()
    return list(_LEGACY_ROLE_TO_CAPS.get(role, ()))


def derive_account_kind_from_legacy(user_doc: Optional[dict]) -> str:
    """Given a legacy users document, return the account.kind (business persona)."""
    if not user_doc:
        return "customer"
    role = (user_doc.get("role") or "customer").strip().lower()
    return _LEGACY_ROLE_TO_ACCOUNT_KIND.get(role, "customer")


def derive_active_account_id(user_doc: Optional[dict]) -> Optional[str]:
    """Return the user's currently-active account id.

    Sprint 1A: there's no `accounts` collection yet, so the "account" is just
    the user themselves. We return `users._id` as a stable handle. Sprint 1C
    will replace this with a real `accounts._id` after migration.
    """
    if not user_doc:
        return None
    _id = user_doc.get("_id")
    return str(_id) if _id is not None else user_doc.get("id")


def build_active_account_snapshot(user_doc: Optional[dict]) -> Optional[dict]:
    """Synthesize the active-account blob used by `/auth/me` and the UI
    account-mode switcher. Shape is the SAME we will return from `accounts`
    in 1C, so frontend can be written against this contract today.
    """
    if not user_doc:
        return None
    caps = derive_capabilities_from_legacy(user_doc)
    kind = derive_account_kind_from_legacy(user_doc)
    return {
        "id": derive_active_account_id(user_doc),
        "kind": kind,                # 'inspector' / 'service_provider' / 'customer' / ...
        "displayName": (
            f"{user_doc.get('firstName', '')} {user_doc.get('lastName', '')}".strip()
            or user_doc.get("email", "")
        ),
        "capabilities": caps,        # action verbs — what this account can DO
        "isLegacy": True,            # 1A flag — frontend can show "compat mode" hint
    }


# ─────────────────────────────────────────────────────────────────────────────
# Public predicates
# ─────────────────────────────────────────────────────────────────────────────

def has_capability(user_doc_or_payload: Optional[dict], capability: str) -> bool:
    """Does the account have the given capability (action verb)?

    Accepts either a raw `users` document OR a JWT payload dict (which may
    already carry a `caps` array set by the login endpoint in 1A or later).
    Falls back to legacy role derivation when caps are absent.
    """
    if not user_doc_or_payload or not capability:
        return False
    # 1) JWT payload path — `caps` claim added by login in Sprint 1A
    caps = user_doc_or_payload.get("caps")
    if isinstance(caps, list):
        return capability in caps
    # 2) Raw users-collection doc path
    return capability in derive_capabilities_from_legacy(user_doc_or_payload)


def has_any_capability(user_doc_or_payload: Optional[dict], capabilities: Iterable[str]) -> bool:
    return any(has_capability(user_doc_or_payload, c) for c in capabilities)


# ─────────────────────────────────────────────────────────────────────────────
# FastAPI dependency — capability-aware middleware
# ─────────────────────────────────────────────────────────────────────────────

def require_capability(*capabilities: str):
    """FastAPI dependency factory — capability gate.

    Sprint 1C: this is now a thin **adapter** that delegates to
    `app.core.identity_runtime.require_capability_v2`. V1 and V2 are no longer
    parallel authorization universes — there is ONE capability resolver:
    `identity_runtime.resolve_capabilities()`. V1 is retained so existing import
    paths keep working; new code should import from `identity_runtime` directly.

    Behaviour change vs Sprint 1A: the dep now reads caps from the
    `account_capabilities` collection (with legacy `users.role` fallback) and
    returns a full `IdentityContext`, not a raw JWT payload. This means caps
    granted AFTER the token was issued are honored without re-login.

    Lazy import below avoids the `capability ↔ identity_runtime` circular
    (identity_runtime imports vocabulary from this file).
    """
    if not capabilities:
        raise ValueError("require_capability needs at least one capability")
    # Local import — `identity_runtime` imports KNOWN_CAPABILITIES/ACCOUNT_KINDS
    # from this module at its own load time, so we cannot import at top-level.
    from app.core.identity_runtime import require_capability_v2
    return require_capability_v2(*capabilities)


__all__ = [
    "KNOWN_CAPABILITIES",
    "KNOWN_CAPABILITY_KINDS",        # legacy alias
    "ACCOUNT_KINDS",
    "SYNTHETIC_PRINCIPALS",
    "derive_capabilities_from_legacy",
    "derive_account_kind_from_legacy",
    "derive_active_account_id",
    "build_active_account_snapshot",
    "has_capability",
    "has_any_capability",
    "require_capability",
]
