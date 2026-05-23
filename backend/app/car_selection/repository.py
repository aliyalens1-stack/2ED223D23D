"""car_selection.repository — Mongo persistence for advisory requests.

All DB I/O for the namespace funnels through this class. Routers and
tests depend on this surface. Three reasons we keep it explicit:

  1. Single point for `_id` strategy (uuid4 hex) and `_id` projection
     (`{"_id": 0}` is NEVER used here — `_id` IS the request id and
     the API returns it as `id`).
  2. Single point for timeline append — every status/assignment change
     pushes an event so we don't end up with mixed-truth audit history.
  3. Test isolation — fixtures can swap the collection name to a
     scratch DB without touching the rest of the codebase.
"""
from __future__ import annotations
import uuid
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

from app.car_selection.lifecycle import (
    is_transition_allowed,
    TERMINAL_STATUSES,
)

# Mongo collection name — locked. Same renaming rule as pricing /
# matching: a rename implies a migration.
COLLECTION = "car_selection_requests"


# ── Errors ───────────────────────────────────────────────────────────


class RequestNotFoundError(Exception):
    code = "CAR_SELECTION_NOT_FOUND"

    def __init__(self, request_id: str):
        self.request_id = request_id
        super().__init__(f"car_selection request {request_id!r} not found")


class InvalidTransitionError(Exception):
    code = "INVALID_TRANSITION"

    def __init__(self, current: str, target: str):
        self.current = current
        self.target = target
        super().__init__(
            f"lifecycle does not permit {current!r} → {target!r}"
        )


# ── Repository ───────────────────────────────────────────────────────


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _new_id() -> str:
    return uuid.uuid4().hex


