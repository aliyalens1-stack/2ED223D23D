"""app.vehicles.router — Vehicle Memory MVP endpoints (customer-scoped).

Sprint 2B (initial):
  POST    /api/customer/vehicles                  → create a saved vehicle
  GET     /api/customer/vehicles                  → list mine
  GET     /api/customer/vehicles/{id}             → fetch one
  PATCH   /api/customer/vehicles/{id}             → partial update
  DELETE  /api/customer/vehicles/{id}             → remove

Sprint 2C — Vehicle Workspace additions:
  POST    /api/customer/vehicles/{id}/activity    → append a timeline event

PATCH now also auto-records a `status_changed` activity entry when `status`
changes, and a `note_added` entry when `notes` changes (truncated). This
keeps the timeline meaningful without requiring the client to also POST an
activity event for every common edit.

Auth model: same `require_account_kind("customer")` gate the rest of
`/api/customer/*` uses. No org-shared visibility yet — strictly user-scoped.
"""
from __future__ import annotations
import logging
from typing import List

from fastapi import APIRouter, HTTPException, Depends

from app.core.db import db
from app.core.utils import now_utc, uid
from app.core.identity_runtime import IdentityContext, require_account_kind
from app.vehicles.schemas import Vehicle, VehicleCreate, VehicleUpdate, ActivityCreate, ActivityEvent
from app.vehicles import timeline as timeline_svc


logger = logging.getLogger("server")
router = APIRouter(prefix="/api/customer/vehicles", tags=["customer-vehicles"])

_customer_required = require_account_kind("customer")

# Server-side cap on embedded activity entries per vehicle. We drop oldest
# entries beyond this. Should be enough for years of normal usage; if a real
# need for richer history emerges, evolve to a separate `vehicle_events`
# collection rather than fattening the document.
_MAX_ACTIVITY = 200


def _new_vehicle_id() -> str:
    return f"vehicle_{uid()}"


def _trim_activity(activity: list) -> list:
    """Return at most _MAX_ACTIVITY entries, keeping the most recent."""
    if len(activity) <= _MAX_ACTIVITY:
        return activity
    return activity[-_MAX_ACTIVITY:]


