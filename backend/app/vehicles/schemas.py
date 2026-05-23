"""app.vehicles.schemas — Pydantic models for Vehicle Memory layer.

Sprint 2B-ish — vehicle as a first-class entity. Schemas kept minimal and
forward-compatible: every optional field can be filled later (parser, manual
edit, future inspection results) without schema migration.

Sprint 2C extension — Vehicle Workspace:
  - `status` open-string enum tracking acquisition lifecycle
    (saved → inspection_requested → inspection_completed → purchased / archived).
    Intentionally NOT validated as strict transitions — backend just records
    whatever the frontend says. Real workflow guards belong to a later sprint
    when the lifecycle actually has rules attached.
  - `activity` — embedded list of small timeline events. Up to 200 entries per
    vehicle (capped server-side). Each entry has `type`, `at`, optional `text`.

Important invariants:
  - Vehicle has its OWN id (`vehicle_<uuid>`). NOT `request_id`. NOT
    `listing_url`. The id is the canonical handle.
  - `customerId` is the soft owner — for V1 customers can only see their own
    saved vehicles. Future scope (org-shared, public inventory) will introduce
    additional access fields.
  - `source` is open enum (`mobile.de`, `autoscout24`, `manual`, `selection`,
    ...). We do NOT enforce the set so new providers can be added without
    breaking older clients.
"""
from __future__ import annotations
from datetime import datetime
from typing import Optional, List, Literal

from pydantic import BaseModel, Field, ConfigDict


# Activity event types are an open string set so we can introduce new events
# (e.g. "report_uploaded", "owner_changed") without schema migration. The
# frontend renders them with a switch + sane fallback for unknown types.
ActivityType = Literal[
    'saved',
    'note_added',
    'status_changed',
    'inspection_requested',
    'inspection_completed',
    'purchased',
    'archived',
    'reopened',
]


class ActivityEvent(BaseModel):
    """One small timeline event attached to a vehicle.

    Kept narrow on purpose — no nested objects, no rich payload. If a future
    sprint needs richer events (e.g. attached report ids), it should evolve
    via a separate `events` collection rather than fattening this embedded
    list.
    """
    type: str = Field(..., max_length=64)
    at: datetime
    text: Optional[str] = Field(default=None, max_length=500)


class VehicleBase(BaseModel):
    """Shared vehicle fields. Every field is optional except brand/model.

    This intentionally is the smallest possible domain object — just enough to
    re-render a candidate card and re-open it on the listing site (when
    listing_url is present). Anything richer — photos, damage history,
    inspection reports — lives in linked collections, not here.
    """
    brand: str = Field(..., min_length=1, max_length=64)
    model: str = Field(..., min_length=1, max_length=128)
    year: Optional[int] = Field(default=None, ge=1900, le=2099)
    mileage: Optional[int] = Field(default=None, ge=0, le=2_000_000)
    price: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    currency: Optional[str] = Field(default='EUR', max_length=3)
    location: Optional[str] = Field(default=None, max_length=128)
    fuel: Optional[str] = Field(default=None, max_length=32)
    transmission: Optional[str] = Field(default=None, max_length=32)
    thumbnail: Optional[str] = Field(default=None, max_length=2048)
    listing_url: Optional[str] = Field(default=None, max_length=2048)
    source: Optional[str] = Field(default='manual', max_length=32)
    external_source_id: Optional[str] = Field(default=None, max_length=128)
    notes: Optional[str] = Field(default=None, max_length=2000)
    # Sprint 2C — workspace lifecycle. Open string so new statuses can be
    # introduced without migration. Frontend treats unknown values as "saved".
    status: Optional[str] = Field(default='saved', max_length=32)


class VehicleCreate(VehicleBase):
    """Payload for POST /api/customer/vehicles."""
    pass


class VehicleUpdate(BaseModel):
    """Partial update — every field optional. Empty body is a no-op."""
    model_config = ConfigDict(extra='ignore')

    brand: Optional[str] = Field(default=None, min_length=1, max_length=64)
    model: Optional[str] = Field(default=None, min_length=1, max_length=128)
    year: Optional[int] = Field(default=None, ge=1900, le=2099)
    mileage: Optional[int] = Field(default=None, ge=0, le=2_000_000)
    price: Optional[float] = Field(default=None, ge=0, le=100_000_000)
    currency: Optional[str] = Field(default=None, max_length=3)
    location: Optional[str] = Field(default=None, max_length=128)
    fuel: Optional[str] = Field(default=None, max_length=32)
    transmission: Optional[str] = Field(default=None, max_length=32)
    thumbnail: Optional[str] = Field(default=None, max_length=2048)
    listing_url: Optional[str] = Field(default=None, max_length=2048)
    notes: Optional[str] = Field(default=None, max_length=2000)
    status: Optional[str] = Field(default=None, max_length=32)


class ActivityCreate(BaseModel):
    """Payload for POST /api/customer/vehicles/{id}/activity.

    Status is NOT mutated by this endpoint — the frontend should call PATCH
    with a status field for that. Activity is purely an append-only log.
    """
    type: str = Field(..., min_length=1, max_length=64)
    text: Optional[str] = Field(default=None, max_length=500)


class Vehicle(VehicleBase):
    """Persisted vehicle record returned to clients."""
    id: str
    customerId: str
    createdAt: datetime
    updatedAt: datetime
    # Embedded list. Stored on the vehicle document. Capped at 200 server-side
    # so it doesn't grow unbounded (we drop oldest entries on overflow).
    activity: List[ActivityEvent] = Field(default_factory=list)

