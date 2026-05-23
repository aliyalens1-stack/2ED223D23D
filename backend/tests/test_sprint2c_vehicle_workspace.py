"""Sprint 2C — Vehicle Workspace tests.

Covers the workspace additions on top of Sprint 2B Vehicle Memory:
  - Seed `saved` activity entry on POST create
  - Auto status_changed / note_added events on PATCH
  - POST /api/customer/vehicles/{id}/activity append endpoint
  - 200-entry server-side cap on activity (oldest dropped)
  - Cross-customer isolation on /activity
  - Schema shape (status, activity[{type, at, text}])
  - ActivityCreate validation (empty type → 422)
"""
from __future__ import annotations

import os
import uuid
import pytest
import requests

BASE_URL = os.environ.get("EXPO_PUBLIC_BACKEND_URL", "").rstrip("/")
assert BASE_URL, "EXPO_PUBLIC_BACKEND_URL must be set"


# ───────────── helpers ─────────────

def _register_customer():
    suffix = uuid.uuid4().hex[:10]
    email = f"TEST_veh2c_{suffix}@example.com"
    payload = {
        "email": email,
        "password": "TestPass123!",
        "name": f"TEST veh2c {suffix}",
        "role": "customer",
    }
    r = requests.post(f"{BASE_URL}/api/auth/register", json=payload, timeout=20)
    assert r.status_code in (200, 201), f"register failed: {r.status_code} {r.text}"
    data = r.json()
    token = data["accessToken"]
    return token, (data.get("user") or {}).get("id")


def _headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _create_vehicle(token: str, **overrides) -> dict:
    payload = {"brand": "BMW", "model": "320d"}
    payload.update(overrides)
    r = requests.post(
        f"{BASE_URL}/api/customer/vehicles",
        json=payload,
        headers=_headers(token),
        timeout=20,
    )
    assert r.status_code == 201, r.text
    return r.json()


def _delete_vehicle(token: str, vid: str):
    requests.delete(
        f"{BASE_URL}/api/customer/vehicles/{vid}",
        headers=_headers(token),
        timeout=15,
    )


# ───────────── fixtures ─────────────

@pytest.fixture(scope="module")
def cust_a():
    token, uid = _register_customer()
    return {"token": token, "user_id": uid}


@pytest.fixture(scope="module")
def cust_b():
    token, uid = _register_customer()
    return {"token": token, "user_id": uid}


# ───────────── seed activity on create ─────────────