@router.post("", response_model=Vehicle, status_code=201)
async def create_vehicle(
    payload: VehicleCreate,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> Vehicle:
    """Save a new vehicle candidate scoped to the calling customer.

    Sprint 2C: seed the timeline with a `saved` activity entry so the workspace
    timeline is never empty. The seed entry is part of the response, so the UI
    can render it immediately.
    """
    cid = ctx_.user_id
    now = now_utc()
    seed_event = {"type": "saved", "at": now, "text": "Авто добавлено в кандидаты"}
    doc = {
        "id": _new_vehicle_id(),
        "customerId": cid,
        "createdAt": now,
        "updatedAt": now,
        "activity": [seed_event],
        **payload.model_dump(exclude_none=False),
    }
    # `activity` was overwritten by the spread above only if VehicleCreate had
    # an `activity` attribute (it doesn't), so `[seed_event]` survives. Defensive
    # re-assertion for clarity:
    doc["activity"] = [seed_event]

    await db.vehicles.insert_one(dict(doc))  # copy so insert_one doesn't mutate doc
    return Vehicle(**doc)


@router.get("", response_model=List[Vehicle])
async def list_my_vehicles(
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> List[Vehicle]:
    """List the customer's saved vehicles, newest first."""
    cid = ctx_.user_id
    cursor = db.vehicles.find(
        {"customerId": cid},
        {"_id": 0},
    ).sort("createdAt", -1)
    docs = await cursor.to_list(200)
    return [Vehicle(**d) for d in docs]


@router.get("/{vehicle_id}", response_model=Vehicle)
async def get_vehicle(
    vehicle_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> Vehicle:
    cid = ctx_.user_id
    doc = await db.vehicles.find_one({"id": vehicle_id, "customerId": cid}, {"_id": 0})
    if not doc:
        raise HTTPException(status_code=404, detail="vehicle_not_found")
    return Vehicle(**doc)


@router.patch("/{vehicle_id}", response_model=Vehicle)
async def update_vehicle(
    vehicle_id: str,
    patch: VehicleUpdate,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> Vehicle:
    """Partial update. Sprint 2C: emit timeline activity for status/notes changes.

    The activity entries are appended to the existing list in the same atomic
    update so the timeline stays consistent.
    """
    cid = ctx_.user_id
    updates = {k: v for k, v in patch.model_dump(exclude_none=True).items() if v is not None}
    if not updates:
        # Nothing to change → 200 with current state. No-op on empty body.
        existing = await db.vehicles.find_one({"id": vehicle_id, "customerId": cid}, {"_id": 0})
        if not existing:
            raise HTTPException(status_code=404, detail="vehicle_not_found")
        return Vehicle(**existing)

    # Fetch current state to detect meaningful changes for timeline events.
    current = await db.vehicles.find_one({"id": vehicle_id, "customerId": cid}, {"_id": 0})
    if not current:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    now = now_utc()
    new_events: list = []
    if 'status' in updates and updates['status'] != current.get('status'):
        new_events.append({
            "type": "status_changed",
            "at": now,
            "text": f"{current.get('status') or 'saved'} → {updates['status']}",
        })
    if 'notes' in updates and updates['notes'] != current.get('notes'):
        # Keep timeline note short — just signal "updated", not the full text.
        snippet = (updates['notes'] or '').strip()
        if len(snippet) > 80:
            snippet = snippet[:77] + '...'
        new_events.append({
            "type": "note_added",
            "at": now,
            "text": snippet or 'Заметка обновлена',
        })

    updates["updatedAt"] = now

    if new_events:
        merged = list(current.get('activity', []) or [])
        merged.extend(new_events)
        updates['activity'] = _trim_activity(merged)

    res = await db.vehicles.find_one_and_update(
        {"id": vehicle_id, "customerId": cid},
        {"$set": updates},
        return_document=True,
        projection={"_id": 0},
    )
    if not res:
        raise HTTPException(status_code=404, detail="vehicle_not_found")
    return Vehicle(**res)


@router.delete("/{vehicle_id}", status_code=204)
async def delete_vehicle(
    vehicle_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    cid = ctx_.user_id
    res = await db.vehicles.delete_one({"id": vehicle_id, "customerId": cid})
    if res.deleted_count == 0:
        raise HTTPException(status_code=404, detail="vehicle_not_found")
    return None


@router.post("/{vehicle_id}/activity", response_model=Vehicle)
async def append_activity(
    vehicle_id: str,
    payload: ActivityCreate,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
) -> Vehicle:
    """Append a timeline event to a vehicle.

    Sprint 2C — used by the frontend to record meaningful user actions
    (e.g. `inspection_requested`, `reopened`) without mutating the vehicle's
    other fields. The event list is capped server-side at _MAX_ACTIVITY.

    NOTE: This endpoint deliberately does NOT mutate `status`. Status changes
    must go through PATCH so the validation/transition rules (when they exist
    in a future sprint) live in one place.
    """
    cid = ctx_.user_id
    now = now_utc()
    event = ActivityEvent(type=payload.type, at=now, text=payload.text)

    current = await db.vehicles.find_one({"id": vehicle_id, "customerId": cid}, {"_id": 0})
    if not current:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    merged = list(current.get('activity', []) or [])
    merged.append(event.model_dump())

    res = await db.vehicles.find_one_and_update(
        {"id": vehicle_id, "customerId": cid},
        {"$set": {"activity": _trim_activity(merged), "updatedAt": now}},
        return_document=True,
        projection={"_id": 0},
    )
    if not res:
        # Race window between find_one and find_one_and_update — vehicle was
        # deleted concurrently. Treat as not_found to be honest with the client.
        raise HTTPException(status_code=404, detail="vehicle_not_found")
    return Vehicle(**res)


# ─────────────────────────────────────────────────────────────────────
# P4.1 — Vehicle Linkage timeline endpoint.
#
# Aggregates per-vehicle artefacts (reports / quotes / payments /
# bookings) into the typed projection-input shape the surface
# CustomerVehicleDetail.tsx already understands. The shared module
# does the actual semantic projection — backend only assembles the
# graph.
#
# Hard rules: explicit linkage lookups + per-collection indexes only.
# No event log, no graph DB, no event framework.
# ─────────────────────────────────────────────────────────────────────

@router.get("/{vehicle_id}/timeline")
async def vehicle_timeline(
    vehicle_id: str,
    ctx_: IdentityContext = Depends(_customer_required),  # noqa: B008
):
    """Return `{ vehicle, reports, quotes, payments, bookings }` for the
    requested vehicle.

    Authorization: only the owning customer may read. Returns 404 for
    other users' vehicles (NOT 403 — we don't reveal existence).
    """
    cid = ctx_.user_id
    vehicle_doc = await db.vehicles.find_one(
        {"id": vehicle_id, "customerId": cid},
        {"_id": 0},
    )
    if not vehicle_doc:
        raise HTTPException(status_code=404, detail="vehicle_not_found")

    payload = await timeline_svc.build_timeline_payload(vehicle_id)
    return {
        "vehicle": Vehicle(**vehicle_doc).model_dump(mode="json"),
        **payload,
    }
