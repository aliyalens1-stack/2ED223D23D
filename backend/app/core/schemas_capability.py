"""app.core.schemas_capability — Sprint 1B forward-compatible schemas.

These Pydantic models describe the SHAPE of documents that will live in the
new collections (`accounts`, `account_capabilities`, `organizations`,
`specializations`). They are NOT bound to a single ORM — Mongo documents are
plain dicts, but Pydantic gives us:

  - One source of truth for the field names everyone has to agree on.
  - Validation when (later) endpoints accept payloads.
  - Stable JSON contract for `/api/auth/me.activeAccount` regardless of
    whether the data came from legacy `users.role` or the new collections.

Naming rule (1B contract):
  - account.kind = BUSINESS PERSONA (noun: who you are)
      'customer' | 'admin' | 'inspector' | 'service_provider' | 'dealer' | 'transport_provider'
  - account_capability.capability = ACTION VERB (what you can DO)
      'inspect' | 'repair' | 'wash' | 'tow' | 'transport' | 'sell'
  - specialization._id = STABLE ENUM ID (lowercase ASCII, no spaces)
      'bmw' / 'ev' / 'accident_detection' (NEVER user-typed strings)

Goal of 1B = future-proof contracts. NOT migration. Empty collections + indexes
+ seed for `specializations` only.
"""
from __future__ import annotations
from datetime import datetime, timezone
from typing import Literal, Optional

from pydantic import BaseModel, Field

from app.core.capability import KNOWN_CAPABILITIES, ACCOUNT_KINDS


# ─────────────────────────────────────────────────────────────────────────────
# accounts collection
# ─────────────────────────────────────────────────────────────────────────────

AccountKind = Literal[
    "customer",
    "admin",
    "inspector",
    "service_provider",
    "dealer",
    "transport_provider",
]
AccountStatus = Literal["pending", "active", "suspended", "archived"]


class AccountStats(BaseModel):
    """Aggregate counters that are denormalized onto the account doc for fast reads.
    Source of truth lives elsewhere (reviews, jobs, payouts) — these are recomputed
    by background loops, never directly written by request handlers."""
    rating: float = 0.0          # 0.0–5.0
    reviewsCount: int = 0
    completedJobs: int = 0
    cancelledJobs: int = 0
    earningsTotalCents: int = 0  # store money in cents to avoid float drift


class Account(BaseModel):
    """Operational context. NOT a business/legal entity — that's `organizations`.

    A single `users` row may own multiple accounts (e.g. one inspector account +
    one workshop account on the same person). Switching the active account is
    a session-level concern (`accountId` claim in JWT)."""
    id: Optional[str] = Field(default=None, alias="_id")
    userId: str
    kind: AccountKind
    status: AccountStatus = "pending"

    displayName: str
    avatar: Optional[str] = None              # base64 or URL — frontend-agnostic
    publicSlug: Optional[str] = None          # for `/i/<slug>` public profile

    organizationId: Optional[str] = None      # optional FK → organizations
    legacyRole: Optional[str] = None          # the old users.role at migration time
    isPrimary: bool = True                    # the default account on login

    stats: AccountStats = Field(default_factory=AccountStats)

    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updatedAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        populate_by_name = True


# ─────────────────────────────────────────────────────────────────────────────
# account_capabilities collection
# ─────────────────────────────────────────────────────────────────────────────

CapabilityVerb = Literal["inspect", "repair", "wash", "tow", "transport", "sell"]
CapabilityStatus = Literal["pending", "verified", "suspended"]


class AccountCapability(BaseModel):
    """One row per (account × capability). KEEP THIS THIN.

    Specializations are referenced by stable ID (e.g. 'bmw'), NEVER by free text.
    The label / aliases / search tokens live on the `specializations` doc, not here.
    Rating / earnings live on `accounts.stats`, not here. This collection is a pure
    permission/skill layer — what the account can DO and how well it's verified.
    """
    id: Optional[str] = Field(default=None, alias="_id")
    accountId: str
    capability: CapabilityVerb
    status: CapabilityStatus = "pending"

    # Stable IDs from the `specializations` collection — never free text.
    specializations: list[str] = Field(default_factory=list)

    # Optional metadata that's intrinsic to the capability assignment.
    verifiedAt: Optional[datetime] = None
    verifiedBy: Optional[str] = None     # admin user_id

    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updatedAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        populate_by_name = True


