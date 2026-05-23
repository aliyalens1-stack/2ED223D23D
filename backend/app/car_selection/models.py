"""car_selection.models — request schemas and DB document shape.

Pydantic v2. Field-level validation is intentionally tight at the API
boundary; once inside the repository we operate on plain dicts so the
DB doc shape is explicit and easy to query.
"""
from __future__ import annotations
from typing import List, Literal, Optional, Annotated
from pydantic import BaseModel, Field, HttpUrl, field_validator

from app.car_selection.lifecycle import (
    SERVICE_TYPES,
    STATUSES,
    CarSelectionServiceType,
    CarSelectionStatus,
)


# ── Submit (customer) ─────────────────────────────────────────────────


class BudgetSearchExtras(BaseModel):
    """Optional structured criteria for `budget_search`. Free-form fields
    stay in `description` — these are filters the admin can sort on."""
    budgetMin: Optional[Annotated[float, Field(ge=0)]] = None
    budgetMax: Optional[Annotated[float, Field(ge=0)]] = None
    brands: Optional[List[Annotated[str, Field(min_length=1, max_length=64)]]] = None
    fuelTypes: Optional[List[
        Literal["petrol", "diesel", "hybrid", "electric", "lpg", "cng"]
    ]] = None
    transmission: Optional[Literal["manual", "automatic"]] = None
    yearMin: Optional[Annotated[int, Field(ge=1970, le=2100)]] = None
    yearMax: Optional[Annotated[int, Field(ge=1970, le=2100)]] = None


class CarSelectionCreateIn(BaseModel):
    """Customer POST body.

    `serviceType` decides which extras are honoured:
      • budget_search    → `budget` extras
      • market_search    → `description` is the primary signal
      • negotiation_help → `sourceLink` recommended (specific listing)
      • listing_review   → `sourceLink` REQUIRED
    """
    serviceType: CarSelectionServiceType
    countryCode: Annotated[str, Field(min_length=2, max_length=2)]
    cityId: Annotated[str, Field(min_length=1, max_length=80)]
    description: Annotated[str, Field(min_length=4, max_length=4000)]

    # Optional contextual fields
    sourceLink: Optional[HttpUrl] = None
    budget: Optional[BudgetSearchExtras] = None

    @field_validator("serviceType")
    @classmethod
    def _service_type_locked(cls, v: str) -> str:
        if v not in SERVICE_TYPES:
            raise ValueError(f"serviceType must be one of {sorted(SERVICE_TYPES)}")
        return v

    @field_validator("countryCode")
    @classmethod
    def _country_upper(cls, v: str) -> str:
        return v.upper()


# ── Admin operations ──────────────────────────────────────────────────


class AdminAssignIn(BaseModel):
    """Body for `POST /api/admin/car-selection/{id}/assign`.

    Exactly ONE of `providerId` / `adminId` MUST be supplied. The route
    will lift the request to `assigned` status. If the request is in
    `submitted`, admin must first transition it to `reviewing` (or
    accept the implicit jump — we keep it explicit by rejecting jumps).
    """
    providerId: Optional[str] = None
    adminId: Optional[str] = None
    note: Optional[Annotated[str, Field(max_length=500)]] = None

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) and v.strip() else None


class AdminStatusIn(BaseModel):
    """Body for `POST /api/admin/car-selection/{id}/status`.

    Driven by the lifecycle adjacency table — invalid transitions are
    rejected with 409 INVALID_TRANSITION.
    """
    status: CarSelectionStatus
    note: Optional[Annotated[str, Field(max_length=500)]] = None

    @field_validator("status")
    @classmethod
    def _status_locked(cls, v: str) -> str:
        if v not in STATUSES:
            raise ValueError(f"status must be one of {sorted(STATUSES)}")
        return v

    @field_validator("note")
    @classmethod
    def _strip_note(cls, v: Optional[str]) -> Optional[str]:
        return v.strip() if isinstance(v, str) and v.strip() else None


# ── Outputs ───────────────────────────────────────────────────────────


class TimelineEvent(BaseModel):
    type: str
    at: str
    actorId: Optional[str] = None
    actorRole: Optional[str] = None
    note: Optional[str] = None
    # Free-form context (e.g. {"from":"submitted","to":"reviewing"})
    data: Optional[dict] = None


class CarSelectionRequestOut(BaseModel):
    id: str = Field(..., alias="_id")
    customerId: str
    serviceType: CarSelectionServiceType
    countryCode: str
    cityId: str
    description: str
    sourceLink: Optional[str] = None
    budget: Optional[BudgetSearchExtras] = None
    status: CarSelectionStatus
    assignedAdminId: Optional[str] = None
    assignedProviderId: Optional[str] = None
    createdAt: str
    updatedAt: str
    timeline: List[TimelineEvent]

    class Config:
        populate_by_name = True


__all__ = [
    "BudgetSearchExtras",
    "CarSelectionCreateIn",
    "AdminAssignIn",
    "AdminStatusIn",
    "TimelineEvent",
    "CarSelectionRequestOut",
]