class TestSeedActivity:
    def test_create_seeds_saved_activity(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        assert "activity" in v and isinstance(v["activity"], list)
        assert len(v["activity"]) == 1
        ev = v["activity"][0]
        assert ev["type"] == "saved"
        assert "at" in ev and ev["at"]
        # status field default
        assert v.get("status") == "saved"
        _delete_vehicle(cust_a["token"], v["id"])

    def test_create_with_explicit_status_keeps_seed_saved(self, cust_a):
        v = _create_vehicle(cust_a["token"], status="inspection_requested")
        assert v["status"] == "inspection_requested"
        # Activity still has only the seed 'saved' (status field is open
        # but seed is hardcoded as 'saved')
        assert len(v["activity"]) == 1
        assert v["activity"][0]["type"] == "saved"
        # persisted
        r = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{v['id']}",
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["status"] == "inspection_requested"
        _delete_vehicle(cust_a["token"], v["id"])


# ───────────── PATCH auto-events ─────────────

class TestPatchAutoEvents:
    def test_status_change_appends_status_changed_event(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        original_created = v["createdAt"]
        original_updated = v["updatedAt"]

        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"status": "inspection_requested"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["status"] == "inspection_requested"
        assert len(body["activity"]) == 2
        ev = body["activity"][-1]
        assert ev["type"] == "status_changed"
        assert "saved" in ev["text"] and "inspection_requested" in ev["text"]
        assert "→" in ev["text"]
        # createdAt unchanged, updatedAt advances (or equal at sub-second)
        assert body["createdAt"][:19] == original_created[:19]
        assert body["updatedAt"] >= original_updated[:19]
        _delete_vehicle(cust_a["token"], vid)

    def test_notes_change_appends_note_added_with_truncation(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        long_note = "X" * 200
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"notes": long_note},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["notes"] == long_note  # full notes saved
        assert len(body["activity"]) == 2
        ev = body["activity"][-1]
        assert ev["type"] == "note_added"
        # snippet truncated to ≤ 80 chars
        assert ev["text"] is not None
        assert len(ev["text"]) <= 80
        assert ev["text"].endswith("...")
        _delete_vehicle(cust_a["token"], vid)

    def test_short_notes_no_truncation(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        short = "TEST_short note"
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"notes": short},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        ev = body["activity"][-1]
        assert ev["type"] == "note_added"
        assert ev["text"] == short
        _delete_vehicle(cust_a["token"], vid)

    def test_patch_status_and_notes_appends_two_events(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"status": "inspection_requested", "notes": "TEST_combo"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # seed + 2 new = 3
        assert len(body["activity"]) == 3
        types = [e["type"] for e in body["activity"]]
        assert types[0] == "saved"
        assert "status_changed" in types[1:]
        assert "note_added" in types[1:]
        _delete_vehicle(cust_a["token"], vid)

    def test_patch_same_status_no_event(self, cust_a):
        v = _create_vehicle(cust_a["token"])  # default status "saved"
        vid = v["id"]
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"status": "saved"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["activity"]) == 1  # unchanged
        assert body["activity"][0]["type"] == "saved"
        _delete_vehicle(cust_a["token"], vid)

    def test_patch_same_notes_no_event(self, cust_a):
        v = _create_vehicle(cust_a["token"], notes="TEST_same")
        vid = v["id"]
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"notes": "TEST_same"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["activity"]) == 1  # only seed
        _delete_vehicle(cust_a["token"], vid)

    def test_patch_unrelated_field_no_activity_event(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.patch(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            json={"mileage": 50000},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert len(body["activity"]) == 1  # only seed; mileage isn't tracked
        _delete_vehicle(cust_a["token"], vid)


# ───────────── POST /activity ─────────────

class TestActivityAppend:
    def test_append_activity_returns_full_vehicle(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "inspection_requested", "text": "TEST_user requested inspection"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        # full vehicle returned
        assert body["id"] == vid
        assert body["customerId"] == cust_a["user_id"]
        assert body["brand"] == "BMW"
        # activity grew by 1
        assert len(body["activity"]) == 2
        ev = body["activity"][-1]
        assert ev["type"] == "inspection_requested"
        assert ev["text"] == "TEST_user requested inspection"
        assert "at" in ev and ev["at"]
        _delete_vehicle(cust_a["token"], vid)

    def test_append_activity_no_text_ok(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "reopened"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()
        assert body["activity"][-1]["type"] == "reopened"
        _delete_vehicle(cust_a["token"], vid)

    def test_append_activity_anonymous_401(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "inspection_requested"},
            timeout=15,
        )
        assert r.status_code == 401, r.text
        _delete_vehicle(cust_a["token"], vid)

    def test_append_activity_other_customer_404(self, cust_a, cust_b):
        v = _create_vehicle(cust_b["token"])
        vid = v["id"]
        # A tries to append to B's vehicle
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "inspection_requested"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 404
        # B can still see only their seed (no foreign event injected)
        r2 = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(cust_b["token"]),
            timeout=15,
        )
        assert r2.status_code == 200
        assert len(r2.json()["activity"]) == 1
        _delete_vehicle(cust_b["token"], vid)

    def test_append_activity_nonexistent_404(self, cust_a):
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/vehicle_does_not_exist_xyz/activity",
            json={"type": "reopened"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 404


# ───────────── validation ─────────────

class TestActivityValidation:
    def test_empty_type_422(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": ""},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 422
        _delete_vehicle(cust_a["token"], vid)

    def test_missing_type_422(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"text": "no type"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 422
        _delete_vehicle(cust_a["token"], vid)

    def test_type_too_long_422(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "x" * 65},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 422
        _delete_vehicle(cust_a["token"], vid)

    def test_text_too_long_422(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "reopened", "text": "x" * 501},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 422
        _delete_vehicle(cust_a["token"], vid)


# ───────────── activity cap ─────────────

class TestActivityCap:
    def test_cap_at_200_drops_oldest(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        # Initially 1 (seed). Append 210 events → final length must be 200.
        # We'll tag each with its index in `text` to verify the most recent
        # ones survive. Using a Session for keep-alive + retries to ride
        # through transient ingress hiccups during the burst.
        from requests.adapters import HTTPAdapter
        from urllib3.util.retry import Retry
        sess = requests.Session()
        retry = Retry(total=4, backoff_factor=0.5,
                      status_forcelist=[500, 502, 503, 504],
                      allowed_methods=["POST", "GET", "DELETE"])
        sess.mount("https://", HTTPAdapter(max_retries=retry, pool_connections=1, pool_maxsize=1))
        sess.headers.update(_headers(cust_a["token"]))

        N = 210
        last_body = None
        for i in range(N):
            for attempt in range(3):
                try:
                    r = sess.post(
                        f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
                        json={"type": "reopened", "text": f"TEST_evt_{i:04d}"},
                        timeout=30,
                    )
                    break
                except (requests.exceptions.ConnectionError,
                        requests.exceptions.Timeout):
                    if attempt == 2:
                        raise
                    import time as _t
                    _t.sleep(1.0 * (attempt + 1))
            assert r.status_code == 200, f"iter {i} failed: {r.status_code} {r.text}"
            last_body = r.json()
        assert last_body is not None
        activity = last_body["activity"]
        assert len(activity) == 200, f"expected 200 entries, got {len(activity)}"
        # The most recent N entries kept → the seed and the earliest events
        # should have been dropped. Last entry must be index N-1.
        assert activity[-1]["text"] == f"TEST_evt_{N-1:04d}"
        # First surviving entry must be index N - 200 = 10 (seed dropped,
        # events 0..9 dropped, events 10..209 kept).
        assert activity[0]["text"] == f"TEST_evt_{N-200:04d}"
        # Seed must be gone
        types = [e["type"] for e in activity]
        # 'saved' is the seed type — not present in the appended events
        assert "saved" not in types
        _delete_vehicle(cust_a["token"], vid)


# ───────────── cross-customer isolation on activity ─────────────

class TestCrossCustomerIsolationActivity:
    def test_a_cannot_see_or_mutate_b_activity(self, cust_a, cust_b):
        v = _create_vehicle(cust_b["token"])
        vid = v["id"]
        # B appends an event
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "inspection_requested", "text": "TEST_b_only"},
            headers=_headers(cust_b["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        # A cannot GET the vehicle
        r_get = requests.get(
            f"{BASE_URL}/api/customer/vehicles/{vid}",
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r_get.status_code == 404
        # A's list does NOT contain B's vehicle
        r_list = requests.get(
            f"{BASE_URL}/api/customer/vehicles",
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r_list.status_code == 200
        assert vid not in [v["id"] for v in r_list.json()]
        # A cannot append to B
        r_post = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "reopened"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r_post.status_code == 404
        _delete_vehicle(cust_b["token"], vid)


# ───────────── schema shape ─────────────

class TestSchemaShape:
    def test_vehicle_response_includes_status_and_activity(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        # status string|null
        assert "status" in v
        assert v["status"] is None or isinstance(v["status"], str)
        # activity is list
        assert isinstance(v["activity"], list)
        # each event has type/at/text shape
        for ev in v["activity"]:
            assert "type" in ev and isinstance(ev["type"], str)
            assert "at" in ev and ev["at"]
            assert "text" in ev  # may be None
            # No extra unexpected keys leak
            assert set(ev.keys()) <= {"type", "at", "text"}
        _delete_vehicle(cust_a["token"], v["id"])

    def test_no_mongo_id_in_responses(self, cust_a):
        v = _create_vehicle(cust_a["token"])
        vid = v["id"]
        r = requests.post(
            f"{BASE_URL}/api/customer/vehicles/{vid}/activity",
            json={"type": "reopened", "text": "TEST_nomongoid"},
            headers=_headers(cust_a["token"]),
            timeout=15,
        )
        assert r.status_code == 200
        body = r.json()

        def _check(o):
            if isinstance(o, dict):
                assert "_id" not in o
                for v_ in o.values():
                    _check(v_)
            elif isinstance(o, list):
                for x in o:
                    _check(x)
        _check(body)
        _delete_vehicle(cust_a["token"], vid)
