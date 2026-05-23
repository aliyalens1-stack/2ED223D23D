"""car_selection — lifecycle and repository invariant tests.

Critical invariants verified:
  1. Lifecycle adjacency table is locked — every allowed/forbidden
     transition matches the spec exactly.
  2. Terminal statuses never accept further transitions.
  3. Repository.create produces a doc with `submitted` status and a
     `submitted` timeline event whose actor matches the customer.
  4. Repository.transition_status appends an audit event and refuses
     invalid transitions.
  5. Repository.assign auto-lifts `submitted` → `reviewing` → `assigned`
     in a single call, leaving BOTH events in the audit trail.
  6. Lists scope correctly — customer queries are filtered by customerId.
"""
from __future__ import annotations
import os
import sys
import types

import pytest

# Break the server.py ↔ app.marketplace.cities circular import for tests.
_HERE = os.path.dirname(__file__)
sys.path.insert(0, os.path.abspath(os.path.join(_HERE, "..")))
if "server" not in sys.modules:
    _stub = types.ModuleType("server")
    _stub.db = None
    sys.modules["server"] = _stub

from motor.motor_asyncio import AsyncIOMotorClient  # noqa: E402

from app.car_selection.lifecycle import (  # noqa: E402
    is_transition_allowed,
    ALLOWED_TRANSITIONS,
    STATUSES,
    SERVICE_TYPES,
    TERMINAL_STATUSES,
)
from app.car_selection.repository import (  # noqa: E402
    CarSelectionRepository,
    InvalidTransitionError,
    RequestNotFoundError,
)


pytestmark = pytest.mark.asyncio


# ── Test-DB plumbing ──────────────────────────────────────────────────


def _mongo_url() -> str:
    return os.environ.get("MONGO_URL", "mongodb://localhost:27017")


def _db_name() -> str:
    return os.environ.get("DB_NAME_TEST", "test_car_selection_sprint1")


@pytest.fixture
async def db():
    client = AsyncIOMotorClient(_mongo_url())
    database = client[_db_name()]
    await database.car_selection_requests.delete_many({})
    try:
        yield database
    finally:
        await database.car_selection_requests.delete_many({})
        client.close()


# ── Locked enums ──────────────────────────────────────────────────────


def test_service_types_locked():
    assert SERVICE_TYPES == frozenset({
        "budget_search", "market_search",
        "negotiation_help", "listing_review",
    })


def test_statuses_locked():
    assert STATUSES == frozenset({
        "submitted", "reviewing", "assigned",
        "in_progress", "waiting_customer",
        "completed", "cancelled",
    })


def test_terminal_statuses_locked():
    assert TERMINAL_STATUSES == frozenset({"completed", "cancelled"})


# ── Adjacency table — explicit allow ─────────────────────────────────


@pytest.mark.parametrize("cur,nxt", [
    ("submitted", "reviewing"),
    ("submitted", "cancelled"),
    ("reviewing", "assigned"),
    ("reviewing", "cancelled"),
    ("assigned", "in_progress"),
    ("assigned", "waiting_customer"),
    ("assigned", "cancelled"),
    ("in_progress", "waiting_customer"),
    ("in_progress", "completed"),
    ("in_progress", "cancelled"),
    ("waiting_customer", "in_progress"),
    ("waiting_customer", "completed"),
    ("waiting_customer", "cancelled"),
])
def test_allowed_transitions(cur, nxt):
    assert is_transition_allowed(cur, nxt) is True


# ── Adjacency table — explicit deny ──────────────────────────────────


@pytest.mark.parametrize("cur,nxt", [
    # Same-status hop is not a transition.
    ("submitted", "submitted"),
    ("in_progress", "in_progress"),
    # No direct close from submitted/reviewing — must go through work.
    ("submitted", "completed"),
    ("reviewing", "completed"),
    ("submitted", "in_progress"),
    # Backwards moves are forbidden.
    ("in_progress", "assigned"),
    ("assigned", "reviewing"),
    # Terminal is terminal.
    ("completed", "in_progress"),
    ("completed", "cancelled"),
    ("cancelled", "in_progress"),
    # Unknown statuses always false.
    ("submitted", "lol"),
    ("???", "completed"),
])
def test_forbidden_transitions(cur, nxt):
    assert is_transition_allowed(cur, nxt) is False


def test_terminal_states_have_empty_adjacency():
    for s in TERMINAL_STATUSES:
        assert ALLOWED_TRANSITIONS[s] == frozenset()


# ── Repository.create ────────────────────────────────────────────────


async def test_create_persists_with_submitted_event(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1",
        service_type="budget_search",
        country_code="DE",
        city_id="aachen",
        description="ищу BMW G30 до 25k",
        source_link=None,
        budget={"budgetMax": 25000, "brands": ["BMW"]},
    )
    assert doc["status"] == "submitted"
    assert doc["customerId"] == "cust-1"
    assert doc["serviceType"] == "budget_search"
    assert doc["countryCode"] == "DE"
    assert doc["cityId"] == "aachen"
    assert doc["budget"]["budgetMax"] == 25000
    assert isinstance(doc["_id"], str)
    assert len(doc["timeline"]) == 1
    ev = doc["timeline"][0]
    assert ev["type"] == "submitted"
    assert ev["actorId"] == "cust-1"
    assert ev["actorRole"] == "customer"
    # Persisted on disk too.
    stored = await db.car_selection_requests.find_one({"_id": doc["_id"]})
    assert stored is not None
    assert stored["status"] == "submitted"