class CarSelectionRepository:
    """Thin async wrapper over the `car_selection_requests` collection."""

    def __init__(self, db):
        self._db = db
        self._coll = db[COLLECTION]

    # ── Indexes ──────────────────────────────────────────────────────
    # Listed for completeness — Sprint 1 keeps them optional. The
    # router never depends on indexes being present; this method is
    # provided so a bootstrap path can call it once at startup.

    async def ensure_indexes(self) -> None:
        await self._coll.create_index("customerId")
        await self._coll.create_index("status")
        await self._coll.create_index("assignedAdminId")
        await self._coll.create_index("assignedProviderId")
        await self._coll.create_index([("createdAt", -1)])

    # ── Insert ───────────────────────────────────────────────────────

    async def create(
        self,
        *,
        customer_id: str,
        service_type: str,
        country_code: str,
        city_id: str,
        description: str,
        source_link: Optional[str] = None,
        budget: Optional[Dict[str, Any]] = None,
    ) -> Dict[str, Any]:
        """Persist a brand-new advisory request in `submitted` status.

        Returns the fully-formed doc (the router serialises it back as
        the response body).
        """
        now = _now_iso()
        doc: Dict[str, Any] = {
            "_id": _new_id(),
            "customerId": customer_id,
            "serviceType": service_type,
            "countryCode": country_code,
            "cityId": city_id,
            "description": description,
            "sourceLink": source_link,
            "budget": budget,
            "status": "submitted",
            "assignedAdminId": None,
            "assignedProviderId": None,
            "createdAt": now,
            "updatedAt": now,
            "timeline": [
                {
                    "type": "submitted",
                    "at": now,
                    "actorId": customer_id,
                    "actorRole": "customer",
                }
            ],
        }
        await self._coll.insert_one(doc)
        # `insert_one` mutates `doc` to add `_id` — but we set `_id`
        # ourselves so the object is already correct. Return a copy
        # so callers can safely mutate without poisoning Mongo state.
        return dict(doc)

    # ── Reads ────────────────────────────────────────────────────────

    async def get_by_id(self, request_id: str) -> Optional[Dict[str, Any]]:
        return await self._coll.find_one({"_id": request_id})

    async def list_for_customer(
        self,
        customer_id: str,
        *,
        limit: int = 50,
    ) -> List[Dict[str, Any]]:
        cur = (
            self._coll
            .find({"customerId": customer_id})
            .sort("createdAt", -1)
            .limit(max(1, min(limit, 200)))
        )
        return [doc async for doc in cur]

    async def list_for_admin(
        self,
        *,
        status: Optional[str] = None,
        service_type: Optional[str] = None,
        assigned_admin_id: Optional[str] = None,
        assigned_provider_id: Optional[str] = None,
        country_code: Optional[str] = None,
        city_id: Optional[str] = None,
        limit: int = 100,
    ) -> List[Dict[str, Any]]:
        """Admin queue projection. Applies straightforward AND filters.
        Sorted newest-first — admin triage starts from the top."""
        q: Dict[str, Any] = {}
        if status:
            q["status"] = status
        if service_type:
            q["serviceType"] = service_type
        if assigned_admin_id is not None:
            q["assignedAdminId"] = assigned_admin_id
        if assigned_provider_id is not None:
            q["assignedProviderId"] = assigned_provider_id
        if country_code:
            q["countryCode"] = country_code.upper()
        if city_id:
            q["cityId"] = city_id
        cur = (
            self._coll
            .find(q)
            .sort("createdAt", -1)
            .limit(max(1, min(limit, 500)))
        )
        return [doc async for doc in cur]

    # ── Mutations ────────────────────────────────────────────────────

    async def transition_status(
        self,
        request_id: str,
        *,
        target_status: str,
        actor_id: str,
        actor_role: str,
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Lifecycle-checked status update. Raises:
          • RequestNotFoundError when the doc is missing
          • InvalidTransitionError when the lifecycle adjacency forbids it
            (also covers terminal states — they have empty adjacency).
        """
        current = await self.get_by_id(request_id)
        if current is None:
            raise RequestNotFoundError(request_id)
        cur_status = current["status"]
        if not is_transition_allowed(cur_status, target_status):
            raise InvalidTransitionError(cur_status, target_status)
        now = _now_iso()
        event = {
            "type": f"status:{target_status}",
            "at": now,
            "actorId": actor_id,
            "actorRole": actor_role,
            "note": note,
            "data": {"from": cur_status, "to": target_status},
        }
        await self._coll.update_one(
            {"_id": request_id},
            {
                "$set": {"status": target_status, "updatedAt": now},
                "$push": {"timeline": event},
            },
        )
        # Return the post-mutation doc so the caller doesn't need a
        # follow-up read.
        return await self.get_by_id(request_id)  # type: ignore[return-value]

    async def assign(
        self,
        request_id: str,
        *,
        admin_id: Optional[str],
        provider_id: Optional[str],
        actor_id: str,
        actor_role: str,
        note: Optional[str] = None,
    ) -> Dict[str, Any]:
        """Set assignees and bring the request into `assigned`.

        Accepts both fields simultaneously (admin can pre-claim *and*
        delegate to a provider in one call). At least ONE of the two
        must be supplied — the router enforces this at the schema layer.

        Lifecycle: must be reachable from current status via
        `submitted → reviewing → assigned` OR `reviewing → assigned`.
        We auto-lift `submitted` to `reviewing` first (single admin
        click "assign" should not be blocked by an artificial review
        step). Terminal statuses still refuse.
        """
        current = await self.get_by_id(request_id)
        if current is None:
            raise RequestNotFoundError(request_id)
        cur_status = current["status"]
        if cur_status in TERMINAL_STATUSES:
            raise InvalidTransitionError(cur_status, "assigned")

        now = _now_iso()
        events: List[Dict[str, Any]] = []

        # Implicit reviewing step (if currently submitted). Keeps the
        # audit trail honest — assignment from `submitted` always
        # records an intermediate `reviewing` event.
        if cur_status == "submitted":
            events.append({
                "type": "status:reviewing",
                "at": now,
                "actorId": actor_id,
                "actorRole": actor_role,
                "data": {"from": "submitted", "to": "reviewing"},
            })

        # The assignment event itself.
        events.append({
            "type": "assigned",
            "at": now,
            "actorId": actor_id,
            "actorRole": actor_role,
            "note": note,
            "data": {
                "adminId": admin_id,
                "providerId": provider_id,
                "from": cur_status,
                "to": "assigned",
            },
        })

        update_set: Dict[str, Any] = {
            "status": "assigned",
            "updatedAt": now,
        }
        # Only overwrite when supplied — keeps the other side untouched
        # if admin is just claiming for themselves.
        if admin_id is not None:
            update_set["assignedAdminId"] = admin_id
        if provider_id is not None:
            update_set["assignedProviderId"] = provider_id

        await self._coll.update_one(
            {"_id": request_id},
            {"$set": update_set, "$push": {"timeline": {"$each": events}}},
        )
        return await self.get_by_id(request_id)  # type: ignore[return-value]


__all__ = [
    "COLLECTION",
    "CarSelectionRepository",
    "RequestNotFoundError",
    "InvalidTransitionError",
]
