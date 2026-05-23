"""Sprint 3 Step 5 — Ops Map acceptance tests.

Covers:
  • health + auth gates
  • snapshot shape & determinism
  • pressure_label boundaries (pure)
  • hardFloor exclusion from supply
  • busy exclusion (active job → busy_by_zone, removed from supply)
  • demand counting from auto_requests
  • SLA risk classification (late / watch / ok)
  • summary aggregates consistency
  • assignments filtering (offered+accepted only)
  • empty-state behaviour (no inspectors / no jobs)
"""
from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone

import pytest
import requests
from bson import ObjectId
from pymongo import MongoClient

BASE_URL = os.environ.get("BACKEND_URL", "http://localhost:8001").rstrip("/")
SNAPSHOT_URL = f"{BASE_URL}/api/admin/ops-map/snapshot"
LOGIN_URL = f"{BASE_URL}/api/auth/login"

MONGO_URL = os.environ.get("MONGO_URL", "mongodb://localhost:27017")
DB_NAME = os.environ.get("DB_NAME", "test_database")

# A point that lives inside zone bbox berlin-neukolln (52.46..52.50, 13.40..13.48)
NEUKOLLN_LAT, NEUKOLLN_LNG = 52.48, 13.44


# ─────────────────────────────────────────────────────────────────────
# Fixtures
# ─────────────────────────────────────────────────────────────────────

@pytest.fixture(scope="module")
def db():
    client = MongoClient(MONGO_URL)
    yield client[DB_NAME]
    client.close()


@pytest.fixture(scope="module")
def admin_headers():
    r = requests.post(LOGIN_URL, json={"email": "admin@autoservice.com", "password": "Admin123!"}, timeout=15)
    assert r.status_code == 200, f"login failed: {r.status_code} {r.text}"
    tok = r.json().get("accessToken") or r.json().get("token")
    assert tok, "no token in login response"
    return {"Authorization": f"Bearer {tok}"}


def _snapshot(headers) -> dict:
    r = requests.get(SNAPSHOT_URL, headers=headers, timeout=15)
    assert r.status_code == 200, f"{r.status_code} {r.text}"
    return r.json()