# ─────────────────────────────────────────────────────────────────────────────
# account_organizations collection (Sprint 1B-named to avoid clash with the
# legacy `organizations` workshop directory. 1C may merge them.)
# ─────────────────────────────────────────────────────────────────────────────

OrganizationType = Literal["agency", "workshop", "dealer", "network", "fleet"]


class OrganizationMember(BaseModel):
    """Membership row in `organization_members` collection.
    Kept as a separate collection (not embedded in organizations.members[])
    because at scale (1 org × N members × M role-changes) embedded arrays
    become hot documents."""
    id: Optional[str] = Field(default=None, alias="_id")
    organizationId: str
    userId: str
    accountId: Optional[str] = None       # which of the user's accounts is the org member (optional)
    role: Literal["owner", "manager", "staff"]
    invitedBy: Optional[str] = None       # user_id of inviter
    joinedAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    leftAt: Optional[datetime] = None     # null = still active

    class Config:
        populate_by_name = True


class Organization(BaseModel):
    """A team / business / network of accounts. Intentionally minimal in 1B.
    Membership lives in `organization_members` collection (not embedded), so
    `members` here is left as a transient projection, never written to Mongo."""
    id: Optional[str] = Field(default=None, alias="_id")
    type: OrganizationType
    name: str
    slug: str
    ownerUserId: str

    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    updatedAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        populate_by_name = True


# ─────────────────────────────────────────────────────────────────────────────
# specializations collection (CONTROLLED VOCABULARY)
# ─────────────────────────────────────────────────────────────────────────────

SpecializationCategory = Literal[
    "brand",            # bmw, mercedes, porsche, audi, vw, opel
    "powertrain",       # ev, hybrid, diesel, gasoline, lpg
    "vehicle_class",    # classic, motorcycle, truck, van
    "service_type",     # accident_detection, mileage_fraud, paint_thickness
    "trust_signal",     # tuv_certified, dekra_certified, master_mechanic
    "geographic",       # eu_import, ru_import
]


class Specialization(BaseModel):
    """Stable enum entry. The `_id` is the canonical ID used everywhere
    (account_capabilities.specializations, request filters, search tokens).
    Frontend renders `labels[locale]`. Aliases are matched on parser ingest."""
    id: str = Field(alias="_id")               # stable, lowercase ASCII, no spaces
    category: SpecializationCategory
    labels: dict[str, str] = Field(default_factory=dict)   # {'en': '...', 'de': '...', 'ru': '...'}
    aliases: list[str] = Field(default_factory=list)        # free-form variants seen in the wild
    searchTokens: list[str] = Field(default_factory=list)   # normalized search keywords
    active: bool = True
    sortOrder: int = 0
    createdAt: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))

    class Config:
        populate_by_name = True


# ─────────────────────────────────────────────────────────────────────────────
# Internal sanity — make sure literals stay in sync with capability.py constants
# ─────────────────────────────────────────────────────────────────────────────

# If these assertions ever fail, someone added a value in only one place.
assert set(CapabilityVerb.__args__) == set(KNOWN_CAPABILITIES), (
    "CapabilityVerb literal drifted from KNOWN_CAPABILITIES — keep them in sync"
)
assert set(AccountKind.__args__) == set(ACCOUNT_KINDS), (
    "AccountKind literal drifted from ACCOUNT_KINDS — keep them in sync"
)


__all__ = [
    "AccountKind", "AccountStatus", "AccountStats", "Account",
    "CapabilityVerb", "CapabilityStatus", "AccountCapability",
    "OrganizationType", "OrganizationMember", "Organization",
    "SpecializationCategory", "Specialization",
]
