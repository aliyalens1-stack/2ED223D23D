"""offer_packages — Pydantic shapes.

Field discipline:

    * Provider-supplied content (title / summary / price / artifactIds)
      is validated at the API boundary. Inside the repo we operate on
      plain dicts so the DB document shape stays explicit.

    * Money is stored as `priceCents: int + currency: str`. Money
      arithmetic on floats is forbidden — even for display the route
      layer never converts back to fractional units; that is a UI
      concern.

    * `artifactIds` references existing artifacts created via the
      car_selection_thread artifacts endpoint. Resolution + cross-
      request validation happens in repository.deliver()/update_draft().

    * `version` is reserved for future revisions; v1 always sets 1
      and freezes it at deliver-time.
"""
from __future__ import annotations
from typing import Annotated, List, Literal, Optional

from pydantic import BaseModel, Field, field_validator

from app.offer_packages.lifecycle import STATUSES, OfferPackageStatus


# Currency allow-list — keep tight. Adding a new code requires touching
# pricing aggregation downstream.
SUPPORTED_CURRENCIES = frozenset({"EUR", "USD", "GBP", "PLN", "BYN"})


# ── Input bodies ─────────────────────────────────────────────────────


class _PackageContent(BaseModel):
    """Common, provider-controlled content fields.

    Used as the body of both `create-draft` and `update-draft`. The
    `update-draft` route applies the fields that were sent (Pydantic
    `model_dump(exclude_unset=True)`) — sending an empty body is a
    no-op, not a wipe.
    """
    title:        Optional[Annotated[str, Field(min_length=1, max_length=200)]] = None
    summary:      Optional[Annotated[str, Field(max_length=4000)]] = None
    priceCents:   Optional[Annotated[int, Field(ge=0, le=10**10)]] = None
    currency:     Optional[Annotated[str, Field(min_length=3, max_length=3)]] = None
    artifactIds:  Optional[List[Annotated[str, Field(min_length=1, max_length=64)]]] = (
        Field(default=None, max_length=10)
    )

    @field_validator("title", "summary")
    @classmethod
    def _strip(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.strip()
        return v if v else None

    @field_validator("currency")
    @classmethod
    def _currency_locked(cls, v: Optional[str]) -> Optional[str]:
        if v is None:
            return None
        v = v.upper()
        if v not in SUPPORTED_CURRENCIES:
            raise ValueError(
                f"currency must be one of {sorted(SUPPORTED_CURRENCIES)}"
            )
        return v


class CreateDraftIn(_PackageContent):
    """`POST .../offer-packages` — start a new draft.

    All fields are optional: a provider may create an empty draft
    first and fill in details over time. Delivery rules will reject
    the eventual `deliver` if the package has neither a title nor a
    summary nor any artifacts.
    """
    pass


class UpdateDraftIn(_PackageContent):
    """`PATCH .../offer-packages/{pid}` — edit draft content.

    The route applies only fields present in the body. To clear a
    nullable field, the caller sends `null`; missing fields are
    ignored. We expose `None`-vs-missing via `model_fields_set`.
    """
    pass


class DecisionIn(BaseModel):
    """`POST .../accept`, `.../decline`, `.../revoke` — terminal decision."""
    note: Optional[Annotated[str, Field(max_length=500)]] = None

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) and v.strip() else None


# ── Outputs ──────────────────────────────────────────────────────────


class OfferPackageTimelineEvent(BaseModel):
    type: str
    at: str
    actorId: Optional[str] = None
    actorRole: Optional[Literal["customer", "provider", "admin"]] = None
    note: Optional[str] = None
    data: Optional[dict] = None


class OfferPackageLineageOut(BaseModel):
    """Adjacent-only lineage projection (Phase 9, decision 7.6).

    UI consumers see at most one step backward and forward in the
    commercial chain. Walking the full chain is reserved for future
    `?walk=chain` queries — surfacing the whole ribbon by default
    leaks competitor intent and bloats list payloads.
    """
    previousId: Optional[str] = None
    nextId:     Optional[str] = None


class OfferPackageOut(BaseModel):
    """API projection of an offer package.

    Note: `artifacts` is the server-resolved projection of the
    immutable artifacts referenced by `artifactIds` — same shape as
    on a thread message, including a surface-specific download URL.
    `artifactIds` itself is kept on the wire for clients that prefer
    ids over expanded blobs.

    Phase 9 — Offer Package Versioning fields:
      * `chainId` — stable identity of the commercial line this
        package belongs to. Set at create-time, never mutates. v1
        packages get a fresh chainId; revisions inherit it from the
        predecessor (decision 7.1 + 7.8: chainId is stored, multiple
        chains per request).
      * `version` — 1 for the initial deliverable in a chain,
        N+1 for the Nth revision. Set at create-time; never mutates.
      * `parentId` — the package this draft revises. Set at
        create-revision time; never mutates. None for v1.
      * `supersedesId` — adjacent backward link. Forged at deliver-
        time only (decision 7.2). None for v1.
      * `supersededById` — adjacent forward link. Set on the
        predecessor when a successor is delivered (CAS — decision
        7.9). None for the latest delivered package in a chain.
      * `lineage` — convenience projection for UI; same payload as
        `(supersedesId, supersededById)` but under a stable key.
    """
    id: str
    requestId: str
    providerId: str
    version: int
    status: OfferPackageStatus

    chainId: str
    parentId:       Optional[str] = None
    supersedesId:   Optional[str] = None
    supersededById: Optional[str] = None
    lineage:        OfferPackageLineageOut

    title: Optional[str] = None
    summary: Optional[str] = None
    priceCents: Optional[int] = None
    currency: Optional[str] = None

    artifactIds: List[str]
    artifacts: List[dict]

    createdAt: str
    updatedAt: str
    deliveredAt: Optional[str] = None
    decidedAt: Optional[str] = None
    decidedBy: Optional[str] = None
    decidedNote: Optional[str] = None

    timeline: List[OfferPackageTimelineEvent]

    @field_validator("status")
    @classmethod
    def _status_known(cls, v: str) -> str:
        if v not in STATUSES:
            raise ValueError(f"unknown status {v!r}")
        return v


class OfferPackageListOut(BaseModel):
    items: List[OfferPackageOut]
    total: int


__all__ = [
    "SUPPORTED_CURRENCIES",
    "CreateDraftIn",
    "UpdateDraftIn",
    "DecisionIn",
    "OfferPackageTimelineEvent",
    "OfferPackageOut",
    "OfferPackageListOut",
]