def _isoz(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat()


@pytest.fixture
def cleanup(db):
    """Track ids inserted by each test and remove them on teardown."""
    state = {"user_ids": [], "job_ids": [], "request_ids": [], "asg_ids": []}
    yield state
    if state["user_ids"]:
        db.users.delete_many({"_id": {"$in": state["user_ids"]}})
    if state["job_ids"]:
        db.inspection_jobs.delete_many({"_id": {"$in": state["job_ids"]}})
    if state["request_ids"]:
        db.auto_requests.delete_many({"_id": {"$in": state["request_ids"]}})
    if state["asg_ids"]:
        db.inspection_assignments.delete_many({"id": {"$in": state["asg_ids"]}})


# ─────────────────────────────────────────────────────────────────────
# Smoke
# ─────────────────────────────────────────────────────────────────────

class TestSmoke:
    def test_health(self):
        r = requests.get(f"{BASE_URL}/api/health", timeout=10)
        assert r.status_code == 200
        body = r.json()
        assert body.get("status") == "ok"
        assert body.get("db") == "connected"

    def test_snapshot_requires_auth(self):
        r = requests.get(SNAPSHOT_URL, timeout=10)
        assert r.status_code == 401

    def test_snapshot_with_admin_token(self, admin_headers):
        snap = _snapshot(admin_headers)
        for key in ("generatedAt", "zones", "inspectors", "assignments", "jobs", "pressure", "summary"):
            assert key in snap, f"missing key {key}"
        assert isinstance(snap["zones"], list)
        assert isinstance(snap["inspectors"], list)
        assert isinstance(snap["assignments"], list)
        assert isinstance(snap["jobs"], list)
        assert isinstance(snap["summary"], dict)
        # On seed-state expect at least 4 zones (mitte/neukolln/munich-zentrum/hamburg-altona).
        zone_ids = {z["id"] for z in snap["zones"]}
        expected = {"berlin-mitte", "berlin-neukolln", "munich-zentrum", "hamburg-altona"}
        assert expected.issubset(zone_ids), f"missing seed zones, got {zone_ids}"


# ─────────────────────────────────────────────────────────────────────
# Pure pressure_label boundaries
# ─────────────────────────────────────────────────────────────────────

class TestPressureLabel:
    @pytest.mark.parametrize("ratio,label", [
        (0,    "low"),
        (1.0,  "low"),
        (1.01, "medium"),
        (2.0,  "medium"),
        (2.5,  "high"),
        (4.0,  "high"),
        (4.5,  "critical"),
        (10,   "critical"),
    ])
    def test_pressure_label(self, ratio, label):
        from app.ops_map.snapshot import pressure_label
        assert pressure_label(ratio) == label, f"ratio={ratio}"


# ─────────────────────────────────────────────────────────────────────
# Determinism
# ─────────────────────────────────────────────────────────────────────

class TestDeterminism:
    def test_two_consecutive_snapshots_have_identical_pressure(self, admin_headers):
        s1 = _snapshot(admin_headers)
        s2 = _snapshot(admin_headers)
        z1 = {z["id"]: (z["ratio"], z["pressure"]) for z in s1["zones"]}
        z2 = {z["id"]: (z["ratio"], z["pressure"]) for z in s2["zones"]}
        assert z1 == z2, f"non-deterministic\nfirst={z1}\nsecond={z2}"


# ─────────────────────────────────────────────────────────────────────
# Supply/Busy/Demand
# ─────────────────────────────────────────────────────────────────────

class TestSupplyAndBusy:
    def test_hardfloor_inspector_excluded_from_supply(self, db, admin_headers, cleanup):
        uid = ObjectId()
        cleanup["user_ids"].append(uid)
        db.users.insert_one({
            "_id": uid,
            "name": "TEST_hardfloor_insp",
            "email": f"TEST_hf_{uuid.uuid4().hex[:6]}@test.local",
            "role": "inspector",
            "isOnline": True,
            "location": {"lat": NEUKOLLN_LAT, "lng": NEUKOLLN_LNG},
            "reputation": {"hardFloor": True, "tier": "bronze", "score": 0},
        })

        # baseline supply (snapshot before is racy if other tests run in parallel — we
        # rely on the inserted user appearing & being excluded; assertion is structural).
        snap = _snapshot(admin_headers)

        me = next((i for i in snap["inspectors"] if i["id"] == str(uid)), None)
        assert me is not None, "inserted inspector missing from snapshot"
        assert me["status"] == "blocked"
        assert me.get("excludedFromSupply") == "hardFloor"

        # Per-zone: this inspector must NOT inflate supply.
        zone = next(z for z in snap["zones"] if z["id"] == "berlin-neukolln")
        # We cannot pin absolute supply (env may have other seed inspectors) but
        # we can assert that the *blocked* inspector did not contribute. Re-running
        # snapshot after toggling hardFloor=False should grow supply by exactly 1.
        baseline_supply = zone["supply"]

        db.users.update_one({"_id": uid}, {"$set": {"reputation.hardFloor": False}})
        snap2 = _snapshot(admin_headers)
        zone2 = next(z for z in snap2["zones"] if z["id"] == "berlin-neukolln")
        assert zone2["supply"] == baseline_supply + 1, (
            f"toggling hardFloor off should grow supply by 1 "
            f"(before={baseline_supply}, after={zone2['supply']})"
        )

    def test_busy_inspector_counts_as_busy_not_supply(self, db, admin_headers, cleanup):
        uid = ObjectId()
        cleanup["user_ids"].append(uid)
        db.users.insert_one({
            "_id": uid,
            "name": "TEST_busy_insp",
            "email": f"TEST_busy_{uuid.uuid4().hex[:6]}@test.local",
            "role": "inspector",
            "isOnline": True,
            "location": {"lat": NEUKOLLN_LAT, "lng": NEUKOLLN_LNG},
            "reputation": {"hardFloor": False, "tier": "silver", "score": 50},
        })
        # First snapshot — inspector is supply.
        snap_pre = _snapshot(admin_headers)
        zone_pre = next(z for z in snap_pre["zones"] if z["id"] == "berlin-neukolln")
        supply_pre = zone_pre["supply"]
        busy_pre = zone_pre["busy"]

        # Now attach an active job → must move into busy bucket.
        jid = ObjectId()
        cleanup["job_ids"].append(jid)
        db.inspection_jobs.insert_one({
            "_id": jid,
            "status": "claimed",
            "inspectorId": str(uid),
            "createdAt": _isoz(datetime.now(timezone.utc) - timedelta(hours=1)),
            "claimedAt": _isoz(datetime.now(timezone.utc)),
            "location": {"lat": NEUKOLLN_LAT, "lng": NEUKOLLN_LNG},
            "vehicle": {"make": "TEST", "model": "Busy"},
        })

        snap = _snapshot(admin_headers)
        zone = next(z for z in snap["zones"] if z["id"] == "berlin-neukolln")
        assert zone["supply"] == supply_pre - 1, "supply should drop by 1 when inspector becomes busy"
        assert zone["busy"] == busy_pre + 1, "busy should grow by 1"

        me = next(i for i in snap["inspectors"] if i["id"] == str(uid))
        assert me["status"] == "busy"
        assert me.get("excludedFromSupply") == "busy"
        assert me["activeJobs"] >= 1

    def test_demand_counted_from_pending_requests(self, db, admin_headers, cleanup):
        snap_pre = _snapshot(admin_headers)
        zpre = next(z for z in snap_pre["zones"] if z["id"] == "berlin-neukolln")
        baseline = zpre["demand"]

        for _ in range(2):
            rid = ObjectId()
            cleanup["request_ids"].append(rid)
            db.auto_requests.insert_one({
                "_id": rid,
                "status": "pending",
                "zoneId": "berlin-neukolln",
                "location": {"lat": NEUKOLLN_LAT, "lng": NEUKOLLN_LNG},
                "createdAt": _isoz(datetime.now(timezone.utc)),
            })

        snap = _snapshot(admin_headers)
        zone = next(z for z in snap["zones"] if z["id"] == "berlin-neukolln")
        assert zone["demand"] == baseline + 2


# ─────────────────────────────────────────────────────────────────────
# SLA risk
# ─────────────────────────────────────────────────────────────────────

class TestSlaRisk:
    def test_three_buckets(self, db, admin_headers, cleanup):
        now = datetime.now(timezone.utc)
        cases = [
            ("late",  now - timedelta(hours=36)),
            ("watch", now - timedelta(hours=23, minutes=30)),
            ("ok",    now - timedelta(hours=5)),
        ]
        ids: dict[str, str] = {}
        for label, created in cases:
            jid = ObjectId()
            cleanup["job_ids"].append(jid)
            db.inspection_jobs.insert_one({
                "_id": jid,
                "status": "claimed",
                "inspectorId": f"TEST_sla_{label}",
                "createdAt": _isoz(created),
                "location": {"lat": NEUKOLLN_LAT, "lng": NEUKOLLN_LNG},
                "vehicle": {"make": "TEST", "model": f"sla_{label}"},
            })
            ids[label] = str(jid)

        snap = _snapshot(admin_headers)
        jobs_by_id = {j["id"]: j for j in snap["jobs"]}

        for label, jid in ids.items():
            assert jid in jobs_by_id, f"{label} job missing"
            assert jobs_by_id[jid]["slaRisk"] == label, (
                f"job {label}: expected slaRisk={label}, "
                f"got {jobs_by_id[jid]['slaRisk']}"
            )


# ─────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────

class TestSummary:
    def test_summary_keys_and_types(self, admin_headers):
        snap = _snapshot(admin_headers)
        s = snap["summary"]
        keys = (
            "totalZones", "totalInspectors", "onlineInspectors",
            "busyInspectors", "blockedInspectors", "activeJobs",
            "lateJobs", "watchJobs", "liveOffers", "claimedAssignments",
            "criticalZones", "highPressureZones",
        )
        for k in keys:
            assert k in s, f"missing summary key {k}"
            assert isinstance(s[k], int), f"{k} is {type(s[k])}, want int"

    def test_summary_aggregates_match_arrays(self, admin_headers):
        snap = _snapshot(admin_headers)
        s = snap["summary"]
        assert s["totalZones"] == len(snap["zones"])
        assert s["totalInspectors"] == len(snap["inspectors"])
        assert s["activeJobs"] == len(snap["jobs"])
        assert s["onlineInspectors"] == sum(1 for i in snap["inspectors"] if i["status"] == "online")
        assert s["busyInspectors"] == sum(1 for i in snap["inspectors"] if i["status"] == "busy")
        assert s["blockedInspectors"] == sum(1 for i in snap["inspectors"] if i["status"] == "blocked")
        assert s["lateJobs"] == sum(1 for j in snap["jobs"] if j["slaRisk"] == "late")
        assert s["watchJobs"] == sum(1 for j in snap["jobs"] if j["slaRisk"] == "watch")
        assert s["liveOffers"] == sum(1 for a in snap["assignments"] if a["status"] == "offered")
        assert s["claimedAssignments"] == sum(1 for a in snap["assignments"] if a["status"] == "accepted")
        assert s["criticalZones"] == sum(1 for z in snap["zones"] if z["pressure"] == "critical")
        assert s["highPressureZones"] == sum(1 for z in snap["zones"] if z["pressure"] in ("high", "critical"))


# ─────────────────────────────────────────────────────────────────────
# Assignments filtering
# ─────────────────────────────────────────────────────────────────────

class TestAssignmentsFilter:
    def test_only_offered_and_accepted_appear(self, db, admin_headers, cleanup):
        # Insert one of each terminal status, plus offered + accepted, all for
        # the same fake job. Only offered/accepted must surface in snapshot.
        statuses = ["offered", "accepted", "declined", "expired", "cancelled"]
        marker = uuid.uuid4().hex[:8]
        for st in statuses:
            asg_id = f"asg_TEST_{marker}_{st}"
            cleanup["asg_ids"].append(asg_id)
            db.inspection_assignments.insert_one({
                "id": asg_id,
                "jobId": f"TEST_job_{marker}",
                "inspectorId": f"TEST_insp_{marker}",
                "status": st,
                "priority": "standard",
                "score": 50,
                "createdAt": _isoz(datetime.now(timezone.utc)),
                "expiresAt": _isoz(datetime.now(timezone.utc) + timedelta(minutes=2)),
            })

        snap = _snapshot(admin_headers)
        ids_in_snap = {a["id"] for a in snap["assignments"]}
        assert f"asg_TEST_{marker}_offered" in ids_in_snap
        assert f"asg_TEST_{marker}_accepted" in ids_in_snap
        for bad in ("declined", "expired", "cancelled"):
            assert f"asg_TEST_{marker}_{bad}" not in ids_in_snap, f"{bad} leaked into snapshot"


# ─────────────────────────────────────────────────────────────────────
# Empty-state — we cannot wipe the seed DB, but we can verify shape
# when no test data added: snapshot still returns 200 with seed zones.
# ─────────────────────────────────────────────────────────────────────

class TestEmptyState:
    def test_shape_with_no_test_data(self, admin_headers):
        snap = _snapshot(admin_headers)
        assert isinstance(snap["zones"], list) and len(snap["zones"]) >= 4
        # arrays must always be present (never None)
        assert snap["inspectors"] is not None
        assert snap["assignments"] is not None
        assert snap["jobs"] is not None
        # ratio/pressure must be sane on empty supply (no division by zero)
        for z in snap["zones"]:
            assert isinstance(z["ratio"], (int, float))
            assert z["pressure"] in ("low", "medium", "high", "critical")