# ── Repository.transition_status ─────────────────────────────────────


async def test_transition_appends_event_and_updates_status(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1", service_type="market_search",
        country_code="DE", city_id="aachen",
        description="ищу пикап",
    )
    updated = await repo.transition_status(
        doc["_id"], target_status="cancelled",
        actor_id="cust-1", actor_role="customer",
        note="передумал",
    )
    assert updated["status"] == "cancelled"
    types_ = [e["type"] for e in updated["timeline"]]
    assert types_ == ["submitted", "status:cancelled"]
    last = updated["timeline"][-1]
    assert last["data"] == {"from": "submitted", "to": "cancelled"}
    assert last["note"] == "передумал"
    assert last["actorRole"] == "customer"


async def test_transition_refuses_invalid(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1", service_type="negotiation_help",
        country_code="DE", city_id="aachen", description="торг с дилером",
    )
    with pytest.raises(InvalidTransitionError):
        # submitted → completed is forbidden.
        await repo.transition_status(
            doc["_id"], target_status="completed",
            actor_id="admin-1", actor_role="admin",
        )


async def test_transition_on_unknown_request(db):
    repo = CarSelectionRepository(db)
    with pytest.raises(RequestNotFoundError):
        await repo.transition_status(
            "no-such-id", target_status="reviewing",
            actor_id="admin-1", actor_role="admin",
        )


# ── Repository.assign — auto-lift ────────────────────────────────────


async def test_assign_from_submitted_records_both_events(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1", service_type="budget_search",
        country_code="DE", city_id="aachen",
        description="ищу BMW",
    )
    updated = await repo.assign(
        doc["_id"], admin_id="admin-1", provider_id=None,
        actor_id="admin-1", actor_role="admin", note="taking it",
    )
    assert updated["status"] == "assigned"
    assert updated["assignedAdminId"] == "admin-1"
    assert updated["assignedProviderId"] is None
    types_ = [e["type"] for e in updated["timeline"]]
    # submitted → reviewing → assigned all in the audit trail.
    assert types_ == ["submitted", "status:reviewing", "assigned"]
    last = updated["timeline"][-1]
    assert last["data"]["adminId"] == "admin-1"
    assert last["data"]["from"] == "submitted"
    assert last["data"]["to"] == "assigned"


async def test_assign_from_reviewing_no_double_event(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1", service_type="market_search",
        country_code="DE", city_id="aachen", description="x",
    )
    await repo.transition_status(
        doc["_id"], target_status="reviewing",
        actor_id="admin-1", actor_role="admin",
    )
    updated = await repo.assign(
        doc["_id"], admin_id=None, provider_id="prov-1",
        actor_id="admin-1", actor_role="admin",
    )
    types_ = [e["type"] for e in updated["timeline"]]
    # Already reviewing — no implicit reviewing event injected again.
    assert types_ == ["submitted", "status:reviewing", "assigned"]
    assert updated["assignedProviderId"] == "prov-1"
    assert updated["assignedAdminId"] is None  # untouched


async def test_assign_refuses_on_terminal(db):
    repo = CarSelectionRepository(db)
    doc = await repo.create(
        customer_id="cust-1", service_type="market_search",
        country_code="DE", city_id="aachen", description="x",
    )
    await repo.transition_status(
        doc["_id"], target_status="cancelled",
        actor_id="cust-1", actor_role="customer",
    )
    with pytest.raises(InvalidTransitionError):
        await repo.assign(
            doc["_id"], admin_id="admin-1", provider_id=None,
            actor_id="admin-1", actor_role="admin",
        )


# ── Listing ──────────────────────────────────────────────────────────


async def test_list_for_customer_filters_by_customer(db):
    repo = CarSelectionRepository(db)
    await repo.create(
        customer_id="A", service_type="budget_search",
        country_code="DE", city_id="aachen", description="a",
    )
    await repo.create(
        customer_id="A", service_type="market_search",
        country_code="DE", city_id="berlin", description="b",
    )
    await repo.create(
        customer_id="B", service_type="listing_review",
        country_code="DE", city_id="berlin",
        description="c", source_link="https://mobile.de/x",
    )
    a = await repo.list_for_customer("A")
    b = await repo.list_for_customer("B")
    assert {d["customerId"] for d in a} == {"A"}
    assert {d["customerId"] for d in b} == {"B"}
    assert len(a) == 2 and len(b) == 1


async def test_list_for_admin_filters_combine(db):
    repo = CarSelectionRepository(db)
    await repo.create(
        customer_id="A", service_type="budget_search",
        country_code="DE", city_id="aachen", description="a",
    )
    await repo.create(
        customer_id="B", service_type="budget_search",
        country_code="DE", city_id="berlin", description="b",
    )
    await repo.create(
        customer_id="C", service_type="market_search",
        country_code="DE", city_id="aachen", description="c",
    )
    result = await repo.list_for_admin(service_type="budget_search", city_id="aachen")
    assert len(result) == 1
    assert result[0]["customerId"] == "A"
